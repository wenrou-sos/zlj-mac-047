// 手持扫描队列与补传引擎（单例）
// 生命周期（每条扫描本地 state）：
//   pending 待补传 → applied 已记账 / conflict 冲突暂停 / error 失败可重试
// 冲突由人工选择：discarded 放弃（以服务器为准）/ kept 暂留 / retried 已调整重扫
// 未确认的扫描（pending/error/未处理冲突）绝不算成功作业
import { api, pingServer } from '../api.js';
import { getDevice, makeScanId } from './device.js';
import * as db from './offlineStore.js';

const LS_LAST_SYNC = 'hh_last_sync_at';
const LS_VEHICLES = 'hh_vehicles_cache';

const listeners = new Set();
let scans = [];
let batches = [];
let syncState = {
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  syncing: false,
  lastSyncAt: localStorage.getItem(LS_LAST_SYNC) || null,
  lastSummary: null,
  syncError: null,
};
let device = getDevice();
let vehiclesCache = [];
try { vehiclesCache = JSON.parse(localStorage.getItem(LS_VEHICLES) || '[]'); } catch { /* ignore */ }

// 稳定快照引用：仅在 emit 时重建，配合 React useSyncExternalStore 避免无限重渲染
let snapshot = { scans, batches, syncState, device, vehicles: vehiclesCache };
function emit() {
  snapshot = { scans, batches, syncState, device, vehicles: vehiclesCache };
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot() {
  return snapshot;
}

function persistScan(s) {
  return db.putScan(s);
}

// ── 初始化：载入本地队列、连通性探测、自动补传 ──
let initialized = false;
async function init() {
  if (initialized) return;
  initialized = true;
  [scans, batches] = await Promise.all([db.getAllScans(), db.getAllBatches()]);
  emit();

  window.addEventListener('online', () => {
    syncState.online = true;
    emit();
    heartbeat();
    syncNow(true);
  });
  window.addEventListener('offline', () => {
    syncState.online = false;
    emit();
  });

  // 定时探测（现场可能内网中断但系统仍显示"在线"），在线时自动补传
  const tick = async () => {
    const ok = await pingServer();
    if (ok !== syncState.online) {
      syncState.online = ok;
      emit();
      if (ok) {
        heartbeat();
        syncNow(true);
      }
    } else if (ok && hasUnfinished()) {
      syncNow(true);
    }
    if (ok) refreshVehicles();
  };
  tick();
  setInterval(tick, 10000);

  // 跨标签页恢复（另一标签页完成补传后本页也刷新）
  window.addEventListener('storage', async (e) => {
    if (e.key === LS_LAST_SYNC) {
      syncState.lastSyncAt = localStorage.getItem(LS_LAST_SYNC);
      scans = await db.getAllScans();
      emit();
    }
  });
}

async function heartbeat() {
  try {
    await api.scanHeartbeat({ device_id: device.id, name: device.name || null });
  } catch { /* 静默，探测下轮再试 */ }
}

async function refreshVehicles() {
  try {
    const list = await api.vehicles();
    vehiclesCache = list;
    localStorage.setItem(LS_VEHICLES, JSON.stringify(list));
    emit();
  } catch { /* 离线用缓存 */ }
}

function hasUnfinished() {
  return scans.some(
    (s) => s.state === 'pending' || s.state === 'error' || (s.state === 'conflict' && !s.resolution)
  );
}

// 未完成扫描数（导航角标）：待补传 + 失败 + 未处理冲突；已放弃/已重扫不算
function pendingCount() {
  return scans.filter(
    (s) => s.state === 'pending' || s.state === 'error' || (s.state === 'conflict' && !s.resolution)
  ).length;
}

// ── 批次 ──
// 每种作业类型记住"当前批次"（localStorage），刷新/重开自动继续未完成批次
function activeBatchKey(op) {
  return `hh_active_batch_${op}`;
}

async function getOpenBatch(op) {
  const activeId = localStorage.getItem(activeBatchKey(op));
  const active = activeId && batches.find((b) => b.id === activeId && !b.closed);
  if (active) return active;
  const latest = batches.find((b) => b.op === op && !b.closed);
  if (latest) {
    localStorage.setItem(activeBatchKey(op), latest.id);
    return latest;
  }
  const b = {
    id: `B-${op}-${Date.now().toString(36)}`,
    op,
    created_at: new Date().toISOString(),
    closed: false,
  };
  await db.putBatch(b);
  batches = [b, ...batches];
  localStorage.setItem(activeBatchKey(op), b.id);
  return b;
}

// 手动开启新批次（旧的未完成批次保留，可随时切回去继续）
async function startNewBatch(op) {
  const b = {
    id: `B-${op}-${Date.now().toString(36)}`,
    op,
    created_at: new Date().toISOString(),
    closed: false,
  };
  await db.putBatch(b);
  batches = [b, ...batches];
  localStorage.setItem(activeBatchKey(op), b.id);
  emit();
  return b;
}

function setActiveBatch(op, id) {
  localStorage.setItem(activeBatchKey(op), id);
  emit();
}

// 批次是否可关闭：所有扫描均已记账，或冲突已有结论（放弃/重扫且结论已回传，暂留除外）
function batchUnfinished(batchId) {
  return scans.some(
    (s) =>
      s.batch_id === batchId &&
      (s.state === 'pending' ||
        s.state === 'error' ||
        (s.state === 'conflict' && (!s.resolution || (s.resolution !== 'kept' && !s.resolution_synced))))
  );
}

async function closeBatch(batchId) {
  if (batchUnfinished(batchId)) {
    return { ok: false, error: '批次仍有未补传或未处理完的扫描，不能关闭' };
  }
  const b = batches.find((x) => x.id === batchId);
  if (!b) return { ok: false, error: '批次不存在' };
  b.closed = true;
  await db.putBatch(b);
  emit();
  return { ok: true };
}

// ── 扫描录入（断网照常）──
async function addScan({ op, tracking_no, occurred_at, payload }) {
  tracking_no = (tracking_no || '').trim();
  if (!tracking_no) return { ok: false, error: '请扫描或输入运单号' };
  if (op === 'arrive' && !payload?.destination?.trim()) return { ok: false, error: '到件扫描需要目的地' };
  if (op === 'load' && !payload?.vehicle_id) return { ok: false, error: '装车扫描请先选择目标班次' };

  // 同一批次重复扫描同一运单的同类操作直接拦截（扫描仪重复触发）
  const batch = await getOpenBatch(op);
  const dup = scans.find(
    (s) =>
      s.batch_id === batch.id &&
      s.op === op &&
      s.tracking_no === tracking_no &&
      !['discarded', 'retried'].includes(s.resolution) &&
      s.state !== 'applied'
  );
  if (dup) {
    return { ok: false, error: `该运单已在当前批次扫描过（${dup.scan_id.slice(-6)}），请勿重复扫描` };
  }

  const nowIso = new Date().toISOString();
  const scan = {
    scan_id: makeScanId(device.id),
    device_id: device.id,
    device_name: device.name || '',
    op,
    tracking_no,
    occurred_at: occurred_at || nowIso, // 默认此刻；可手工改为作业实际发生时间
    payload: payload || {},
    batch_id: batch.id,
    state: 'pending',
    result: null,
    resolution: null,
    resolution_synced: false,
    attempts: 0,
    last_error: null,
    created_local_at: nowIso,
  };
  await persistScan(scan);
  scans = [scan, ...scans];
  emit();

  if (syncState.online) scheduleSync(600); // 连扫时合并成一个补传请求
  return { ok: true, scan };
}

let syncTimer = null;
function scheduleSync(delay = 600) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), delay);
}

