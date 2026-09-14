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

// 距现在多少分钟，如 "12分钟前"
export const fmtAgo = (t) => {
  if (!t) return '—';
  const min = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  return `${h}小时${min % 60 ? `${min % 60}分` : ''}前`;
};
