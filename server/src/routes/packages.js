// 包裹路由：查询、分拣、装车、异常拦截（生成处置工单）
import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// 包裹列表（分页，支持状态/目的地/异常/车辆/单号筛选，附带未结工单数）
router.get('/', async (req, res) => {
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
       (SELECT COUNT(*)::int FROM work_orders w
         WHERE w.package_id = p.id AND w.status IN ('open','processing','pending_review')) AS open_work_orders
     FROM packages p LEFT JOIN vehicles v ON v.id = p.vehicle_id
     ${where}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
});

// 新增包裹（模拟到件扫描）
router.post('/', async (req, res) => {
  const { tracking_no, vehicle_id, destination, weight_kg } = req.body || {};
  if (!tracking_no || !destination) {
    return res.status(400).json({ error: '运单号和目的地不能为空' });
  }
  try {
    const rows = await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tracking_no, vehicle_id || null, destination, weight_kg || 1]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
      return res.status(409).json({ error: '运单号已存在' });
    }
    throw e;
  }
});

// 分拣完成
router.post('/:id/sort', async (req, res) => {
  const rows = await query(
    `UPDATE packages SET status = 'sorted', sorted_at = NOW()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: '仅待分拣包裹可执行分拣操作' });
  res.json(rows[0]);
});

// 装车（拦截件禁止装车；尚有未结工单禁止装车）
router.post('/:id/load', async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'intercepted') {
    return res.status(409).json({ error: '该件已被拦截，禁止装车' });
  }
  if (pkg.status === 'returned') {
    return res.status(409).json({ error: '该件已退回，不属于正常待发库存' });
  }
  if (pkg.status !== 'sorted') {
    return res.status(409).json({ error: '仅已分拣包裹可装车' });
  }
  const [{ count }] = await query(
    `SELECT COUNT(*)::int AS count FROM work_orders
     WHERE package_id = $1 AND status IN ('open','processing','pending_review')`,
    [pkg.id]
  );
  if (count > 0) {
    return res.status(409).json({ error: `该包裹尚有 ${count} 张未结处置工单，禁止装车` });
  }
  const rows = await query(`UPDATE packages SET status = 'loaded' WHERE id = $1 RETURNING *`, [pkg.id]);
  res.json(rows[0]);
});

// 异常拦截：每次拦截生成一张独立处置工单（同一包裹多次异常分别留档）
router.post('/:id/intercept', async (req, res) => {
  const { abnormal_type, note } = req.body || {};
  const operator = (req.body?.operator || '').trim();
  if (!abnormal_type) return res.status(400).json({ error: '请选择异常类型' });
  if (!operator) return res.status(400).json({ error: '请填写操作人' });
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'loaded') {
    return res.status(409).json({ error: '包裹已装车，无法拦截' });
  }
  if (pkg.status === 'returned') {
    return res.status(409).json({ error: '包裹已退回，无法拦截' });
  }
  // 已拦截包裹允许再次登记异常：生成新的独立工单，各自流转、分别留档
  const [wo] = await query(
    `INSERT INTO work_orders (package_id, abnormal_type, note, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [pkg.id, abnormal_type, note || null, operator]
  );
  await query(
    `INSERT INTO work_order_events (work_order_id, action, actor, detail)
     VALUES ($1, 'create', $2, $3)`,
    [wo.id, operator, `拦截登记${note ? `：${note}` : ''}`]
  );
  const rows = await query(
    `UPDATE packages
     SET status = 'intercepted', is_abnormal = TRUE, abnormal_type = $1,
         abnormal_note = $2, intercepted_at = NOW()
     WHERE id = $3 RETURNING *`,
    [abnormal_type, note || null, pkg.id]
  );
  res.status(201).json({ package: rows[0], work_order: wo });
});

export default router;
