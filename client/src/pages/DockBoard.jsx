import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Megaphone, ArrowUpToLine, CalendarClock, Ban, RotateCcw,
  Plus, Power, XCircle, CircleCheck, Clock, Timer, Truck, ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty, ReasonModal } from '../components/common.jsx';
import {
  VEHICLE_TYPES, APPOINTMENT_STATUS, fmtDateTime, fmtTime, fmtDur, minutesBetween,
} from '../utils.js';

const TYPE_KEYS = ['small', 'medium', 'large', 'extra_large'];

// 把本地 datetime-local 值按浏览器时区转 ISO
const toISO = (v) => (v ? new Date(v).toISOString() : null);

function TypeChips({ types }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {TYPE_KEYS.filter((t) => types.includes(t)).map((t) => (
        <span key={t} className="type-chip" style={{ color: VEHICLE_TYPES[t].color, background: VEHICLE_TYPES[t].bg }}>
          {VEHICLE_TYPES[t].label}
        </span>
      ))}
    </span>
  );
}

// 三项分开的计时：排队等待 / 靠台待卸 / 实际卸车
function TimingMetrics({ item, now }) {
  // 排队等待：进队 -> 叫号；尚在队列则走到当前时间
  const waitCall = item.status === 'checked'
    ? minutesBetween(item.queued_at, now)
    : minutesBetween(item.queued_at, item.assigned_at ?? now);
  // 靠台待卸：叫号 -> 实际开卸
  const waitBerth = item.status === 'called'
    ? minutesBetween(item.assigned_at, now)
    : minutesBetween(item.assigned_at, item.assignment_unload_start_at);
  // 实际卸车：开卸 -> 当前（完成时由后端写 released_at，看板不含已完成）
  const unloading = item.status === 'unloading'
    ? minutesBetween(item.assignment_unload_start_at, now)
    : null;

  return (
    <div className="timing-box">
      <div className="timing-item" title="从到场排队到叫号的等待时间">
        <Clock size={12} />
        <span className="text-muted">排队等待</span>
        <b className="mono">{fmtDur(waitCall)}</b>
      </div>
      {item.status !== 'checked' && (
        <div className="timing-item" title="叫号靠台后等待开始卸车">
          <Timer size={12} />
          <span className="text-muted">靠台待卸</span>
          <b className="mono">{fmtDur(waitBerth)}</b>
        </div>
      )}
      {unloading !== null && (
        <div className="timing-item timing-active" title="实际卸车作业时长（卸车结束才释放泊位）">
          <Truck size={12} />
          <span>实际卸车</span>
          <b className="mono">{fmtDur(unloading)}</b>
        </div>
      )}
    </div>
  );
}

