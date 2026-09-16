import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, Search, ChevronLeft, ChevronRight, ClipboardList,
  UserCheck, ArrowRightLeft, Paperclip, Send, ShieldCheck, Ban,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast, useAuth } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { WORK_ORDER_STATUS, CONCLUSIONS, ABNORMAL_TYPES, WO_ACTIONS, fmtDateTime } from '../utils.js';

const PAGE_SIZE = 50;

export default function WorkOrders() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [summary, setSummary] = useState(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: '', q: '' });
  const [detail, setDetail] = useState(null);
  const toast = useToast();
  const { user } = useAuth();

  const load = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([
        api.workOrders({ ...filters, page, pageSize: PAGE_SIZE }),
        api.abnormalStats(),
      ]);
      setData(list);
      setSummary(stats.summary);
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [filters, page]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const openDetail = async (id) => {
    try {
      setDetail(await api.workOrder(id));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const setF = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>异常处置工单</h1>
          <div className="sub">每次拦截生成独立工单：认领 → 处理 → 提交结论 → 复核结案，全程留档</div>
        </div>
        <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
      </div>

      {/* 状态汇总 */}
      {summary && (
        <div className="wo-summary">
          {[
            ['待认领', summary.unclaimed, '#b45309'],
            ['处理中', summary.processing, '#1d4ed8'],
            ['待复核', summary.pending_review, '#7c3aed'],
            ['已结案', summary.closed, '#15803d'],
          ].map(([label, n, color]) => (
            <div key={label} className="wo-summary-item">
              <b className="mono" style={{ color }}>{n}</b>
              <span>{label}</span>
            </div>
          ))}
          <div className="wo-summary-item">
            <b className="mono">{summary.reject_total}</b>
            <span>累计驳回</span>
          </div>
        </div>
      )}

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
              {Object.entries(WORK_ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <span className="text-muted">共 {data.total} 张工单</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>工单号</th>
                <th>运单号 / 目的地</th>
                <th>异常类型</th>
                <th>状态</th>
                <th>处理人</th>
                <th>处理结论</th>
                <th>提交 / 复核</th>
                <th>创建时间</th>
                <th style={{ width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((w) => (
                <tr key={w.id} className={w.status === 'pending_review' ? 'row-warn' : ''}>
                  <td className="mono">#{w.id}</td>
                  <td>
                    <div className="mono">{w.tracking_no}</div>
                    <div className="text-muted">{w.destination}</div>
                  </td>
                  <td>
                    <span style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13 }}>
                      {ABNORMAL_TYPES[w.abnormal_type] || w.abnormal_type}
                    </span>
                    {w.note && <div className="text-muted">{w.note}</div>}
                  </td>
                  <td><Badge conf={WORK_ORDER_STATUS[w.status]} /></td>
                  <td>{w.assignee || <span className="text-muted">未认领</span>}</td>
                  <td>
                    {w.conclusion ? <Badge conf={CONCLUSIONS[w.conclusion]} /> : <span className="text-muted">—</span>}
                    {w.conclusion === 'return' && w.return_destination && (
                      <div className="text-muted">{w.return_destination}</div>
                    )}
                  </td>
                  <td>
                    <div>{w.submitted_by || '—'}{w.reviewed_by ? ` / ${w.reviewed_by}` : ''}</div>
                    {w.reject_count > 0 && <div className="text-muted">被驳回 {w.reject_count} 次</div>}
                  </td>
                  <td className="mono text-muted">{fmtDateTime(w.created_at)}</td>
                  <td>
                    <button className="btn btn-next btn-sm" onClick={() => openDetail(w.id)}>
                      <ClipboardList size={13} /> 办理
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.items.length === 0 && <Empty text="没有符合条件的工单" />}
        </div>
        {data.total > 0 && (
          <div className="card-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
            <span className="text-muted">
              第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} 张，共 {data.total} 张
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

      {detail && (
        <WorkOrderDetail
          detail={detail}
          user={user}
          onClose={() => setDetail(null)}
          onChanged={() => { openDetail(detail.id); load(); }}
        />
      )}
    </div>
  );
}

// 工单详情 + 办理操作
function WorkOrderDetail({ detail: w, user, onClose, onChanged }) {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [transferTo, setTransferTo] = useState('');
  const [evidence, setEvidence] = useState('');
  const [conclusion, setConclusion] = useState({ conclusion: 'repair_release', note: '', return_destination: '' });
  const [reviewNote, setReviewNote] = useState('');

  // 转交对象从系统用户中选择
  useEffect(() => {
    api.users().then(setUsers).catch(() => {});
  }, []);

  const act = async (fn, okMsg) => {
    if (!user) {
      toast('请先在左侧边栏登录', 'error');
      return;
    }
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      setTransferTo('');
      setEvidence('');
      setConclusion({ conclusion: 'repair_release', note: '', return_destination: '' });
      setReviewNote('');
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const me = user?.display_name;
  const isAssignee = me && w.assignee === me;
  const isSubmitter = me && w.submitted_by === me;

  return (
    <Modal
      title={`处置工单 #${w.id}（运单 ${w.tracking_no}）`}
      width={640}
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>关闭</button>}
    >
      {/* 基本信息 */}
      <div className="wo-info">
        <div><label>异常类型</label><b style={{ color: 'var(--red)' }}>{ABNORMAL_TYPES[w.abnormal_type] || w.abnormal_type}</b></div>
        <div><label>工单状态</label><Badge conf={WORK_ORDER_STATUS[w.status]} /></div>
        <div><label>目的地</label>{w.destination}</div>
        <div><label>所属车辆</label>{w.plate_no ? `${w.plate_no}（${w.route_code}）` : '未分配'}</div>
        <div><label>拦截人</label>{w.created_by}</div>
        <div><label>拦截时间</label>{fmtDateTime(w.created_at)}</div>
        {w.note && <div style={{ gridColumn: '1 / -1' }}><label>拦截备注</label>{w.note}</div>}
        {w.assignee && <div><label>当前处理人</label>{w.assignee}</div>}
        {w.submitted_by && <div><label>结论提交人</label>{w.submitted_by}</div>}
        {w.conclusion && (
          <div><label>处理结论</label><Badge conf={CONCLUSIONS[w.conclusion]} /></div>
        )}
        {w.return_destination && <div><label>退回去向</label>{w.return_destination}</div>}
        {w.conclusion_note && <div style={{ gridColumn: '1 / -1' }}><label>结论说明</label>{w.conclusion_note}</div>}
        {w.reviewed_by && (
          <div><label>复核人</label>{w.reviewed_by}{w.reject_count > 0 ? `（累计驳回 ${w.reject_count} 次）` : ''}</div>
        )}
        {w.review_note && <div style={{ gridColumn: '1 / -1' }}><label>复核意见</label>{w.review_note}</div>}
      </div>

      {/* 同一包裹的其他工单（多次异常分别留档） */}
      {w.siblings.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="wo-section-title">该包裹另有 {w.siblings.length} 张异常工单（分别留档）</div>
          {w.siblings.map((s) => (
            <div key={s.id} className="wo-sibling">
              <span className="mono">#{s.id}</span>
              <span style={{ color: 'var(--red)' }}>{ABNORMAL_TYPES[s.abnormal_type] || s.abnormal_type}</span>
              <Badge conf={WORK_ORDER_STATUS[s.status]} />
              {s.conclusion && <Badge conf={CONCLUSIONS[s.conclusion]} />}
              <span className="text-muted mono">{fmtDateTime(s.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* 流转留档 */}
      <div className="wo-section-title">流转记录</div>
      <div className="wo-flow">
        {w.events.map((e) => (
          <div key={e.id} className={`wo-flow-item action-${e.action}`}>
            <div className="wo-flow-head">
              <b>{WO_ACTIONS[e.action] || e.action}</b>
              <span>{e.actor}</span>
              <span className="text-muted mono">{fmtDateTime(e.created_at)}</span>
            </div>
            {e.detail && <div className="wo-flow-detail">{e.detail}</div>}
          </div>
        ))}
      </div>

      {/* 办理操作区 */}
      {!user && (
        <div className="alert-item warn" style={{ marginTop: 16, marginBottom: 0 }}>
          <span className="alert-icon"><Ban size={16} /></span>
          <div className="alert-msg">请先在左侧边栏<b>登录操作员账号</b>，再办理工单。</div>
        </div>
      )}

      {user && w.status === 'open' && (
        <div className="wo-actions">
          <button className="btn btn-primary" onClick={() => act(() => api.claimWorkOrder(w.id), '已认领该工单')}>
            <UserCheck size={14} /> 认领（{me}）
          </button>
        </div>
      )}

      {user && w.status === 'processing' && (
        <div className="wo-actions">
          {!isAssignee && (
            <div className="alert-item warn" style={{ marginBottom: 0 }}>
              <span className="alert-icon"><Ban size={16} /></span>
              <div className="alert-msg">当前处理人为 <b>{w.assignee}</b>，仅其本人可转交、补充证据和提交结论。</div>
            </div>
          )}
          {isAssignee && (
            <>
              <div className="wo-action-row">
                <label><ArrowRightLeft size={13} /> 转交</label>
                <select className="input" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                  <option value="">选择转交对象</option>
                  {users.filter((u) => u.display_name !== me).map((u) => (
                    <option key={u.username} value={u.display_name}>{u.display_name}（@{u.username}）</option>
                  ))}
                </select>
                <button
                  className="btn" disabled={!transferTo}
                  onClick={() => act(() => api.transferWorkOrder(w.id, { to: transferTo }), '已转交')}
                >转交</button>
              </div>
              <div className="wo-action-row">
                <label><Paperclip size={13} /> 补充证据</label>
                <input className="input" placeholder="证据描述，如：现场照片、称重记录" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
                <button
                  className="btn" disabled={!evidence.trim()}
                  onClick={() => act(() => api.addEvidence(w.id, { content: evidence.trim() }), '证据已补充')}
                >提交</button>
              </div>
              <div className="wo-action-row" style={{ alignItems: 'flex-start' }}>
                <label><Send size={13} /> 提交结论</label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <select
                    className="input" value={conclusion.conclusion}
                    onChange={(e) => setConclusion({ ...conclusion, conclusion: e.target.value })}
                  >
                    {Object.entries(CONCLUSIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                  {conclusion.conclusion === 'return' && (
                    <input
                      className="input" placeholder="退回去向 *（如：退回发件人）"
                      value={conclusion.return_destination}
                      onChange={(e) => setConclusion({ ...conclusion, return_destination: e.target.value })}
                    />
                  )}
                  <input
                    className="input" placeholder="结论说明（选填）"
                    value={conclusion.note}
                    onChange={(e) => setConclusion({ ...conclusion, note: e.target.value })}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => act(
                    () => api.submitConclusion(w.id, {
                      conclusion: conclusion.conclusion,
                      conclusion_note: conclusion.note || undefined,
                      return_destination: conclusion.return_destination || undefined,
                    }),
                    '结论已提交，等待复核'
                  )}
                >提交复核</button>
              </div>
            </>
          )}
        </div>
      )}

      {user && w.status === 'pending_review' && (
        <div className="wo-actions">
          {isSubmitter ? (
            <div className="alert-item warn" style={{ marginBottom: 0 }}>
              <span className="alert-icon"><Ban size={16} /></span>
              <div className="alert-msg">该结论由 <b>{w.submitted_by}</b> 提交，<b>提交人与复核人不能是同一人</b>，请其他同事复核。</div>
            </div>
          ) : (
            <div className="wo-action-row" style={{ alignItems: 'flex-start' }}>
              <label><ShieldCheck size={13} /> 复核</label>
              <input
                className="input" placeholder="复核意见（选填）"
                value={reviewNote} onChange={(e) => setReviewNote(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => act(() => api.reviewWorkOrder(w.id, { decision: 'approve', review_note: reviewNote || undefined }), '复核通过，工单结案')}
                >通过</button>
                <button
                  className="btn btn-danger"
                  onClick={() => act(() => api.reviewWorkOrder(w.id, { decision: 'reject', review_note: reviewNote || undefined }), '已驳回，退回继续处理')}
                >驳回</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
