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
  // 异常处置工单
  workOrders: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/api/work-orders${qs ? `?${qs}` : ''}`);
  },
  workOrder: (id) => request(`/api/work-orders/${id}`),
  claimWorkOrder: (id, body) => request(`/api/work-orders/${id}/claim`, { method: 'POST', body: JSON.stringify(body) }),
  transferWorkOrder: (id, body) => request(`/api/work-orders/${id}/transfer`, { method: 'POST', body: JSON.stringify(body) }),
  addEvidence: (id, body) => request(`/api/work-orders/${id}/evidence`, { method: 'POST', body: JSON.stringify(body) }),
  submitConclusion: (id, body) => request(`/api/work-orders/${id}/submit`, { method: 'POST', body: JSON.stringify(body) }),
  reviewWorkOrder: (id, body) => request(`/api/work-orders/${id}/review`, { method: 'POST', body: JSON.stringify(body) }),
  // 统计
  backlog: () => request('/api/stats/backlog'),
  abnormalStats: () => request('/api/stats/abnormal'),
  // 设置
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};
