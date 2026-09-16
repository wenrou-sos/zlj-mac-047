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
  interceptPackage: (id, body) => request(`/api/packages/${id}/intercept`, { method: 'POST', body: JSON.stringify(body) }),
  releasePackage: (id) => request(`/api/packages/${id}/release`, { method: 'POST' }),
  // 出港配载单
  loadPlans: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/api/load-plans${qs ? `?${qs}` : ''}`);
  },
  loadPlan: (id) => request(`/api/load-plans/${id}`),
  previewCandidates: (params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/api/load-plans/candidates/preview?${qs}`);
  },
  createLoadPlan: (body) => request('/api/load-plans', { method: 'POST', body: JSON.stringify(body) }),
  planAddItems: (id, package_ids) => request(`/api/load-plans/${id}/items`, { method: 'POST', body: JSON.stringify({ package_ids }) }),
  planRemoveItems: (id, package_ids) => request(`/api/load-plans/${id}/items`, { method: 'DELETE', body: JSON.stringify({ package_ids }) }),
  planReassign: (id, body) => request(`/api/load-plans/${id}/reassign`, { method: 'POST', body: JSON.stringify(body) }),
  planCancel: (id, reason) => request(`/api/load-plans/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  planSeal: (id) => request(`/api/load-plans/${id}/seal`, { method: 'POST' }),
  planUnseal: (id) => request(`/api/load-plans/${id}/unseal`, { method: 'POST' }),
  // 统计
  backlog: () => request('/api/stats/backlog'),
  abnormalStats: () => request('/api/stats/abnormal'),
  // 设置
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};
