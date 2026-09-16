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
  // 库位与盘点
  locations: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return request(`/api/locations${qs ? `?${qs}` : ''}`);
  },
  createLocation: (body) => request('/api/locations', { method: 'POST', body: JSON.stringify(body) }),
  disableLocation: (id) => request(`/api/locations/${id}/disable`, { method: 'POST' }),
  movePackage: (body) => request('/api/locations/move', { method: 'POST', body: JSON.stringify(body) }),
  stocktakes: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return request(`/api/stocktakes${qs ? `?${qs}` : ''}`);
  },
  stocktake: (id) => request(`/api/stocktakes/${id}`),
  createStocktake: (body) => request('/api/stocktakes', { method: 'POST', body: JSON.stringify(body) }),
  scanStocktake: (id, body) => request(`/api/stocktakes/${id}/scan`, { method: 'POST', body: JSON.stringify(body) }),
  completeStocktake: (id) => request(`/api/stocktakes/${id}/complete`, { method: 'POST' }),
  reviewDifference: (stocktakeId, diffId, body) =>
    request(`/api/stocktakes/${stocktakeId}/differences/${diffId}/review`, { method: 'PUT', body: JSON.stringify(body) }),
  adjustStocktake: (id) => request(`/api/stocktakes/${id}/adjust`, { method: 'POST' }),
  cancelStocktake: (id) => request(`/api/stocktakes/${id}/cancel`, { method: 'POST' }),
  // 统计
  backlog: () => request('/api/stats/backlog'),
  abnormalStats: () => request('/api/stats/abnormal'),
  // 设置
  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};
