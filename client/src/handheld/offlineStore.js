// 离线扫描存储：IndexedDB 持久化
// 断网时扫描全部落本机库，刷新页面、关掉浏览器再打开都不丢；
// 扫描记录以 scan_id 为主键，服务端按它幂等去重，本地也不会因重复写入产生两条。
const DB_NAME = 'hh-offline-db';
const DB_VERSION = 1;
const S_SCAN = 'scans';
const S_BATCH = 'batches';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_SCAN)) {
        const store = db.createObjectStore(S_SCAN, { keyPath: 'scan_id' });
        store.createIndex('batch_id', 'batch_id', { unique: false });
        store.createIndex('state', 'state', { unique: false });
      }
      if (!db.objectStoreNames.contains(S_BATCH)) {
        db.createObjectStore(S_BATCH, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const out = fn(store);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// ── 扫描记录 ──
export async function putScan(scan) {
  await tx(S_SCAN, 'readwrite', (s) => s.put(scan));
  return scan;
}

export async function putScans(scans) {
  if (!scans.length) return;
  await tx(S_SCAN, 'readwrite', (s) => {
    for (const sc of scans) s.put(sc);
  });
}

export async function getScan(scanId) {
  return tx(S_SCAN, 'readonly', (s) => reqP(s.get(scanId)));
}

export async function deleteScan(scanId) {
  await tx(S_SCAN, 'readwrite', (s) => s.delete(scanId));
}

export async function getAllScans() {
  const rows = await tx(S_SCAN, 'readonly', (s) => reqP(s.getAll()));
  return rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
}

// ── 批次 ──
export async function putBatch(batch) {
  await tx(S_BATCH, 'readwrite', (s) => s.put(batch));
  return batch;
}

export async function getBatch(id) {
  return tx(S_BATCH, 'readonly', (s) => reqP(s.get(id)));
}

export async function getAllBatches() {
  const rows = await tx(S_BATCH, 'readonly', (s) => reqP(s.getAll()));
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
