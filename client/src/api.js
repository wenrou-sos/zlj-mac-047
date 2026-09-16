// API 封装

// 当前操作人：无登录系统，用本地存储的姓名标识认领/处理/规则调整的操作人
const USER_KEY = 'express_hub_user';
export const currentUser = () => localStorage.getItem(USER_KEY) || '';
export const setCurrentUser = (name) => {
  localStorage.setItem(USER_KEY, (name || '').trim());
};
export const ensureUser = () => {
  let u = currentUser();
  if (!u) {
    u = (prompt('请输入你的姓名（用于认领和处理记录）') || '').trim();
    if (u) setCurrentUser(u);
  }
  return u;
};

const request = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(currentUser() ? { 'X-User-Name': encodeURIComponent(currentUser()) } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
};

export const api = {
  // 总览
  overview: () => request('/api/overview'),
  // 预警事件：scope=active|unassigned|mine|escalated|resolved|history|all
  alerts: (scope, user) => {
    const qs = new URLSearchParams();
    if (scope) qs.set('scope', scope);
    if (user) qs.set('user', user);
    const s = qs.toString();
    return request(`/api/alerts${s ? `?${s}` : ''}`);
  },
  alertDetail: (id) => request(`/api/alerts/${id}`),
  todoSummary: (user) => request(`/api/alerts/todo-summary${user ? `?user=${encodeURIComponent(user)}` : ''}`),
  claimAlert: (id) => request(`/api/alerts/${id}/claim`, { method: 'POST', body: '{}' }),
  addAlertNote: (id, note) => request(`/api/alerts/${id}/notes`, { method: 'POST', body: JSON.stringify({ note }) }),
  resolveAlert: (id, note) => request(`/api/alerts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ note }) }),
  reassignAlert: (id, to) => request(`/api/alerts/${id}/reassign`, { method: 'POST', body: JSON.stringify({ to }) }),
  // 车辆
  vehicles: (status) => request(`/api/vehicles${status ? `?status=${status}` : ''}`),
  createVehicle: (body) => request('/api/vehicles', { method: 'POST', body: JSON.stringify(body) }),
  vehicleAction: (id, action) => request(`/api/vehicles/${id}/action/${action}`, { method: 'POST' }),
  deleteVehicle: (id) => request(`/api/vehicles/${id}`, { method: 'DELETE' }),
  // 包裹
  packages: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/api/packages${qs ? `?${qs}` : ''}`);
  },
  createPackage: (body) => request('/api/packages', { method: 'POST', body: JSON.stringify(body) }),
  sortPackage: (id) => request(`/api/packages/${id}/sort`, { method: 'POST' }),
  loadPackage: (id) => request(`/api/packages/${id}/load`, { method: 'POST' }),
  interceptPackage: (id, body) => request(`/api/packages/${id}/intercept`, { method: 'POST', body: JSON.stringify(body) }),
  releasePackage: (id) => request(`/api/packages/${id}/release`, { method: 'POST' }),
  // 统计
  backlog: () => request('/api/stats/backlog'),
  abnormalStats: () => request('/api/stats/abnormal'),
  // 设置 / 规则版本台账
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  settingsHistory: () => request('/api/settings/history'),
};
