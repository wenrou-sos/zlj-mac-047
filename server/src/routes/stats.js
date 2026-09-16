// 统计路由：总览、超时预警、积压统计、异常统计、超时规则配置
import { Router } from 'express';
import { query } from '../db.js';
import { getSettings, computeAlerts } from '../helpers.js';

const router = Router();

// 仪表盘总览
router.get('/overview', async (req, res) => {
  const [vehicleStats] = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status != 'departed')::int AS active_vehicles,
       COUNT(*) FILTER (WHERE status = 'expected')::int  AS expected_vehicles,
       COUNT(*) FILTER (WHERE status = 'departed')::int  AS departed_vehicles,
       COUNT(*)::int                                     AS total_vehicles
     FROM vehicles`
  );
  const [pkgStats] = await query(
    `SELECT
       COUNT(*)::int                                        AS total,
       COUNT(*) FILTER (WHERE status = 'pending' AND intercept_status <> 'held')::int      AS pending,
       COUNT(*) FILTER (WHERE status = 'sorted' AND intercept_status <> 'held')::int       AS sorted,
       COUNT(*) FILTER (WHERE status IN ('loaded','departed'))::int                         AS loaded,
       COUNT(*) FILTER (WHERE intercept_status = 'held')::int  AS intercepted
     FROM packages`
  );
  const vehicles = await query(`SELECT * FROM vehicles WHERE status NOT IN ('departed','expected')`);
  const alerts = computeAlerts(vehicles, await getSettings());

  res.json({
    vehicles: vehicleStats,
    packages: pkgStats,
    alert_count: alerts.length,
    overdue_count: alerts.filter((a) => a.level === 'overdue').length,
  });
});

// 超时预警列表
router.get('/alerts', async (req, res) => {
  const vehicles = await query(`SELECT * FROM vehicles WHERE status NOT IN ('departed','expected')`);
  res.json(computeAlerts(vehicles, await getSettings()));
});

// 积压统计：按状态 / 按目的地 / 按在途车辆
router.get('/stats/backlog', async (req, res) => {
  // 积压按作业生命周期统计；拦截中单独保留，不把“处置状态”和“位置/作业状态”混成一类
  const byStatus = await query(
    `SELECT
       CASE WHEN intercept_status = 'held' THEN 'held' ELSE status END AS status,
       COUNT(*)::int AS count, COALESCE(SUM(weight_kg),0)::float AS weight
     FROM packages
     WHERE status IN ('pending','sorted','lost') OR intercept_status = 'held'
     GROUP BY 1`
  );
  const byDestination = await query(
    `SELECT destination,
       COUNT(*) FILTER (WHERE status IN ('pending','sorted') AND intercept_status <> 'held')::int AS count,
       COUNT(*) FILTER (WHERE intercept_status = 'held')::int AS held_count
     FROM packages
     WHERE status IN ('pending','sorted') OR intercept_status = 'held'
     GROUP BY destination
     HAVING COUNT(*) FILTER (WHERE status IN ('pending','sorted')) > 0
        OR COUNT(*) FILTER (WHERE intercept_status = 'held') > 0
     ORDER BY count DESC`
  );
  const byLocation = await query(
    `SELECT l.id, l.code, l.name, l.loc_type, l.capacity,
       COUNT(p.id)::int AS occupied,
       COUNT(p.id) FILTER (WHERE p.status = 'pending' AND p.intercept_status <> 'held')::int AS pending,
       COUNT(p.id) FILTER (WHERE p.status = 'sorted' AND p.intercept_status <> 'held')::int AS sorted,
       COUNT(p.id) FILTER (WHERE p.intercept_status = 'held')::int AS held
     FROM locations l
     LEFT JOIN packages p ON p.current_location_id = l.id
     WHERE l.loc_type IN ('receiving','sorting','storage','intercept') AND l.is_active = TRUE
     GROUP BY l.id
     HAVING COUNT(p.id) > 0
     ORDER BY (
       COUNT(p.id) FILTER (WHERE p.status IN ('pending','sorted') AND p.intercept_status <> 'held')
     ) DESC, l.code`
  );
  const byVehicle = await query(
    `SELECT v.id, v.plate_no, v.route_code, v.status,
            COUNT(p.id) FILTER (WHERE p.status = 'pending' AND p.intercept_status <> 'held')::int AS pending,
            COUNT(p.id) FILTER (WHERE p.status = 'sorted' AND p.intercept_status <> 'held')::int  AS sorted,
            COUNT(p.id) FILTER (WHERE p.intercept_status = 'held')::int AS held
     FROM vehicles v
     JOIN packages p ON p.vehicle_id = v.id
     WHERE v.status NOT IN ('departed','expected')
     GROUP BY v.id
     HAVING COUNT(p.id) FILTER (WHERE p.status IN ('pending','sorted')) > 0
        OR COUNT(p.id) FILTER (WHERE p.intercept_status = 'held') > 0
     ORDER BY pending DESC`
  );
  // 近24小时按小时的到件/分拣趋势
  const trend = await query(
    `WITH hours AS (
       SELECT generate_series(0, 23) AS h
     )
     SELECT h,
       (SELECT COUNT(*)::int FROM packages
         WHERE created_at >= NOW() - (h + 1) * INTERVAL '1 hour'
           AND created_at <  NOW() - h * INTERVAL '1 hour') AS arrived,
       (SELECT COUNT(*)::int FROM packages
         WHERE sorted_at >= NOW() - (h + 1) * INTERVAL '1 hour'
           AND sorted_at <  NOW() - h * INTERVAL '1 hour') AS sorted
     FROM hours ORDER BY h DESC`
  );
  res.json({ byStatus, byDestination, byLocation, byVehicle, trend });
});

// 异常件统计
// 台账口径：intercepted_at IS NOT NULL 表示"曾被拦截过的异常件"（含已解除），
// 不能用 is_abnormal（解除拦截时会置 FALSE，导致已处理记录从台账消失、与累计数对不上）
router.get('/stats/abnormal', async (req, res) => {
  const byType = await query(
    `SELECT abnormal_type, COUNT(*)::int AS count
     FROM packages WHERE intercepted_at IS NOT NULL
     GROUP BY abnormal_type ORDER BY count DESC`
  );
  const recent = await query(
    `SELECT p.*, v.plate_no, v.route_code
     FROM packages p LEFT JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.intercepted_at IS NOT NULL
     ORDER BY p.intercepted_at DESC LIMIT 20`
  );
  const [summary] = await query(
    `SELECT
       COUNT(*) FILTER (WHERE intercepted_at IS NOT NULL)::int         AS total_abnormal,
       COUNT(*) FILTER (WHERE intercept_status = 'held')::int            AS intercepted,
       COUNT(*) FILTER (WHERE intercept_released_at IS NOT NULL)::int AS released
     FROM packages`
  );
  res.json({ byType, recent, summary });
});

// 超时规则配置
router.get('/settings', async (req, res) => {
  res.json(await getSettings());
});

router.put('/settings', async (req, res) => {
  const { unload_timeout_min, sort_timeout_min, warn_ratio } = req.body || {};
  const entries = { unload_timeout_min, sort_timeout_min, warn_ratio };
  for (const [key, val] of Object.entries(entries)) {
    if (val === undefined || val === null || Number.isNaN(Number(val))) continue;
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, Number(val)]
    );
  }
  res.json(await getSettings());
});

export default router;
