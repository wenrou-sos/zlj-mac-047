// 展示辅助：状态字典、时间格式化
export const VEHICLE_STATUS = {
  expected:  { label: '待到车', color: '#64748b', bg: '#f1f5f9' },
  arrived:   { label: '已到车', color: '#1d4ed8', bg: '#dbeafe' },
  unloading: { label: '卸车中', color: '#b45309', bg: '#fef3c7' },
  unloaded:  { label: '待分拣', color: '#c2410c', bg: '#ffedd5' },
  sorting:   { label: '分拣中', color: '#7c3aed', bg: '#ede9fe' },
  sorted:    { label: '待发车', color: '#0f766e', bg: '#ccfbf1' },
  departed:  { label: '已发车', color: '#15803d', bg: '#dcfce7' },
};

export const PACKAGE_STATUS = {
  pending:     { label: '待分拣', color: '#b45309', bg: '#fef3c7' },
  sorted:      { label: '已分拣', color: '#7c3aed', bg: '#ede9fe' },
  loaded:      { label: '已装车', color: '#15803d', bg: '#dcfce7' },
  intercepted: { label: '已拦截', color: '#b91c1c', bg: '#fee2e2' },
};

export const ABNORMAL_TYPES = {
  damaged: '外包装破损',
  wrong_route: '错分线路',
  overweight: '超重超限',
  prohibited: '疑似违禁品',
  address_issue: '地址信息异常',
};

export const fmtTime = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const fmtDateTime = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(t)}`;
};

// 带年份的完整日期时间（交接单跨天追溯用）
export const fmtFull = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(t)}`;
};

// 作业日 + 班次
export const fmtShift = (workDate, name) => `${(workDate || '').slice(5).replace('-', '/')} ${name}`;

// 班次交接
export const HANDOVER_STATUS = {
  draft:     { label: '草稿',   color: '#64748b', bg: '#f1f5f9' },
  pending:   { label: '待签收', color: '#b45309', bg: '#fef3c7' },
  signed:    { label: '已签收', color: '#15803d', bg: '#dcfce7' },
  cancelled: { label: '已取消', color: '#94a3b8', bg: '#f1f5f9' },
};

export const HANDOVER_ITEM_STATUS = {
  pending:  { label: '待接收', color: '#64748b', bg: '#f1f5f9' },
  accepted: { label: '已接收', color: '#15803d', bg: '#dcfce7' },
  returned: { label: '已退回', color: '#b91c1c', bg: '#fee2e2' },
  resolved: { label: '作业已完成', color: '#0f766e', bg: '#ccfbf1' },
};

export const HANDOVER_ITEM_TYPES = {
  vehicle:   { label: '未发车车辆', color: '#1d4ed8', bg: '#dbeafe' },
  package:   { label: '待处理包裹', color: '#b45309', bg: '#fef3c7' },
  intercept: { label: '拦截件',     color: '#b91c1c', bg: '#fee2e2' },
  alert:     { label: '超时事项',   color: '#c2410c', bg: '#ffedd5' },
  note:      { label: '补充事项',   color: '#7c3aed', bg: '#ede9fe' },
};

// 距现在多少分钟，如 "12分钟前"
// 相对时间：过去显示 "12分钟前"，未来显示 "35分钟后"
export const fmtAgo = (t) => {
  if (!t) return '—';
  const diff = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  const abs = Math.abs(diff);
  const text =
    abs < 1 ? '不到1分钟'
    : abs < 60 ? `${abs}分钟`
    : `${Math.floor(abs / 60)}小时${abs % 60 ? `${abs % 60}分` : ''}`;
  return diff >= 0 ? `${text}前` : `${text}后`;
};
