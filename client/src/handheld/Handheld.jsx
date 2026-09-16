import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wifi, WifiOff, RefreshCw, ScanLine, PackagePlus, PackageCheck, Forklift,
  AlertOctagon, XCircle, Clock, History, Layers, Play, Square,
  Trash2, Loader2, Radio, Pencil,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Empty } from '../components/common.jsx';
import { queueStore } from './scanQueue.js';
import { useQueue, SCAN_OP, SCAN_STATE, RESOLUTION_LABEL, toLocalInput } from './useQueue.js';
import { fmtLocal, fmtClock, batchShort } from './ui.js';
import ConflictModal from './ConflictModal.jsx';
import LedgerTab from './LedgerTab.jsx';

const TABS = [
  { key: 'arrive', label: '到件扫描', icon: PackagePlus },
  { key: 'sort', label: '分拣扫描', icon: PackageCheck },
  { key: 'load', label: '装车扫描', icon: Forklift },
];

function StatusBar({ snap }) {
  const { syncState, device } = snap;
  const online = syncState.online;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name || '');

  const saveName = () => {
    queueStore.renameDevice(name);
    setEditing(false);
    toast('设备名称已保存', 'success');
  };

  return (
    <div className={`hh-status ${online ? 'online' : 'offline'}`}>
      <div className="hh-status-left">
        {online ? <Wifi size={15} /> : <WifiOff size={15} />}
        <span className="hh-dot" />
        {online ? '服务器在线' : '离线模式 · 扫描将暂存本机'}
        <span className="hh-sep">|</span>
        <Radio size={14} />
        设备 <b className="mono">{device.id}</b>
        {editing ? (
          <span className="hh-name-edit">
            <input
              className="input" style={{ width: 160, height: 28, padding: '2px 8px' }}
              value={name} placeholder="设备名称（如 1号手持机）"
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
            />
            <button className="btn btn-sm btn-primary" onClick={saveName}>保存</button>
          </span>
        ) : (
          <button className="hh-name-btn" onClick={() => { setName(device.name || ''); setEditing(true); }}>
            {device.name || '未命名'} <Pencil size={11} />
          </button>
        )}
      </div>
      <div className="hh-status-right mono">
        <Clock size={13} />
        上次补传 {fmtClock(syncState.lastSyncAt)}
      </div>
    </div>
  );
}

