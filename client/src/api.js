// API 封装
const request = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
};

export const api = {
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
  scanPackage: (tracking_no) => request('/api/packages/scan', { method: 'POST', body: JSON.stringify({ tracking_no }) }),
  sortPackage: (id, body) => request(`/api/packages/${id}/sort`, { method: 'POST', body: JSON.stringify(body || {}) }),
  loadPackage: (id) => request(`/api/packages/${id}/load`, { method: 'POST' }),
  interceptPackage: (id, body) => request(`/api/packages/${id}/intercept`, { method: 'POST', body: JSON.stringify(body) }),
  releasePackage: (id, body) => request(`/api/packages/${id}/release`, { method: 'POST', body: JSON.stringify(body || {}) }),
  // 格口
  chutes: () => request('/api/chutes'),
  createChute: (body) => request('/api/chutes', { method: 'POST', body: JSON.stringify(body) }),
  disableChute: (id, body) => request(`/api/chutes/${id}/disable`, { method: 'POST', body: JSON.stringify(body || {}) }),
  enableChute: (id) => request(`/api/chutes/${id}/enable`, { method: 'POST' }),
  // 分拣规则
  sortRules: () => request('/api/sort-rules'),
  createDraft: () => request('/api/sort-rules/draft', { method: 'POST' }),
  discardDraft: () => request('/api/sort-rules/draft', { method: 'DELETE' }),
  addRule: (body) => request('/api/sort-rules/draft/rules', { method: 'POST', body: JSON.stringify(body) }),
  updateRule: (id, body) => request(`/api/sort-rules/draft/rules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteRule: (id) => request(`/api/sort-rules/draft/rules/${id}`, { method: 'DELETE' }),
  simulateDraft: () => request('/api/sort-rules/draft/simulate', { method: 'POST' }),
  publishDraft: () => request('/api/sort-rules/draft/publish', { method: 'POST' }),
  // 统计
  backlog: () => request('/api/stats/backlog'),
  abnormalStats: () => request('/api/stats/abnormal'),
  // 设置
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};
