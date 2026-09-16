// 手持工作台展示辅助
export function fmtLocal(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtClock(t) {
  if (!t) return '从未';
  const diff = Math.max(0, Date.now() - new Date(t).getTime());
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return fmtLocal(t);
}

// 批次短编号
export const batchShort = (id) => String(id || '').replace(/^B-[a-z]+-/, '');
