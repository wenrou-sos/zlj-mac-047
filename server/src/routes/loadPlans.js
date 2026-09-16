// 出港配载单路由：从在场包裹建单，按目的地/截单/载重分配；支持拆单、撤配、改配、封车
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { computeCutoff, findCandidates } from '../helpers.js';
import {
  HttpError, genPlanNo, validatePackagesForPlan, insertPlanItems,
} from '../dispatch.js';

const router = Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const PLAN_SELECT = `
  SELECT lp.*,
    v.plate_no, v.route_code, v.status AS vehicle_status,
    v.planned_departure, v.capacity_kg AS vehicle_capacity_kg,
    COALESCE(SUM(p.weight_kg) FILTER (WHERE lpi.is_active), 0)::float  AS loaded_kg,
    COUNT(p.id) FILTER (WHERE lpi.is_active)::int                       AS item_count
  FROM load_plans lp
  JOIN vehicles v ON v.id = lp.vehicle_id
  LEFT JOIN load_plan_items lpi ON lpi.plan_id = lp.id AND lpi.is_active
  LEFT JOIN packages p ON p.id = lpi.package_id`;

async function getPlan(tx, id, { lock = false, activeOnly = false } = {}) {
  const [plan] = await tx(`SELECT * FROM load_plans WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!plan) throw new HttpError(404, '配载单不存在');
  if (activeOnly && !['draft', 'sealed'].includes(plan.status)) {
    throw new HttpError(409, `配载单已${plan.status === 'departed' ? '发车锁定' : '撤单'}，不可操作`);
  }
  return plan;
}

async function getVehicle(tx, id, { lock = false } = {}) {
  const [v] = await tx(`SELECT * FROM vehicles WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!v) throw new HttpError(404, '出港班次不存在');
  return v;
}

// ── 列表 ─────────────────────────────────────────────────────────────
router.get('/', wrap(async (req, res) => {
  const { status, vehicle_id } = req.query;
  const conds = [];
  const params = [];
  if (status) { params.push(status); conds.push(`lp.status = $${params.length}`); }
  if (vehicle_id) { params.push(vehicle_id); conds.push(`lp.vehicle_id = $${params.length}`); }
  const rows = await query(
    `${PLAN_SELECT} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     GROUP BY lp.id, v.id
     ORDER BY
       CASE lp.status WHEN 'draft' THEN 0 WHEN 'sealed' THEN 1 WHEN 'departed' THEN 2 ELSE 3 END,
       lp.created_at DESC`,
    params
  );
  res.json(rows);
}));

// ── 明细：单据 + 当前实际占用清单（含进港来源）──────────────────────
router.get('/:id', wrap(async (req, res) => {
  const [plan] = await query(
    `${PLAN_SELECT} WHERE lp.id = $1 GROUP BY lp.id, v.id`,
    [req.params.id]
  );
  if (!plan) throw new HttpError(404, '配载单不存在');
  const [vehicle] = await query(`SELECT * FROM vehicles WHERE id = $1`, [plan.vehicle_id]);
  const cutoffAt = plan.cutoff_at || (await computeCutoff(vehicle));
  const items = await query(
    `SELECT lpi.id, lpi.package_id, lpi.added_at, p.tracking_no, p.destination,
            p.weight_kg::float AS weight_kg, p.status AS package_status,
            p.vehicle_id AS source_vehicle_id, sv.plate_no AS source_plate_no, sv.route_code AS source_route_code
     FROM load_plan_items lpi
     JOIN packages p ON p.id = lpi.package_id
     LEFT JOIN vehicles sv ON sv.id = p.vehicle_id
     WHERE lpi.plan_id = $1 AND lpi.is_active
     ORDER BY p.destination, p.sorted_at, p.id`,
    [req.params.id]
  );
  res.json({ ...plan, items });
}));

