import React, { useEffect, useState } from 'react';
import { Truck, Package, PackageCheck, Ban, AlertTriangle, RefreshCw, ArrowRight, Clock, Hand, ShieldAlert } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { StatCard, Empty, Badge } from '../components/common.jsx';
import { ALERT_STATUS, fmtAgo, fmtDateTime } from '../utils.js';

const PIE_COLORS = { pending: '#f59e0b', sorted: '#8b5cf6', loaded: '#22c55e', intercepted: '#ef4444' };
const PIE_LABEL = { pending: '待分拣', sorted: '已分拣', loaded: '已装车', intercepted: '已拦截' };

export default function Dashboard({ onAlertCount, goAlerts, goVehicles }) {
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const toast = useToast();

  const load = async () => {
    try {
      const [ov, al] = await Promise.all([api.overview(), api.alerts('active')]);
      setOverview(ov);
      setAlerts(al);
      setUpdatedAt(new Date());
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  if (!overview) return <div className="empty">加载中…</div>;

  const pkg = overview.packages;
  const a = overview.alerts;
  const pieData = ['pending', 'sorted', 'loaded', 'intercepted']
    .map((k) => ({ key: k, name: PIE_LABEL[k], value: pkg[k] }))
    .filter((d) => d.value > 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>监控总览</h1>
          <div className="sub">
            实时分拨作业监控
            {updatedAt && <span> · 更新于 {updatedAt.toLocaleTimeString('zh-CN')}</span>}
          </div>
        </div>
        <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
      </div>

      <div className="stat-grid">
        <StatCard icon={<Truck size={22} />} label="在场作业车辆" value={overview.vehicles.active_vehicles} iconBg="#dbeafe" iconColor="#1d4ed8" />
        <StatCard icon={<Package size={22} />} label="待分拣包裹" value={pkg.pending} iconBg="#fef3c7" iconColor="#b45309" />
        <StatCard icon={<PackageCheck size={22} />} label="已装车包裹" value={pkg.loaded} iconBg="#dcfce7" iconColor="#15803d" />
        <StatCard icon={<Ban size={22} />} label="拦截异常件" value={pkg.intercepted} iconBg="#fee2e2" iconColor="#b91c1c" />
        <StatCard
          icon={<AlertTriangle size={22} />}
          label="未恢复预警事件"
          value={a.alert_count}
          iconBg={a.escalated_count > 0 ? '#fee2e2' : '#fef3c7'}
          iconColor={a.escalated_count > 0 ? '#b91c1c' : '#b45309'}
        />
      </div>

      <div className="grid-32">
        <div className="card section-gap">
          <div className="card-header">
            <h3>
              {a.escalated_count > 0 && <ShieldAlert size={16} color="#dc2626" className="pulse" />}
              超时预警事件
              <span className="text-muted" style={{ fontWeight: 400 }}>
                待认领 {a.unassigned_count} · 主管待办 {a.escalated_count} · 已处理待恢复 {a.resolved_waiting}
              </span>
            </h3>
            <button className="btn btn-sm" onClick={goAlerts}>
              前往认领处理 <ArrowRight size={13} />
            </button>
          </div>
          <div className="card-body">
            {alerts.length === 0 ? (
              <Empty text="当前无未恢复预警，作业正常" />
            ) : (
              alerts.map((ev) => (
                <div key={ev.id} className={`alert-item ${ev.level === 'overdue' ? 'overdue' : 'warn'}`} onClick={goAlerts}>
                  <span className="alert-icon">
                    {ev.level === 'overdue' ? <AlertTriangle size={18} /> : <Clock size={18} />}
                  </span>
                  <div className="alert-msg">
                    <div>
                      <b>{ev.plate_no}</b>（{ev.route_code}）{ev.message}
                    </div>
                    <div className="alert-sub">
                      <Badge conf={ALERT_STATUS[ev.status]} />
                      <span>首次触发 {fmtDateTime(ev.first_triggered_at)}（{fmtAgo(ev.first_triggered_at)}）</span>
                      {ev.assigned_to
                        ? <span className="assignee">跟进人：{ev.assigned_to}</span>
                        : <span className="unassigned"><Hand size={11} /> 待认领</span>}
                    </div>
                  </div>
                  <span className="alert-level">{ev.level === 'overdue' ? '已超时' : '预警'}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card section-gap">
          <div className="card-header"><h3>包裹状态分布</h3></div>
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 220, height: 220, flexShrink: 0 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieData} dataKey="value" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {pieData.map((d) => <Cell key={d.key} fill={PIE_COLORS[d.key]} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [`${v} 件`, n]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ flex: 1 }}>
              {pieData.map((d) => (
                <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: PIE_COLORS[d.key] }} />
                  <span style={{ flex: 1, color: 'var(--text-2)' }}>{d.name}</span>
                  <b className="mono">{d.value}</b>
                  <span className="text-muted" style={{ width: 48, textAlign: 'right' }}>
                    {pkg.total ? Math.round((d.value / pkg.total) * 100) : 0}%
                  </span>
                </div>
              ))}
              <div style={{ padding: '8px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
                今日累计到件 <b className="mono">{pkg.total}</b> · 已发车班次 {overview.vehicles.departed_vehicles} · 待到车 {overview.vehicles.expected_vehicles}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
