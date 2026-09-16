// 统计路由：总览、积压统计、异常统计、超时规则配置（含规则调整台账）
import { Router } from 'express';
import { query, transaction } from '../db.js';
import { getSettings } from '../helpers.js';
import { reconcileAlerts } from '../alerts.js';

const router = Router();

const SETTING_META = {
  unload_timeout_min:    { label: '卸车时限（分钟）' },
  sort_timeout_min:      { label: '分拣时限（分钟）' },
  warn_ratio:            { label: '预警阈值比例' },
  response_timeout_min:  { label: '响应期限（分钟）' },
  escalation_grace_min:  { label: '超时升级宽限（分钟）' },
};

// 操作人（允许百分号编码，前端 api 层统一 encodeURIComponent）
function readUserName(req, fallback = null) {
  let raw = String(req.get('x-user-name') || fallback || '').trim();
  if (!raw) return null;
  if (raw.includes('%')) {
    try { raw = decodeURIComponent(raw).trim(); } catch { /* 保留原值 */ }
  }
  return raw.slice(0, 50) || null;
}
function actorOf(req) {
  return readUserName(req, req.body?.changed_by);
}

// 仪表盘总览（预警口径来自 alert_events：可认领、可追溯，而非瞬时计算）
router.get('/overview', async (req, res) => {
  await reconcileAlerts(); // 读前对账：新超时建事件、恢复关事件，刷新本身不重复生成

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
       COUNT(*) FILTER (WHERE status = 'intercepted')::int  AS intercepted
     FROM packages`
  );
  const [alertStats] = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status <> 'recovered')::int                            AS alert_count,
       COUNT(*) FILTER (WHERE overdue_at IS NOT NULL AND status <> 'recovered')::int AS overdue_count,
       COUNT(*) FILTER (WHERE status = 'escalated')::int                             AS escalated_count,
       COUNT(*) FILTER (WHERE status = 'resolved')::int                              AS resolved_waiting,
       COUNT(*) FILTER (WHERE status <> 'recovered' AND assigned_to IS NULL)::int    AS unassigned_count
     FROM alert_events`
  );

  res.json({ vehicles: vehicleStats, packages: pkgStats, alerts: alertStats });
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

// 超时规则配置（当前值）
router.get('/settings', async (req, res) => {
  res.json(await getSettings());
});

// 规则调整历史（阈值可追溯：每个事件按 rule_snapshot 关联到当时采用的规则版本）
router.get('/settings/history', async (req, res) => {
  const rows = await query(
    `SELECT id, key, old_value::float AS old_value, new_value::float AS new_value,
            changed_by, created_at
     FROM settings_history ORDER BY id DESC LIMIT 100`
  );
  res.json(rows.map((r) => ({ ...r, label: SETTING_META[r.key]?.label || r.key })));
});

// 修改规则：写入 settings 并在 settings_history 留痕
// 说明：调整只对之后新触发的事件生效；进行中的事件保留创建时的 rule_snapshot 不变，
// 因此「当时按哪条规则触发/判定」始终可追溯。
router.put('/settings', async (req, res) => {
  const actor = actorOf(req);
  const updates = {};
  for (const key of Object.keys(SETTING_META)) {
    const val = req.body?.[key];
    if (val === undefined || val === null || Number.isNaN(Number(val))) continue;
    updates[key] = Number(val);
  }
  // 基本校验
  if (updates.warn_ratio !== undefined && (updates.warn_ratio <= 0 || updates.warn_ratio > 1)) {
    return res.status(400).json({ error: '预警阈值比例需在 0~1 之间' });
  }
  for (const k of ['unload_timeout_min', 'sort_timeout_min', 'response_timeout_min', 'escalation_grace_min']) {
    if (updates[k] !== undefined && updates[k] <= 0) {
      return res.status(400).json({ error: `${SETTING_META[k].label}必须大于 0` });
    }
  }

  await transaction(async (tx) => {
    for (const [key, val] of Object.entries(updates)) {
      const oldRows = await tx.query('SELECT value FROM settings WHERE key = $1', [key]);
      const oldVal = oldRows[0] ? Number(oldRows[0].value) : null;
      if (oldVal === val) continue; // 值未变化，不留痕
      await tx.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, val]
      );
      await tx.query(
        `INSERT INTO settings_history (key, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [key, oldVal, val, actor]
      );
    }
  });

  // 阈值调整后立即对账一次（新规则对当前现场的影响：新事件按新规则触发）
  await reconcileAlerts({ actor: actor || 'system' });
  res.json(await getSettings());
});

export default router;
