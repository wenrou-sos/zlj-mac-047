import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Hand, MessageSquarePlus, CheckCircle2, History, UserCog,
  AlertOctagon, Clock, Inbox, ChevronRight, ShieldAlert, ListChecks,
} from 'lucide-react';
import { api, currentUser, ensureUser, setCurrentUser } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { ALERT_STATUS, STAGE_LABEL, ALERT_LOG_LABEL, fmtAgo, fmtDateTime } from '../utils.js';

const TABS = [
  { key: 'active', label: '全部待办', icon: ListChecks },
  { key: 'unassigned', label: '待认领', icon: Inbox },
  { key: 'mine', label: '我的跟进', icon: UserCog },
  { key: 'escalated', label: '主管待办', icon: ShieldAlert },
  { key: 'history', label: '历史事件', icon: History },
];

function EventRow({ ev, onOpen, onClaim, onNote, onResolve, onReassign, me }) {
  const overdue = ev.level === 'overdue';
  const mine = ev.assigned_to === me;
  return (
    <div className={`ev-row ${overdue ? 'overdue' : 'warn'} ${ev.status === 'escalated' ? 'escalated' : ''}`}>
      <span className="ev-icon">
        {overdue ? <AlertOctagon size={18} /> : <Clock size={18} />}
      </span>
      <div className="ev-main" onClick={() => onOpen(ev)}>
        <div className="ev-title">
          <b>{ev.plate_no}</b>
          <span className="text-muted">{ev.route_code} · {ev.stage_label}环节</span>
          <span className={`ev-level ${overdue ? 'overdue' : 'warn'}`}>{overdue ? '已超时' : '预警'}</span>
          <Badge conf={ALERT_STATUS[ev.status]} />
          {ev.assigned_to && <span className={`ev-assignee ${mine ? 'mine' : ''}`}>跟进：{ev.assigned_to}{mine ? '（我）' : ''}</span>}
        </div>
        <div className="ev-msg">{ev.message}</div>
        <div className="ev-meta">
          <span>首次触发 {fmtDateTime(ev.first_triggered_at)}（{fmtAgo(ev.first_triggered_at)}）</span>
          {ev.acknowledged_at && <span>认领于 {fmtDateTime(ev.acknowledged_at)}</span>}
          {ev.escalated_at && <span className="escalated-text">升级于 {fmtDateTime(ev.escalated_at)}</span>}
          {ev.status === 'recovered' && ev.recovered_at && <span>恢复于 {fmtDateTime(ev.recovered_at)}</span>}
        </div>
      </div>
      {ev.status !== 'recovered' && (
        <div className="ev-actions">
          {!ev.assigned_to && (
            <button className="btn btn-primary btn-sm" onClick={() => onClaim(ev)}><Hand size={13} /> 认领</button>
          )}
          <button className="btn btn-sm" onClick={() => onNote(ev)}><MessageSquarePlus size={13} /> 记录</button>
          {ev.status !== 'resolved' && (
            <button className="btn btn-sm" onClick={() => onResolve(ev)}><CheckCircle2 size={13} /> 处理完成</button>
          )}
          <button className="btn btn-sm" onClick={() => onReassign(ev)}><UserCog size={13} /></button>
          <button className="btn btn-sm icon-only" onClick={() => onOpen(ev)} title="处理台账"><ChevronRight size={15} /></button>
        </div>
      )}
    </div>
  );
}