function DockCard({ dock, now, onCallNext, onRecall, onDisable, onEnable, onUnloadEnd }) {
  const busy = !!dock.assignment_id;
  const inUse = dock.assignment_status === 'in_use';
  const disabled = dock.status === 'disabled';

  return (
    <div className={`dock-card ${disabled ? 'dock-disabled' : ''} ${busy ? 'dock-busy' : ''} ${inUse ? 'dock-inuse' : ''}`}>
      <div className="dock-head">
        <div>
          <div className="dock-code">{dock.code}</div>
          <div className="dock-name">{dock.dock_name}</div>
        </div>
        {disabled
          ? <Badge conf={{ color: '#b91c1c', bg: '#fee2e2', label: '停用中' }} />
          : busy
            ? <Badge conf={inUse ? APPOINTMENT_STATUS.unloading : APPOINTMENT_STATUS.called} />
            : <Badge conf={{ color: '#15803d', bg: '#dcfce7', label: '空闲' }} />}
      </div>

      <div className="dock-types"><TypeChips types={dock.allowed_types} /></div>

      {disabled ? (
        <div className="dock-disabled-reason">
          <Ban size={13} /> {dock.disabled_reason}
          <div className="text-muted" style={{ marginTop: 4 }}>{fmtDateTime(dock.disabled_at)} 停用</div>
        </div>
      ) : busy ? (
        <div className="dock-vehicle">
          <div className="dock-plate">
            {dock.plate_no}
            {dock.vehicle_is_late && <span className="tag tag-late">迟到重排</span>}
            {dock.priority_reason && <span className="tag tag-prio">优先</span>}
          </div>          <div className="text-muted">{dock.route_code} · {VEHICLE_TYPES[dock.vehicle_type]?.label}</div>
          <div className="text-muted">叫号于 {fmtTime(dock.assigned_at)}</div>
          <TimingMetrics item={{
            status: inUse ? 'unloading' : 'called',
            assigned_at: dock.assigned_at,
            assignment_unload_start_at: dock.assignment_unload_start_at,
          }} now={now} />
        </div>
      ) : (
        <div className="dock-empty-hint">暂无车辆占用，预约车辆不会预占月台</div>
      )}

      <div className="dock-actions">
        {disabled ? (
          <button className="btn btn-sm" onClick={() => onEnable(dock)}><Power size={13} /> 恢复启用</button>
        ) : !busy ? (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => onCallNext(dock)}>
              <Megaphone size={13} /> 叫下一位
            </button>
            <button className="btn btn-danger btn-sm" onClick={() => onDisable(dock)}><Ban size={13} /> 临时停用</button>
          </>
        ) : inUse ? (
          <button className="btn btn-next btn-sm" onClick={() => onUnloadEnd(dock)}>
            <CircleCheck size={13} /> 完成卸车并释放
          </button>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => onRecall(dock)}>
            <RotateCcw size={13} /> 召回重排
          </button>
        )}
      </div>
    </div>
  );
}

function QueueRow({ q, now, onCall, onPriority, onCancel }) {
  return (
    <div className={`queue-row ${q.is_late ? 'is-late' : ''} ${q.requeued ? 'is-requeued' : ''}`}>
      <div className="queue-rank">
        <span className="rank-no">#{q.rank}</span>
        {q.is_late
          ? <span className="tag tag-late">迟到重排</span>
          : q.requeued
            ? <span className="tag tag-recall">召回重排</span>
            : q.priority > 100 && <span className="tag tag-prio">优先</span>}
      </div>
      <div className="queue-main">
        <div className="queue-title">
          <b>{q.plate_no}</b>
          <span className="type-chip" style={{ color: VEHICLE_TYPES[q.vehicle_type].color, background: VEHICLE_TYPES[q.vehicle_type].bg }}>
            {VEHICLE_TYPES[q.vehicle_type].label}
          </span>
        </div>
        <div className="text-muted">{q.route_code} · 预约 {fmtDateTime(q.slot_start)}–{fmtTime(q.slot_end)}</div>
        {q.priority_reason && <div className="queue-reason">优先原因：{q.priority_reason}</div>}
        {q.recall_reason && <div className="queue-reason">召回原因：{q.recall_reason}（重新排队尾）</div>}
        <TimingMetrics item={q} now={now} />
      </div>
      <div className="queue-ops">
        <button className="btn btn-primary btn-sm" onClick={() => onCall(q)}>
          <Megaphone size={13} /> 叫号
        </button>
        <button className="btn btn-sm" onClick={() => onPriority(q)} title="有理由的插队">
          <ArrowUpToLine size={13} /> 插队
        </button>
        <button className="btn btn-danger btn-sm" onClick={() => onCancel(q)}><XCircle size={13} /></button>
      </div>
    </div>
  );
}

