// 班次交接核心业务：快照汇集、交接期间变化检测、后续去向追溯
//
// 设计要点：
//  - 建单时把现场（车辆/包裹/拦截件/超时）拍成快照写入 shift_handover_items.snapshot，
//    之后现场作业继续推进，但快照永不变更；签收后连同逐项接收结果一并成为历史记录。
//  - 交接期间事项被完成（发车、装车、解除拦截、超时消除）时，GET 时自动判定为 resolved，
//    只提示变化，不再需要接班人重复接收，也不会在下一张交接单里重复移交。
//  - 未接收（退回）事项责任仍留在交出班次：下一张交接单的 owner 取自最近一次签收结果。
import { query } from './db.js';
import { getSettings, computeAlerts, VEHICLE_STATUS_LABEL, PACKAGE_STATUS_LABEL, ABNORMAL_TYPE_LABEL } from './helpers.js';

const TITLE_STAGE_LABEL = { unload: '卸车', sort: '分拣', departure: '发车' };

// ───────────────────────────── 现场快照汇集 ─────────────────────────────

// 汇集当前在场全部未完成作业：未发车车辆、待处理包裹、拦截件、超时事项
// 返回 [{ item_type, item_key, ref_id, title, subtitle, detail, snapshot }]
export async function buildLiveItems(now = new Date()) {
  const items = [];

  // 1) 未发车车辆（含待到车预报；已发车离场不再移交）
  const vehicles = await query(
    `SELECT v.*,
       COUNT(p.id)::int                                         AS package_count,
       COUNT(p.id) FILTER (WHERE p.status = 'pending')::int     AS pending_count,
       COUNT(p.id) FILTER (WHERE p.status = 'sorted')::int      AS sorted_count,
       COUNT(p.id) FILTER (WHERE p.status = 'intercepted')::int AS intercepted_count
     FROM vehicles v
     LEFT JOIN packages p ON p.vehicle_id = v.id
     WHERE v.status <> 'departed'
     GROUP BY v.id
     ORDER BY v.created_at DESC`
  );

  // 2) 待处理包裹（待分拣 / 已分拣未装车）
  const packages = await query(
    `SELECT p.*, v.plate_no, v.route_code
     FROM packages p LEFT JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.status IN ('pending','sorted')
     ORDER BY p.created_at DESC`
  );

  // 3) 拦截件（处于拦截状态、未装车的异常件）
  const intercepts = await query(
    `SELECT p.*, v.plate_no, v.route_code
     FROM packages p LEFT JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.status = 'intercepted'
     ORDER BY p.intercepted_at DESC`
  );

  // 4) 超时事项（复用统一的预警规则，与总览/车辆页口径一致）
  const settings = await getSettings();
  const alertVehicles = vehicles.filter((v) => v.status !== 'expected');
  const alerts = computeAlerts(alertVehicles, settings, now);

  for (const v of vehicles) {
    const isExpected = v.status === 'expected';
    items.push({
      item_type: 'vehicle',
      item_key: `veh:${v.id}`,
      ref_id: v.id,
      title: `${v.plate_no} · ${v.route_code}`,
      subtitle: isExpected ? '待到车预报' : VEHICLE_STATUS_LABEL[v.status] || v.status,
      detail: isExpected
        ? `计划到车 ${v.planned_arrival ? new Date(v.planned_arrival).toISOString() : '未定'}`
        : `车上包裹 ${v.package_count} 件（待分拣 ${v.pending_count} / 已分拣 ${v.sorted_count}${v.intercepted_count ? ` / 拦截 ${v.intercepted_count}` : ''}）`,
      snapshot: v,
    });
  }

  for (const p of packages) {
    items.push({
      item_type: 'package',
      item_key: `pkg:${p.id}`,
      ref_id: p.id,
      title: p.tracking_no,
      subtitle: `${PACKAGE_STATUS_LABEL[p.status]} · ${p.destination}`,
      detail: p.plate_no ? `所属车辆 ${p.plate_no}（${p.route_code}）` : '尚未分配车辆',
      snapshot: p,
    });
  }

  for (const p of intercepts) {
    items.push({
      item_type: 'intercept',
      item_key: `itc:${p.id}`,
      ref_id: p.id,
      title: p.tracking_no,
      subtitle: `${ABNORMAL_TYPE_LABEL[p.abnormal_type] || p.abnormal_type} · ${p.destination}`,
      detail: p.abnormal_note || '无异常备注',
      snapshot: p,
    });
  }

  for (const a of alerts) {
    items.push({
      item_type: 'alert',
      item_key: `alt:${a.vehicle_id}:${a.stage}`,
      ref_id: a.vehicle_id,
      title: `${a.plate_no} · ${TITLE_STAGE_LABEL[a.stage] || a.stage_label}${a.stage === 'departure' ? '超时' : a.level === 'overdue' ? '作业超时' : '即将超时'}`,
      subtitle: a.level === 'overdue' ? '已超时' : '预警',
      detail: a.message,
      snapshot: a,
    });
  }

  return items;
}