export default function Alerts() {
  const [tab, setTab] = useState('active');
  const [events, setEvents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [me, setMe] = useState(currentUser());
  const [detail, setDetail] = useState(null);
  const [noteTarget, setNoteTarget] = useState(null);
  const [resolveTarget, setResolveTarget] = useState(null);
  const [reassignTarget, setReassignTarget] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [reassignTo, setReassignTo] = useState('');
  const toast = useToast();

  const load = async () => {
    try {
      const user = currentUser();
      const scope = tab === 'mine' ? 'mine' : tab;
      const [list, sum] = await Promise.all([
        api.alerts(scope, user),
        api.todoSummary(user),
      ]);
      setEvents(list);
      setSummary(sum);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [tab, me]);

  const openDetail = async (ev) => {
    try { setDetail(await api.alertDetail(ev.id)); } catch (e) { toast(e.message, 'error'); }
  };

  const requireMe = () => {
    const u = ensureUser();
    setMe(u);
    return u;
  };

  const claim = async (ev) => {
    if (!requireMe()) return;
    try {
      const r = await api.claimAlert(ev.id);
      toast(r.claimed ? `已认领 ${ev.plate_no} 的${ev.stage_label}预警` : '你已认领过该预警', r.claimed ? 'success' : 'info');
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const submitNote = async () => {
    if (!noteText.trim()) return toast('请填写处理记录', 'error');
    if (!requireMe()) return;
    try {
      await api.addAlertNote(noteTarget.id, noteText.trim());
      toast('处理记录已追加', 'success');
      setNoteTarget(null); setNoteText('');
      if (detail?.id === noteTarget.id) openDetail({ id: noteTarget.id });
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const submitResolve = async () => {
    if (!requireMe()) return;
    try {
      const r = await api.resolveAlert(resolveTarget.id, noteText.trim());
      if (r.status === 'recovered') toast('车辆已恢复，事件关闭', 'success');
      else toast('已标记处理完成；车辆恢复前事件仍留在待办', 'success');
      setResolveTarget(null); setNoteText('');
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const submitReassign = async () => {
    const to = reassignTo.trim();
    if (!to) return toast('请填写改派对象', 'error');
    if (!requireMe()) return;
    try {
      await api.reassignAlert(reassignTarget.id, to);
      toast(`已改派给 ${to}`, 'success');
      setReassignTarget(null); setReassignTo('');
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const counts = useMemo(() => ({
    active: summary?.active ?? 0,
    unassigned: summary?.unassigned ?? 0,
    mine: summary?.mine ?? 0,
    escalated: summary?.escalated ?? 0,
  }), [summary]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>预警事件中心</h1>
          <div className="sub">
            每一次超时都是可认领、可追溯的事件 ·
            {me ? <> 当前操作人：<b>{me}</b></> : ' 尚未设置操作人'}
            <button className="link-btn" onClick={() => {
              const n = (prompt('修改操作人姓名', me || '') || '').trim();
              if (n) { setCurrentUser(n); setMe(n); }
            }}>{me ? '切换' : '设置'}</button>
          </div>
        </div>
        <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
      </div>

      <div className="tab-bar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            <Icon size={14} />
            {label}
            {key !== 'history' && counts[key] > 0 && <span className={`tab-count ${key === 'escalated' ? 'danger' : ''}`}>{counts[key]}</span>}
          </button>
        ))}
      </div>

      {summary && tab !== 'history' && (
        <div className="ev-summary">
          <span>待办 <b className="mono">{summary.active}</b></span>
          <span>待认领 <b className="mono">{summary.unassigned}</b></span>
          <span>我的跟进 <b className="mono">{summary.mine}</b></span>
          <span className="escalated-text">主管待办 <b className="mono">{summary.escalated}</b></span>
          <span>已处理·待恢复 <b className="mono">{summary.resolved_waiting}</b></span>
          <span className="text-muted">红色超时 <b className="mono">{summary.overdue}</b></span>
        </div>
      )}

      <div className="ev-list">
        {events.length === 0
          ? <Empty text={tab === 'history' ? '暂无已恢复的历史事件' : '当前没有需要跟进的预警事件'} />
          : events.map((ev) => (
            <EventRow key={ev.id} ev={ev} me={me}
              onOpen={openDetail} onClaim={claim}
              onNote={(e) => { setNoteTarget(e); setNoteText(''); }}
              onResolve={(e) => { setResolveTarget(e); setNoteText(''); }}
              onReassign={(e) => { setReassignTarget(e); setReassignTo(''); }} />
          ))}
      </div>

      {/* 事件详情 / 处理台账 */}
      {detail && (
        <Modal title={`预警事件 #${detail.id} · ${detail.plate_no} ${detail.stage_label}环节`} onClose={() => setDetail(null)} width={620}>
          <div className="detail-head">
            <Badge conf={ALERT_STATUS[detail.status]} />
            <span className={`ev-level ${detail.level === 'overdue' ? 'overdue' : 'warn'}`}>
              {detail.level === 'overdue' ? '已超时' : '黄色预警'}
            </span>
            <span className="text-muted">{detail.route_code} · {detail.driver_name || '未指派司机'}</span>
          </div>
          <p className="detail-msg">{detail.message}</p>
          <div className="detail-grid">
            <div><label>首次触发</label><span>{fmtDateTime(detail.first_triggered_at)}</span></div>
            <div><label>时限截止</label><span>{fmtDateTime(detail.due_at)}</span></div>
            <div><label>红色超时</label><span>{detail.overdue_at ? fmtDateTime(detail.overdue_at) : '—'}</span></div>
            <div><label>认领确认</label><span>{detail.acknowledged_at ? `${fmtDateTime(detail.acknowledged_at)} · ${detail.assigned_to || ''}` : '无人认领'}</span></div>
            <div><label>升级主管</label><span className="escalated-text">{detail.escalated_at ? fmtDateTime(detail.escalated_at) : '—'}</span></div>
            <div><label>处理完成</label><span>{detail.resolved_at ? `${fmtDateTime(detail.resolved_at)} · ${detail.resolved_by || ''}` : '—'}</span></div>
            <div><label>车辆恢复</label><span>{detail.recovered_at ? fmtDateTime(detail.recovered_at) : '尚未恢复'}</span></div>
            <div><label>采用规则</label><span className="mono">
              {detail.stage === 'departure' ? '以计划发车时间为准'
                : `${STAGE_LABEL[detail.stage]}时限 ${Number(detail.threshold_min)} 分钟 · 阈值 ${Math.round(detail.rule_snapshot?.warn_ratio * 100)}% · 响应期 ${detail.rule_snapshot?.response_timeout_min} 分钟`}
            </span></div>
          </div>
          {detail.escalation_reason && <div className="detail-reason"><ShieldAlert size={14} /> {detail.escalation_reason}</div>}

          <h4 className="detail-logs-title">处理记录</h4>
          <div className="log-timeline">
            {detail.logs.map((l) => (
              <div key={l.id} className="log-item">
                <div className="log-dot" data-action={l.action} />
                <div className="log-body">
                  <div className="log-head">
                    <b>{ALERT_LOG_LABEL[l.action] || l.action}</b>
                    <span>{l.actor || '系统'}</span>
                    <span className="text-muted">{fmtDateTime(l.created_at)}</span>
                  </div>
                  {l.note && <div className="log-note">{l.note}</div>}
                </div>
              </div>
            ))}
          </div>

          {detail.status !== 'recovered' && (
            <div className="detail-footer-actions">
              {!detail.assigned_to && <button className="btn btn-primary btn-sm" onClick={() => { claim(detail); openDetail(detail); }}><Hand size={13} /> 认领</button>}
              <button className="btn btn-sm" onClick={() => { setNoteTarget(detail); setNoteText(''); setDetail(null); }}><MessageSquarePlus size={13} /> 追加记录</button>
              {detail.status !== 'resolved' && <button className="btn btn-sm" onClick={() => { setResolveTarget(detail); setNoteText(''); setDetail(null); }}><CheckCircle2 size={13} /> 处理完成</button>}
              <button className="btn btn-sm" onClick={() => { setReassignTarget(detail); setReassignTo(''); setDetail(null); }}><UserCog size={13} /> 改派</button>
            </div>
          )}
        </Modal>
      )}

      {noteTarget && (
        <Modal title={`追加处理记录 · ${noteTarget.plate_no}`} onClose={() => setNoteTarget(null)}
          footer={<><button className="btn" onClick={() => setNoteTarget(null)}>取消</button>
            <button className="btn btn-primary" onClick={submitNote}>提交记录</button></>}>
          <textarea className="input" rows={4} placeholder="如：已联系维修组 / 已增派人手 / 等待尾单…"
            value={noteText} onChange={(e) => setNoteText(e.target.value)} autoFocus />
        </Modal>
      )}

      {resolveTarget && (
        <Modal title={`标记处理完成 · ${resolveTarget.plate_no}`} onClose={() => setResolveTarget(null)}
          footer={<><button className="btn" onClick={() => setResolveTarget(null)}>取消</button>
            <button className="btn btn-primary" onClick={submitResolve}>确认处理完成</button></>}>
          <p className="text-muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
            仅表示你已完成处置动作；<b>车辆真正恢复前事件仍会留在待办中</b>，不会消失。
          </p>
          <textarea className="input" rows={3} placeholder="处理措施说明（可选）"
            value={noteText} onChange={(e) => setNoteText(e.target.value)} />
        </Modal>
      )}

      {reassignTarget && (
        <Modal title={`改派 · ${reassignTarget.plate_no}`} onClose={() => setReassignTarget(null)}
          footer={<><button className="btn" onClick={() => setReassignTarget(null)}>取消</button>
            <button className="btn btn-primary" onClick={submitReassign}>确认改派</button></>}>
          <input className="input" placeholder="改派给（姓名）" value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)} autoFocus />
        </Modal>
      )}
    </div>
  );
}
