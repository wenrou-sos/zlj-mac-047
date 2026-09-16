// 包裹路由：查询、分拣、装车、异常拦截/解除
import { Router } from 'express';
import { query } from '../db.js';
import { requirePerm } from '../auth.js';
import { audit } from '../audit.js';

const router = Router();

// 包裹列表（分页，支持状态/目的地/异常/车辆/单号筛选）
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
    `SELECT p.*, v.plate_no, v.route_code
     FROM packages p LEFT JOIN vehicles v ON v.id = p.vehicle_id
     ${where}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
});

// 新增包裹（到件登记）—— 需分拣权限
router.post('/', requirePerm('package:create'), async (req, res) => {
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
    await audit(req, 'package.create', {
      targetType: 'package', targetId: rows[0].id,
      after: { tracking_no, destination, weight_kg: weight_kg || 1, vehicle_id: vehicle_id || null },
    });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
      return res.status(409).json({ error: '运单号已存在' });
    }
    throw e;
  }
});

// 分拣完成 —— 需分拣权限
router.post('/:id/sort', requirePerm('package:sort'), async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status !== 'pending') {
    return res.status(409).json({ error: '仅待分拣包裹可执行分拣操作' });
  }
  const rows = await query(
    `UPDATE packages SET status = 'sorted', sorted_at = NOW() WHERE id = $1 RETURNING *`,
    [pkg.id]
  );
  await audit(req, 'package.sort', {
    targetType: 'package', targetId: pkg.id,
    before: { status: pkg.status },
    after: { status: 'sorted' },
    extra: { tracking_no: pkg.tracking_no },
  });
  res.json(rows[0]);
});

// 装车（拦截件禁止装车）—— 需分拣权限
router.post('/:id/load', requirePerm('package:load'), async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'intercepted') {
    return res.status(409).json({ error: '该件已被拦截，禁止装车' });
  }
  if (pkg.status !== 'sorted') {
    return res.status(409).json({ error: '仅已分拣包裹可装车' });
  }
  const rows = await query(`UPDATE packages SET status = 'loaded' WHERE id = $1 RETURNING *`, [pkg.id]);
  await audit(req, 'package.load', {
    targetType: 'package', targetId: pkg.id,
    before: { status: pkg.status },
    after: { status: 'loaded' },
    extra: { tracking_no: pkg.tracking_no },
  });
  res.json(rows[0]);
});

// 异常拦截 —— 需异常处理权限
router.post('/:id/intercept', requirePerm('package:intercept'), async (req, res) => {
  const { abnormal_type, note } = req.body || {};
  if (!abnormal_type) return res.status(400).json({ error: '请选择异常类型' });
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'loaded') {
    return res.status(409).json({ error: '包裹已装车，无法拦截' });
  }
  if (pkg.status === 'intercepted') {
    return res.status(409).json({ error: '包裹已处于拦截状态' });
  }
  const rows = await query(
    `UPDATE packages
     SET status = 'intercepted', is_abnormal = TRUE, abnormal_type = $1,
         abnormal_note = $2, intercepted_at = NOW()
     WHERE id = $3 RETURNING *`,
    [abnormal_type, note || null, pkg.id]
  );
  await audit(req, 'package.intercept', {
    targetType: 'package', targetId: pkg.id,
    before: { status: pkg.status },
    after: { status: 'intercepted', abnormal_type, note: note || null },
    extra: { tracking_no: pkg.tracking_no },
  });
  res.json(rows[0]);
});

// 解除拦截（回到待分拣；若已分拣过则回到已分拣）—— 需异常处理权限
router.post('/:id/release', requirePerm('package:release'), async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status !== 'intercepted') {
    return res.status(409).json({ error: '包裹未处于拦截状态' });
  }
  const backTo = pkg.sorted_at ? 'sorted' : 'pending';
  const rows = await query(
    `UPDATE packages
     SET status = $1, is_abnormal = FALSE, intercept_released_at = NOW()
     WHERE id = $2 RETURNING *`,
    [backTo, pkg.id]
  );
  await audit(req, 'package.release', {
    targetType: 'package', targetId: pkg.id,
    before: { status: pkg.status, abnormal_type: pkg.abnormal_type },
    after: { status: backTo },
    extra: { tracking_no: pkg.tracking_no },
  });
  res.json(rows[0]);
});

export default router;