function BookedRow({ a, onReschedule, onCancel }) {
  return (
    <div className="booked-row">
      <div>
        <b>{a.plate_no}</b>
        <span className="type-chip" style={{ marginLeft: 8, color: VEHICLE_TYPES[a.vehicle_type].color, background: VEHICLE_TYPES[a.vehicle_type].bg }}>
          {VEHICLE_TYPES[a.vehicle_type].label}
        </span>
        <div className="text-muted">
          {a.route_code} · {fmtDateTime(a.slot_start)}–{fmtTime(a.slot_end)}
          {a.reschedule_count > 0 && <span style={{ color: 'var(--amber)' }}> · 已改约 {a.reschedule_count} 次</span>}
        </div>
        {a.reschedule_reason && <div className="queue-reason">上次改约：{a.reschedule_reason}</div>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm" onClick={() => onReschedule(a)}><CalendarClock size={13} /> 改约</button>
        <button className="btn btn-danger btn-sm" onClick={() => onCancel(a)}><Ban size={13} /> 取消</button>
      </div>
    </div>
  );
}

export default function DockBoard() {
  const [docks, setDocks] = useState([]);
  const [queue, setQueue] = useState([]);
  const [called, setCalled] = useState([]);
  const [booked, setBooked] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [updatedAt, setUpdatedAt] = useState(null);
  const toast = useToast();

  // 弹窗状态
  const [showDockForm, setShowDockForm] = useState(false);
  const [action, setAction] = useState(null); // {type, target}
  const [resched, setResched] = useState(null);
  const [reschedForm, setReschedForm] = useState({ start: '', end: '', reason: '' });

  const load = async (silent) => {
    try {
      const [ds, board, bks] = await Promise.all([
        api.docks(), api.board(), api.appointments({ status: 'booked' }),
      ]);
      setDocks(ds);
      setQueue(board.queue);
      setCalled(board.called);
      setBooked(bks);
      setUpdatedAt(new Date());
    } catch (e) {
      if (!silent) toast(e.message, 'error');
    }
  };

  useEffect(() => {
    load();
    const dataTimer = setInterval(() => load(true), 15000);
    const tickTimer = setInterval(() => setNow(Date.now()), 5000);
    return () => { clearInterval(dataTimer); clearInterval(tickTimer); };
  }, []);

  const run = async (fn, okMsg) => {
    try {
      await fn();
      toast(okMsg, 'success');
      setAction(null);
      await load(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const stats = useMemo(() => ({
    total: docks.length,
    free: docks.filter((d) => d.status === 'active' && !d.assignment_id).length,
    busy: docks.filter((d) => d.assignment_id).length,
    disabled: docks.filter((d) => d.status === 'disabled').length,
  }), [docks]);

  const confirmReason = async (reason) => {
    const { type, target } = action;
    if (type === 'callnext') return run(() => api.callNextDock(target.id), `已为 ${target.code} 叫下一位`);
    if (type === 'recall') return run(() => api.recallAppointment(target.id, reason), '已召回，车辆重新排队尾');
    if (type === 'disable') return run(() => api.disableDock(target.id, reason), `${target.code} 已临时停用`);
    if (type === 'priority') return run(() => api.prioritizeAppointment(target.id, reason), '已调整到队前优先叫号');
    if (type === 'cancel-q') return run(() => api.cancelAppointment(target.id, reason), '预约已取消');
    if (type === 'cancel-b') return run(() => api.cancelAppointment(target.id, reason), '预约已取消');
  };

  const rescheduleSubmit = () => {
    const { start, end, reason } = reschedForm;
    if (!start || !end) { toast('请选择新的预约时段', 'error'); return; }
    if (!reason.trim()) { toast('改约必须填写原因', 'error'); return; }
    run(
      () => api.rescheduleAppointment(resched.id, { slot_start: toISO(start), slot_end: toISO(end), reason: reason.trim() }),
      '改约成功',
    ).then(() => setResched(null));
  };

  const reasonModalTitle = {
    disable: '临时停用月台', priority: '有理由插队', recall: '召回已叫号车辆',
    'cancel-q': '取消排队预约', 'cancel-b': '取消预约',
  }[action?.type];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>月台调度</h1>
          <div className="sub">
            预约不占泊位 · 叫号才靠台 · 卸车结束才释放
            {updatedAt && <span> · 更新于 {updatedAt.toLocaleTimeString('zh-CN')}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={() => load()}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowDockForm(true)}><Plus size={15} /> 新增月台</button>
        </div>
      </div>

      <div className="dock-stat-row">
        <div className="dock-stat"><b>{stats.total}</b><span>月台总数</span></div>
        <div className="dock-stat free"><b>{stats.free}</b><span>空闲可叫号</span></div>
        <div className="dock-stat busy"><b>{stats.busy}</b><span>占用中</span></div>
        <div className="dock-stat disabled"><b>{stats.disabled}</b><span>临时停用</span></div>
        <div className="dock-stat queue"><b>{queue.length}</b><span>候叫车辆</span></div>
      </div>

      <div className="board-layout">
        <div>
          <div className="card section-gap">
            <div className="card-header"><h3><Truck size={16} /> 月台占用实况</h3></div>
            <div className="dock-grid">
              {docks.map((d) => (
                <DockCard
                  key={d.id}
                  dock={d}
                  now={now}
                  onCallNext={(dock) => run(() => api.callNextDock(dock.id), `${dock.code} 叫号成功`)}
                  onRecall={(dock) => setAction({ type: 'recall', target: { id: dock.appointment_id } })}
                  onDisable={(dock) => setAction({ type: 'disable', target: dock })}
                  onEnable={(dock) => run(() => api.enableDock(dock.id), `${dock.code} 已恢复`)}
                  onUnloadEnd={(dock) => run(() => api.vehicleAction(dock.vehicle_id, 'unload-end'), `${dock.plate_no} 卸车完成，${dock.code} 已释放`)}
                />
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3><CalendarClock size={16} /> 未到场预约（{booked.length}）</h3>
              <span className="text-muted">预约仅排班，不占用月台</span>
            </div>
            {booked.length === 0 ? <Empty text="暂无未到场预约" /> : (
              <div className="card-body" style={{ paddingTop: 8, paddingBottom: 8 }}>
                {booked.map((a) => (
                  <BookedRow
                    key={a.id}
                    a={a}
                    onReschedule={(x) => { setResched(x); setReschedForm({ start: '', end: '', reason: '' }); }}
                    onCancel={(x) => setAction({ type: 'cancel-b', target: x })}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="board-side">
          <div className="card section-gap">
            <div className="card-header">
              <h3><Megaphone size={16} /> 现场叫号队列</h3>
              <span className="text-muted">{queue.length} 辆候叫</span>
            </div>
            {queue.length === 0 ? <Empty text="暂无候叫车辆" /> : (
              <div>
                {queue.map((q) => (
                  <QueueRow
                    key={q.id}
                    q={q}
                    now={now}
                    onCall={(x) => run(() => api.callAppointment(x.id), `${x.plate_no} 叫号成功`)}
                    onPriority={(x) => setAction({ type: 'priority', target: x })}
                    onCancel={(x) => setAction({ type: 'cancel-q', target: x })}
                  />
                ))}
                <div className="queue-rule">
                  排序：召回车绝对队尾；站长有理由插队（优先）可提前，同优先级内迟到重排的车在正常车之后；再按预约时段、到场顺序。
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h3><ChevronRight size={16} /> 已叫号 / 卸车中（{called.length}）</h3>
            </div>
            {called.length === 0 ? <Empty text="暂无靠台车辆" /> : (
              <div>
                {called.map((c) => (
                  <div key={c.id} className="called-row">
                    <div className="queue-title">
                      <b>{c.plate_no}</b>
                      <span className="dock-tag">{c.dock_code}</span>
                      <Badge conf={APPOINTMENT_STATUS[c.status]} />
                    </div>
                    <div className="text-muted">{c.route_code} · {VEHICLE_TYPES[c.vehicle_type].label}</div>
                    <TimingMetrics item={c} now={now} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {c.status === 'called' && (
                        <button className="btn btn-danger btn-sm" onClick={() => setAction({ type: 'recall', target: c })}>
                          <RotateCcw size={13} /> 召回重排
                        </button>
                      )}
                      {c.status === 'unloading' && (
                        <button
                          className="btn btn-next btn-sm"
                          onClick={() => run(() => api.vehicleAction(c.vehicle_id, 'unload-end'), `${c.plate_no} 卸车完成，${c.dock_code} 已释放`)}
                        >
                          <CircleCheck size={13} /> 完成卸车并释放
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showDockForm && <DockFormModal onClose={() => setShowDockForm(false)} onSaved={() => { setShowDockForm(false); load(true); }} />}

      {action && ['disable', 'priority', 'recall', 'cancel-q', 'cancel-b'].includes(action.type) && (
        <ReasonModal
          title={reasonModalTitle}
          danger={['disable', 'recall', 'cancel-q', 'cancel-b'].includes(action.type)}
          confirmText={action.type === 'priority' ? '调整优先级' : action.type === 'recall' ? '召回并重排' : '确认'}
          placeholder={
            action.type === 'priority' ? '如：冷链货物，站长批准优先卸车'
            : action.type === 'recall' ? '如：月台设备突发故障 / 司机手续不全'
            : '请说明原因，操作将记录在案'
          }
          onClose={() => setAction(null)}
          onConfirm={confirmReason}
        />
      )}

      {resched && (
        <Modal
          title={`改约 · ${resched.plate_no}`}
          onClose={() => setResched(null)}
          footer={
            <>
              <button className="btn" onClick={() => setResched(null)}>取消</button>
              <button className="btn btn-primary" onClick={rescheduleSubmit}>保存改约</button>
            </>
          }
        >
          <div className="form-row">
            <label>原预约时段</label>
            <div className="text-muted">{fmtDateTime(resched.slot_start)} – {fmtDateTime(resched.slot_end)}</div>
          </div>
          <div className="grid-2">
            <div className="form-row">
              <label>新开始时间 *</label>
              <input className="input" type="datetime-local" value={reschedForm.start} onChange={(e) => setReschedForm({ ...reschedForm, start: e.target.value })} />
            </div>
            <div className="form-row">
              <label>新结束时间 *</label>
              <input className="input" type="datetime-local" value={reschedForm.end} onChange={(e) => setReschedForm({ ...reschedForm, end: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <label>改约原因（必填）</label>
            <textarea className="input" rows={3} value={reschedForm.reason} onChange={(e) => setReschedForm({ ...reschedForm, reason: e.target.value })} placeholder="如：高速封路预计晚到 1 小时" />
          </div>
        </Modal>
      )}
    </div>
  );
}

function DockFormModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ code: '', dock_name: '', types: [...TYPE_KEYS] });
  const toast = useToast();
  const toggle = (t) => setForm((f) => ({
    ...f,
    types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
  }));
  const submit = async () => {
    if (!form.code.trim() || !form.dock_name.trim()) { toast('编号和名称必填', 'error'); return; }
    if (!form.types.length) { toast('至少选择一种适配车型', 'error'); return; }
    try {
      await api.createDock({ code: form.code.trim(), dock_name: form.dock_name.trim(), allowed_types: form.types });
      toast('月台已新增', 'success');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal
      title="新增月台"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit}>保存</button>
        </>
      }
    >
      <div className="form-row">
        <label>月台编号 *</label>
        <input className="input" placeholder="如 D08" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
      </div>
      <div className="form-row">
        <label>月台名称 *</label>
        <input className="input" placeholder="如 8号月台" value={form.dock_name} onChange={(e) => setForm({ ...form, dock_name: e.target.value })} />
      </div>
      <div className="form-row">
        <label>适配车型（多选）</label>
        <div className="type-check-row">
          {TYPE_KEYS.map((t) => (
            <label key={t} className={`type-check ${form.types.includes(t) ? 'on' : ''}`}>
              <input type="checkbox" checked={form.types.includes(t)} onChange={() => toggle(t)} />
              {VEHICLE_TYPES[t].label}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
