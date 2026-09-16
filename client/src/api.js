// API 封装：自动携带登录令牌；401 清理会话回到登录页，403 触发权限刷新
const TOKEN_KEY = 'eh_token';

let unauthorizedHandler = null;
let forbiddenHandler = null;

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
export const onUnauthorized = (fn) => { unauthorizedHandler = fn; };
export const onForbidden = (fn) => { forbiddenHandler = fn; };

const request = async (url, options = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/auth/login')) {
    // 会话失效/被撤销/账号停用：清理本地令牌，回到登录页
    setToken(null);
    unauthorizedHandler?.();
  }
  if (res.status === 403) forbiddenHandler?.(); // 权限可能已被管理员调整，刷新当前用户权限
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
};

export const api = {
  // 认证
  login: (body) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  // 总览与预警
  overview: () => request('/api/overview'),
  alerts: () => request('/api/alerts'),
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
  // 设置
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  // 账号与岗位（管理员）
  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUserRoles: (id, roles) => request(`/api/users/${id}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) }),
  updateUserStatus: (id, status) => request(`/api/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  resetUserPassword: (id, password) => request(`/api/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }),
  userSessions: (id) => request(`/api/users/${id}/sessions`),
  revokeSession: (userId, sessionId) => request(`/api/users/${userId}/sessions/${sessionId}`, { method: 'DELETE' }),
  // 操作日志（管理员）
  auditLogs: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/api/audit-logs${qs ? `?${qs}` : ''}`);
  },
};