// ── 候选件预览：按目的地/截单过滤，按载重贪心，装不下的列为积压 ─────
router.get('/candidates/preview', wrap(async (req, res) => {
  const vehicleId = Number(req.query.vehicle_id);
  if (!vehicleId) throw new HttpError(400, '请选择出港班次');
  const vehicle = await query('SELECT * FROM vehicles WHERE id = $1', [vehicleId]);
  if (!vehicle.length) throw new HttpError(404, '出港班次不存在');
  const destination = req.query.destination || null;
  const limitKg = req.query.limit_kg !== undefined ? Number(req.query.limit_kg) : null;

  const cutoff = await computeCutoff(vehicle[0]);
  // limitKg=null 取全部候选（仅过滤），否则按容量贪心装入
  const fitted = await findCandidates(vehicle[0], { destination, limitKg, });
  // 全量候选（不限重）用于提示"装不下、留待下一班"的积压量
  const all = limitKg != null
    ? await findCandidates(vehicle[0], { destination })
    : fitted;
  const fitIds = new Set(fitted.map((p) => p.id));
  const overflow = all.filter((p) => !fitIds.has(p.id));
  const sum = (arr) => Math.round(arr.reduce((s, p) => s + Number(p.weight_kg), 0) * 100) / 100;
  res.json({
    cutoff_at: cutoff,
    fitted: fitted.map((p) => ({ id: p.id, tracking_no: p.tracking_no, destination: p.destination, weight_kg: Number(p.weight_kg) })),
    fitted_count: fitted.length,
    fitted_kg: sum(fitted),
    overflow_count: overflow.length,
    overflow_kg: sum(overflow),
    remaining_kg: limitKg != null ? Math.round((limitKg - sum(fitted)) * 100) / 100 : null,
  });
}));

