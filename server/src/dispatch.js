// 出港配载领域服务：配载单编号、候选件校验、发车锁定（均事务化）
import { withTransaction } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 配载单号：LP + 日期 + 当日序号
export async function genPlanNo(tx) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 3; i++) {
    const [r] = await tx(`SELECT COUNT(*)::int AS c FROM load_plans WHERE plan_no LIKE $1`, [`LP${ymd}-%`]);
    const no = `LP${ymd}-${String(r.c + 1).padStart(3, '0')}`;
    const [dup] = await tx(`SELECT 1 FROM load_plans WHERE plan_no = $1`, [no]);
    if (!dup) return no;
  }
  return `LP${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

// 生效配载单占用查询（is_active 由数据库触发器维护，DB 层另有唯一索引兜底）
export async function activeOccupancy(tx, packageIds, excludePlanId = null) {
  if (!packageIds.length) return [];
  const params = [packageIds];
  let sql = `
    SELECT lpi.plan_id, lp.plan_no, lp.status AS plan_status, lpi.package_id
    FROM load_plan_items lpi
    JOIN load_plans lp ON lp.id = lpi.plan_id
    WHERE lpi.is_active = TRUE AND lpi.package_id = ANY($1::int[])`;
  if (excludePlanId != null) {
    params.push(excludePlanId);
    sql += ` AND lpi.plan_id <> $2`;
  }
  return tx(sql, params);
}

/**
 * 校验一批包裹是否可加入某班次的配载单
 * 规则：已分拣未拦截 / 目的地与单据一致 / 班次可达 / 未过截单时间 / 未被其它生效单占用
 */
export async function validatePackagesForPlan(tx, vehicle, destination, packageIds, cutoff, excludePlanId = null, now = new Date()) {
  const ids = [...new Set(packageIds.map(Number))];
  const pkgs = await tx(`SELECT * FROM packages WHERE id = ANY($1::int[])`, [ids]);
  if (pkgs.length !== ids.length) throw new HttpError(404, '部分包裹不存在');

  // 已过班次截单点：禁止再向该班次配载/调整
  if (cutoff && now > new Date(cutoff)) {
    throw new HttpError(409, '已超过该班次截单时间，不能再调整配载（可改配后续班次）');
  }

  const occupied = await activeOccupancy(tx, ids, excludePlanId);
  const occMap = new Map(occupied.map((o) => [o.package_id, o]));

  const bad = [];
  for (const p of pkgs) {
    const reasons = [];
    if (p.status === 'intercepted') reasons.push('拦截件禁止放行');
    else if (p.status !== 'sorted') reasons.push('仅已分拣在场件可配载');
    if (destination && p.destination !== destination) reasons.push(`目的地不符（${p.destination}）`);
    if (vehicle.destinations?.length && !vehicle.destinations.includes(p.destination)) {
      reasons.push(`${vehicle.plate_no} 不承运 ${p.destination}`);
    }
    const occ = occMap.get(p.id);
    if (occ) reasons.push(`已在生效配载单 ${occ.plan_no} 中`);
    if (reasons.length) bad.push({ tracking_no: p.tracking_no, reasons });
  }
  if (bad.length) {
    const detail = bad.slice(0, 5).map((b) => `${b.tracking_no}：${b.reasons.join('、')}`).join('；');
    throw new HttpError(409, `${bad.length} 件不能配载 —— ${detail}${bad.length > 5 ? ' 等' : ''}`);
  }
  return pkgs;
}

// 写入明细；同一单内历史移除记录复用（留痕链不断），冲突唯一索引兜底
export async function insertPlanItems(tx, planId, packageIds, addedBy = 'manual') {
  for (const pid of packageIds) {
    try {
      await tx(
        `INSERT INTO load_plan_items (plan_id, package_id, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (plan_id, package_id) DO UPDATE
           SET removed_at = NULL, added_at = NOW(), added_by = EXCLUDED.added_by`,
        [planId, pid, addedBy]
      );
    } catch (e) {
      if (/uq_lpi_active_package|duplicate key/i.test(String(e.message))) {
        const [occ] = await activeOccupancy(tx, [pid], planId);
        throw new HttpError(409, occ ? `该件已被配载单 ${occ.plan_no} 占用` : '该件已被其它生效配载单占用');
      }
      throw e;
    }
  }
}

export const isDupKey = (e) => /duplicate key|unique constraint/i.test(String(e?.message));

/**
 * 确认发车（车辆状态机唯一入口）：
 *  1. 锁定本班次全部生效配载单（draft 自动随班封发，sealed 直接发）
 *  2. 拦截件复查：任一单含拦截件则整笔回滚，不允许放行
 *  3. 仅这些单据实际占用的包裹按「实际去向」置为已装车；其它件（含进港车带来但已改配走、
 *     或尚未配载的）一律不动，留待下一班
 *  4. 配载单置 departed、明细移除时间置位（释放占用，实际清单永久留痕）
 */
export async function departVehicle(vehicleId) {
  return withTransaction(async (tx) => {
    const [vehicle] = await tx(`SELECT * FROM vehicles WHERE id = $1 FOR UPDATE`, [vehicleId]);
    if (!vehicle) throw new HttpError(404, '车辆不存在');
    if (vehicle.status !== 'sorted') throw new HttpError(409, '当前状态不允许发车');

    const plans = await tx(
      `SELECT * FROM load_plans WHERE vehicle_id = $1 AND status IN ('draft','sealed') ORDER BY id FOR UPDATE`,
      [vehicleId]
    );
    if (!plans.length) {
      throw new HttpError(409, '本班次没有生效的出港配载单，请先建立配载单再发车');
    }

    const planIds = plans.map((p) => p.id);
    // 拦截件复查（正常流程拦截件无法入单，此处为数据层兜底）
    const intercepted = await tx(
      `SELECT lp.plan_no, p.tracking_no
       FROM load_plan_items lpi
       JOIN load_plans lp ON lp.id = lpi.plan_id
       JOIN packages p ON p.id = lpi.package_id
       WHERE lpi.is_active = TRUE AND lp.id = ANY($1::int[]) AND p.status = 'intercepted'`,
      [planIds]
    );
    if (intercepted.length) {
      throw new HttpError(409, `配载单 ${intercepted[0].plan_no} 含拦截件 ${intercepted[0].tracking_no}，禁止发车`);
    }

    // 实际发车清单 = 这些单当前生效占用的全部包裹
    const items = await tx(
      `SELECT plan_id, package_id FROM load_plan_items WHERE plan_id = ANY($1::int[]) AND is_active = TRUE`,
      [planIds]
    );
    const pkgIds = [...new Set(items.map((i) => i.package_id))];
    if (!pkgIds.length) throw new HttpError(409, '配载单为空，无实际装车清单');

    // 空的生效单（调度建了但没配货）随班撤销，不产生空的"已发车"单
    const filledPlanIds = [...new Set(items.map((i) => i.plan_id))];
    const emptyPlanIds = planIds.filter((id) => !filledPlanIds.includes(id));
    if (emptyPlanIds.length) {
      await tx(
        `UPDATE load_plans SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = '发车时空单自动撤销'
         WHERE id = ANY($1::int[])`,
        [emptyPlanIds]
      );
    }
    const departingPlanIds = filledPlanIds;

    // 锁父单为已发车：明细 removed_at 保持 NULL，实际清单永久保留；
    // 占用释放由父单状态触发器（is_active=FALSE）完成，不在发车时移除明细
    await tx(
      `UPDATE packages SET status = 'loaded', loaded_at = NOW()
       WHERE id = ANY($1::int[]) AND status <> 'intercepted'`,
      [pkgIds]
    );
    await tx(
      `UPDATE load_plans SET status = 'departed', departed_at = NOW() WHERE id = ANY($1::int[])`,
      [departingPlanIds]
    );
    const [updatedVehicle] = await tx(
      `UPDATE vehicles SET status = 'departed', departed_at = NOW() WHERE id = $1 RETURNING *`,
      [vehicleId]
    );
    return { vehicle: updatedVehicle, plans: plans.filter((p) => filledPlanIds.includes(p.id)), loaded_count: pkgIds.length, cancelled_empty: emptyPlanIds.length };
  });
}
