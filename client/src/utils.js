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
  departed:    { label: '已离场', color: '#047857', bg: '#a7f3d0' },
  lost:        { label: '盘亏', color: '#6b21a8', bg: '#f3e8ff' },
};

export const INTERCEPT_STATUS = {
  none:     { label: '未拦截', color: '#64748b', bg: '#f1f5f9' },
  held:     { label: '拦截中', color: '#b91c1c', bg: '#fee2e2' },
  released: { label: '已解除', color: '#15803d', bg: '#dcfce7' },
};

export const LOCATION_TYPES = {
  receiving: { label: '到件暂存', color: '#1d4ed8', bg: '#dbeafe' },
  sorting:   { label: '分拣区', color: '#7c3aed', bg: '#ede9fe' },
  storage:   { label: '场区库位', color: '#0f766e', bg: '#ccfbf1' },
  intercept: { label: '拦截隔离', color: '#b91c1c', bg: '#fee2e2' },
  vehicle:   { label: '车辆库位', color: '#15803d', bg: '#dcfce7' },
  lost:      { label: '盘亏库位', color: '#6b21a8', bg: '#f3e8ff' },
};

export const STOCKTAKE_STATUS = {
  counting:  { label: '盘点中', color: '#b45309', bg: '#fef3c7' },
  reviewing: { label: '待复核', color: '#1d4ed8', bg: '#dbeafe' },
  adjusted:  { label: '已调整', color: '#15803d', bg: '#dcfce7' },
  cancelled: { label: '已取消', color: '#64748b', bg: '#f1f5f9' },
};

export const DIFF_TYPES = {
  surplus:   { label: '盘盈', color: '#15803d', bg: '#dcfce7' },
  shortage:  { label: '盘亏', color: '#b91c1c', bg: '#fee2e2' },
  misplaced: { label: '错位', color: '#b45309', bg: '#fef3c7' },
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
