import React, { useEffect, useState } from 'react';
import { Truck, Package, PackageCheck, Ban, AlertTriangle, AlertOctagon, RefreshCw, ArrowRight, Clock, ClipboardList } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { StatCard, Empty } from '../components/common.jsx';
import { fmtAgo } from '../utils.js';

const PIE_COLORS = { pending: '#f59e0b', unplanned: '#a78bfa', planned: '#2563eb', loaded: '#22c55e', intercepted: '#ef4444' };
const PIE_LABEL = { pending: '待分拣', unplanned: '已分拣未配载', planned: '已配载待发车', loaded: '已装车发运', intercepted: '已拦截' };

export default function Dashboard({ onAlertCount, goVehicles }) {
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const toast = useToast();

  const load = async () => {
    try {
      const [ov, al] = await Promise.all([api.overview(), api.alerts()]);
      setOverview(ov);
      setAlerts(al);
      onAlertCount(al.length);
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
  const unplanned = pkg.sorted - (pkg.planned || 0);
  const pieData = ['pending', 'unplanned', 'planned', 'loaded', 'intercepted']
    .map((k) => ({ key: k, name: PIE_LABEL[k], value: k === 'unplanned' ? unplanned : pkg[k] }))
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
        <StatCard icon={<ClipboardList size={22} />} label="已配载待发车" value={pkg.planned} iconBg="#dbeafe" iconColor="#1d4ed8" />
        <StatCard icon={<PackageCheck size={22} />} label="已装车发运" value={pkg.loaded} iconBg="#dcfce7" iconColor="#15803d" />
        <StatCard icon={<Ban size={22} />} label="拦截异常件" value={pkg.intercepted} iconBg="#fee2e2" iconColor="#b91c1c" />
        <StatCard
          icon={<AlertTriangle size={22} />}
          label="超时预警"
          value={overview.alert_count}
          iconBg={overview.overdue_count > 0 ? '#fee2e2' : '#fef3c7'}
          iconColor={overview.overdue_count > 0 ? '#b91c1c' : '#b45309'}
        />
      </div>

      <div className="grid-32">
        <div className="card section-gap">
          <div className="card-header">
            <h3><AlertOctagon size={16} color="#dc2626" /> 超时预警</h3>
            <button className="btn btn-sm" onClick={goVehicles}>
              前往处理 <ArrowRight size={13} />
            </button>
          </div>
          <div className="card-body">
            {alerts.length === 0 ? (
              <Empty text="当前无超时预警，作业正常" />
            ) : (
              alerts.map((a, i) => (
                <div key={i} className={`alert-item ${a.level}`}>
                  <span className="alert-icon">
                    {a.level === 'overdue' ? <AlertOctagon size={18} /> : <Clock size={18} />}
                  </span>
                  <div className="alert-msg">
                    <b>{a.plate_no}</b>（{a.route_code}）{a.message}
                  </div>
                  <span className="alert-level">{a.level === 'overdue' ? '已超时' : '预警'}</span>
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
