import React, { useEffect, useState } from 'react';
import { RefreshCw, Save, Ban, History } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, CartesianGrid, Legend, Cell,
} from 'recharts';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Empty } from '../components/common.jsx';
import { VEHICLE_STATUS, ABNORMAL_TYPES, fmtDateTime } from '../utils.js';

const ABNORMAL_COLORS = ['#ef4444', '#f97316', '#eab308', '#8b5cf6', '#06b6d4'];

export default function Stats() {
  const [backlog, setBacklog] = useState(null);
  const [abnormal, setAbnormal] = useState(null);
  const [settings, setSettings] = useState(null);
  const [ruleHistory, setRuleHistory] = useState([]);
  const toast = useToast();

  const load = async () => {
    try {
      const [b, a, s, h] = await Promise.all([api.backlog(), api.abnormalStats(), api.settings(), api.settingsHistory()]);
      setBacklog(b);
      setAbnormal(a);
      setSettings(s);
      setRuleHistory(h);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => { load(); }, []);

  const saveSettings = async () => {
    try {
      const body = {
        unload_timeout_min: Number(settings.unload_timeout_min),
        sort_timeout_min: Number(settings.sort_timeout_min),
        warn_ratio: Number(settings.warn_ratio),
        response_timeout_min: Number(settings.response_timeout_min),
        escalation_grace_min: Number(settings.escalation_grace_min),
      };
      if (body.warn_ratio <= 0 || body.warn_ratio > 1) return toast('预警阈值比例需在 0~1 之间', 'error');
      const s = await api.saveSettings(body);
      setSettings(s);
      const h = await api.settingsHistory();
      setRuleHistory(h);
      toast('超时规则已保存：进行中事件按原规则执行，新事件按新规则触发', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (!backlog || !abnormal || !settings) return <div className="empty">加载中…</div>;

  const backlogTotal = backlog.byStatus.reduce((s, x) => s + x.count, 0);
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
          <div className="sub">当前积压 <b style={{ color: 'var(--amber)' }}>{backlogTotal}</b> 件（待分拣 + 已分拣未装车）</div>
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
            <div className="form-row">
              <label>响应期限（触发后多少分钟无人确认，自动升级主管）</label>
              <input className="input" type="number" min="1" value={settings.response_timeout_min}
                onChange={(e) => setSettings({ ...settings, response_timeout_min: e.target.value })} />
            </div>
            <div className="form-row">
              <label>升级宽限（红色超时后多少分钟仍未恢复，主管督办）</label>
              <input className="input" type="number" min="1" value={settings.escalation_grace_min}
                onChange={(e) => setSettings({ ...settings, escalation_grace_min: e.target.value })} />
            </div>
            <button className="btn btn-primary" onClick={saveSettings} style={{ width: '100%', justifyContent: 'center' }}>
              <Save size={14} /> 保存规则
            </button>
            <div className="text-muted" style={{ marginTop: 10, lineHeight: 1.7 }}>
              超过时限标记为「已超时」（红色）；达到时限 {Math.round(settings.warn_ratio * 100)}% 标记为「预警」（黄色）。发车超时以计划发车时间为准。
              <br />
              <b>规则只对之后新触发的事件生效</b>；进行中的事件保留创建时的规则快照，每次调整都进入下方台账可追溯。
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
                    {p.status === 'intercepted'
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

      {/* 超时规则调整台账：阈值每次修改可追溯，事件按创建时的规则快照执行 */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3><History size={15} /> 超时规则调整台账</h3>
          <span className="text-muted">进行中的事件按创建时快照执行；此处只记录规则版本变化</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>调整时间</th><th>规则项</th><th>原值</th><th>新值</th><th>操作人</th></tr>
            </thead>
            <tbody>
              {ruleHistory.map((h) => (
                <tr key={h.id}>
                  <td className="mono text-muted">{fmtDateTime(h.created_at)}</td>
                  <td style={{ fontWeight: 600 }}>{h.label}</td>
                  <td className="mono">{h.old_value ?? '—'}</td>
                  <td className="mono"><b>{h.new_value}</b></td>
                  <td>{h.changed_by || <span className="text-muted">系统</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ruleHistory.length === 0 && <Empty text="暂无规则调整记录（初始默认值未变更）" />}
        </div>
      </div>
    </div>
  );
}
