// 共享业务逻辑：超时预警计算
import { query } from './db.js';

export async function getSettings() {
  const rows = await query('SELECT key, value::float AS value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    unload_timeout_min: s.unload_timeout_min ?? 30,
    sort_timeout_min: s.sort_timeout_min ?? 60,
    warn_ratio: s.warn_ratio ?? 0.8,
    cutoff_lead_min: s.cutoff_lead_min ?? 30,
  };
}

/**
 * 班次截单时间：计划发车前 cutoff_min（缺省取全局 cutoff_lead_min）。
 * 无计划发车时间则无截单限制。
 */
export async function computeCutoff(vehicle) {
  if (!vehicle.planned_departure) return null;
  let lead = vehicle.cutoff_min;
  if (lead == null) {
    const s = await getSettings();
    lead = s.cutoff_lead_min;
  }
  return new Date(new Date(vehicle.planned_departure).getTime() - lead * 60_000);
}

const STAGE_LABEL = { unload: '卸车', sort: '分拣', departure: '发车' };

/**
 * 对车辆列表计算超时预警
 * 规则：
 *  - 卸车：到车后 unload_timeout_min 分钟内未完成卸车
 *  - 分拣：卸车完成后 sort_timeout_min 分钟内未完成分拣
 *  - 发车：超过计划发车时间仍未发车
 *  达到时限 warn_ratio（默认80%）触发黄色预警，超过时限为红色超时
 */
export function computeAlerts(vehicles, settings, now = new Date()) {
  const alerts = [];
  const { unload_timeout_min, sort_timeout_min, warn_ratio } = settings;

  const push = (v, stage, elapsedMin, limitMin) => {
    const overdue = elapsedMin > limitMin;
    const warn = !overdue && elapsedMin >= limitMin * warn_ratio;
    if (!overdue && !warn) return;
    alerts.push({
      vehicle_id: v.id,
      plate_no: v.plate_no,
      route_code: v.route_code,
      stage,
      stage_label: STAGE_LABEL[stage],
      level: overdue ? 'overdue' : 'warn',
      elapsed_min: Math.round(elapsedMin),
      limit_min: limitMin,
      message: overdue
        ? `${STAGE_LABEL[stage]}已超时 ${Math.round(elapsedMin - limitMin)} 分钟`
        : `${STAGE_LABEL[stage]}即将超时（已用时 ${Math.round(elapsedMin)}/${limitMin} 分钟）`,
    });
  };

  for (const v of vehicles) {
    if (v.status === 'departed' || v.status === 'expected') continue;

    // 卸车环节：已到车但卸车未完成
    if (!v.unload_end_at && v.arrived_at) {
      push(v, 'unload', (now - new Date(v.arrived_at)) / 60_000, unload_timeout_min);
    }
    // 分拣环节：卸车完成但分拣未完成
    if (v.unload_end_at && !v.sort_end_at) {
      push(v, 'sort', (now - new Date(v.unload_end_at)) / 60_000, sort_timeout_min);
    }
    // 发车环节：超过计划发车时间
    if (v.planned_departure && !v.departed_at) {
      const elapsed = (now - new Date(v.planned_departure)) / 60_000;
      if (elapsed > 0) {
        alerts.push({
          vehicle_id: v.id,
          plate_no: v.plate_no,
          route_code: v.route_code,
          stage: 'departure',
          stage_label: STAGE_LABEL.departure,
          level: 'overdue',
          elapsed_min: Math.round(elapsed),
          limit_min: 0,
          message: `已超过计划发车时间 ${Math.round(elapsed)} 分钟`,
        });
      }
    }
  }
  // 超时优先，按超时时长降序
  return alerts.sort((a, b) => (a.level === b.level ? b.elapsed_min - a.elapsed_min : a.level === 'overdue' ? -1 : 1));
}

// 车辆状态机定义
export const VEHICLE_FLOW = {
  arrive:         { from: ['expected'],  to: 'arrived',   set: 'arrived_at',       label: '到车' },
  'unload-start': { from: ['arrived'],   to: 'unloading', set: 'unload_start_at',  label: '开始卸车' },
  'unload-end':   { from: ['unloading'], to: 'unloaded',  set: 'unload_end_at',    label: '完成卸车' },
  'sort-start':   { from: ['unloaded'],  to: 'sorting',   set: 'sort_start_at',    label: '开始分拣' },
  'sort-end':     { from: ['sorting'],   to: 'sorted',    set: 'sort_end_at',      label: '完成分拣' },
  depart:         { from: ['sorted'],    to: 'departed',  set: 'departed_at',      label: '发车' },
};

export const VEHICLE_STATUS_LABEL = {
  expected: '待到车', arrived: '已到车', unloading: '卸车中',
  unloaded: '待分拣', sorting: '分拣中', sorted: '待发车', departed: '已发车',
};

export const PACKAGE_STATUS_LABEL = {
  pending: '待分拣', sorted: '已分拣', loaded: '已装车', intercepted: '已拦截',
};

export const ABNORMAL_TYPE_LABEL = {
  damaged: '外包装破损', wrong_route: '错分线路', overweight: '超重超限',
  prohibited: '疑似违禁品', address_issue: '地址信息异常',
};

// ── 出港配载单 ────────────────────────────────────────────────────────
export const PLAN_STATUS_LABEL = {
  draft: '配载中', sealed: '已封车', departed: '已发车', cancelled: '已撤单',
};

// 生效中（未发车但占用在场包裹）的配载单状态
export const ACTIVE_PLAN_STATES = ['draft', 'sealed'];

// 在场可配载包裹：已分拣、未被生效单占用（is_active 由 DB 触发器维护）、目的地可达、未过截单
export async function findCandidates(vehicle, { destination, limitKg, now = new Date() } = {}) {
  const params = [];
  const conds = [
    "p.status = 'sorted'",
    'NOT EXISTS (SELECT 1 FROM load_plan_items lpi2 '
      + "WHERE lpi2.package_id = p.id AND lpi2.is_active)",
  ];
  if (destination) {
    params.push(destination);
    conds.push(`p.destination = $${params.length}`);
  }
  if (vehicle.destinations && vehicle.destinations.length) {
    params.push(vehicle.destinations);
    conds.push(`p.destination = ANY($${params.length}::text[])`);
  }
  // 截单语义：当前时间超过班次截单点后，不再向该班次配载（件赶不上发车）；
  // 件只要在发车前完成分拣即可，越早分拣越优先
  const cutoff = await computeCutoff(vehicle);
  if (cutoff && now > cutoff) {
    return [];
  }
  // 先进先出：先分拣、先到件优先
  const rows = await query(
    `SELECT p.* FROM packages p
     WHERE ${conds.join(' AND ')}
     ORDER BY p.sorted_at ASC NULLS LAST, p.created_at ASC, p.id ASC`,
    params
  );
  // 按剩余容量贪心装入；装不下的留待下一班
  const picked = [];
  let used = 0;
  for (const p of rows) {
    const w = Number(p.weight_kg);
    if (limitKg != null && used + w > Number(limitKg)) continue; // 装不下，留待下一班
    picked.push(p);
    used += w;
  }
  return picked;
}