// 查询每个事项当前的责任归属：取该 item_key 最近一次"已签收"交接单的决定。
// accepted → 接班人班次；returned / resolved → 原交出班次。
// 从未进过交接单的事项没有 owner（调用方按当前交出班次处理）。
export async function getLatestOwnerMap() {
  const rows = await query(
    `SELECT DISTINCT ON (i.item_key)
       i.item_key, i.status, h.shift_id, h.to_shift_id, h.signed_at
     FROM shift_handover_items i
     JOIN shift_handovers h ON h.id = i.handover_id
     WHERE h.status = 'signed'
     ORDER BY i.item_key, h.signed_at DESC, i.id DESC`
  );
  const map = {};
  for (const r of rows) {
    map[r.item_key] = r.status === 'accepted' ? r.to_shift_id : r.shift_id;
  }
  return map;
}

// 上一张交接单里同一事项的 item id（再次转交追溯链）
export async function getSourceItemIds(keys) {
  if (!keys.length) return {};
  const rows = await query(
    `SELECT DISTINCT ON (i.item_key) i.id AS source_item_id, i.item_key
     FROM shift_handover_items i
     JOIN shift_handovers h ON h.id = i.handover_id
     WHERE h.status = 'signed' AND i.item_key = ANY($1::text[])
     ORDER BY i.item_key, h.signed_at DESC, i.id DESC`,
    [keys]
  );
  return Object.fromEntries(rows.map((r) => [r.item_key, r.source_item_id]));
}

// ───────────────────────────── 交接期间变化检测 ─────────────────────────────

// 对照现场实时数据，判定一条事项是否在交接期间被完成/发生变化
// 返回 { state, changeLabel }
//   state = 'unchanged' 无变化（继续等待接收）
//          | 'changed'   有变化但仍需移交（如预警升级为超时）
//          | 'resolved'  作业已完成（自动确认，不再移交）
export async function evaluateItem(item, now = new Date()) {
  const live = await fetchLiveEntity(item.item_type, item.item_key);

  switch (item.item_type) {
    case 'vehicle': {
      if (!live) return { state: 'resolved', changeLabel: '车辆预报已删除' };
      if (live.status === 'departed') {
        return { state: 'resolved', changeLabel: '已发车离场' };
      }
      if (live.status !== item.snapshot.status) {
        return { state: 'changed', changeLabel: `状态已变化：${VEHICLE_STATUS_LABEL[item.snapshot.status]} → ${VEHICLE_STATUS_LABEL[live.status]}` };
      }
      return { state: 'unchanged' };
    }
    case 'package': {
      if (!live) return { state: 'unchanged' };
      if (live.status === 'loaded') return { state: 'resolved', changeLabel: '已装车发运' };
      if (live.status === 'intercepted') {
        return { state: 'changed', changeLabel: '交接期间已被拦截，转作拦截件处理' };
      }
      if (live.status !== item.snapshot.status) {
        return { state: 'changed', changeLabel: `状态已变化：${PACKAGE_STATUS_LABEL[item.snapshot.status]} → ${PACKAGE_STATUS_LABEL[live.status]}` };
      }
      return { state: 'unchanged' };
    }
    case 'intercept': {
      if (!live) return { state: 'unchanged' };
      if (live.status !== 'intercepted') {
        return {
          state: 'resolved',
          changeLabel: live.status === 'loaded' ? '拦截已解除并已装车发运' : '拦截已解除，恢复作业',
        };
      }
      return { state: 'unchanged' };
    }
    case 'alert': {
      // 超时事项：重新跑一遍同一套预警规则
      const vid = item.ref_id;
      const [v] = await query(`SELECT * FROM vehicles WHERE id = $1`, [vid]);
      if (!v || v.status === 'departed') {
        return { state: 'resolved', changeLabel: !v ? '车辆记录已删除' : '已发车离场，超时事项消除' };
      }
      const settings = await getSettings();
      const [current] = computeAlerts([v], settings, now).filter(
        (a) => a.stage === item.snapshot.stage
      );
      if (!current) return { state: 'resolved', changeLabel: '作业已推进，超时事项消除' };
      if (current.level === 'overdue' && item.snapshot.level !== 'overdue') {
        return { state: 'changed', changeLabel: current.message }; // 预警升级为超时
      }
      return { state: 'unchanged' };
    }
    case 'note':
    default:
      return { state: 'unchanged' };
  }
}

