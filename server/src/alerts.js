// 预警事件引擎
// 设计要点：
//  1. 预警是「事件」而非瞬时计算结果：一次超时生成一行 alert_events，
//     全程记录首次触发、认领、确认、升级、处理、恢复时间。
//  2. reconcileAlerts 是幂等的对账：条件仍存在且已有事件 → 不重复生成；
//     新进入预警/超时 → 新建事件；车辆环节实际完成（恢复）→ 关闭本次事件；
//     再次超时 → 因唯一索引允许重新插入，自动另起一次新事件。
//  3. 所有计时依据全部落库（时间戳、规则快照、due_at），不依赖进程内存，
//     服务重启后下一次对账/升级扫描照常继续计时。
//  4. 响应期 / 超时宽限到期由 checkEscalations 自动升级进主管待办；
//     已确认（acknowledged）或已升级但未恢复的事件状态不会被回退，待办不消失。
import { query, transaction } from './db.js';
import { getSettings, STAGE_LABEL } from './helpers.js';

// ── 实时预警条件计算（只用于对账时判断"要不要新建事件"）──
function currentConditions(vehicles, settings, now) {
  const { unload_timeout_min, sort_timeout_min, warn_ratio } = settings;
  const out = [];

  for (const v of vehicles) {
    if (v.status === 'departed' || v.status === 'expected') continue;

    // 卸车环节：已到车但卸车未完成
    if (!v.unload_end_at && v.arrived_at) {
      const start = new Date(v.arrived_at);
      const elapsed = (now - start) / 60_000;
      if (elapsed >= unload_timeout_min * warn_ratio) {
        out.push(makeCond(v.id, 'unload', start, unload_timeout_min, elapsed, now, warn_ratio));
      }
    }
    // 分拣环节：卸车完成但分拣未完成
    if (v.unload_end_at && !v.sort_end_at) {
      const start = new Date(v.unload_end_at);
      const elapsed = (now - start) / 60_000;
      if (elapsed >= sort_timeout_min * warn_ratio) {
        out.push(makeCond(v.id, 'sort', start, sort_timeout_min, elapsed, now, warn_ratio));
      }
    }
    // 发车环节：超过计划发车时间仍未发车（无预警区间，计划时刻一到即为超时）
    if (v.planned_departure && !v.departed_at) {
      const due = new Date(v.planned_departure);
      const elapsed = (now - due) / 60_000;
      if (elapsed > 0) {
        out.push({
          vehicle_id: v.id,
          stage: 'departure',
          level: 'overdue',
          threshold_min: 0,
          due_at: due,
          warn_at: due,
          overdue_at: due,
          elapsed_min: elapsed,
        });
      }
    }
  }
  return out;
}

function makeCond(vehicleId, stage, startAt, limitMin, elapsed, now, warnRatio) {
  const dueAt = new Date(startAt.getTime() + limitMin * 60_000);
  return {
    vehicle_id: vehicleId,
    stage,
    level: elapsed > limitMin ? 'overdue' : 'warn',
    threshold_min: limitMin,
    due_at: dueAt,
    // 级别跨越时间，用于初始化事件的 warn_at / overdue_at
    warn_at: new Date(startAt.getTime() + limitMin * warnRatio * 60_000),
    overdue_at: elapsed > limitMin ? dueAt : null,
    elapsed_min: elapsed,
  };
}

async function addLog(tx, eventId, action, actor = null, note = null) {
  await tx.query(
    `INSERT INTO alert_event_logs (event_id, action, actor, note) VALUES ($1,$2,$3,$4)`,
    [eventId, action, actor, note]
  );
}

// 单实例串行锁：对账 / 升级 / 人工操作共用一把锁，避免交叉写入
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.then(() => {}, () => {}); // 失败不冲掉后续调用
  return run;
}

/**
 * 事件对账（幂等）。
 * @param {object} opts
 * @param {string} opts.actor     触发对账的操作人（如打卡人），仅写入自动台账
 * @param {number} opts.vehicleId 仅需立刻感知某辆车时传入；省略则全量对账
 */
export function reconcileAlerts(opts = {}) {
  return withLock(() => reconcileAlertsLocked(opts));
}

