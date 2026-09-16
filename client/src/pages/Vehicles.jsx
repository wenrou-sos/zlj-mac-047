import React, { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Truck, Check, ArrowRight, Trash2, Hand, ShieldAlert } from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { VEHICLE_STATUS, fmtTime, fmtAgo } from '../utils.js';

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

export default function Vehicles({ goAlerts }) {
  const [vehicles, setVehicles] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ plate_no: '', route_code: '', driver_name: '', planned_arrival: '', planned_departure: '' });
  const toast = useToast();

  const load = async () => {
    try {
      // alerts 为未恢复的预警事件（可认领、可追溯），一辆车同一环节至多一条
      const [vs, al] = await Promise.all([api.vehicles(), api.alerts('active')]);
      setVehicles(vs);
      setAlerts(al);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  // 取车辆当前最严重的未恢复事件（红色超时优先、升级优先）
  const alertMap = useMemo(() => {
    const m = {};
    const rank = (e) => (e.status === 'escalated' ? 3 : e.level === 'overdue' ? 2 : 1);
    for (const e of alerts) {
      if (!m[e.vehicle_id] || rank(e) > rank(m[e.vehicle_id])) m[e.vehicle_id] = e;
    }
    return m;
  }, [alerts]);

  const quickClaim = async (ev) => {
    try {
      const r = await api.claimAlert(ev.id);
      toast(r.claimed ? `已认领 ${ev.plate_no} 的预警` : '你已认领过该预警', r.claimed ? 'success' : 'info');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

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

  const create = async () => {
    if (!form.plate_no.trim() || !form.route_code.trim()) {
      toast('请填写车牌号和线路', 'error');
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
      });
      toast('到车预报已登记', 'success');
      setShowCreate(false);
      setForm({ plate_no: '', route_code: '', driver_name: '', planned_arrival: '', planned_departure: '' });
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
          <div className="sub">到车 → 卸车 → 分拣 → 发车 全流程时间节点记录</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
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
                <th>作业时间线</th>
                <th>包裹进度</th>
                <th>计划发车</th>
                <th style={{ width: 210 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const alert = alertMap[v.id];
                const next = NEXT_ACTION[v.status];
                const done = v.sorted_count + v.loaded_count;
                const pct = v.package_count ? Math.round((done / v.package_count) * 100) : 0;
                return (
                  <tr key={v.id} className={alert ? (alert.level === 'overdue' ? 'row-alert' : 'row-warn') : ''}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{v.plate_no}</div>
                      <div className="text-muted">{v.route_code} · {v.driver_name || '未指派司机'}</div>
                      {alert && (
                        <div className="vehicle-alert" style={{ color: alert.level === 'overdue' ? 'var(--red)' : 'var(--amber)' }}>
                          {alert.status === 'escalated'
                            ? <ShieldAlert size={12} />
                            : <AlertOctagon size={12} />}
                          <span>{alert.message}</span>
                          {alert.assigned_to
                            ? <em className="alert-assignee">跟进：{alert.assigned_to}</em>
                            : (
                              <button type="button" className="mini-claim" onClick={(e) => { e.stopPropagation(); quickClaim(alert); }}>
                                <Hand size={11} /> 认领
                              </button>
                            )}
                          {goAlerts && (
                            <button type="button" className="mini-link" onClick={(e) => { e.stopPropagation(); goAlerts(); }}>详情</button>
                          )}
                        </div>
                      )}
                    </td>
                    <td><Badge conf={VEHICLE_STATUS[v.status]} /></td>
                    <td><Timeline v={v} /></td>
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
                      <div style={{ display: 'flex', gap: 6 }}>
                        {next && (
                          <button className="btn btn-next btn-sm" onClick={() => doAction(v)}>
                            {next.label} <ArrowRight size={13} />
                          </button>
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
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn btn-primary" onClick={create}>登记</button>
            </>
          }
        >
          <div className="form-row">
            <label>车牌号 *</label>
            <input className="input" placeholder="如 沪A·12345" value={form.plate_no} onChange={(e) => setForm({ ...form, plate_no: e.target.value })} />
          </div>
          <div className="form-row">
            <label>线路编码 *</label>
            <input className="input" placeholder="如 BJ-SH" value={form.route_code} onChange={(e) => setForm({ ...form, route_code: e.target.value })} />
          </div>
          <div className="form-row">
            <label>司机</label>
            <input className="input" placeholder="司机姓名" value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
          </div>
          <div className="form-row">
            <label>计划到车时间</label>
            <input className="input" type="datetime-local" value={form.planned_arrival} onChange={(e) => setForm({ ...form, planned_arrival: e.target.value })} />
          </div>
          <div className="form-row">
            <label>计划发车时间</label>
            <input className="input" type="datetime-local" value={form.planned_departure} onChange={(e) => setForm({ ...form, planned_departure: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
