import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Plus, MapPin, PlayCircle, ScanLine, CheckCheck, ClipboardList,
  Ban, XCircle, ChevronRight, PackagePlus, PackageCheck,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { LOCATION_TYPES, STOCKTAKE_STATUS, DIFF_TYPES, fmtDateTime } from '../utils.js';

const SCAN_RESULT_LABEL = {
  matched: { label: '账实相符', color: '#15803d', bg: '#dcfce7' },
  misplaced: { label: '错位', color: '#b45309', bg: '#fef3c7' },
  surplus: { label: '盘盈', color: '#0f766e', bg: '#ccfbf1' },
  period_in: { label: '期间移入', color: '#1d4ed8', bg: '#dbeafe' },
  period_out: { label: '期间移出', color: '#1d4ed8', bg: '#dbeafe' },
  shipped: { label: '期间装车', color: '#15803d', bg: '#dcfce7' },
  pending: { label: '待盘', color: '#64748b', bg: '#f1f5f9' },
};

function LocationModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ code: '', name: '', loc_type: 'storage', zone: '场区', capacity: '' });
  const toast = useToast();
  const submit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast('库位编码和名称必填', 'error');
      return;
    }
    try {
      await api.createLocation({ ...form, capacity: form.capacity ? Number(form.capacity) : null });
      toast('场区库位已创建', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title="新建场区库位" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn btn-primary" onClick={submit}>保存</button>
    </>}>
      <div className="form-row"><label>库位编码 *</label><input className="input" placeholder="如 C-03-02" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
      <div className="form-row"><label>库位名称 *</label><input className="input" placeholder="如 C区 03 架 02 层" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="form-row"><label>库区</label><input className="input" value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} /></div>
      <div className="form-row">
        <label>库位类型</label>
        <select className="input" value={form.loc_type} onChange={(e) => setForm({ ...form, loc_type: e.target.value })}>
          {Object.entries(LOCATION_TYPES).filter(([k]) => !['vehicle', 'lost'].includes(k)).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>
      <div className="form-row"><label>容量（留空不限）</label><input className="input" type="number" min="1" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></div>
    </Modal>
  );
}