async function fetchLiveEntity(type, key) {
  const id = Number(key.split(':')[1]);
  if (!id) return null;
  if (type === 'vehicle') {
    const rows = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
    return rows[0] || null;
  }
  // package / intercept 都是包裹
  const rows = await query('SELECT * FROM packages WHERE id = $1', [id]);
  return rows[0] || null;
}

// 对一张未签收交接单：自动确认交接期间被完成的事项（幂等）
// 只处理 pending（未决定）事项；已接收/已退回的决定保持不变
export async function syncResolved(handoverId, now = new Date()) {
  const items = await query(
    `SELECT * FROM shift_handover_items WHERE handover_id = $1 AND status = 'pending'`,
    [handoverId]
  );
  let count = 0;
  for (const item of items) {
    if (item.item_type === 'note') continue;
    const { state, changeLabel } = await evaluateItem(item, now);
    if (state === 'resolved') {
      await query(
        `UPDATE shift_handover_items
         SET status = 'resolved', resolved_at = NOW(), resolved_note = $1
         WHERE id = $2 AND status = 'pending'`,
        [changeLabel, item.id]
      );
      count += 1;
    }
  }
  return count;
}

// ───────────────────────────── 签收后去向追溯 ─────────────────────────────

// 为已签收交接单的事项计算"后续处理去向"
export async function buildFollowups(items, now = new Date()) {
  const followupMap = {};
  for (const item of items) {
    if (item.item_type === 'note') {
      followupMap[item.id] = { state: item.status, label: '口头补充事项' };
      continue;
    }
    if (item.status === 'resolved') {
      followupMap[item.id] = { state: 'resolved', label: item.resolved_note || '交接期间已完成' };
      continue;
    }
    // accepted / returned：看现场现状
    const { state, changeLabel } = await evaluateItem(item, now);
    if (state === 'resolved') {
      followupMap[item.id] = { state: 'done', label: changeLabel };
    } else if (state === 'changed') {
      followupMap[item.id] = { state: 'changed', label: changeLabel };
    } else {
      followupMap[item.id] = { state: 'open', label: '仍在处理中' };
    }
  }

  // 再次转交链：该事项之后又出现在哪张已签收交接单里
  const ids = items.map((i) => i.id);
  if (ids.length) {
    const chains = await query(
      `SELECT i2.source_item_id AS item_id, i2.status,
              h.id AS handover_id, h.handover_no, h.signed_at,
              sf.name AS from_name, sf.work_date AS from_date,
              st.name AS to_name, st.work_date AS to_date
       FROM shift_handover_items i2
       JOIN shift_handovers h ON h.id = i2.handover_id
       JOIN shifts sf ON sf.id = h.shift_id
       JOIN shifts st ON st.id = h.to_shift_id
       WHERE h.status = 'signed' AND i2.source_item_id = ANY($1::int[])
       ORDER BY h.signed_at`,
      [ids]
    );
    for (const c of chains) {
      const existing = followupMap[c.item_id];
      const decision =
        c.status === 'accepted' ? `由${c.to_name}接收`
        : c.status === 'returned' ? `被${c.to_name}退回，仍归${c.from_name}`
        : c.status === 'resolved' ? '交接期间完成'
        : c.status;
      const link = { handover_no: c.handover_no, handover_id: c.handover_id, signed_at: c.signed_at, decision };
      if (existing) {
        existing.chain = [...(existing.chain || []), link];
      }
    }
  }
  return followupMap;
}

// 生成交接单号 JD-YYYYMMDD-序号（按交出班次作业日）
// PGlite 的 DATE 列可能返回 Date 对象，统一规范成 YYYY-MM-DD 文本，避免被按 Date.toString 解析
export async function nextHandoverNo(workDate) {
  const raw = workDate instanceof Date ? workDate.toISOString() : String(workDate);
  const day = raw.slice(0, 10);
  const ymd = day.replace(/-/g, '');
  const [{ count }] = await query(
    `SELECT COUNT(*)::int AS count FROM shift_handovers h
     JOIN shifts s ON s.id = h.shift_id WHERE s.work_date = $1::date`,
    [day]
  );
  return `JD-${ymd}-${String(count + 1).padStart(3, '0')}`;
}