function StatStrip({ counts, syncing }) {
  const items = [
    { label: '待补传', value: counts.pending, cls: 'pending' },
    { label: '已记账', value: counts.applied, cls: 'applied' },
    { label: '冲突暂停', value: counts.conflict, cls: 'conflict' },
    { label: '补传失败', value: counts.error, cls: 'error' },
  ];
  return (
    <div className="hh-stats">
      {items.map((it) => (
        <div key={it.label} className={`hh-stat ${it.cls}`}>
          <div className="hh-stat-value">{it.value}</div>
          <div className="hh-stat-label">{it.label}</div>
        </div>
      ))}
      <button
        className="btn btn-primary hh-sync-btn"
        onClick={() => window.__hhSync?.()}
        disabled={syncing || counts.todo === 0}
      >
        {syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        {syncing ? '补传中…' : '立即补传'}
      </button>
    </div>
  );
}

function BatchBar({ op, scans, batches }) {
  const toast = useToast();
  const opBatches = useMemo(
    () => batches.filter((b) => b.op === op).slice(0, 8),
    [batches, op]
  );
  const currentId = localStorage.getItem(`hh_active_batch_${op}`);
  const current = batches.find((b) => b.id === currentId && b.op === op) || opBatches.find((b) => !b.closed);
  const mine = scans.filter((s) => s.batch_id === current?.id);
  const unfinished = current ? queueStore.batchUnfinished(current.id) : false;

  const close = async () => {
    const r = await queueStore.closeBatch(current.id);
    if (!r.ok) toast(r.error, 'error');
    else toast(`批次 ${batchShort(current.id)} 已完成关闭`, 'success');
  };

  if (!current) return null;
  return (
    <div className="hh-batch">
      <Layers size={15} />
      <span className="text-muted">当前批次</span>
      <b className="mono">#{batchShort(current.id)}</b>
      <span className="text-muted">
        本批 {mine.length} 扫 · 待补 {mine.filter((s) => s.state === 'pending' || s.state === 'error').length}
        {' · '}冲突 {mine.filter((s) => s.state === 'conflict' && !s.resolution).length}
      </span>
      <select
        className="input hh-batch-select"
        value={current.id}
        onChange={(e) => queueStore.setActiveBatch(op, e.target.value)}
      >
        {opBatches.map((b) => (
          <option key={b.id} value={b.id}>
            #{batchShort(b.id)} {b.closed ? '（已关闭）' : '（进行中）'} · {fmtLocal(b.created_at)}
          </option>
        ))}
      </select>
      <button className="btn btn-sm" onClick={() => queueStore.startNewBatch(op)}>
        <Play size={12} /> 新批次
      </button>
      <button className="btn btn-sm btn-danger" disabled={unfinished} onClick={close}>
        <Square size={11} /> 关闭批次
      </button>
      {unfinished && <span className="text-muted">存在未完成扫描，暂不能关闭</span>}
    </div>
  );
}

// 扫描台：输入运单号（模拟扫码枪），离线也能扫
function ScanDock({ op, snap }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [tracking, setTracking] = useState('');
  const [destination, setDestination] = useState('');
  const [weight, setWeight] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [manualTime, setManualTime] = useState(false);
  const [occurred, setOccurred] = useState(toLocalInput());
  const vehicles = snap.vehicles;

  useEffect(() => { inputRef.current?.focus(); }, [op]);

  const submit = async (e) => {
    e?.preventDefault();
    const payload = {};
    if (op === 'arrive') {
      payload.destination = destination.trim();
      payload.weight_kg = Number(weight) || 1;
    }
    if (op === 'load') payload.vehicle_id = vehicleId ? Number(vehicleId) : null;
    const occurred_at = manualTime && occurred ? new Date(occurred).toISOString() : null;
    const r = await queueStore.addScan({ op, tracking_no: tracking, occurred_at, payload });
    if (!r.ok) {
      toast(r.error, 'error');
      return;
    }
    toast(`${SCAN_OP[op].label} 已保存：${tracking.trim()}`, snap.syncState.online ? 'success' : 'info');
    setTracking('');
    setManualTime(false);
    setOccurred(toLocalInput());
    inputRef.current?.focus();
  };

  const loadableVehicles = vehicles.filter((v) => v.status !== 'expected' && v.status !== 'departed');

  return (
    <form className={`hh-dock hh-dock-${op}`} onSubmit={submit}>
      <div className="hh-dock-main">
        <ScanLine size={26} className="hh-dock-icon" />
        <input
          ref={inputRef}
          className="hh-scan-input mono"
          placeholder="扫描或输入运单号后回车（断网也可扫）"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary">
          <ScanLine size={15} /> 确认扫描
        </button>
      </div>

      <div className="hh-dock-fields">
        {op === 'arrive' && (
          <>
            <input
              className="input" placeholder="目的地 *（如 上海）" value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
            <input
              className="input" placeholder="重量 kg，默认 1" type="number" min="0" step="0.1"
              value={weight} onChange={(e) => setWeight(e.target.value)} style={{ maxWidth: 150 }}
            />
          </>
        )}
        {op === 'load' && (
          <select className="input" required value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">选择装车班次 *</option>
            {loadableVehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.plate_no} · {v.route_code}</option>
            ))}
            {loadableVehicles.length === 0 && <option disabled>（无在场可装班次，请先在车辆页确认班次）</option>}
          </select>
        )}
        <label className="hh-time-toggle">
          <input type="checkbox" checked={manualTime} onChange={(e) => { setManualTime(e.target.checked); setOccurred(toLocalInput()); }} />
          <Clock size={13} /> 指定实际扫描时间
        </label>
        {manualTime && (
          <input type="datetime-local" className="input" style={{ maxWidth: 200 }}
            value={occurred} onChange={(e) => setOccurred(e.target.value)} />
        )}
      </div>
    </form>
  );
}

