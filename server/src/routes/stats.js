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
       COUNT(*) FILTER (WHERE p.status = 'pending')::int      AS pending,
       COUNT(*) FILTER (WHERE p.status = 'sorted')::int       AS sorted,
       COUNT(*) FILTER (WHERE p.status = 'loaded')::int       AS loaded,
       COUNT(*) FILTER (WHERE p.status = 'intercepted')::int  AS intercepted,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM load_plan_items lpi
         WHERE lpi.package_id = p.id AND lpi.is_active
       ))::int                                                AS planned
     FROM packages p`
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

// 积压统计：按状态 / 按目的地 / 按在途车辆（积压与班次进度按"实际去向"口径）
router.get('/stats/backlog', async (req, res) => {
  // 在场未发运 = pending + sorted；其中 sorted 再区分已配载（待发车）/ 未配载（留场待下一班）
  const byStatus = await query(
    `WITH occ AS (
       SELECT package_id FROM load_plan_items WHERE is_active
     )
     SELECT p.status, COUNT(*)::int AS count, COALESCE(SUM(p.weight_kg),0)::float AS weight,
            COUNT(occ.package_id)::int AS planned
     FROM packages p LEFT JOIN occ ON occ.package_id = p.id
     WHERE p.status IN ('pending','sorted')
     GROUP BY p.status`
  );
  // 按目的地：已配载随班走的不再算场地积压，单独给 planned 供前端区分
  const byDestination = await query(
    `WITH occ AS (
       SELECT package_id FROM load_plan_items WHERE is_active
     )
     SELECT p.destination,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE occ.package_id IS NOT NULL)::int AS planned,
            COUNT(*) FILTER (WHERE occ.package_id IS NULL)::int     AS unplanned
     FROM packages p LEFT JOIN occ ON occ.package_id = p.id
     WHERE p.status IN ('pending','sorted')
     GROUP BY p.destination ORDER BY unplanned DESC, count DESC`
  );
  // 在场车辆：进港来源进度（待分拣/已分拣）+ 出港配载进度（生效单件数/重量）
  const byVehicle = await query(
    `SELECT v.id, v.plate_no, v.route_code, v.status,
            COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'pending')::int AS pending,
            COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'sorted')::int  AS sorted,
            COUNT(DISTINCT lp.id) FILTER (WHERE lp.status IN ('draft','sealed'))::int AS active_plans,
            COUNT(DISTINCT lpi.id) FILTER (WHERE lpi.is_active)::int AS planned_items,
            COALESCE(SUM(lp_p.weight_kg) FILTER (WHERE lpi.is_active),0)::float AS planned_kg,
            v.capacity_kg::float AS capacity_kg
     FROM vehicles v
     LEFT JOIN packages p ON p.vehicle_id = v.id
     LEFT JOIN load_plans lp ON lp.vehicle_id = v.id
     LEFT JOIN load_plan_items lpi ON lpi.plan_id = lp.id AND lpi.is_active
     LEFT JOIN packages lp_p ON lp_p.id = lpi.package_id
     WHERE v.status NOT IN ('departed','expected')
     GROUP BY v.id
     HAVING COUNT(DISTINCT p.id) FILTER (WHERE p.status IN ('pending','sorted')) > 0
         OR COUNT(DISTINCT lpi.id) FILTER (WHERE lpi.is_active) > 0
     ORDER BY pending DESC, planned_items DESC`
  );
  // 近24小时按小时的到件/发车趋势（发车按实际去向 loaded_at）
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
           AND sorted_at <  NOW() - h * INTERVAL '1 hour') AS sorted,
       (SELECT COUNT(*)::int FROM packages
         WHERE loaded_at >= NOW() - (h + 1) * INTERVAL '1 hour'
           AND loaded_at <  NOW() - h * INTERVAL '1 hour') AS loaded
     FROM hours ORDER BY h DESC`
  );
  res.json({ byStatus, byDestination, byVehicle, trend });
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
       COUNT(*) FILTER (WHERE status = 'intercepted')::int            AS intercepted,
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
