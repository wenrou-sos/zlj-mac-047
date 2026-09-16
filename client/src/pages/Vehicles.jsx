import React, { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Truck, Check, ArrowRight, Trash2, AlertOctagon, Warehouse, Clock, Timer, RotateCcw } from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { VEHICLE_STATUS, VEHICLE_TYPES, APPOINTMENT_STATUS, fmtTime, fmtDateTime, fmtAgo, fmtDur, minutesBetween } from '../utils.js';

const NEXT_ACTION = {
  expected:  { action: 'arrive',       label: '确认到车' },
  arrived:   { action: 'unload-start', label: '开始卸车' },
  unloading: { action: 'unload-end',   label: '完成卸车' },
  unloaded:  { action: 'sort-start',   label: '开始分拣' },
  sorting:   { action: 'sort-end',     label: '完成分拣' },
  sorted:    { action: 'depart',       label: '确认发车' },
};

// 四阶段时间线：到车 → 卸车 → 分拣 → 发车
function Timeline({ v }) {
  const steps = [
    { label: '到车', done: !!v.arrived_at, active: false, time: v.arrived_at },
    { label: '卸车', done: !!v.unload_end_at, active: !!v.unload_start_at && !v.unload_end_at, time: v.unload_end_at || v.unload_start_at },
    { label: '分拣', done: !!v.sort_end_at, active: !!v.sort_start_at && !v.sort_end_at, time: v.sort_end_at || v.sort_start_at },
    { label: '发车', done: !!v.departed_at, active: false, time: v.departed_at },
  ];
  return (
    <div className="timeline">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          {i > 0 && <div className={`tl-line ${steps[i - 1].done ? 'done' : ''}`} />}
          <div className={`tl-step ${s.done ? 'done' : ''} ${s.active ? 'active' : ''}`}>
            <div className={`tl-dot ${s.active ? 'pulse' : ''}`}>
              {s.done ? <Check size={14} /> : <Truck size={13} />}
            </div>
            <div className="tl-label">{s.label}</div>
            <div className="tl-time mono">{s.time ? fmtTime(s.time) : '--:--'}</div>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// 等待时间与实际卸车时间分开显示
function DockTiming({ v, now }) {
  const parts = [];
  // 排队等待（候叫 -> 叫号）
  if (v.queued_at || v.appointment_status) {
    const end = v.called_at || (v.appointment_status === 'checked' ? now : null);
    const wait = minutesBetween(v.checked_at, end);
    if (wait !== null) {
      parts.push(
        <span key="wait" className={`dur-chip ${v.appointment_status === 'checked' ? 'dur-running' : ''}`} title="到场排队等待时间（不含卸车作业）">
          <Clock size={11} /> 等待 {fmtDur(wait)}
        </span>
      );
    }
  }
  // 实际卸车（开卸 -> 卸完 / 当前）
  if (v.unload_start_at) {
    const unload = minutesBetween(v.unload_start_at, v.unload_end_at || now);
    parts.push(
      <span key="unload" className={`dur-chip dur-unload ${!v.unload_end_at ? 'dur-running' : ''}`} title="实际卸车作业时间，与等待时间分开统计">
        <Timer size={11} /> 卸车 {fmtDur(unload)}{!v.unload_end_at && '中'}
      </span>
    );
  }
  return parts.length ? <div className="dur-row">{parts}</div> : null;
}

export default function Vehicles({ goDocks }) {
  const [vehicles, setVehicles] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState({
    plate_no: '', route_code: '', driver_name: '', vehicle_type: 'medium',
    planned_arrival: '', planned_departure: '', with_slot: false, slot_start: '', slot_end: '',
  });
  const toast = useToast();

  const load = async () => {
    try {
      const [vs, al] = await Promise.all([api.vehicles(), api.alerts()]);
      setVehicles(vs);
      setAlerts(al);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { clearInterval(timer); clearInterval(tick); };
  }, []);

  const alertMap = useMemo(() => {
    const m = {};
    for (const a of alerts) {
      if (!m[a.vehicle_id] || a.level === 'overdue') m[a.vehicle_id] = a;
    }
    return m;
  }, [alerts]);

  const doAction = async (v) => {
    const next = NEXT_ACTION[v.status];
    if (!next) return;
    try {
      await api.vehicleAction(v.id, next.action);
      toast(`${v.plate_no} ${next.label}成功`, 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const remove = async (v) => {
    try {
      await api.deleteVehicle(v.id);
      toast(`班次 ${v.plate_no} 已删除`, 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // 候叫预约被取消后，已到场车辆可重新入队（后端为已到场车辆直接建候叫预约）
  const requeue = async (v) => {
    try {
      await api.createAppointment({
        vehicle_id: v.id,
        slot_start: new Date().toISOString(),
        slot_end: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      toast(`${v.plate_no} 已重新进入候叫队列`, 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const create = async () => {
    if (!form.plate_no.trim() || !form.route_code.trim()) {
      toast('请填写车牌号和线路', 'error');
      return;
    }
    if (form.with_slot && (!form.slot_start || !form.slot_end)) {
      toast('请填写完整的预约时段', 'error');
      return;
    }
    try {
      // datetime-local 是不带时区的本地时间，必须显式按浏览器时区转为 ISO(UTC)，
      // 否则服务端会按自身时区解析，导致非 UTC 环境下时间整体偏移
      const toISO = (v) => (v ? new Date(v).toISOString() : null);
      await api.createVehicle({
        ...form,
        planned_arrival: toISO(form.planned_arrival),
        planned_departure: toISO(form.planned_departure),
        slot_start: form.with_slot ? toISO(form.slot_start) : null,
        slot_end: form.with_slot ? toISO(form.slot_end) : null,
      });
      toast(form.with_slot ? '到车预报与月台预约已登记（预约不占用月台）' : '到车预报已登记', 'success');
      setShowCreate(false);
      setForm({
        plate_no: '', route_code: '', driver_name: '', vehicle_type: 'medium',
        planned_arrival: '', planned_departure: '', with_slot: false, slot_start: '', slot_end: '',
      });
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const filtered = filter ? vehicles.filter((v) => v.status === filter) : vehicles;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>车辆班次</h1>
          <div className="sub">到车 → 排队叫号 → 卸车（占用/释放月台）→ 分拣 → 发车</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={goDocks}><Warehouse size={14} /> 月台调度</button>
          <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={15} /> 到车预报</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="filter-bar">
            <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">全部状态</option>
              {Object.entries(VEHICLE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <span className="text-muted">共 {filtered.length} 个班次</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>车辆 / 线路</th>
                <th>状态</th>
                <th>月台 / 预约</th>
                <th>作业时间线与耗时</th>
                <th>包裹进度</th>
                <th>计划发车</th>
                <th style={{ width: 230 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const alert = alertMap[v.id];
                const next = NEXT_ACTION[v.status];
                const done = v.sorted_count + v.loaded_count;
                const pct = v.package_count ? Math.round((done / v.package_count) * 100) : 0;
                const waitingDock = v.status === 'arrived' && v.appointment_status === 'checked';
                const atDock = !!v.dock_code;
                return (
                  <tr key={v.id} className={alert ? (alert.level === 'overdue' ? 'row-alert' : 'row-warn') : ''}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {v.plate_no}
                        <span className="type-chip" style={{ marginLeft: 6, color: VEHICLE_TYPES[v.vehicle_type]?.color, background: VEHICLE_TYPES[v.vehicle_type]?.bg }}>
                          {VEHICLE_TYPES[v.vehicle_type]?.label}
                        </span>
                      </div>
                      <div className="text-muted">{v.route_code} · {v.driver_name || '未指派司机'}</div>
                      {alert && (
                        <div style={{ color: alert.level === 'overdue' ? 'var(--red)' : 'var(--amber)', fontSize: 12, marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <AlertOctagon size={12} /> {alert.message}
                        </div>
                      )}
                    </td>
                    <td><Badge conf={VEHICLE_STATUS[v.status]} /></td>
                    <td>
                      {v.dock_code ? (
                        <div>
                          <span className="dock-tag">{v.dock_code}</span>
                          {APPOINTMENT_STATUS[v.appointment_status] && (
                            <Badge conf={APPOINTMENT_STATUS[v.appointment_status]} />
                          )}
                        </div>
                      ) : v.appointment_status === 'checked' ? (
                        <div>
                          <Badge conf={APPOINTMENT_STATUS.checked} />
                          {v.is_late && <span className="tag tag-late" style={{ marginLeft: 4 }}>迟到重排</span>}
                          {v.requeued && !v.is_late && <span className="tag tag-recall" style={{ marginLeft: 4 }}>召回重排</span>}
                          <div className="text-muted" style={{ marginTop: 4 }}>到场 {fmtAgo(v.checked_at)}</div>
                        </div>
                      ) : v.appointment_status === 'booked' ? (
                        <div>
                          <Badge conf={APPOINTMENT_STATUS.booked} />
                          <div className="text-muted" style={{ marginTop: 4 }}>{fmtDateTime(v.slot_start)}–{fmtTime(v.slot_end)}</div>
                        </div>
                      ) : (
                        <span className="text-muted">{v.status === 'expected' ? '未预约月台' : '—'}</span>
                      )}
                      {v.priority_reason && <div className="queue-reason">优先：{v.priority_reason}</div>}
                    </td>
                    <td>
                      <Timeline v={v} />
                      <DockTiming v={v} now={now} />
                    </td>
                    <td>
                      {v.package_count > 0 ? (
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className="progress-bar" style={{ flex: 1 }}><div style={{ width: `${pct}%` }} /></div>
                            <span className="mono text-muted">{done}/{v.package_count}</span>
                          </div>
                          <div className="text-muted" style={{ marginTop: 4 }}>
                            待分拣 {v.pending_count}
                            {v.intercepted_count > 0 && <span style={{ color: 'var(--red)' }}> · 拦截 {v.intercepted_count}</span>}
                          </div>
                        </div>
                      ) : <span className="text-muted">未到件</span>}
                    </td>
                    <td>
                      <div className="mono">{fmtTime(v.planned_departure)}</div>
                      {v.departed_at
                        ? <div className="text-muted">实际 {fmtTime(v.departed_at)}</div>
                        : <div className="text-muted">{v.planned_departure ? fmtAgo(v.planned_departure) : ''}</div>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {waitingDock ? (
                          <button className="btn btn-next btn-sm" onClick={goDocks}>
                            <Warehouse size={13} /> 候叫中·去叫号
                          </button>
                        ) : (
                          <>
                            {v.status === 'arrived' && !v.dock_code && (
                              <button className="btn btn-sm" onClick={() => requeue(v)}>
                                <RotateCcw size={13} /> 重新排队
                              </button>
                            )}
                            {next && (
                              <button
                                className={`btn ${next.action === 'unload-start' && !atDock ? '' : 'btn-next'} btn-sm`}
                                onClick={() => doAction(v)}
                                disabled={next.action === 'unload-start' && !atDock}
                                title={next.action === 'unload-start' && !atDock ? '需先在月台调度叫号靠台' : ''}
                              >
                                {next.label} <ArrowRight size={13} />
                              </button>
                            )}
                          </>
                        )}
                        {v.status === 'expected' && (
                          <button className="btn btn-danger btn-sm" onClick={() => remove(v)}><Trash2 size={13} /></button>
                        )}
                        {v.status === 'departed' && <span className="text-muted">已离场</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <Empty text="没有符合条件的班次" />}
        </div>
      </div>

      {showCreate && (
        <Modal
          title="到车预报"
          onClose={() => setShowCreate(false)}
          width={520}
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn btn-primary" onClick={create}>登记</button>
            </>
          }
        >
          <div className="grid-2">
            <div className="form-row">
              <label>车牌号 *</label>
              <input className="input" placeholder="如 沪A·12345" value={form.plate_no} onChange={(e) => setForm({ ...form, plate_no: e.target.value })} />
            </div>
            <div className="form-row">
              <label>线路编码 *</label>
              <input className="input" placeholder="如 BJ-SH" value={form.route_code} onChange={(e) => setForm({ ...form, route_code: e.target.value })} />
            </div>
          </div>
          <div className="grid-2">
            <div className="form-row">
              <label>司机</label>
              <input className="input" placeholder="司机姓名" value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
            </div>
            <div className="form-row">
              <label>车型（决定可适配月台）</label>
              <select className="input" value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })}>
                {Object.entries(VEHICLE_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid-2">
            <div className="form-row">
              <label>计划到车时间</label>
              <input className="input" type="datetime-local" value={form.planned_arrival} onChange={(e) => setForm({ ...form, planned_arrival: e.target.value })} />
            </div>
            <div className="form-row">
              <label>计划发车时间</label>
              <input className="input" type="datetime-local" value={form.planned_departure} onChange={(e) => setForm({ ...form, planned_departure: e.target.value })} />
            </div>
          </div>

          <label className="slot-switch">
            <input type="checkbox" checked={form.with_slot} onChange={(e) => setForm({ ...form, with_slot: e.target.checked })} />
            同时登记月台预约时段（预约仅排班，不占用月台）
          </label>
          {form.with_slot && (
            <div className="grid-2">
              <div className="form-row">
                <label>预约开始 *</label>
                <input className="input" type="datetime-local" value={form.slot_start} onChange={(e) => setForm({ ...form, slot_start: e.target.value })} />
              </div>
              <div className="form-row">
                <label>预约结束 *</label>
                <input className="input" type="datetime-local" value={form.slot_end} onChange={(e) => setForm({ ...form, slot_end: e.target.value })} />
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
