// 包裹路由：查询、分拣、异常拦截/解除
// 装车不再逐件手工操作：包裹只能通过「出港配载单」随班发车锁定去向
import { Router } from 'express';
import { query } from '../db.js';
import { HttpError } from '../dispatch.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// 包裹列表（分页，支持状态/目的地/异常/进港车辆/单号筛选，并带当前配载去向）
router.get('/', wrap(async (req, res) => {
  const { status, destination, abnormal, vehicle_id, q, page = 1, pageSize = 50 } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  if (status) add('p.status = ?', status);
  if (destination) add('p.destination = ?', destination);
  if (vehicle_id) add('p.vehicle_id = ?', vehicle_id);
  if (abnormal === 'true') conds.push('p.is_abnormal = TRUE');
  if (q) add('p.tracking_no ILIKE ?', `%${q}%`);

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);

  const [{ count }] = await query(
    `SELECT COUNT(*)::int AS count FROM packages p ${where}`,
    params
  );
  params.push(size, (pageNum - 1) * size);
  const items = await query(
    `SELECT p.*, v.plate_no, v.route_code,
            lp.id AS plan_id, lp.plan_no, lp.status AS plan_status,
            ov.plate_no AS out_plate_no, ov.route_code AS out_route_code
     FROM packages p
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     LEFT JOIN LATERAL (
       SELECT lpi.plan_id FROM load_plan_items lpi
       JOIN load_plans lp2 ON lp2.id = lpi.plan_id
       WHERE lpi.package_id = p.id AND lpi.is_active LIMIT 1
     ) cur ON TRUE
     LEFT JOIN load_plans lp ON lp.id = cur.plan_id
     LEFT JOIN vehicles ov ON ov.id = lp.vehicle_id
     ${where}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
}));

// 新增包裹（模拟到件扫描）
router.post('/', wrap(async (req, res) => {
  const { tracking_no, vehicle_id, destination, weight_kg } = req.body || {};
  if (!tracking_no || !destination) throw new HttpError(400, '运单号和目的地不能为空');
  try {
    const rows = await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tracking_no, vehicle_id || null, destination, weight_kg || 1]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e.message))) throw new HttpError(409, '运单号已存在');
    throw e;
  }
}));

// 分拣完成
router.post('/:id/sort', wrap(async (req, res) => {
  const rows = await query(
    `UPDATE packages SET status = 'sorted', sorted_at = NOW()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) throw new HttpError(409, '仅待分拣包裹可执行分拣操作');
  res.json(rows[0]);
}));

// 装车已并入配载单发车流程；保留路由给出明确指引，避免旧调用静默误装
router.post('/:id/load', wrap(async (req, res) => {
  throw new HttpError(409, '请在「出港配载」中建立配载单，包裹随班发车后自动锁定装车，不再支持逐件装车');
}));

// 异常拦截
router.post('/:id/intercept', wrap(async (req, res) => {
  const { abnormal_type, note } = req.body || {};
  if (!abnormal_type) throw new HttpError(400, '请选择异常类型');
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) throw new HttpError(404, '包裹不存在');
  if (pkg.status === 'loaded') throw new HttpError(409, '包裹已随班发车，无法拦截');
  if (pkg.status === 'intercepted') throw new HttpError(409, '包裹已处于拦截状态');

  // 在配载中(draft)单上：自动撤配，件留场处理；在已封车(sealed)单上：拦截即意味着不能放行
  const occ = await query(
    `SELECT lp.id, lp.plan_no, lp.status FROM load_plan_items lpi
     JOIN load_plans lp ON lp.id = lpi.plan_id
     WHERE lpi.package_id = $1 AND lpi.is_active`,
    [pkg.id]
  );
  const sealed = occ.find((o) => o.status === 'sealed');
  if (sealed) {
    throw new HttpError(409, `该件已在封车配载单 ${sealed.plan_no} 上，请先让调度解封并撤配后再拦截`);
  }
  for (const o of occ) {
    await query(
      `UPDATE load_plan_items SET removed_at = NOW()
       WHERE plan_id = $1 AND package_id = $2 AND is_active`,
      [o.id, pkg.id]
    );
  }

  const rows = await query(
    `UPDATE packages
     SET status = 'intercepted', is_abnormal = TRUE, abnormal_type = $1,
         abnormal_note = $2, intercepted_at = NOW()
     WHERE id = $3 RETURNING *`,
    [abnormal_type, note || null, pkg.id]
  );
  res.json(rows[0]);
}));

// 解除拦截（回到待分拣；若已分拣过则回到已分拣，可重新配载）
router.post('/:id/release', wrap(async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) throw new HttpError(404, '包裹不存在');
  if (pkg.status !== 'intercepted') throw new HttpError(409, '包裹未处于拦截状态');
  const backTo = pkg.sorted_at ? 'sorted' : 'pending';
  const rows = await query(
    `UPDATE packages
     SET status = $1, is_abnormal = FALSE, intercept_released_at = NOW()
     WHERE id = $2 RETURNING *`,
    [backTo, pkg.id]
  );
  res.json(rows[0]);
}));

export default router;
