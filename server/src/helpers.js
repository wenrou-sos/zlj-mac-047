// 共享业务逻辑：超时规则、状态机定义
import { query } from './db.js';

export async function getSettings() {
  const rows = await query('SELECT key, value::float AS value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    unload_timeout_min: s.unload_timeout_min ?? 30,   // 到车后完成卸车时限
    sort_timeout_min: s.sort_timeout_min ?? 60,       // 卸完后完成分拣时限
    warn_ratio: s.warn_ratio ?? 0.8,                  // 达到时限比例触发黄色预警
    response_timeout_min: s.response_timeout_min ?? 15, // 响应期限：无人确认自动升级主管
    escalation_grace_min: s.escalation_grace_min ?? 15, // 红色超时后未恢复宽限
  };
}

export const STAGE_LABEL = { unload: '卸车', sort: '分拣', departure: '发车' };

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
