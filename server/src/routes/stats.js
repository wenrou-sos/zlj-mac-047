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
       COUNT(*) FILTER (WHERE status = 'pending')::int      AS pending,
       COUNT(*) FILTER (WHERE status = 'sorted')::int       AS sorted,
       COUNT(*) FILTER (WHERE status = 'loaded')::int       AS loaded,
       COUNT(*) FILTER (WHERE status = 'intercepted')::int  AS intercepted,
       COUNT(*) FILTER (WHERE status = 'returned')::int     AS returned
     FROM packages`
  );
  const [woStats] = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('open','processing','pending_review'))::int AS open,
       COUNT(*) FILTER (WHERE status = 'open')::int           AS unclaimed,
       COUNT(*) FILTER (WHERE status = 'pending_review')::int AS pending_review
     FROM work_orders`
  );
  const vehicles = await query(`SELECT * FROM vehicles WHERE status NOT IN ('departed','expected')`);
  const alerts = computeAlerts(vehicles, await getSettings());

  res.json({
    vehicles: vehicleStats,
    packages: pkgStats,
    work_orders: woStats,
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
  const byStatus = await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(weight_kg),0)::float AS weight
     FROM packages WHERE status IN ('pending','sorted')
     GROUP BY status`
  );
  const byDestination = await query(
    `SELECT destination, COUNT(*)::int AS count
     FROM packages WHERE status IN ('pending','sorted')
     GROUP BY destination ORDER BY count DESC`
  );
  const byVehicle = await query(
    `SELECT v.id, v.plate_no, v.route_code, v.status,
            COUNT(p.id) FILTER (WHERE p.status = 'pending')::int AS pending,
            COUNT(p.id) FILTER (WHERE p.status = 'sorted')::int  AS sorted
     FROM vehicles v
     JOIN packages p ON p.vehicle_id = v.id
     WHERE v.status NOT IN ('departed','expected')
     GROUP BY v.id
     HAVING COUNT(p.id) FILTER (WHERE p.status IN ('pending','sorted')) > 0
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
  res.json({ byStatus, byDestination, byVehicle, trend });
});

// 异常件统计（工单口径：每次拦截一张工单，同一包裹多次异常分别计入）
router.get('/stats/abnormal', async (req, res) => {
  const byType = await query(
    `SELECT abnormal_type, COUNT(*)::int AS count
     FROM work_orders GROUP BY abnormal_type ORDER BY count DESC`
  );
  const byConclusion = await query(
    `SELECT conclusion, COUNT(*)::int AS count
     FROM work_orders WHERE status = 'closed' AND conclusion IS NOT NULL
     GROUP BY conclusion`
  );
  const recent = await query(
    `SELECT w.*, p.tracking_no, p.destination, p.status AS package_status, v.plate_no
     FROM work_orders w
     JOIN packages p ON p.id = w.package_id
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     ORDER BY w.created_at DESC LIMIT 20`
  );
  const [summary] = await query(
    `SELECT
       COUNT(*)::int                                              AS total,
       COUNT(*) FILTER (WHERE status = 'open')::int              AS unclaimed,
       COUNT(*) FILTER (WHERE status = 'processing')::int        AS processing,
       COUNT(*) FILTER (WHERE status = 'pending_review')::int    AS pending_review,
       COUNT(*) FILTER (WHERE status = 'closed')::int            AS closed,
       COALESCE(SUM(reject_count), 0)::int                       AS reject_total
     FROM work_orders`
  );
  res.json({ byType, byConclusion, recent, summary });
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