// ── 建立配载单 ───────────────────────────────────────────────────────
// body: { vehicle_id, destination?, capacity_kg?, cutoff_at?, package_ids?[], auto_load? }
router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const result = await withTransaction(async (tx) => {
    const vehicle = await getVehicle(tx, b.vehicle_id, { lock: true });
    if (vehicle.status === 'departed' || vehicle.status === 'expected') {
      throw new HttpError(409, '该班次状态不允许建立出港配载单');
    }
    const destination = b.destination || null;
    if (destination && vehicle.destinations?.length && !vehicle.destinations.includes(destination)) {
      throw new HttpError(409, `${vehicle.plate_no}（${vehicle.route_code}）不承运 ${destination}`);
    }
    // 截单时间默认取班次（计划发车 − 截单提前量）；仅可显式覆盖，缺省不能绕过班次截单
    let cutoff = await computeCutoff(vehicle);
    if (b.cutoff_at) {
      const manual = new Date(b.cutoff_at);
      if (!Number.isNaN(manual)) cutoff = manual;
    }
    // 已过截单时间且未显式放宽：不允许再向该班次新建配载
    if (cutoff && new Date() > cutoff && !(b.cutoff_at && new Date(b.cutoff_at) > new Date())) {
      throw new HttpError(409, '该班次已过截单时间，不能新建配载（可调度后续班次）');
    }

    // 容量：显式指定优先，否则取车辆额定载重减去其它生效单已占重量
    let capacity = b.capacity_kg !== undefined && b.capacity_kg !== null && b.capacity_kg !== ''
      ? Number(b.capacity_kg) : null;
    if (capacity == null) {
      const [used] = await tx(
        `SELECT COALESCE(SUM(p.weight_kg),0)::float AS kg
         FROM load_plan_items lpi
         JOIN load_plans lp ON lp.id = lpi.plan_id
         JOIN packages p ON p.id = lpi.package_id
         WHERE lp.vehicle_id = $1 AND lpi.is_active`,
        [vehicle.id]
      );
      capacity = Number(vehicle.capacity_kg) - (used.kg || 0);
    }
    if (!(capacity >= 0)) throw new HttpError(400, '配载载重必须 ≥ 0');

    const planNo = await genPlanNo(tx);
    let [plan] = await tx(
      `INSERT INTO load_plans (plan_no, vehicle_id, destination, cutoff_at, capacity_kg, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [planNo, vehicle.id, destination, cutoff, capacity, b.auto_load ? 'auto' : 'manual']
    );

    let addedPkgs = [];
    let overflowCount = 0;
    let overflowKg = 0;
    if (b.auto_load) {
      const cands = await findCandidates(vehicle, { destination, limitKg: capacity });
      const all = await findCandidates(vehicle, { destination });
      const fitIds = new Set(cands.map((p) => p.id));
      const overflow = all.filter((p) => !fitIds.has(p.id));
      overflowCount = overflow.length;
      overflowKg = Math.round(overflow.reduce((s, p) => s + Number(p.weight_kg), 0) * 100) / 100;
      await validatePackagesForPlan(tx, vehicle, destination, cands.map((p) => p.id), cutoff, plan.id);
      await insertPlanItems(tx, plan.id, cands.map((p) => p.id), 'auto');
      addedPkgs = cands;
    } else if (Array.isArray(b.package_ids) && b.package_ids.length) {
      const pkgs = await validatePackagesForPlan(tx, vehicle, destination, b.package_ids, cutoff, plan.id);
      const over = pkgs.reduce((s, p) => s + Number(p.weight_kg), 0);
      if (over > capacity) {
        throw new HttpError(409, `合计重量 ${over.toFixed(2)}kg 超过本单载重 ${capacity}kg，请拆单或提高载重`);
      }
      await insertPlanItems(tx, plan.id, pkgs.map((p) => p.id), 'manual');
      addedPkgs = pkgs;
    }
    [plan] = await tx(`${PLAN_SELECT} WHERE lp.id = $1 GROUP BY lp.id, v.id`, [plan.id]);
    return { plan, added_count: addedPkgs.length, overflow_count: overflowCount, overflow_kg: overflowKg };
  });
  res.status(201).json(result);
}));

// 单据存在性/状态校验（写操作前置）
async function loadPlanContext(tx, id, { editable = true } = {}) {
  const plan = await getPlan(tx, id, { lock: true, activeOnly: editable });
  const vehicle = await getVehicle(tx, plan.vehicle_id, { lock: true });
  return { plan, vehicle };
}

// ── 追加包裹（手动补配）──────────────────────────────────────────────
router.post('/:id/items', wrap(async (req, res) => {
  const ids = req.body?.package_ids;
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, '请选择要配载的包裹');
  const result = await withTransaction(async (tx) => {
    const { plan, vehicle } = await loadPlanContext(tx, req.params.id);
    if (plan.status === 'sealed') throw new HttpError(409, '配载单已封车，请先解封再调整');
    const pkgs = await validatePackagesForPlan(tx, vehicle, plan.destination, ids, plan.cutoff_at, plan.id);
    const [agg] = await tx(
      `SELECT COALESCE(SUM(p.weight_kg),0)::float AS kg
       FROM load_plan_items lpi JOIN packages p ON p.id = lpi.package_id
       WHERE lpi.plan_id = $1 AND lpi.is_active`,
      [plan.id]
    );
    const addWeight = pkgs.reduce((s, p) => s + Number(p.weight_kg), 0);
    if (agg.kg + addWeight > Number(plan.capacity_kg) + 1e-6) {
      throw new HttpError(409, `将超出载重 ${plan.capacity_kg}kg（当前 ${agg.kg.toFixed(2)} + 新增 ${addWeight.toFixed(2)}），装不下请改配其它班次`);
    }
    await insertPlanItems(tx, plan.id, pkgs.map((p) => p.id), 'manual');
    return tx(`${PLAN_SELECT} WHERE lp.id = $1 GROUP BY lp.id, v.id`, [plan.id]);
  });
  res.json(result[0]);
}));

// ── 拆单 / 撤配：把件从单上移除（件回到在场，可再配下班）────────────
router.delete('/:id/items', wrap(async (req, res) => {
  const ids = (req.body?.package_ids || (req.query.package_ids ? req.query.package_ids.split(',') : []))
    .map(Number).filter(Boolean);
  if (!ids.length) throw new HttpError(400, '请选择要撤配的包裹');
  const result = await withTransaction(async (tx) => {
    const { plan } = await loadPlanContext(tx, req.params.id);
    if (plan.status === 'sealed') throw new HttpError(409, '配载单已封车，请先解封再调整');
    const r = await tx(
      `UPDATE load_plan_items SET removed_at = NOW()
       WHERE plan_id = $1 AND is_active AND package_id = ANY($2::int[]) RETURNING package_id`,
      [plan.id, ids]
    );
    if (!r.length) throw new HttpError(404, '所选包裹不在本配载单中');
    return tx(`${PLAN_SELECT} WHERE lp.id = $1 GROUP BY lp.id, v.id`, [plan.id]);
  });
  res.json(result[0]);
}));

// ── 改配：把件从源单移到另一张生效单（同车拆单或换班次）─────────────
router.post('/:id/reassign', wrap(async (req, res) => {
  const { target_plan_id, package_ids } = req.body || {};
  const ids = (package_ids || []).map(Number).filter(Boolean);
  if (!target_plan_id) throw new HttpError(400, '请选择目标配载单');
  if (!ids.length) throw new HttpError(400, '请选择要改配的包裹');
  if (Number(target_plan_id) === Number(req.params.id)) throw new HttpError(400, '目标单不能与源单相同');
  const result = await withTransaction(async (tx) => {
    const src = await loadPlanContext(tx, req.params.id);
    if (src.plan.status === 'sealed') throw new HttpError(409, '源单已封车，请先解封');
    const target = await loadPlanContext(tx, target_plan_id);
    if (target.plan.status === 'sealed') throw new HttpError(409, '目标单已封车，请先解封');

    const inSrc = await tx(
      `SELECT package_id FROM load_plan_items WHERE plan_id = $1 AND is_active AND package_id = ANY($2::int[])`,
      [src.plan.id, ids]
    );
    if (inSrc.length !== ids.length) throw new HttpError(409, '部分包裹不在源配载单中');

    // 先从源单移除（源单不再占用），再以目标单规则校验：目的地、截单、载重、是否被其它生效单占用
    // 任一步失败由事务整体回滚，源单自动还原
    await tx(
      `UPDATE load_plan_items SET removed_at = NOW()
       WHERE plan_id = $1 AND is_active AND package_id = ANY($2::int[])`,
      [src.plan.id, ids]
    );
    const pkgs = await validatePackagesForPlan(tx, target.vehicle, target.plan.destination, ids, target.plan.cutoff_at, target.plan.id);
    const [agg] = await tx(
      `SELECT COALESCE(SUM(p.weight_kg),0)::float AS kg
       FROM load_plan_items lpi JOIN packages p ON p.id = lpi.package_id
       WHERE lpi.plan_id = $1 AND lpi.is_active`,
      [target.plan.id]
    );
    const addWeight = pkgs.reduce((s, p) => s + Number(p.weight_kg), 0);
    if (agg.kg + addWeight > Number(target.plan.capacity_kg) + 1e-6) {
      throw new HttpError(409, `目标单载重不足（剩余 ${(target.plan.capacity_kg - agg.kg).toFixed(2)}kg，本次 ${addWeight.toFixed(2)}kg）`);
    }

    await insertPlanItems(tx, target.plan.id, ids, 'manual');
    const [s, t] = await Promise.all([
      tx(`${PLAN_SELECT} WHERE lp.id = $1 GROUP BY lp.id, v.id`, [src.plan.id]),
      tx(`${PLAN_SELECT} WHERE lp.id = $1 GROUP BY lp.id, v.id`, [target.plan.id]),
    ]);
    return { source: s[0], target: t[0], moved: ids.length };
  });
  res.json(result);
}));

// ── 撤单：整张配载单作废，全部件回到在场 ────────────────────────────
router.post('/:id/cancel', wrap(async (req, res) => {
  const result = await withTransaction(async (tx) => {
    const { plan } = await loadPlanContext(tx, req.params.id);
    if (plan.status === 'sealed') throw new HttpError(409, '配载单已封车，请先解封再撤单');
    await tx(
      `UPDATE load_plan_items SET removed_at = NOW() WHERE plan_id = $1 AND is_active`,
      [plan.id]
    );
    const [cancelled] = await tx(
      `UPDATE load_plans SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1
       WHERE id = $2 RETURNING *`,
      [req.body?.reason || null, plan.id]
    );
    return cancelled;
  });
  res.json(result);
}));

// ── 封车（发车前锁定）：拦截件/清单校验，封车后不可再改 ────────────
router.post('/:id/seal', wrap(async (req, res) => {
  const result = await withTransaction(async (tx) => {
    const { plan } = await loadPlanContext(tx, req.params.id);
    if (plan.status === 'sealed') throw new HttpError(409, '配载单已封车');
    const [bad] = await tx(
      `SELECT p.tracking_no FROM load_plan_items lpi
       JOIN packages p ON p.id = lpi.package_id
       WHERE lpi.plan_id = $1 AND lpi.is_active AND p.status = 'intercepted' LIMIT 1`,
      [plan.id]
    );
    if (bad) throw new HttpError(409, `清单含拦截件 ${bad.tracking_no}，请先撤配该件`);
    const [cnt] = await tx(
      `SELECT COUNT(*)::int AS c FROM load_plan_items WHERE plan_id = $1 AND is_active`,
      [plan.id]
    );
    if (cnt.c === 0) throw new HttpError(409, '配载单为空，无法封车');
    const [sealed] = await tx(
      `UPDATE load_plans SET status = 'sealed', sealed_at = NOW() WHERE id = $1 RETURNING *`,
      [plan.id]
    );
    return sealed;
  });
  res.json(result);
}));

// ── 解封：发车前如需调整可退回配载中 ────────────────────────────────
router.post('/:id/unseal', wrap(async (req, res) => {
  const result = await withTransaction(async (tx) => {
    const plan = await getPlan(tx, req.params.id, { lock: true });
    if (plan.status !== 'sealed') throw new HttpError(409, '仅已封车的配载单可解封');
    const [unsealed] = await tx(
      `UPDATE load_plans SET status = 'draft', sealed_at = NULL WHERE id = $1 RETURNING *`,
      [plan.id]
    );
    return unsealed;
  });
  res.json(result);
}));

export default router;