function ReviewModal({ diff, stocktakeId, onDone }) {
  const [note, setNote] = useState('');
  const toast = useToast();
  const decide = async (decision) => {
    try {
      await api.reviewDifference(stocktakeId, diff.id, { decision, note });
      toast(decision === 'confirmed' ? '差异已确认，可统一调账' : '差异已驳回，不调整账面', 'success');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title={`复核${DIFF_TYPES[diff.diff_type]?.label}差异`} onClose={onDone} footer={<>
      <button className="btn" onClick={onDone}>关闭</button>
      <button className="btn btn-danger" onClick={() => decide('dismissed')}><XCircle size={14} /> 驳回</button>
      <button className="btn btn-primary" onClick={() => decide('confirmed')}><CheckCheck size={14} /> 确认差异</button>
    </>}>
      <div className="diff-box">
        <div><span>运单号</span><b className="mono">{diff.tracking_no}</b></div>
        <div><span>账面库位</span><b>{diff.expected_code || '账外件'}</b></div>
        <div><span>实盘库位</span><b>{diff.actual_code || '未盘到'}</b></div>
        <div><span>目的地</span><b>{diff.actual_destination || diff.destination || '—'}</b></div>
      </div>
      <div className="form-row" style={{ marginTop: 12 }}>
        <label>复核备注</label>
        <textarea className="input" rows="3" placeholder="说明确认/驳回原因（选填）" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function StocktakeModal({ id, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [scanNo, setScanNo] = useState('');
  const [scanDest, setScanDest] = useState('');
  const [reviewDiff, setReviewDiff] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setDetail(await api.stocktake(id));
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const mutate = async (fn, msg) => {
    try {
      const next = await fn();
      if (next) setDetail(next);
      else await load();
      if (msg) toast(msg, 'success');
      onChanged();
      setScanNo('');
      setScanDest('');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (!detail) return <Modal title="盘点详情" onClose={onClose}><div className="empty">加载中…</div></Modal>;

  const s = detail.snapshot_summary;
  const c = detail.scan_summary;
  const d = detail.diff_summary;
  return (
    <Modal width="980px" title={`滚动盘点 #${detail.id} · ${detail.location_code} ${detail.location_name}`} onClose={onClose}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <Badge conf={STOCKTAKE_STATUS[detail.status]} />
        <span className="text-muted">盘点时点 {fmtDateTime(detail.snapshot_at)}</span>
        {detail.completed_at && <span className="text-muted">实盘冻结 {fmtDateTime(detail.completed_at)}</span>}
        <span className="text-muted">发起人 {detail.created_by || '现场员'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {detail.status === 'counting' && (
            <button className="btn btn-primary" onClick={() => mutate(() => api.completeStocktake(id), '实盘已结束，进入差异复核')}>
              <CheckCheck size={14} /> 结束并核对期间流转
            </button>
          )}
          {detail.status === 'reviewing' && (
            <button className="btn btn-primary" disabled={d.pending_review > 0} onClick={() => mutate(() => api.adjustStocktake(id), '复核差异已调整账面')}>
              <PackagePlus size={14} /> {d.pending_review > 0 ? `先复核 ${d.pending_review} 条差异` : '确认复核并调整账面'}
            </button>
          )}
          {['counting', 'reviewing'].includes(detail.status) && (
            <button className="btn btn-danger" onClick={() => mutate(() => api.cancelStocktake(id), '盘点单已取消')}><Ban size={14} /> 取消</button>
          )}
        </div>
      </div>

      <div className="stocktake-kpis">
        <div><b>{s.total}</b><span>时点账存</span></div>
        <div className="ok"><b>{s.matched + c.matched}</b><span>账实相符</span></div>
        <div className="blue"><b>{s.period_out + s.shipped + c.period}</b><span>期间流转核销</span></div>
        <div className="red"><b>{d.shortage}</b><span>盘亏</span></div>
        <div className="amber"><b>{d.misplaced}</b><span>错位</span></div>
        <div className="green"><b>{d.surplus}</b><span>盘盈</span></div>
        <div><b>{s.pending}</b><span>未盘到</span></div>
      </div>

      {detail.status === 'counting' && (
        <div className="scan-bar">
          <ScanLine size={18} />
          <input
            className="input"
            placeholder="扫描/输入运单号；盘点期间到件、移位、装车可继续，系统按流水自动核销"
            value={scanNo}
            onChange={(e) => setScanNo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && scanNo.trim()) {
                mutate(() => api.scanStocktake(id, {
                  tracking_no: scanNo.trim(),
                  observed_location_id: detail.location_id,
                  destination: scanDest || undefined,
                }), '扫描已记录');
              }
            }}
          />
          <input className="input" style={{ width: 130 }} placeholder="盘盈目的地" value={scanDest} onChange={(e) => setScanDest(e.target.value)} />
          <button className="btn btn-primary" disabled={!scanNo.trim()} onClick={() => mutate(() => api.scanStocktake(id, {
            tracking_no: scanNo.trim(),
            observed_location_id: detail.location_id,
            destination: scanDest || undefined,
          }), '扫描已记录')}>登记实盘</button>
        </div>
      )}

      <div className="stocktake-section-title">
        <ClipboardList size={15} /> 差异复核
        <span className="text-muted">盘盈补账、盘亏挂入 LOST-01、错位调整到实盘库位；均需复核确认</span>
      </div>
      <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
        <table className="tbl">
          <thead><tr><th>类型</th><th>运单号</th><th>账面库位</th><th>实盘库位</th><th>作业状态</th><th>复核</th><th>调账</th><th></th></tr></thead>
          <tbody>
            {detail.differences.map((diff) => (
              <tr key={diff.id}>
                <td><Badge conf={DIFF_TYPES[diff.diff_type]} /></td>
                <td className="mono">{diff.tracking_no}</td>
                <td>{diff.expected_code || <span className="text-muted">账外</span>}</td>
                <td>{diff.actual_code || <span className="text-muted">未找到</span>}</td>
                <td className="text-muted">{diff.package_status || '待补账'}</td>
                <td>
                  {diff.resolution === 'pending' ? <span className="text-muted">待复核</span>
                    : diff.resolution === 'confirmed' ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>已确认</span>
                    : <span style={{ color: 'var(--red)' }}>已驳回</span>}
                  {diff.resolution_note && <div className="text-muted">{diff.resolution_note}</div>}
                </td>
                <td>{diff.adjusted_at ? <span className="text-muted">{fmtDateTime(diff.adjusted_at)}</span> : '—'}</td>
                <td>
                  {detail.status === 'reviewing' && diff.resolution === 'pending' && (
                    <button className="btn btn-sm" onClick={() => setReviewDiff(diff)}><ChevronRight size={13} />复核</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {detail.differences.length === 0 && <Empty text="暂无差异；未盘到件将在结束实盘后按期间流水统一核对" />}
      </div>

      <div className="stocktake-section-title"><ScanLine size={15} /> 最近扫描</div>
      <div className="scan-list">
        {detail.recent_scans.slice(0, 12).map((sc) => (
          <div key={sc.id}>
            <span className="mono">{sc.tracking_no}</span>
            <Badge conf={SCAN_RESULT_LABEL[sc.result]} />
            <span className="text-muted">{fmtDateTime(sc.observed_at)}</span>
          </div>
        ))}
        {detail.recent_scans.length === 0 && <Empty text="尚未扫描" />}
      </div>

      {reviewDiff && <ReviewModal diff={reviewDiff} stocktakeId={id} onDone={async () => { setReviewDiff(null); await load(); onChanged(); }} />}
    </Modal>
  );
}

export default function Inventory() {
  const [locations, setLocations] = useState([]);
  const [stocktakes, setStocktakes] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [activeStocktake, setActiveStocktake] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [ls, ss] = await Promise.all([
        api.locations({ includeVehicles: false }),
        api.stocktakes(),
      ]);
      setLocations(ls);
      setStocktakes(ss);
    } catch (e) {
      toast(e.message, 'error');
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const startStocktake = async (loc) => {
    try {
      const s = await api.createStocktake({ location_id: loc.id });
      toast(`已按盘点时点冻结 ${loc.code} 账存，作业不中断`, 'success');
      await load();
      setActiveStocktake(s.id);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const disable = async (loc) => {
    try {
      await api.disableLocation(loc.id);
      toast(`${loc.code} 已停用`, 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const yard = useMemo(() => locations.filter((l) => !['vehicle', 'lost'].includes(l.loc_type)), [locations]);
  const totalOccupied = yard.reduce((sum, l) => sum + Number(l.occupied || 0), 0);
  const backlog = yard.reduce((sum, l) => sum + Number(l.backlog || 0), 0);
  const held = yard.reduce((sum, l) => sum + Number(l.held || 0), 0);
  const counting = stocktakes.filter((s) => s.status === 'counting').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>场区库位与滚动盘点</h1>
          <div className="sub">积压件可定位到具体库位；盘点不封锁作业，按盘点时点和期间流水核对差异</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={15} /> 新建库位</button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card"><div className="stat-icon" style={{ background: '#dbeafe', color: '#1d4ed8' }}><MapPin size={22} /></div><div><div className="stat-value">{yard.length}</div><div className="stat-label">场区库位</div></div></div>
        <div className="stat-card"><div className="stat-icon" style={{ background: '#ccfbf1', color: '#0f766e' }}><PackageCheck size={22} /></div><div><div className="stat-value">{totalOccupied}</div><div className="stat-label">在场定位件</div></div></div>
        <div className="stat-card"><div className="stat-icon" style={{ background: '#fef3c7', color: '#b45309' }}><ClipboardList size={22} /></div><div><div className="stat-value">{backlog}</div><div className="stat-label">待处理库内件</div></div></div>
        <div className="stat-card"><div className="stat-icon" style={{ background: '#fee2e2', color: '#b91c1c' }}><Ban size={22} /></div><div><div className="stat-value">{held}</div><div className="stat-label">拦截留置件</div></div></div>
        <div className="stat-card"><div className="stat-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}><PlayCircle size={22} /></div><div><div className="stat-value">{counting}</div><div className="stat-label">滚动盘点中</div></div></div>
      </div>

      <div className="card section-gap">
        <div className="card-header">
          <h3><MapPin size={16} /> 库位占用</h3>
          <span className="text-muted">同一件始终只有 current_location_id 一个有效位置</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>库位</th><th>类型</th><th>占用/容量</th><th>待分拣</th><th>已分拣</th><th>拦截留置</th><th>盘点</th><th style={{ width: 230 }}>操作</th></tr>
            </thead>
            <tbody>
              {yard.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{l.code}</div>
                    <div className="text-muted">{l.name} · {l.zone}</div>
                  </td>
                  <td><Badge conf={LOCATION_TYPES[l.loc_type]} /></td>
                  <td>
                    <div className="mono">{l.occupied}/{l.capacity || '∞'}</div>
                    <div className="progress-bar" style={{ marginTop: 5 }}><div style={{ width: `${l.capacity ? Math.min(100, Math.round(l.occupied / l.capacity * 100)) : 0}%` }} /></div>
                  </td>
                  <td className="mono">{l.loc_type === 'intercept' ? '—' : l.pending}</td>
                  <td className="mono">{l.sorted}</td>
                  <td className="mono" style={{ color: l.held ? 'var(--red)' : undefined, fontWeight: l.held ? 700 : 400 }}>{l.held}</td>
                  <td>{l.counting ? <Badge conf={STOCKTAKE_STATUS.counting} /> : <span className="text-muted">空闲可盘</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-next btn-sm" disabled={l.counting} onClick={() => startStocktake(l)}>
                        <PlayCircle size={13} /> {l.counting ? '盘点中' : '发起盘点'}
                      </button>
                      {l.occupied === 0 && l.loc_type !== 'receiving' && l.loc_type !== 'sorting' && l.loc_type !== 'intercept' && (
                        <button className="btn btn-danger btn-sm" onClick={() => disable(l)}>停用</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {yard.length === 0 && <Empty text="暂无场区库位" />}
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3><ClipboardList size={16} /> 滚动盘点单</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>单号</th><th>库位</th><th>状态</th><th>时点账存</th><th>已扫描</th><th>差异</th><th>盘点时点</th><th></th></tr></thead>
            <tbody>
              {stocktakes.map((s) => (
                <tr key={s.id}>
                  <td className="mono">#{s.id}</td>
                  <td><b>{s.location_code}</b><div className="text-muted">{s.location_name}</div></td>
                  <td><Badge conf={STOCKTAKE_STATUS[s.status]} /></td>
                  <td className="mono">{s.snapshot_count}</td>
                  <td className="mono">{s.scan_count}</td>
                  <td>{s.diff_count > 0 ? <span style={{ color: s.pending_review ? 'var(--amber)' : 'var(--green)', fontWeight: 700 }}>{s.diff_count} 条{s.pending_review ? `（待复核 ${s.pending_review}）` : ''}</span> : '无'}</td>
                  <td className="mono text-muted">{fmtDateTime(s.snapshot_at)}</td>
                  <td><button className="btn btn-sm" onClick={() => setActiveStocktake(s.id)}>处理 <ChevronRight size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {stocktakes.length === 0 && <Empty text="尚未发起滚动盘点" />}
        </div>
      </div>

      {showCreate && <LocationModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {activeStocktake && <StocktakeModal id={activeStocktake} onClose={() => setActiveStocktake(null)} onChanged={load} />}
    </div>
  );
}
