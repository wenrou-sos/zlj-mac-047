import { useSyncExternalStore } from 'react';
import { queueStore } from './scanQueue.js';

export function useQueue() {
  return useSyncExternalStore(queueStore.subscribe, queueStore.getSnapshot, queueStore.getSnapshot);
}

export const SCAN_OP = {
  arrive: { label: '到件扫描', color: '#1d4ed8', bg: '#dbeafe' },
  sort:   { label: '分拣扫描', color: '#7c3aed', bg: '#ede9fe' },
  load:   { label: '装车扫描', color: '#0f766e', bg: '#ccfbf1' },
};

export const SCAN_STATE = {
  pending:   { label: '待补传', color: '#b45309', bg: '#fef3c7' },
  conflict:  { label: '冲突暂停', color: '#b91c1c', bg: '#fee2e2' },
  applied:   { label: '已记账', color: '#15803d', bg: '#dcfce7' },
  error:     { label: '补传失败', color: '#b91c1c', bg: '#fee2e2' },
};

export const CONFLICT_CODE = {
  already_arrived: '运单已到件',
  pkg_intercepted: '包裹已被拦截',
  vehicle_departed: '班次已发车',
  vehicle_mismatch: '装车班次不一致',
  state_advanced: '服务器状态已推进',
  state_not_ready: '服务器上前置作业未完成',
  pkg_not_found: '运单不存在',
};

export const RESOLUTION_LABEL = {
  discarded: '已放弃（以服务器为准）',
  kept: '暂留待人工处理',
  retried: '已调整，重新补扫',
};

// Date 对象 → datetime-local 输入框值（本地时区）
export function toLocalInput(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