async function reconcileAlertsLocked({ actor = 'system', vehicleId = null } = {}) {
  const now = new Date();
  const settings = await getSettings();

  // 1. 在场车辆当前命中的预警条件（按当前规则；仅决定是否新建）
  const vehicles = await query(
    `SELECT * FROM vehicles
     WHERE status NOT IN ('departed','expected') ${vehicleId ? 'AND id = $1' : ''}`,
    vehicleId ? [vehicleId] : []
  );
  const conditions = currentConditions(vehicles, settings, now);

  // 2. 全部未关闭事件（带车辆实时字段）。事件只能由「车辆真正恢复」关闭，
  //    不能因刷新时按新阈值算不到条件而消失——那只是规则调整，不代表现场恢复。
  const openEvents = await query(
    `SELECT e.*,
            v.status AS vehicle_status,
            v.unload_end_at AS v_unload_end_at,
            v.sort_end_at   AS v_sort_end_at,
            v.departed_at   AS v_departed_at
       FROM alert_events e
       JOIN vehicles v ON v.id = e.vehicle_id
      WHERE e.status <> 'recovered' ${vehicleId ? 'AND e.vehicle_id = $1' : ''}`,
    vehicleId ? [vehicleId] : []
  );
  const openKeys = new Set(openEvents.map((e) => `${e.vehicle_id}:${e.stage}`));

  await transaction(async (tx) => {
    // 3. 逐一对账已有事件
    for (const ev of openEvents) {
      const isRecovered = ev.vehicle_status === 'departed'
        || (ev.stage === 'unload' && ev.v_unload_end_at)
        || (ev.stage === 'sort' && ev.v_sort_end_at)
        || (ev.stage === 'departure' && ev.v_departed_at);

      if (isRecovered) {
        // 环节实际完成 = 车辆恢复 → 结束本次事件
        await tx.query(
          `UPDATE alert_events
             SET status = 'recovered', recovered_at = $2,
                 close_note = COALESCE(close_note, $3), last_seen_at = $2
           WHERE id = $1 AND status <> 'recovered'`,
          [ev.id, now, `${STAGE_LABEL[ev.stage]}环节已完成，预警自动恢复`]
        );
        await addLog(tx, ev.id, 'recovered', actor, '条件消除，车辆恢复，事件关闭');
        continue;
      }

      // 现场未恢复：刷新 last_seen；按事件冻结的 due_at 补 warn→overdue 跨越，
      // 与当前阈值解耦，事后调整规则不改变本事件的超时判定
      const patch = ['last_seen_at = $2'];
      const params = [ev.id, now];
      let crossedToOverdue = false;
      if (!ev.overdue_at && ev.due_at && now >= new Date(ev.due_at)) {
        patch.push('overdue_at = $3', "initial_level = 'overdue'");
        params.push(ev.due_at);
        crossedToOverdue = true;
      }
      if (!ev.warn_at) {
        patch.push('warn_at = $' + (params.length + 1));
        params.push(ev.first_triggered_at);
      }
      await tx.query(`UPDATE alert_events SET ${patch.join(', ')} WHERE id = $1`, params);
      if (crossedToOverdue) {
        await addLog(tx, ev.id, 'overdue', 'system',
          `已超过${STAGE_LABEL[ev.stage]}时限（${Number(ev.threshold_min)} 分钟），升级为红色超时`);
      }
    }

    // 4. 命中条件但没有未关闭事件 → 新建（openKeys + 唯一索引双重防重，刷新不重复生成）
    for (const c of conditions) {
      if (openKeys.has(`${c.vehicle_id}:${c.stage}`)) continue;
      const snapshot = {
        unload_timeout_min: settings.unload_timeout_min,
        sort_timeout_min: settings.sort_timeout_min,
        warn_ratio: settings.warn_ratio,
        response_timeout_min: settings.response_timeout_min,
        escalation_grace_min: settings.escalation_grace_min,
      };
      const rows = await tx.query(
        `INSERT INTO alert_events
           (vehicle_id, stage, initial_level, status, rule_snapshot, threshold_min, due_at,
            first_triggered_at, warn_at, overdue_at, last_seen_at)
         VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [c.vehicle_id, c.stage, c.level, JSON.stringify(snapshot), c.threshold_min, c.due_at,
         now, c.warn_at || now, c.overdue_at, now]
      );
      if (rows[0]) {
        await addLog(tx, rows[0].id, 'trigger', 'system',
          c.level === 'overdue'
            ? `${STAGE_LABEL[c.stage]}超时首次触发（红色），规则快照已冻结`
            : `${STAGE_LABEL[c.stage]}预警首次触发（黄色，达时限 ${Math.round(settings.warn_ratio * 100)}%）`);
        if (c.level === 'overdue') {
          // 发车超时没有预警区间，第一次出现即为超时，补一条 overdue 记录
          await addLog(tx, rows[0].id, 'overdue', 'system',
            c.stage === 'departure' ? '已超过计划发车时间' : '已超过时限，红色超时');
        }
      }
    }
  });

  // 5. 对账后立即检查一次响应期（同锁内串行，不并发）
  await checkEscalationsLocked(now, settings);
}

/**
 * 响应期/宽限期扫描：超过响应期限自动进入主管待办。
 * - open 且无人确认：首次触发后 response_timeout_min（取事件快照）到期 → 升级
 * - open 已确认但红色超时持续：overdue_at + escalation_grace_min（取事件快照）到期 → 升级
 * - resolved（已处理待恢复）不再自动升级，但只要未恢复就仍留在待办中
 * 纯时间戳比较，重启服务后立即能对历史事件继续计时。
 */
export function checkEscalations() {
  return withLock(() => checkEscalationsLocked());
}

async function checkEscalationsLocked(now = new Date(), settings = null) {
  settings = settings || await getSettings();

  const candidates = await query(`SELECT e.* FROM alert_events e WHERE e.status = 'open'`);
  for (const ev of candidates) {
    // 时限以事件创建时冻结的快照为准：调整响应期限不追溯改变历史事件的承诺
    const snap = ev.rule_snapshot || {};
    const responseTimeout = Number(snap.response_timeout_min ?? settings.response_timeout_min);
    const graceMin = Number(snap.escalation_grace_min ?? settings.escalation_grace_min);

    let reason = null;
    if (!ev.acknowledged_at) {
      const deadline = new Date(ev.first_triggered_at).getTime() + responseTimeout * 60_000;
      if (now.getTime() >= deadline) {
        reason = `触发后 ${responseTimeout} 分钟内无人确认，自动升级主管`;
      }
    } else if (ev.overdue_at) {
      const deadline = new Date(ev.overdue_at).getTime() + graceMin * 60_000;
      if (now.getTime() >= deadline) {
        reason = `超时后 ${graceMin} 分钟仍未恢复，主管督办`;
      }
    }
    if (!reason) continue;

    await transaction(async (tx) => {
      const rows = await tx.query(
        `UPDATE alert_events SET status = 'escalated', escalated_at = COALESCE(escalated_at, $2),
             escalation_reason = $3
         WHERE id = $1 AND status = 'open' RETURNING id`,
        [ev.id, now, reason]
      );
      if (rows[0]) await addLog(tx, ev.id, 'escalated', 'system', reason);
    });
  }
}
