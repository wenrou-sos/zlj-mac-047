import React, { useEffect, useState } from 'react';
import { RefreshCw, Save, Ban } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, CartesianGrid, Legend, Cell,
} from 'recharts';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Empty } from '../components/common.jsx';
import { VEHICLE_STATUS, ABNORMAL_TYPES, LOCATION_TYPES, fmtDateTime } from '../utils.js';

const ABNORMAL_COLORS = ['#ef4444', '#f97316', '#eab308', '#8b5cf6', '#06b6d4'];

export default function Stats() {
  const [backlog, setBacklog] = useState(null);
  const [abnormal, setAbnormal] = useState(null);
  const [settings, setSettings] = useState(null);
  const toast = useToast();

  const load = async () => {
    try {
      const [b, a, s] = await Promise.all([api.backlog(), api.abnormalStats(), api.settings()]);
      setBacklog(b);
      setAbnormal(a);
      setSettings(s);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => { load(); }, []);

  const saveSettings = async () => {
    try {
      const s = await api.saveSettings({
        unload_timeout_min: Number(settings.unload_timeout_min),
        sort_timeout_min: Number(settings.sort_timeout_min),
        warn_ratio: Number(settings.warn_ratio),
      });
      setSettings(s);
      toast('超时规则已保存，预警实时生效', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (!backlog || !abnormal || !settings) return <div className="empty">加载中…</div>;

  const statusRows = backlog.byStatus.map((x) => ({
    ...x,
    label: x.status === 'held' ? '拦截留置' : x.status === 'pending' ? '待分拣' : x.status === 'sorted' ? '已分拣未装车' : x.status === 'lost' ? '盘亏挂账' : x.status,
  }));
  const operationTotal = backlog.byStatus
    .filter((x) => ['pending', 'sorted'].includes(x.status))
    .reduce((s, x) => s + x.count, 0);
  const heldTotal = backlog.byStatus.find((x) => x.status === 'held')?.count || 0;
  const backlogTotal = operationTotal + heldTotal;
  const trendData = backlog.trend.map((t) => ({
    name: `${24 - backlog.trend.indexOf(t) - 1}h前`,
    到件: t.arrived,
    分拣完成: t.sorted,
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>积压统计</h1>
          <div className="sub">当前积压 <b style={{ color: 'var(--amber)' }}>{backlogTotal}</b> 件（待分拣/已分拣 {operationTotal}，拦截留置 {heldTotal}），可在「库位与盘点」定位具体库位</div>
        </div>
        <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
      </div>

      {/* 24小时到件/分拣趋势 */}
      <div className="card section-gap">
        <div className="card-header"><h3>近 24 小时作业趋势</h3></div>
        <div className="card-body" style={{ height: 240 }}>
          <ResponsiveContainer>
            <AreaChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" fontSize={11} tick={{ fill: '#94a3b8' }} interval={3} />
              <YAxis fontSize={11} tick={{ fill: '#94a3b8' }} />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey="到件" stroke="#3b82f6" fill="#dbeafe" strokeWidth={2} />
              <Area type="monotone" dataKey="分拣完成" stroke="#22c55e" fill="#dcfce7" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 按库位积压：解决“数得出、找不到”的定位问题 */}
      <div className="card section-gap">
        <div className="card-header"><h3>积压定位（按场区库位）</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>库位</th><th>类型</th><th>在场件</th><th>待分拣</th><th>已分拣</th><th>拦截留置</th><th>容量占用</th></tr></thead>
            <tbody>
              {backlog.byLocation.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.code}</b><div className="text-muted">{l.name}</div></td>
                  <td><span className="badge" style={{ color: LOCATION_TYPES[l.loc_type]?.color, background: LOCATION_TYPES[l.loc_type]?.bg }}><span className="dot" />{LOCATION_TYPES[l.loc_type]?.label || l.loc_type}</span></td>
                  <td className="mono">{l.occupied}</td>
                  <td className="mono" style={{ color: l.pending ? 'var(--amber)' : undefined, fontWeight: l.pending ? 700 : 400 }}>{l.pending}</td>
                  <td className="mono">{l.sorted}</td>
                  <td className="mono" style={{ color: l.held ? 'var(--red)' : undefined, fontWeight: l.held ? 700 : 400 }}>{l.held}</td>
                  <td>{l.capacity ? `${l.occupied}/${l.capacity}` : '不限'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {backlog.byLocation.length === 0 && <Empty text="当前无在场定位件" />}
        </div>
      </div>

      <div className="grid-2 section-gap">
        {/* 按目的地积压 */}
        <div className="card">
          <div className="card-header"><h3>积压分布（按目的地）</h3></div>
          <div className="card-body" style={{ height: 260 }}>
            {backlog.byDestination.length === 0 ? <Empty text="当前无积压" /> : (
              <ResponsiveContainer>
                <BarChart data={backlog.byDestination} layout="vertical" margin={{ left: 10 }}>
                  <XAxis type="number" fontSize={11} tick={{ fill: '#94a3b8' }} />
                  <YAxis type="category" dataKey="destination" fontSize={12} width={50} tick={{ fill: '#475569' }} />
                  <Tooltip formatter={(v) => [`${v} 件`, '积压']} />
                  <Bar dataKey="count" fill="#f59e0b" radius={[0, 4, 4, 0]} barSize={16} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 异常件统计 */}
        <div className="card">
          <div className="card-header">
            <h3><Ban size={15} color="#dc2626" /> 异常件统计</h3>
            <span className="text-muted">
              累计 {abnormal.summary.total_abnormal} · 拦截中 {abnormal.summary.intercepted} · 已解除 {abnormal.summary.released}
            </span>
          </div>
          <div className="card-body" style={{ height: 260 }}>
            {abnormal.byType.length === 0 ? <Empty text="暂无异常件" /> : (
              <ResponsiveContainer>
                <BarChart data={abnormal.byType.map((t) => ({ ...t, name: ABNORMAL_TYPES[t.abnormal_type] || t.abnormal_type }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" fontSize={11} tick={{ fill: '#475569' }} />
                  <YAxis fontSize={11} tick={{ fill: '#94a3b8' }} />
                  <Tooltip formatter={(v) => [`${v} 件`, '数量']} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} barSize={36}>
                    {abnormal.byType.map((_, i) => <Cell key={i} fill={ABNORMAL_COLORS[i % ABNORMAL_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="grid-32">
        {/* 超时规则设置 */}
        <div className="card section-gap">
          <div className="card-header"><h3>超时预警规则</h3></div>
          <div className="card-body">
            <div className="form-row">
              <label>卸车时限（到车后，分钟）</label>
              <input className="input" type="number" min="1" value={settings.unload_timeout_min}
                onChange={(e) => setSettings({ ...settings, unload_timeout_min: e.target.value })} />
            </div>
            <div className="form-row">
              <label>分拣时限（卸车完成后，分钟）</label>
              <input className="input" type="number" min="1" value={settings.sort_timeout_min}
                onChange={(e) => setSettings({ ...settings, sort_timeout_min: e.target.value })} />
            </div>
            <div className="form-row">
              <label>预警阈值（达到时限比例，0~1）</label>
              <input className="input" type="number" min="0.1" max="1" step="0.05" value={settings.warn_ratio}
                onChange={(e) => setSettings({ ...settings, warn_ratio: e.target.value })} />
            </div>
            <button className="btn btn-primary" onClick={saveSettings} style={{ width: '100%', justifyContent: 'center' }}>
              <Save size={14} /> 保存规则
            </button>
            <div className="text-muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
              超过时限标记为「已超时」（红色）；达到时限 {Math.round(settings.warn_ratio * 100)}% 标记为「预警」（黄色）。发车超时以计划发车时间为准。
            </div>
          </div>
        </div>

        {/* 车辆积压明细 */}
        <div className="card section-gap">
          <div className="card-header"><h3>在场车辆积压明细</h3></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>车辆</th><th>线路</th><th>状态</th><th>待分拣</th><th>已分拣未装车</th></tr>
              </thead>
              <tbody>
                {backlog.byVehicle.map((v) => (
                  <tr key={v.id}>
                    <td style={{ fontWeight: 600 }}>{v.plate_no}</td>
                    <td>{v.route_code}</td>
                    <td><Badge conf={VEHICLE_STATUS[v.status]} /></td>
                    <td className="mono" style={{ color: v.pending > 0 ? 'var(--amber)' : 'inherit', fontWeight: v.pending > 0 ? 700 : 400 }}>
                      {v.pending}
                    </td>
                    <td className="mono">{v.sorted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {backlog.byVehicle.length === 0 && <Empty text="当前无积压车辆" />}
          </div>
        </div>
      </div>

      {/* 最近异常件 */}
      <div className="card">
        <div className="card-header"><h3>最近异常件记录</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>运单号</th><th>目的地</th><th>所属车辆</th><th>异常类型</th><th>备注</th><th>拦截时间</th><th>当前状态</th></tr>
            </thead>
            <tbody>
              {abnormal.recent.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.tracking_no}</td>
                  <td>{p.destination}</td>
                  <td>{p.plate_no || <span className="text-muted">未分配</span>}</td>
                  <td style={{ color: 'var(--red)', fontWeight: 600 }}>{ABNORMAL_TYPES[p.abnormal_type] || p.abnormal_type}</td>
                  <td className="text-muted">{p.abnormal_note || '—'}</td>
                  <td className="mono text-muted">{fmtDateTime(p.intercepted_at)}</td>
                  <td>
                    {p.intercept_status === 'held'
                      ? <span className="badge" style={{ color: '#b91c1c', background: '#fee2e2' }}><span className="dot" />拦截中</span>
                      : <span className="badge" style={{ color: '#15803d', background: '#dcfce7' }}><span className="dot" />已解除</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {abnormal.recent.length === 0 && <Empty text="暂无异常件记录" />}
        </div>
      </div>
    </div>
  );
}