// ── 冲突人工处理 ──
// discarded 放弃 / kept 暂留 / retried 已调整重扫；结论随下次补传回传服务器
async function resolveConflict(scanId, resolution) {
  const s = scans.find((x) => x.scan_id === scanId);
  if (!s || s.state !== 'conflict') return;
  s.resolution = resolution;
  s.resolution_synced = false;
  await persistScan(s);
  emit();
  if (syncState.online) scheduleSync(400);
}

// 已记账 / 冲突已处理（结论已回传）的本地记录可清理（服务器台账不受影响）
async function removeRecord(scanId) {
  const s = scans.find((x) => x.scan_id === scanId);
  if (!s) return;
  const canRemove =
    s.state === 'applied' || (s.state === 'conflict' && s.resolution && s.resolution_synced);
  if (!canRemove) {
    return { ok: false, error: '未完成或冲突结论尚未回传的扫描不能删除' };
  }
  await db.deleteScan(scanId);
  scans = scans.filter((x) => x.scan_id !== scanId);
  emit();
  return { ok: true };
}

async function clearFinished() {
  // 已记账、冲突已有结论（放弃/暂留/重扫）且结论已回传服务器的，本地可清理；服务器台账仍保留
  const done = scans.filter(
    (s) => s.state === 'applied' || (s.state === 'conflict' && s.resolution && s.resolution_synced)
  );
  for (const s of done) await db.deleteScan(s.scan_id);
  scans = scans.filter((s) => !done.includes(s));
  emit();
  return done.length;
}

