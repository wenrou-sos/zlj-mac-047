// 车辆班次路由：到车、卸车、分拣、发车全流程
import { Router } from 'express';
import { query } from '../db.js';
import { VEHICLE_FLOW } from '../helpers.js';

const router = Router();

// 车辆列表（含包裹统计）
router.get('/', async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE v.status = $1';
  }
  const rows = await query(
    `SELECT v.*,
       COUNT(p.id)::int                                          AS package_count,
       COUNT(p.id) FILTER (WHERE p.status = 'pending')::int      AS pending_count,
       COUNT(p.id) FILTER (WHERE p.status = 'sorted')::int       AS sorted_count,
       COUNT(p.id) FILTER (WHERE p.status = 'loaded')::int       AS loaded_count,
       COUNT(p.id) FILTER (WHERE p.status = 'intercepted')::int  AS intercepted_count
     FROM vehicles v
     LEFT JOIN packages p ON p.vehicle_id = v.id
     ${where}
     GROUP BY v.id
     ORDER BY v.created_at DESC`,
    params
  );
  res.json(rows);
});

// 新增车辆（到车预报）
router.post('/', async (req, res) => {
  const { plate_no, route_code, driver_name, planned_arrival, planned_departure } = req.body || {};
  if (!plate_no || !route_code) {
    return res.status(400).json({ error: '车牌号和线路不能为空' });
  }
  const rows = await query(
    `INSERT INTO vehicles (plate_no, route_code, driver_name, planned_arrival, planned_departure)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [plate_no, route_code, driver_name || null, planned_arrival || null, planned_departure || null]
  );
  res.status(201).json(rows[0]);
});

// 状态推进：到车 / 开始卸车 / 完成卸车 / 开始分拣 / 完成分拣 / 发车
router.post('/:id/action/:action', async (req, res) => {
  const { id } = req.params;
  const { action } = req.params;
  const flow = VEHICLE_FLOW[action];
  if (!flow) return res.status(400).json({ error: `未知操作: ${action}` });

  const [vehicle] = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
  if (!vehicle) return res.status(404).json({ error: '车辆不存在' });
  if (!flow.from.includes(vehicle.status)) {
    return res.status(409).json({ error: `当前状态不允许「${flow.label}」操作` });
  }

  const rows = await query(
    `UPDATE vehicles SET status = $1, ${flow.set} = NOW() WHERE id = $2 RETURNING *`,
    [flow.to, id]
  );

  // 完成分拣：车上所有待分拣包裹自动标记为已分拣（拦截件除外）
  if (action === 'sort-end') {
    await query(
      `UPDATE packages SET status = 'sorted', sorted_at = NOW()
       WHERE vehicle_id = $1 AND status = 'pending'`,
      [id]
    );
  }
  // 发车：已分拣包裹自动装车；拦截件留在场地，不随车发走
  if (action === 'depart') {
    await query(
      `UPDATE packages SET status = 'loaded' WHERE vehicle_id = $1 AND status = 'sorted'`,
      [id]
    );
  }

  res.json(rows[0]);
});

// 删除未到车的预报班次
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const [vehicle] = await query('SELECT status FROM vehicles WHERE id = $1', [id]);
  if (!vehicle) return res.status(404).json({ error: '车辆不存在' });
  if (vehicle.status !== 'expected') {
    return res.status(409).json({ error: '仅待到车状态的班次可以删除' });
  }
  await query('DELETE FROM vehicles WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
