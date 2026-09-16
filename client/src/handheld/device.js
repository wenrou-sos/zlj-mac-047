// 手持设备身份：设备号长期保存在本机（localStorage），每条扫描都带设备号，可追溯
const G = typeof globalThis !== 'undefined' ? globalThis : {};
const KEY = 'hh_device';

function random8() {
  const cryptoApi = G.crypto || (typeof window !== 'undefined' ? window.crypto : null);
  if (cryptoApi?.getRandomValues) {
    const buf = new Uint32Array(2);
    cryptoApi.getRandomValues(buf);
    return (buf[0].toString(16).padStart(8, '0') + buf[1].toString(16).slice(0, 4)).toUpperCase();
  }
  return Math.random().toString(16).slice(2, 12).toUpperCase().padStart(10, '0');
}

// 扫描唯一ID（幂等键）：设备号 + 时间戳 + 随机串，保证多台设备、同一毫秒也不撞
export function makeScanId(deviceId) {
  return `${deviceId}-${Date.now().toString(36)}-${random8().slice(0, 6)}`;
}

export function getDevice() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d?.id) return d;
    }
  } catch { /* 损坏则重建 */ }
  const device = { id: `HH-${random8()}`, name: '', createdAt: new Date().toISOString() };
  localStorage.setItem(KEY, JSON.stringify(device));
  return device;
}

export function saveDevice(patch) {
  const d = { ...getDevice(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(d));
  return d;
}
