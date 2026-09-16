import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, RefreshCw, Search, Ban, Undo2, PackageCheck, Forklift, ChevronLeft, ChevronRight,
  ScanLine, AlertTriangle, PackageSearch, CornerUpLeft,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { PACKAGE_STATUS, ABNORMAL_TYPES, SCAN_OUTCOME, fmtDateTime } from '../utils.js';

const PAGE_SIZE = 50;

export default function Packages() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: '', abnormal: '', review: '', q: '' });
  const [interceptTarget, setInterceptTarget] = useState(null);
  const [interceptForm, setInterceptForm] = useState({ abnormal_type: 'damaged', note: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ tracking_no: '', destination: '', weight_kg: '' });
  // 扫描分拣
  const [scanNo, setScanNo] = useState('');
  const [scanResult, setScanResult] = useState(null); // { package, decision }
  // 待判区人工指定格口
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignChuteId, setAssignChuteId] = useState('');
  const [chutes, setChutes] = useState([]);
  // 错分件复核回流
  const [reviewTarget, setReviewTarget] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api.packages({ ...filters, page, pageSize: PAGE_SIZE }));
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [filters, page]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api.chutes().then(setChutes).catch(() => {});
  }, []);

  const run = async (fn, okMsg) => {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'success');
      load();
      return r;
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // 分拣（自动按规则路由；冲突/无匹配时后端会转入待判区）
  const sort = async (id, okText) => {
    const r = await run(() => api.sortPackage(id), null);
    if (!r) return;
    if (r.outcome === 'sorted') {
      toast(`${okText || '分拣完成'} → 格口 ${r.decision.chute?.code || r.package.chute_id}`, 'success');
    } else if (r.outcome === 'pending_review') {
      toast(`已转入待判区：${r.decision.reason}`, 'error');
    }
    if (scanResult?.package?.id === id) setScanResult(null);
  };

  // ── 扫描 ──
  const scan = async () => {
    if (!scanNo.trim()) return;
    try {
      const r = await api.scanPackage(scanNo.trim());
      setScanResult(r);
      // 冲突/无匹配的包裹已被后端当场转入待判区，刷新列表
      if (r.decision.outcome === 'conflict' || r.decision.outcome === 'unmatched') load();
    } catch (e) {
      setScanResult(null);
      toast(e.message, 'error');
    }
  };

  const intercept = async () => {
    await run(
      () => api.interceptPackage(interceptTarget.id, interceptForm),
      `运单 ${interceptTarget.tracking_no} 已拦截`
    );
    setInterceptTarget(null);
    setInterceptForm({ abnormal_type: 'damaged', note: '' });
  };

  // 解除拦截：错分件弹复核框（回流重分），其他异常直接解除
  const release = (p) => {
    if (p.abnormal_type === 'wrong_route') {
      setReviewTarget(p);
      setReviewNote('');
    } else {
      run(() => api.releasePackage(p.id), '已解除拦截');
    }
  };

  const confirmReview = async () => {
    await run(
      () => api.releasePackage(reviewTarget.id, { review_note: reviewNote }),
      `运单 ${reviewTarget.tracking_no} 已复核回流，等待重新分拣（不重复计完成量）`
    );
    setReviewTarget(null);
  };

  const assignChute = async () => {
    if (!assignChuteId) { toast('请选择格口', 'error'); return; }
    const r = await run(() => api.sortPackage(assignTarget.id, { chute_id: Number(assignChuteId) }), null);
    if (r) {
      toast(`已人工指定格口 ${r.decision.chute.code}`, 'success');
      if (scanResult?.package?.id === assignTarget.id) setScanResult(null);
      setAssignTarget(null);
      setAssignChuteId('');
    }
  };

  const create = async () => {
    if (!createForm.tracking_no.trim() || !createForm.destination.trim()) {
      toast('请填写运单号和目的地', 'error');
      return;
    }
    await run(
      () => api.createPackage({ ...createForm, weight_kg: Number(createForm.weight_kg) || 1 }),
      '到件登记成功'
    );
    setShowCreate(false);
    setCreateForm({ tracking_no: '', destination: '', weight_kg: '' });
  };

  const setF = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1); // 筛选变化回到第一页
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const outcomeConf = scanResult ? SCAN_OUTCOME[scanResult.decision.outcome] : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>包裹与异常拦截</h1>
          <div className="sub">扫描给出目标格口与命中原因；冲突/无匹配进待判区，错分件复核后回流重分</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => load()}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={15} /> 到件登记</button>
        </div>
      </div>

      {/* ── 扫描分拣 ── */}
      <div className="card section-gap">
        <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ position: 'relative' }}>
              <ScanLine size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-3)' }} />
              <input
                className="input" style={{ paddingLeft: 32, width: 260 }}
                placeholder="扫描 / 输入运单号后回车"
                value={scanNo}
                onChange={(e) => setScanNo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && scan()}
                autoFocus
              />
            </div>
            <button className="btn btn-primary" onClick={scan}><ScanLine size={14} /> 扫描</button>
          </div>

          {scanResult && (
            <div
              className="alert-item"
              style={{
                flex: 1, minWidth: 320, marginBottom: 0,
                background: outcomeConf.bg, borderColor: outcomeConf.color + '44',
              }}
            >
              <span className="alert-icon" style={{ color: outcomeConf.color }}>
                {scanResult.decision.outcome === 'routed' ? <PackageCheck size={20} /> : <AlertTriangle size={20} />}
              </span>
              <div className="alert-msg">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <b className="mono">{scanResult.package.tracking_no}</b>
                  <span className="text-muted">{scanResult.package.destination} · {scanResult.package.weight_kg}kg</span>
                  {scanResult.decision.chute && (
                    <span style={{ fontSize: 20, fontWeight: 800, color: outcomeConf.color }}>
                      → {scanResult.decision.chute.code}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                  {scanResult.decision.reason}
                  {scanResult.decision.version_no > 0 && <span className="text-muted">（规则 v{scanResult.decision.version_no}）</span>}
                  {(scanResult.decision.outcome === 'conflict' || scanResult.decision.outcome === 'unmatched') && (
                    <b style={{ color: '#b45309' }}> · 已转入待判区</b>
                  )}
                </div>
              </div>
              {scanResult.decision.outcome === 'routed' && (
                <button className="btn btn-primary btn-sm" onClick={() => sort(scanResult.package.id, '已分拣')}>
                  <PackageCheck size={13} /> 确认分拣
                </button>
              )}
              {(scanResult.decision.outcome === 'conflict' || scanResult.decision.outcome === 'unmatched') && (
                <button className="btn btn-next btn-sm" onClick={() => { setAssignTarget(scanResult.package); setAssignChuteId(''); }}>
                  <PackageSearch size={13} /> 指定格口
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="filter-bar">
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-3)' }} />
              <input
                className="input" style={{ paddingLeft: 30, width: 200 }}
                placeholder="搜索运单号"
                value={filters.q}
                onChange={(e) => setF({ q: e.target.value })}
              />
            </div>
            <select className="input" value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">全部状态</option>
              {Object.entries(PACKAGE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input" value={filters.abnormal} onChange={(e) => setF({ abnormal: e.target.value })}>
              <option value="">全部包裹</option>
              <option value="true">仅异常件</option>
            </select>
            <select className="input" value={filters.review} onChange={(e) => setF({ review: e.target.value })}>
              <option value="">全部包裹</option>
              <option value="true">仅待判区</option>
            </select>
            <span className="text-muted">共 {data.total} 件</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>运单号</th>
                <th>目的地</th>
                <th>重量</th>
                <th>所属车辆</th>
                <th>状态</th>
                <th>格口 / 命中信息</th>
                <th>异常信息</th>
                <th>到件时间</th>
                <th style={{ width: 240 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className={p.status === 'intercepted' ? 'row-alert' : p.needs_review ? 'row-warn' : ''}>
                  <td className="mono">{p.tracking_no}</td>
                  <td>{p.destination}</td>
                  <td className="mono">{p.weight_kg} kg</td>
                  <td>
                    {p.plate_no ? (
                      <>
                        <div>{p.plate_no}</div>
                        <div className="text-muted">{p.route_code}</div>
                      </>
                    ) : <span className="text-muted">未分配</span>}
                  </td>
                  <td>
                    <Badge conf={PACKAGE_STATUS[p.status]} />
                    {p.needs_review && (
                      <span className="badge" style={{ color: '#b45309', background: '#fef3c7', marginLeft: 4 }}>
                        <span className="dot" />待判
                      </span>
                    )}
                  </td>
                  <td>
                    {p.chute_code ? (
                      <div>
                        <b className="mono">{p.chute_code}</b>
                        {p.rule_version_no > 0 && <span className="text-muted"> · v{p.rule_version_no}</span>}
                        {p.resorted_at && <span className="text-muted">（重分）</span>}
                        {p.hit_reason && <div className="text-muted" style={{ maxWidth: 220 }}>{p.hit_reason}</div>}
                      </div>
                    ) : p.needs_review ? (
                      <div className="text-muted" style={{ maxWidth: 220, color: '#b45309' }}>{p.hit_reason || '等待人工判定'}</div>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td>
                    {p.is_abnormal ? (
                      <div>
                        <span style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13 }}>
                          {ABNORMAL_TYPES[p.abnormal_type] || p.abnormal_type}
                        </span>
                        {p.abnormal_note && <div className="text-muted">{p.abnormal_note}</div>}
                      </div>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="mono text-muted">{fmtDateTime(p.created_at)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {p.status === 'pending' && !p.needs_review && (
                        <>
                          <button className="btn btn-next btn-sm" onClick={() => sort(p.id)}>
                            <PackageCheck size={13} /> 分拣
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => { setInterceptTarget(p); setInterceptForm({ abnormal_type: 'damaged', note: '' }); }}>
                            <Ban size={13} /> 拦截
                          </button>
                        </>
                      )}
                      {p.status === 'pending' && p.needs_review && (
                        <button className="btn btn-next btn-sm" onClick={() => { setAssignTarget(p); setAssignChuteId(''); }}>
                          <PackageSearch size={13} /> 指定格口
                        </button>
                      )}
                      {p.status === 'sorted' && (
                        <>
                          <button className="btn btn-next btn-sm" onClick={() => run(() => api.loadPackage(p.id), '已装车')}>
                            <Forklift size={13} /> 装车
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => { setInterceptTarget(p); setInterceptForm({ abnormal_type: 'wrong_route', note: '' }); }}>
                            <Ban size={13} /> 拦截
                          </button>
                        </>
                      )}
                      {p.status === 'intercepted' && (
                        <button className="btn btn-sm" onClick={() => release(p)}>
                          {p.abnormal_type === 'wrong_route'
                            ? <><CornerUpLeft size={13} /> 复核回流</>
                            : <><Undo2 size={13} /> 解除拦截</>}
                        </button>
                      )}
                      {p.status === 'loaded' && <span className="text-muted">已装车发运</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.items.length === 0 && <Empty text="没有符合条件的包裹" />}
        </div>
        {/* 分页栏 */}
        {data.total > 0 && (
          <div className="card-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
            <span className="text-muted">
              第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} 件，共 {data.total} 件
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={14} /> 上一页
              </button>
              <span className="text-muted mono">{page} / {totalPages}</span>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                下一页 <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 拦截弹窗 */}
      {interceptTarget && (
        <Modal
          title={`拦截运单 ${interceptTarget.tracking_no}`}
          onClose={() => setInterceptTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setInterceptTarget(null)}>取消</button>
              <button className="btn btn-danger" onClick={intercept}><Ban size={14} /> 确认拦截</button>
            </>
          }
        >
          <div className="form-row">
            <label>异常类型 *</label>
            <select className="input" value={interceptForm.abnormal_type} onChange={(e) => setInterceptForm({ ...interceptForm, abnormal_type: e.target.value })}>
              {Object.entries(ABNORMAL_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label>备注说明</label>
            <input className="input" placeholder="异常情况描述（选填）" value={interceptForm.note} onChange={(e) => setInterceptForm({ ...interceptForm, note: e.target.value })} />
          </div>
          <div className="alert-item warn" style={{ marginBottom: 0 }}>
            <span className="alert-icon"><Ban size={16} /></span>
            <div className="alert-msg">拦截后该件将<b>禁止装车发运</b>，需在处理完成后手动解除拦截。</div>
          </div>
        </Modal>
      )}

      {/* 错分件复核回流弹窗 */}
      {reviewTarget && (
        <Modal
          title={`错分件复核 · ${reviewTarget.tracking_no}`}
          onClose={() => setReviewTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setReviewTarget(null)}>取消</button>
              <button className="btn btn-primary" onClick={confirmReview}><CornerUpLeft size={14} /> 确认复核，回流重分</button>
            </>
          }
        >
          <div className="form-row">
            <label>复核备注</label>
            <input className="input" placeholder="如：应走 A03 误投 A01，已核实面单" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
          </div>
          <div className="alert-item warn" style={{ marginBottom: 0 }}>
            <span className="alert-icon"><CornerUpLeft size={16} /></span>
            <div className="alert-msg">
              复核后该件将<b>回流到待分拣</b>重新扫描分拣；首次分拣的完成量保留，<b>重分不重复计数</b>。
            </div>
          </div>
        </Modal>
      )}

      {/* 待判区人工指定格口弹窗 */}
      {assignTarget && (
        <Modal
          title={`人工判定 · ${assignTarget.tracking_no}`}
          onClose={() => setAssignTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setAssignTarget(null)}>取消</button>
              <button className="btn btn-primary" onClick={assignChute}><PackageCheck size={14} /> 确认分拣</button>
            </>
          }
        >
          <div className="alert-item warn">
            <span className="alert-icon"><AlertTriangle size={16} /></span>
            <div className="alert-msg">
              {assignTarget.destination} · {assignTarget.weight_kg}kg — {assignTarget.hit_reason || '规则未能自动路由'}
            </div>
          </div>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>指定目标格口 *</label>
            <select className="input" value={assignChuteId} onChange={(e) => setAssignChuteId(e.target.value)}>
              <option value="">请选择格口</option>
              {chutes.filter((c) => c.status === 'active').map((c) => (
                <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {/* 到件登记弹窗 */}
      {showCreate && (
        <Modal
          title="到件登记"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn btn-primary" onClick={create}>登记</button>
            </>
          }
        >
          <div className="form-row">
            <label>运单号 *</label>
            <input className="input" placeholder="如 SF1234567890" value={createForm.tracking_no} onChange={(e) => setCreateForm({ ...createForm, tracking_no: e.target.value })} />
          </div>
          <div className="form-row">
            <label>目的地 *</label>
            <input className="input" placeholder="如 上海" value={createForm.destination} onChange={(e) => setCreateForm({ ...createForm, destination: e.target.value })} />
          </div>
          <div className="form-row">
            <label>重量 (kg)</label>
            <input className="input" type="number" min="0" step="0.1" placeholder="默认 1 kg" value={createForm.weight_kg} onChange={(e) => setCreateForm({ ...createForm, weight_kg: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
