import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus, RefreshCw, Search, Ban, Undo2, PackageCheck, Forklift,
  ChevronLeft, ChevronRight, MapPin, ArrowRightLeft,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { PACKAGE_STATUS, ABNORMAL_TYPES, INTERCEPT_STATUS, LOCATION_TYPES, fmtDateTime } from '../utils.js';

const PAGE_SIZE = 50;

export default function Packages() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [locations, setLocations] = useState([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: '', held: '', q: '' });
  const [interceptTarget, setInterceptTarget] = useState(null);
  const [interceptForm, setInterceptForm] = useState({ abnormal_type: 'damaged', note: '' });
  const [moveTarget, setMoveTarget] = useState(null);
  const [moveForm, setMoveForm] = useState({ target_location_id: '', note: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ tracking_no: '', destination: '', weight_kg: '', location_id: '' });
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api.packages({ ...filters, page, pageSize: PAGE_SIZE }));
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [filters, page]);

  const loadBase = useCallback(async () => {
    try {
      setLocations(await api.locations({ includeVehicles: false }));
    } catch (e) {
      toast(e.message, 'error');
    }
  }, []);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (fn, okMsg, reloadBase = false) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      load();
      if (reloadBase) loadBase();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const intercept = async () => {
    await run(
      () => api.interceptPackage(interceptTarget.id, interceptForm),
      `运单 ${interceptTarget.tracking_no} 已拦截，位置保持不变`
    );
    setInterceptTarget(null);
    setInterceptForm({ abnormal_type: 'damaged', note: '' });
  };

  const move = async () => {
    if (!moveForm.target_location_id) {
      toast('请选择目标库位', 'error');
      return;
    }
    await run(
      () => api.movePackage({ package_id: moveTarget.id, ...moveForm, target_location_id: Number(moveForm.target_location_id) }),
      `运单 ${moveTarget.tracking_no} 位置已更新`,
      true
    );
    setMoveTarget(null);
    setMoveForm({ target_location_id: '', note: '' });
  };

  const create = async () => {
    if (!createForm.tracking_no.trim() || !createForm.destination.trim()) {
      toast('请填写运单号和目的地', 'error');
      return;
    }
    await run(
      () => api.createPackage({
        ...createForm,
        weight_kg: Number(createForm.weight_kg) || 1,
        location_id: createForm.location_id ? Number(createForm.location_id) : undefined,
      }),
      '到件登记成功',
      true
    );
    setShowCreate(false);
    setCreateForm({ tracking_no: '', destination: '', weight_kg: '', location_id: '' });
  };

  const setF = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const moveableLocations = locations.filter((l) => ['receiving', 'sorting', 'storage', 'intercept'].includes(l.loc_type));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>包裹与异常拦截</h1>
          <div className="sub">到件扫描、分拣上架、移位装车；拦截处置状态与物理位置分开管理</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => { load(); loadBase(); }}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={15} /> 到件登记</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="filter-bar">
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-3)' }} />
              <input
                className="input" style={{ paddingLeft: 30, width: 190 }}
                placeholder="搜索运单号"
                value={filters.q}
                onChange={(e) => setF({ q: e.target.value })}
              />
            </div>
            <select className="input" value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">全部作业状态</option>
              {Object.entries(PACKAGE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input" value={filters.held} onChange={(e) => setF({ held: e.target.value })}>
              <option value="">全部处置状态</option>
              <option value="true">仅拦截中</option>
              <option value="false">不含拦截中</option>
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
                <th>当前位置</th>
                <th>所属车辆</th>
                <th>作业状态</th>
                <th>处置/异常</th>
                <th>到件时间</th>
                <th style={{ width: 250 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className={p.intercept_status === 'held' ? 'row-alert' : ''}>
                  <td className="mono">{p.tracking_no}</td>
                  <td>{p.destination}</td>
                  <td>
                    {p.location_code ? (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                          <MapPin size={13} /> {p.location_code}
                        </div>
                        <div className="text-muted">
                          {p.location_name} · {LOCATION_TYPES[p.location_type]?.label || p.location_type}
                        </div>
                      </div>
                    ) : <span className="text-muted">未定位</span>}
                  </td>
                  <td>
                    {p.plate_no ? (
                      <>
                        <div>{p.plate_no}</div>
                        <div className="text-muted">{p.route_code}</div>
                      </>
                    ) : <span className="text-muted">未分配</span>}
                  </td>
                  <td><Badge conf={PACKAGE_STATUS[p.status]} /></td>
                  <td>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <Badge conf={INTERCEPT_STATUS[p.intercept_status] || INTERCEPT_STATUS.none} />
                      {p.is_abnormal && (
                        <span style={{ color: 'var(--red)', fontSize: 12 }}>
                          {ABNORMAL_TYPES[p.abnormal_type] || p.abnormal_type}
                        </span>
                      )}
                      {p.abnormal_note && <div className="text-muted">{p.abnormal_note}</div>}
                    </div>
                  </td>
                  <td className="mono text-muted">{fmtDateTime(p.created_at)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {p.status === 'pending' && (
                        <button className="btn btn-next btn-sm" onClick={() => run(() => api.sortPackage(p.id), '分拣完成并自动上架', true)}>
                          <PackageCheck size={13} /> 分拣上架
                        </button>
                      )}
                      {p.status === 'sorted' && (
                        <button className="btn btn-next btn-sm" onClick={() => run(() => api.loadPackage(p.id), '已装车', true)}>
                          <Forklift size={13} /> 装车
                        </button>
                      )}
                      {['pending', 'sorted'].includes(p.status) && (
                        <>
                          <button className="btn btn-sm" onClick={() => { setMoveTarget(p); setMoveForm({ target_location_id: '', note: '' }); }}>
                            <ArrowRightLeft size={13} /> 移位
                          </button>
                          {p.intercept_status !== 'held' && (
                            <button className="btn btn-danger btn-sm" onClick={() => { setInterceptTarget(p); setInterceptForm({ abnormal_type: 'damaged', note: '' }); }}>
                              <Ban size={13} /> 拦截
                            </button>
                          )}
                        </>
                      )}
                      {p.intercept_status === 'held' && (
                        <button className="btn btn-sm" onClick={() => run(() => api.releasePackage(p.id), '已解除拦截，位置与作业状态保持不变')}>
                          <Undo2 size={13} /> 解除拦截
                        </button>
                      )}
                      {p.status === 'loaded' && <span className="text-muted">车辆库位</span>}
                      {p.status === 'departed' && <span className="text-muted">已离场</span>}
                      {p.status === 'lost' && <span className="text-muted">盘亏挂账</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.items.length === 0 && <Empty text="没有符合条件的包裹" />}
        </div>
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
          <div className="alert-item warn" style={{ marginBottom: 14 }}>
            <span className="alert-icon"><MapPin size={16} /></span>
            <div className="alert-msg">拦截只改变处置状态；包裹继续保留在当前位置 <b>{interceptTarget.location_code || '未定位'}</b>。</div>
          </div>
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
        </Modal>
      )}

      {moveTarget && (
        <Modal
          title={`移位 / 上架：${moveTarget.tracking_no}`}
          onClose={() => setMoveTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setMoveTarget(null)}>取消</button>
              <button className="btn btn-primary" onClick={move}>确认移位</button>
            </>
          }
        >
          <div className="form-row">
            <label>当前位置</label>
            <div className="mono">{moveTarget.location_code || '未定位'} · {moveTarget.location_name}</div>
          </div>
          <div className="form-row">
            <label>目标场区库位 *</label>
            <select className="input" value={moveForm.target_location_id} onChange={(e) => setMoveForm({ ...moveForm, target_location_id: e.target.value })}>
              <option value="">请选择库位</option>
              {moveableLocations.map((l) => (
                <option key={l.id} value={l.id} disabled={l.capacity && l.occupied >= l.capacity}>
                  {l.code} · {l.name}（{l.occupied}/{l.capacity || '∞'}）
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>备注</label>
            <input className="input" placeholder="如：人工找位、整理库位（选填）" value={moveForm.note} onChange={(e) => setMoveForm({ ...moveForm, note: e.target.value })} />
          </div>
        </Modal>
      )}

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
            <label>到件位置</label>
            <select className="input" value={createForm.location_id} onChange={(e) => setCreateForm({ ...createForm, location_id: e.target.value })}>
              <option value="">默认：RECV-01 到件暂存区</option>
              {moveableLocations.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
            </select>
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
