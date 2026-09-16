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
  // 班次
  shifts: () => request('/api/shifts'),
  createShift: (body) => request('/api/shifts', { method: 'POST', body: JSON.stringify(body) }),
  // 班次交接单
  handovers: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/api/handovers${qs ? `?${qs}` : ''}`);
  },
  createHandover: (body) => request('/api/handovers', { method: 'POST', body: JSON.stringify(body) }),
  handoverDetail: (id) => request(`/api/handovers/${id}`),
  saveSummary: (id, summary_note) =>
    request(`/api/handovers/${id}/summary`, { method: 'PUT', body: JSON.stringify({ summary_note }) }),
  submitHandover: (id) => request(`/api/handovers/${id}/submit`, { method: 'POST' }),
  signHandover: (id, signed_by) =>
    request(`/api/handovers/${id}/sign`, { method: 'POST', body: JSON.stringify({ signed_by }) }),
  cancelHandover: (id, reason) =>
    request(`/api/handovers/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  appendItem: (id, body) => request(`/api/handovers/${id}/items`, { method: 'POST', body: JSON.stringify(body) }),
  setItemNote: (itemId, note) =>
    request(`/api/handovers/items/${itemId}/note`, { method: 'PUT', body: JSON.stringify({ note }) }),
  decideItem: (itemId, body) =>
    request(`/api/handovers/items/${itemId}/decision`, { method: 'PUT', body: JSON.stringify(body) }),
};
