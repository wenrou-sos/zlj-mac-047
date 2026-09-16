// 预警事件路由：待办、认领、处理记录、主管升级、恢复台账
import { Router } from 'express';
import { query, transaction } from '../db.js';
import { reconcileAlerts } from '../alerts.js';
import { getSettings, STAGE_LABEL } from '../helpers.js';

const router = Router();

// 规范化事件 id；非整数返回 null（调用方按 404 处理）
const numericId = (req) => {
  const n = Number(req.params.id);
  return Number.isInteger(n) ? n : null;
};

// 操作人身份：前端通过 X-User-Name 头传递当前登录人（允许百分号编码）
function readUserName(req, fallback = null) {
  let raw = String(req.get('x-user-name') || fallback || '').trim();
  if (!raw) return null;
  if (raw.includes('%')) {
    try { raw = decodeURIComponent(raw).trim(); } catch { /* 保留原值 */ }
  }
  return raw.slice(0, 50) || null;
}
function actorOf(req) {
  return readUserName(req, req.body?.name);
}

const SELECT_SQL = `
  SELECT e.*,
    v.plate_no, v.route_code, v.driver_name,
    v.status AS vehicle_status, v.arrived_at, v.unload_end_at,
    v.sort_end_at, v.planned_departure, v.departed_at
  FROM alert_events e
  JOIN vehicles v ON v.id = e.vehicle_id`;

function stageStart(ev) {
  if (ev.stage === 'unload') return ev.arrived_at;
  if (ev.stage === 'sort') return ev.unload_end_at;
  return ev.planned_departure; // departure
}

// 附加实时字段（已用时、当前级别、描述、响应截止等），事件本身字段不被改写
function decorate(rows, now, settings) {
  return rows.map((ev) => {
    const start = stageStart(ev);
    const elapsedMin = start ? Math.max(0, (now - new Date(start)) / 60_000) : 0;
    const threshold = Number(ev.threshold_min);
    const level = ev.stage === 'departure' ? 'overdue' : elapsedMin > threshold ? 'overdue' : 'warn';
    const rule = ev.rule_snapshot || {};
    const responseMin = rule.response_timeout_min ?? settings.response_timeout_min;
    return {
      ...ev,
      stage_label: STAGE_LABEL[ev.stage],
      level, // 实时级别（warn/overdue），随刷新重算
      elapsed_min: Math.round(elapsedMin),
      message: ev.stage === 'departure'
        ? `已超过计划发车时间 ${Math.round(elapsedMin)} 分钟`
        : level === 'overdue'
          ? `${STAGE_LABEL[ev.stage]}已超时 ${Math.round(elapsedMin - threshold)} 分钟`
          : `${STAGE_LABEL[ev.stage]}即将超时（已用时 ${Math.round(elapsedMin)}/${threshold} 分钟）`,
      response_due_at: new Date(new Date(ev.first_triggered_at).getTime() + responseMin * 60_000),
    };
  });
}

