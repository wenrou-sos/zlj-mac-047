import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, Ban, ClipboardList, PackageCheck, Forklift, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api.js';
import { useToast, useOperator } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { PACKAGE_STATUS, ABNORMAL_TYPES, fmtDateTime } from '../utils.js';

const PAGE_SIZE = 50;

export default function Packages({ goWorkOrders }) {
  const [data, setData] = useState({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: '', abnormal: '', q: '' });
  const [interceptTarget, setInterceptTarget] = useState(null);
  const [interceptForm, setInterceptForm] = useState({ abnormal_type: 'damaged', note: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ tracking_no: '', destination: '', weight_kg: '' });
  const toast = useToast();
  const { operator, setOperator } = useOperator();

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

  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const intercept = async () => {
    if (!operator) {
      toast('请先填写操作人', 'error');
      return;
    }
    await run(
      () => api.interceptPackage(interceptTarget.id, { ...interceptForm, operator }),
      `运单 ${interceptTarget.tracking_no} 已拦截，处置工单已生成`
    );
    setInterceptTarget(null);
    setInterceptForm({ abnormal_type: 'damaged', note: '' });
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>包裹与异常拦截</h1>
          <div className="sub">到件扫描、分拣装车；拦截后生成处置工单，在「异常工单」页办理</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => load()}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={15} /> 到件登记</button>
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
                <th>异常信息</th>
                <th>到件时间</th>
                <th style={{ width: 220 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className={p.status === 'intercepted' ? 'row-alert' : ''}>
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
                  <td><Badge conf={PACKAGE_STATUS[p.status]} /></td>
                  <td>
                    {p.is_abnormal ? (
                      <div>
                        <span style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13 }}>
                          {ABNORMAL_TYPES[p.abnormal_type] || p.abnormal_type}
                        </span>
                        {p.abnormal_note && <div className="text-muted">{p.abnormal_note}</div>}
                        {p.open_work_orders > 0 && (
                          <div style={{ color: 'var(--amber)', fontSize: 12, fontWeight: 600 }}>
                            未结工单 {p.open_work_orders} 张
                          </div>
                        )}
                      </div>
                    ) : p.status === 'returned' ? (
                      <div className="text-muted">退回：{p.return_destination || '—'}</div>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="mono text-muted">{fmtDateTime(p.created_at)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {p.status === 'pending' && (
                        <>
                          <button className="btn btn-next btn-sm" onClick={() => run(() => api.sortPackage(p.id), '分拣完成')}>
                            <PackageCheck size={13} /> 分拣
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => { setInterceptTarget(p); setInterceptForm({ abnormal_type: 'damaged', note: '' }); }}>
                            <Ban size={13} /> 拦截
                          </button>
                        </>
                      )}
                      {p.status === 'sorted' && (
                        <>
                          <button className="btn btn-next btn-sm" onClick={() => run(() => api.loadPackage(p.id), '已装车')}>
                            <Forklift size={13} /> 装车
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => { setInterceptTarget(p); setInterceptForm({ abnormal_type: 'damaged', note: '' }); }}>
                            <Ban size={13} /> 拦截
                          </button>
                        </>
                      )}
                      {p.status === 'intercepted' && (
                        <>
                          <button className="btn btn-next btn-sm" onClick={goWorkOrders}>
                            <ClipboardList size={13} /> 处置工单
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => { setInterceptTarget(p); setInterceptForm({ abnormal_type: 'damaged', note: '' }); }}>
                            <Ban size={13} /> 再次登记
                          </button>
                        </>
                      )}
                      {p.status === 'loaded' && <span className="text-muted">已装车发运</span>}
                      {p.status === 'returned' && <span className="text-muted">已退回，不计入待发库存</span>}
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
            <label>操作人 *</label>
            <input className="input" placeholder="登记人姓名" value={operator} onChange={(e) => setOperator(e.target.value.trim())} />
          </div>
          <div className="form-row">
            <label>备注说明</label>
            <input className="input" placeholder="异常情况描述（选填）" value={interceptForm.note} onChange={(e) => setInterceptForm({ ...interceptForm, note: e.target.value })} />
          </div>
          <div className="alert-item warn" style={{ marginBottom: 0 }}>
            <span className="alert-icon"><Ban size={16} /></span>
            <div className="alert-msg">
              拦截后将<b>生成独立处置工单</b>并禁止装车，需经「认领 → 处理 → 提交结论 → 复核」结案后方可恢复。
              {interceptTarget.status === 'intercepted' && (
                <div style={{ marginTop: 4 }}>该件已有拦截记录，本次将<b>另建新工单</b>，与历史工单分别留档。</div>
              )}
            </div>
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
            <label>重量 (kg)</label>
            <input className="input" type="number" min="0" step="0.1" placeholder="默认 1 kg" value={createForm.weight_kg} onChange={(e) => setCreateForm({ ...createForm, weight_kg: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