function ScanRow({ s, onConflict }) {
  const stateConf = SCAN_STATE[s.state];
  const opConf = SCAN_OP[s.op];
  return (
    <tr className={s.state === 'conflict' && !s.resolution ? 'row-alert' : s.state === 'error' ? 'row-warn' : ''}>
      <td><Badge conf={opConf} /></td>
      <td className="mono">{s.tracking_no}</td>
      <td>
        {s.payload?.destination || '—'}
        {s.payload?.vehicle_id && <div className="text-muted">班次 #{s.payload.vehicle_id}</div>}
      </td>
      <td className="mono text-muted">{fmtLocal(s.occurred_at)}</td>
      <td className="text-muted">{s.device_id}</td>
      <td>
        {s.state === 'conflict' ? (
          <button className="btn btn-sm btn-danger" onClick={() => onConflict(s)}>
            <AlertOctagon size={12} /> {SCAN_STATE.conflict.label}
          </button>
        ) : (
          <Badge conf={stateConf} />
        )}
        {s.state === 'conflict' && s.resolution && (
          <div className="text-muted" style={{ marginTop: 3 }}>
            {RESOLUTION_LABEL[s.resolution]}{s.resolution_synced ? '' : '（待回传）'}
          </div>
        )}
        {s.state === 'applied' && s.result?.replayed && (
          <div className="text-muted" style={{ marginTop: 3 }}>重复补传已自动忽略</div>
        )}
        {s.state === 'error' && (
          <>
            {s.last_error && <div className="text-muted" style={{ marginTop: 3, maxWidth: 220 }}>{s.last_error}</div>}
            <button
              className="btn btn-sm btn-next" style={{ marginTop: 4 }}
              onClick={() => window.__hhSync?.()}
            >
              <RefreshCw size={11} /> 重试补传
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function QueuePanel({ scans, tab, onConflict }) {
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const list = scans.filter((s) => (tab === 'ledger' ? true : s.op === tab));
  const shown = list.filter((s) => (filter === 'all' ? true : s.state === filter));

  const clear = async () => {
    const n = await queueStore.clearFinished();
    toast(`已清理 ${n} 条已完成记录`, 'success');
  };

  return (
    <div className="card hh-queue">
      <div className="card-header">
        <h3><History size={16} /> 本批扫描与补传结果 <span className="text-muted">（共 {list.length} 条，逐行显示补传结论）</span></h3>
        <div className="filter-bar">
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部</option>
            <option value="pending">待补传</option>
            <option value="applied">已记账</option>
            <option value="conflict">冲突暂停</option>
            <option value="error">失败</option>
          </select>
          <button className="btn btn-sm" onClick={clear}><Trash2 size={12} /> 清理已完成</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>作业</th><th>运单号</th><th>内容</th><th>扫描时间</th><th>设备</th>
              <th style={{ width: 200 }}>补传结果</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => <ScanRow key={s.scan_id} s={s} onConflict={onConflict} />)}
          </tbody>
        </table>
        {shown.length === 0 && <Empty text="暂无扫描记录 —— 断网时扫描也会保存在这里" />}
      </div>
    </div>
  );
}

export default function Handheld() {
  const snap = useQueue();
  const toast = useToast();
  const [tab, setTab] = useState('arrive');
  const [view, setView] = useState('queue'); // queue | ledger
  const [conflict, setConflict] = useState(null);

  useEffect(() => { queueStore.init(); }, []);

  // 挂给状态条按钮调用（避免 props 透传）
  useEffect(() => {
    window.__hhSync = async () => {
      const r = await queueStore.syncNow(false);
      if (r.ok) {
        if (r.empty) toast('没有待补传的扫描', 'info');
        else toast(`补传完成：记账 ${r.counts.applied}，冲突 ${r.counts.conflict}，失败 ${r.counts.error}`, 'success');
      } else if (!r.offline) {
        toast('补传失败：' + (r.error || ''), 'error');
      } else {
        toast('仍处于离线，扫描已暂存本机', 'error');
      }
    };
    return () => { delete window.__hhSync; };
  }, [toast]);

  // 自动补传后，若新出现冲突可直接打开最新一条（仅在队列视图提示，不打断扫描）
  const counts = useMemo(() => {
    const c = { pending: 0, applied: 0, conflict: 0, error: 0, todo: 0 };
    for (const s of snap.scans) {
      if (s.state === 'pending') c.pending += 1;
      else if (s.state === 'error') c.error += 1;
      else if (s.state === 'conflict') {
        if (s.resolution) {
          // 已有处理结论（待回传）不计入冲突数角标
        } else c.conflict += 1;
      } else if (s.state === 'applied') c.applied += 1;
    }
    c.todo = c.pending + c.error;
    return c;
  }, [snap.scans]);

  const onResolve = async (scanId, resolution) => {
    await queueStore.resolveConflict(scanId, resolution);
    const labels = { discarded: '已放弃，以服务器状态为准', kept: '已暂留，稍后人工处理', retried: '可调整后重新补扫' };
    toast(labels[resolution], 'success');
    setConflict(null);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>手持扫描工作台</h1>
          <div className="sub">断网照常扫描、本机保存；恢复网络后逐条补传，冲突暂停由人工选择处理</div>
        </div>
      </div>

      <StatusBar snap={snap} />
      <StatStrip counts={counts} syncing={snap.syncState.syncing} />
      {snap.syncState.syncError && (
        <div className="alert-item overdue" style={{ marginTop: 12 }}>
          <span className="alert-icon"><XCircle size={16} /></span>
          <div className="alert-msg">{snap.syncState.syncError}</div>
        </div>
      )}

      <div className="hh-tabs">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`hh-tab ${tab === key && view === 'queue' ? 'active' : ''}`}
            onClick={() => { setTab(key); setView('queue'); }}>
            <Icon size={15} /> {label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className={`hh-tab ${view === 'ledger' ? 'active' : ''}`} onClick={() => setView('ledger')}>
          <History size={15} /> 服务器扫描台账
        </button>
      </div>

      {view === 'queue' ? (
        <>
          <BatchBar op={tab} scans={snap.scans} batches={snap.batches} />
          <ScanDock op={tab} snap={snap} />
          <QueuePanel scans={snap.scans} tab={tab} onConflict={setConflict} />
        </>
      ) : (
        <LedgerTab />
      )}

      <ConflictModal
        scan={conflict}
        onClose={() => setConflict(null)}
        onResolve={onResolve}
      />
    </div>
  );
}