// GET /api/alerts?scope=active|mine|unassigned|escalated|resolved|history|all
router.get('/', async (req, res) => {
  await reconcileAlerts(); // 读前对账，幂等；不产生重复事件
  const now = new Date();
  const settings = await getSettings();
  const user = readUserName(req) || (req.query.user ? String(req.query.user).trim().slice(0, 50) : '');
  const scope = req.query.scope || 'active';

  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  switch (scope) {
    case 'mine':
      if (user) { conds.push("e.status <> 'recovered'"); add('e.assigned_to = ?', user); }
      else conds.push('FALSE');
      break;
    case 'unassigned':
      conds.push("e.status <> 'recovered'"); conds.push('e.assigned_to IS NULL');
      break;
    case 'escalated': conds.push("e.status = 'escalated'"); break;
    case 'resolved':  conds.push("e.status = 'resolved'"); break;
    case 'history':   conds.push("e.status = 'recovered'"); break;
    case 'all': break;
    default: conds.push("e.status <> 'recovered'");
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const order = scope === 'history' || scope === 'all'
    ? `ORDER BY COALESCE(e.recovered_at, e.first_triggered_at) DESC, e.id DESC`
    : `ORDER BY CASE e.status WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
              e.first_triggered_at ASC, e.id ASC`;

  const rows = await query(`${SELECT_SQL} ${where} ${order}`, params);
  res.json(decorate(rows, now, settings));
});

// 待办计数（导航徽标 / 总览卡片用）
router.get('/todo-summary', async (req, res) => {
  await reconcileAlerts();
  const user = readUserName(req) || (req.query.user ? String(req.query.user).trim().slice(0, 50) : '');
  const [r] = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status <> 'recovered')::int                              AS active,
       COUNT(*) FILTER (WHERE status = 'open')::int                                    AS open,
       COUNT(*) FILTER (WHERE status = 'escalated')::int                               AS escalated,
       COUNT(*) FILTER (WHERE status = 'resolved')::int                                AS resolved_waiting,
       COUNT(*) FILTER (WHERE status <> 'recovered' AND assigned_to IS NULL)::int      AS unassigned,
       COUNT(*) FILTER (WHERE status <> 'recovered' AND assigned_to = $1)::int         AS mine,
       COUNT(*) FILTER (WHERE overdue_at IS NOT NULL AND status <> 'recovered')::int   AS overdue,
       COUNT(*) FILTER (WHERE status = 'recovered')::int                               AS recovered
     FROM alert_events`,
    [user || null]
  );
  res.json(r);
});

// 事件详情：含处理记录时间线与规则快照
router.get('/:id', async (req, res) => {
  const id = numericId(req);
  if (id === null) return res.status(404).json({ error: '预警事件不存在' });
  const [ev] = await query(`${SELECT_SQL} WHERE e.id = $1`, [id]);
  if (!ev) return res.status(404).json({ error: '预警事件不存在' });
  const logs = await query(
    `SELECT id, action, actor, note, created_at FROM alert_event_logs WHERE event_id = $1 ORDER BY id ASC`,
    [id]
  );
  const settings = await getSettings();
  const [decorated] = decorate([ev], new Date(), settings);
  res.json({ ...decorated, logs });
});

// 认领预警（同时确认响应；幂等：同一人重复认领不重复记台账）
router.post('/:id/claim', async (req, res) => {
  const actor = actorOf(req);
  if (!actor) return res.status(400).json({ error: '缺少处理人身份' });
  const id = numericId(req);
  if (id === null) return res.status(404).json({ error: '预警事件不存在' });
  const [ev] = await query('SELECT * FROM alert_events WHERE id = $1', [id]);
  if (!ev) return res.status(404).json({ error: '预警事件不存在' });
  if (ev.status === 'recovered') return res.status(409).json({ error: '事件已恢复关闭，无需认领' });
  if (ev.assigned_to && ev.assigned_to !== actor) {
    return res.status(409).json({ error: `该预警已由 ${ev.assigned_to} 认领` });
  }
  // 已由本人认领：幂等返回，不重复写台账
  if (ev.assigned_to === actor) return res.json({ ok: true, claimed: false });

  await transaction(async (tx) => {
    await tx.query(
      `UPDATE alert_events
         SET assigned_to = $2, acknowledged_at = NOW()
       WHERE id = $1`,
      [id, actor]
    );
    await tx.query(
      `INSERT INTO alert_event_logs (event_id, action, actor, note) VALUES ($1,'claim',$2,'认领并确认处理')`,
      [id, actor]
    );
  });
  res.json({ ok: true, claimed: true });
});

// 添加处理记录（不改状态；已确认但未恢复的事件持续保留在待办中）
router.post('/:id/notes', async (req, res) => {
  const actor = actorOf(req);
  if (!actor) return res.status(400).json({ error: '缺少处理人身份' });
  const note0 = String(req.body?.note || '').trim();
  if (!note0) return res.status(400).json({ error: '处理记录内容不能为空' });
  const id = numericId(req);
  if (id === null) return res.status(404).json({ error: '预警事件不存在' });
  const [ev] = await query('SELECT status FROM alert_events WHERE id = $1', [id]);
  if (!ev) return res.status(404).json({ error: '预警事件不存在' });
  if (ev.status === 'recovered') return res.status(409).json({ error: '事件已恢复关闭' });

  await query(
    `INSERT INTO alert_event_logs (event_id, action, actor, note) VALUES ($1,'comment',$2,$3)`,
    [id, actor, note0.slice(0, 1000)]
  );
  // 留过言即视为已知会；若尚未认领，自动记到该处理人名下并确认
  await query(
    `UPDATE alert_events
       SET assigned_to = COALESCE(assigned_to, $2),
           acknowledged_at = COALESCE(acknowledged_at, NOW())
     WHERE id = $1`,
    [id, actor]
  );
  res.json({ ok: true });
});

// 标记处理完成（车辆尚未恢复：进入「已处理·待恢复」，仍留在待办直到真正恢复）
router.post('/:id/resolve', async (req, res) => {
  const actor = actorOf(req);
  if (!actor) return res.status(400).json({ error: '缺少处理人身份' });
  const note = String(req.body?.note || '').trim();
  const id = numericId(req);
  if (id === null) return res.status(404).json({ error: '预警事件不存在' });
  const [ev] = await query('SELECT * FROM alert_events WHERE id = $1', [id]);
  if (!ev) return res.status(404).json({ error: '预警事件不存在' });
  if (ev.status === 'recovered') return res.status(409).json({ error: '事件已恢复关闭' });

  await transaction(async (tx) => {
    await tx.query(
      `UPDATE alert_events
         SET status = 'resolved', resolved_at = NOW(), resolved_by = $2,
             assigned_to = COALESCE(assigned_to, $2),
             acknowledged_at = COALESCE(acknowledged_at, NOW()),
             close_note = $3
       WHERE id = $1`,
      [id, actor, note || null]
    );
    await tx.query(
      `INSERT INTO alert_event_logs (event_id, action, actor, note)
       VALUES ($1,'resolve',$2,$3)`,
      [id, actor, note ? `已处理：${note}` : '已处理，等待车辆恢复']
    );
  });
  // 标记后立即对账：若此刻条件已消失则直接恢复关闭
  await reconcileAlerts({ actor, vehicleId: ev.vehicle_id });
  const [updated] = await query('SELECT status, recovered_at FROM alert_events WHERE id = $1', [id]);
  res.json({ ok: true, status: updated.status, recovered_at: updated.recovered_at });
});

// 主管改派
router.post('/:id/reassign', async (req, res) => {
  const actor = actorOf(req);
  if (!actor) return res.status(400).json({ error: '缺少操作人身份' });
  const to = String(req.body?.to || '').trim().slice(0, 50);
  if (!to) return res.status(400).json({ error: '请填写改派对象' });
  const id = numericId(req);
  if (id === null) return res.status(404).json({ error: '预警事件不存在' });
  const [ev] = await query('SELECT id, status, vehicle_id FROM alert_events WHERE id = $1', [id]);
  if (!ev) return res.status(404).json({ error: '预警事件不存在' });
  if (ev.status === 'recovered') return res.status(409).json({ error: '事件已恢复关闭' });

  await transaction(async (tx) => {
    await tx.query(`UPDATE alert_events SET assigned_to = $2 WHERE id = $1`, [id, to]);
    await tx.query(
      `INSERT INTO alert_event_logs (event_id, action, actor, note)
       VALUES ($1,'reassign',$2,$3)`,
      [id, actor, `改派给 ${to}`]
    );
  });
  res.json({ ok: true });
});

export default router;
