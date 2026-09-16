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
  // 手持扫描工作台
  scanHeartbeat: (body) => request('/api/scan/devices/heartbeat', { method: 'POST', body: JSON.stringify(body) }),
  scanSync: (body) => request('/api/scan/sync', { method: 'POST', body: JSON.stringify(body) }),
  scanLedger: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/api/scan/ledger${qs ? `?${qs}` : ''}`);
  },
};

// 仅供离线队列判断连通性使用：失败不抛错，返回布尔
export const pingServer = async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
};
