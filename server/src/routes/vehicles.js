// 车辆班次路由：到车、卸车、分拣、发车全流程
import { Router } from 'express';
import { query } from '../db.js';
import { VEHICLE_FLOW } from '../helpers.js';
import { departVehicle, HttpError } from '../dispatch.js';

const router = Router();

// 车辆列表（含进港包裹统计与出港配载进度）
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE v.status = $1';
    }
    const rows = await query(
      `SELECT v.*,
       -- 进港件进度（vehicle_id = 进港来源班次，始终保留）；与出港单是两个一对多关系，必须 DISTINCT 防相乘
       COUNT(DISTINCT p.id)::int                                          AS package_count,
       COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'pending')::int      AS pending_count,
       COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'sorted')::int       AS sorted_count,
       COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'loaded')::int       AS loaded_count,
       COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'intercepted')::int  AS intercepted_count,
       -- 出港配载进度（本班次作为承运班次的生效单）
       COUNT(DISTINCT lp.id) FILTER (WHERE lp.status IN ('draft','sealed'))::int AS active_plan_count,
       COUNT(DISTINCT lp.id) FILTER (WHERE lp.status = 'departed')::int          AS departed_plan_count,
       COALESCE(SUM(lp_p.weight_kg) FILTER (WHERE lpi.is_active),0)::float AS planned_kg
     FROM vehicles v
     LEFT JOIN packages p ON p.vehicle_id = v.id
     LEFT JOIN load_plans lp ON lp.vehicle_id = v.id
     LEFT JOIN load_plan_items lpi ON lpi.plan_id = lp.id AND lpi.is_active
     LEFT JOIN packages lp_p ON lp_p.id = lpi.package_id
     ${where}
     GROUP BY v.id
     ORDER BY v.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// 新增车辆（到车预报，可带出港配载参数）
router.post('/', (req, res, next) => {
  (async () => {
    const {
      plate_no, route_code, driver_name, planned_arrival, planned_departure,
      capacity_kg, cutoff_min, destinations,
    } = req.body || {};
    if (!plate_no || !route_code) {
      throw new HttpError(400, '车牌号和线路不能为空');
    }
    const destArr = Array.isArray(destinations)
      ? destinations.map((s) => String(s).trim()).filter(Boolean)
      : (destinations ? String(destinations).split(/[,，\s]+/).filter(Boolean) : null);
    const rows = await query(
      `INSERT INTO vehicles
         (plate_no, route_code, driver_name, planned_arrival, planned_departure, capacity_kg, cutoff_min, destinations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        plate_no, route_code, driver_name || null, planned_arrival || null, planned_departure || null,
        capacity_kg ? Number(capacity_kg) : 8000,
        cutoff_min === '' || cutoff_min == null ? null : Number(cutoff_min),
        destArr,
      ]
    );
    res.status(201).json(rows[0]);
  })().catch(next);
});

// 状态推进：到车 / 开始卸车 / 完成卸车 / 开始分拣 / 完成分拣 / 发车
router.post('/:id/action/:action', async (req, res, next) => {
  try {
    const { id, action } = req.params;
    const flow = VEHICLE_FLOW[action];
    if (!flow) throw new HttpError(400, `未知操作: ${action}`);

    const [vehicle] = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
    if (!vehicle) throw new HttpError(404, '车辆不存在');
    if (!flow.from.includes(vehicle.status)) {
      throw new HttpError(409, `当前状态不允许「${flow.label}」操作`);
    }

    if (action === 'depart') {
      // 发车：只按本班次生效配载单锁定实际去向，进港来源为该车但已改配走的件不动
      const result = await departVehicle(id);
      return res.json({ ...result.vehicle, _loaded_count: result.loaded_count, _plan_count: result.plans.length, _cancelled_empty: result.cancelled_empty });
    }

    const rows = await query(
      `UPDATE vehicles SET status = $1, ${flow.set} = NOW() WHERE id = $2 RETURNING *`,
      [flow.to, id]
    );

    // 完成分拣：本车（进港来源）待分拣包裹自动标记为已分拣（拦截件除外）
    if (action === 'sort-end') {
      await query(
        `UPDATE packages SET status = 'sorted', sorted_at = NOW()
         WHERE vehicle_id = $1 AND status = 'pending'`,
        [id]
      );
    }

    res.json(rows[0]);
  } catch (e) { next(e); }
});

// 删除未到车的预报班次（存在配载单时禁止）
router.delete('/:id', async (req, res, next) => {
  try {
    const [vehicle] = await query('SELECT status FROM vehicles WHERE id = $1', [req.params.id]);
    if (!vehicle) throw new HttpError(404, '车辆不存在');
    if (vehicle.status !== 'expected') {
      throw new HttpError(409, '仅待到车状态的班次可以删除');
    }
    const [dep] = await query(
      `SELECT COUNT(*)::int AS c FROM load_plans WHERE vehicle_id = $1 AND status <> 'cancelled'`,
      [req.params.id]
    );
    if (dep.c > 0) throw new HttpError(409, '该班次已建立配载单，无法删除');
    await query('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
