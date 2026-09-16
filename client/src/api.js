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
  // 月台
  docks: () => request('/api/docks'),
  createDock: (body) => request('/api/docks', { method: 'POST', body: JSON.stringify(body) }),
  updateDock: (id, body) => request(`/api/docks/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  disableDock: (id, reason) => request(`/api/docks/${id}/disable`, { method: 'POST', body: JSON.stringify({ reason }) }),
  enableDock: (id) => request(`/api/docks/${id}/enable`, { method: 'POST' }),
  callNextDock: (id) => request(`/api/docks/${id}/call-next`, { method: 'POST' }),
  // 预约与叫号
  appointments: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/api/appointments${qs ? `?${qs}` : ''}`);
  },
  board: () => request('/api/appointments/board'),
  createAppointment: (body) => request('/api/appointments', { method: 'POST', body: JSON.stringify(body) }),
  checkInAppointment: (id) => request(`/api/appointments/${id}/check-in`, { method: 'POST' }),
  callAppointment: (id, dockId = null) => request(`/api/appointments/${id}/call`, { method: 'POST', body: JSON.stringify({ dock_id: dockId }) }),
  prioritizeAppointment: (id, reason, priority = 200) =>
    request(`/api/appointments/${id}/priority`, { method: 'POST', body: JSON.stringify({ priority, reason }) }),
  rescheduleAppointment: (id, body) => request(`/api/appointments/${id}/reschedule`, { method: 'POST', body: JSON.stringify(body) }),
  cancelAppointment: (id, reason) => request(`/api/appointments/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  recallAppointment: (id, reason) => request(`/api/appointments/${id}/recall`, { method: 'POST', body: JSON.stringify({ reason }) }),
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
};
