// 共享业务逻辑：超时预警计算
import { query } from './db.js';

export async function getSettings() {
  const rows = await query('SELECT key, value::float AS value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    unload_timeout_min: s.unload_timeout_min ?? 30,
    sort_timeout_min: s.sort_timeout_min ?? 60,
    warn_ratio: s.warn_ratio ?? 0.8,
  };
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

// ── 班次交接 ──
export const SHIFT_PRESETS = [
  { shift_code: 'day',    name: '白班' },
  { shift_code: 'swing',  name: '中班' },
  { shift_code: 'night',  name: '夜班' },
];

export const SHIFT_CODE_LABEL = Object.fromEntries(
  SHIFT_PRESETS.map((s) => [s.shift_code, s.name]).concat([['custom', '自定义']])
);

export const HANDOVER_STATUS_LABEL = {
  draft: '草稿', pending: '待签收', signed: '已签收', cancelled: '已取消',
};

export const HANDOVER_ITEM_STATUS_LABEL = {
  pending: '待接收', accepted: '已接收', returned: '已退回', resolved: '作业已完成',
};

// 交接事项类型：未发车车辆 / 待处理包裹 / 拦截件 / 超时事项 / 口头补充
export const HANDOVER_ITEM_TYPE_LABEL = {
  vehicle: '未发车车辆',
  package: '待处理包裹',
  intercept: '拦截件',
  alert: '超时事项',
  note: '补充事项',
};