// ── 补传 ──
// silent: 定时自动补传，不弹错误；手动补传由页面提示
async function syncNow(silent = false) {
  if (syncState.syncing) return { ok: false, skipped: true };
  const online = await pingServer();
  syncState.online = online;
  if (!online) {
    syncState.syncError = silent ? null : '当前离线，扫描已保存在本机，恢复网络后自动补传';
    emit();
    return { ok: false, offline: true };
  }

  const toSend = scans.filter((s) => s.state === 'pending' || s.state === 'error');
  const resolutions = scans
    .filter((s) => s.resolution && !s.resolution_synced)
    .map((s) => ({ scan_id: s.scan_id, resolution: s.resolution }));

  if (!toSend.length && !resolutions.length) {
    syncState.syncError = null;
    emit();
    return { ok: true, empty: true };
  }

  syncState.syncing = true;
  syncState.syncError = null;
  emit();

  try {
    const body = {
      device_id: device.id,
      name: device.name || null,
      scans: toSend.map((s) => ({
        scan_id: s.scan_id,
        device_id: s.device_id,
        op: s.op,
        tracking_no: s.tracking_no,
        occurred_at: s.occurred_at,
        payload: s.payload,
      })),
      resolutions,
    };
    const resp = await api.scanSync(body);

    const byId = new Map((resp.results || []).map((r) => [r.scan_id, r]));
    for (const s of toSend) {
      const r = byId.get(s.scan_id);
      s.attempts += 1;
      if (!r) {
        s.state = 'error';
        s.last_error = '服务器未返回该条结果';
      } else if (r.status === 'applied') {
        s.state = 'applied';
        s.result = r;
        s.last_error = null;
      } else if (r.status === 'conflict') {
        // 冲突暂停：只记录服务器状态，绝不自动改写
        s.state = 'conflict';
        s.result = r;
        s.conflict_code = r.conflict_code;
        s.conflict_message = r.message;
        s.choices = r.choices;
        s.server = r.server;
      } else {
        s.state = 'error';
        s.last_error = r.message || '服务器处理失败';
      }
      await persistScan(s);
    }
    // 结论已被服务器接收
    if (resolutions.length) {
      for (const s of scans) {
        if (s.resolution && !s.resolution_synced) {
          s.resolution_synced = true;
          await persistScan(s);
        }
      }
    }

    syncState.lastSummary = resp.counts;
    syncState.lastSyncAt = resp.server_time || new Date().toISOString();
    localStorage.setItem(LS_LAST_SYNC, syncState.lastSyncAt);
    syncState.syncError = null;
    emit();
    return { ok: true, counts: resp.counts };
  } catch (e) {
    syncState.syncError = silent ? null : e.message;
    for (const s of toSend) {
      if (s.state === 'pending' || s.state === 'error') {
        s.state = 'error';
        s.last_error = e.message;
        await persistScan(s);
      }
    }
    emit();
    return { ok: false, error: e.message };
  } finally {
    syncState.syncing = false;
    emit();
  }
}

function renameDevice(name) {
  device = { ...device, name: name.trim() };
  localStorage.setItem(
    'hh_device',
    JSON.stringify(device)
  );
  emit();
  if (syncState.online) heartbeat();
}

export const queueStore = {
  subscribe,
  getSnapshot,
  init,
  addScan,
  syncNow,
  resolveConflict,
  removeRecord,
  clearFinished,
  closeBatch,
  getOpenBatch,
  startNewBatch,
  setActiveBatch,
  batchUnfinished,
  pendingCount,
  refreshVehicles,
  renameDevice,
};
