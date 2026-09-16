import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, UserCog, KeyRound, MonitorX, Ban, CircleCheck, ScrollText, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api.js';
import { useToast, useAuth } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { ROLE_LABEL, AUDIT_ACTIONS, VEHICLE_STATUS, PACKAGE_STATUS, ABNORMAL_TYPES, fmtDateTime } from '../utils.js';

const PAGE_SIZE = 50;

const ROLE_CONF = {
  dispatcher: { color: '#1d4ed8', bg: '#dbeafe' },
  sorter: { color: '#7c3aed', bg: '#ede9fe' },
  exception: { color: '#b45309', bg: '#fef3c7' },
  admin: { color: '#b91c1c', bg: '#fee2e2' },
};
const STATUS_CONF = {
  active: { label: '启用', color: '#15803d', bg: '#dcfce7' },
  disabled: { label: '已停用', color: '#64748b', bg: '#f1f5f9' },
};

/* ── 账号与岗位 ── */
function UsersPanel() {
  const [users, setUsers] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', display_name: '', password: '', roles: [] });
  const [rolesTarget, setRolesTarget] = useState(null);   // 调岗弹窗
  const [rolesSel, setRolesSel] = useState([]);
  const [pwdTarget, setPwdTarget] = useState(null);       // 重置密码弹窗
  const [pwdValue, setPwdValue] = useState('');
  const [sessTarget, setSessTarget] = useState(null);     // 会话弹窗
  const [sessions, setSessions] = useState([]);
  const { user: me } = useAuth();
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
    } catch (e) {
      toast(e.message, 'error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      load();
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  };

  const toggleRole = (list, role) =>
    list.includes(role) ? list.filter((r) => r !== role) : [...list, role];

  const create = async () => {
    const ok = await run(() => api.createUser(createForm), `账号 ${createForm.username} 已创建`);
    if (ok) {
      setShowCreate(false);
      setCreateForm({ username: '', display_name: '', password: '', roles: [] });
    }
  };

  const saveRoles = async () => {
    const ok = await run(
      () => api.updateUserRoles(rolesTarget.id, rolesSel),
      `已调整 ${rolesTarget.display_name} 的岗位，对其现有会话即时生效`
    );
    if (ok) setRolesTarget(null);
  };

  const toggleStatus = (u) =>
    run(
      () => api.updateUserStatus(u.id, u.status === 'active' ? 'disabled' : 'active'),
      u.status === 'active' ? `已停用 ${u.display_name}，其会话已全部撤销` : `已启用 ${u.display_name}`
    );

  const resetPwd = async () => {
    const ok = await run(() => api.resetUserPassword(pwdTarget.id, pwdValue), `已重置 ${pwdTarget.display_name} 的密码，其会话已全部撤销`);
    if (ok) { setPwdTarget(null); setPwdValue(''); }
  };

  const openSessions = async (u) => {
    setSessTarget(u);
    try {
      setSessions(await api.userSessions(u.id));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const revoke = async (sid) => {
    try {
      await api.revokeSession(sessTarget.id, sid);
      toast('会话已撤销', 'success');
      setSessions(await api.userSessions(sessTarget.id));
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const roleChecks = (sel, setSel) => (
    <div className="role-checks">
      {Object.entries(ROLE_LABEL).map(([k, label]) => (
        <label key={k}>
          <input type="checkbox" checked={sel.includes(k)} onChange={() => setSel(toggleRole(sel, k))} />
          <Badge conf={{ label, ...ROLE_CONF[k] }} />
          <span className="text-muted">
            {{ dispatcher: '到车预报、班次推进、删除预报', sorter: '到件登记、分拣、装车', exception: '异常拦截、解除拦截', admin: '全部业务 + 规则/账号/日志' }[k]}
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="card">
      <div className="card-header">
        <span className="text-muted">共 {users.length} 个账号 · 岗位变更与停用对旧会话即时生效</span>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}><Plus size={14} /> 新建账号</button>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>账号</th><th>姓名</th><th>岗位</th><th>状态</th><th>活跃会话</th><th>创建时间</th>
              <th style={{ width: 300 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.status === 'disabled' ? 'row-muted' : ''}>
                <td className="mono">{u.username}{u.id === me.id && <span className="text-muted">（我）</span>}</td>
                <td style={{ fontWeight: 600 }}>{u.display_name}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {u.roles.length
                      ? u.roles.map((r) => <Badge key={r} conf={{ label: ROLE_LABEL[r] || r, ...ROLE_CONF[r] }} />)
                      : <span className="text-muted">无岗位（仅查看）</span>}
                  </div>
                </td>
                <td><Badge conf={STATUS_CONF[u.status]} /></td>
                <td className="mono">{u.active_sessions}</td>
                <td className="mono text-muted">{fmtDateTime(u.created_at)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" onClick={() => { setRolesTarget(u); setRolesSel(u.roles); }}>
                      <UserCog size={13} /> 岗位
                    </button>
                    <button className="btn btn-sm" onClick={() => { setPwdTarget(u); setPwdValue(''); }}>
                      <KeyRound size={13} /> 重置密码
                    </button>
                    <button className="btn btn-sm" onClick={() => openSessions(u)}>
                      <MonitorX size={13} /> 会话
                    </button>
                    {u.status === 'active' ? (
                      <button className="btn btn-danger btn-sm" onClick={() => toggleStatus(u)}>
                        <Ban size={13} /> 停用
                      </button>
                    ) : (
                      <button className="btn btn-next btn-sm" onClick={() => toggleStatus(u)}>
                        <CircleCheck size={13} /> 启用
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <Empty text="暂无账号" />}
      </div>

      {showCreate && (
        <Modal
          title="新建账号"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn btn-primary" onClick={create}>创建</button>
            </>
          }
        >
          <div className="form-row">
            <label>登录账号 *</label>
            <input className="input" placeholder="3-20 位字母、数字或下划线" value={createForm.username}
              onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} />
          </div>
          <div className="form-row">
            <label>姓名 *</label>
            <input className="input" placeholder="显示姓名" value={createForm.display_name}
              onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })} />
          </div>
          <div className="form-row">
            <label>初始密码 *</label>
            <input className="input" type="password" placeholder="至少 6 位" value={createForm.password}
              onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
          </div>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>岗位（可兼岗）</label>
            {roleChecks(createForm.roles, (r) => setCreateForm({ ...createForm, roles: r }))}
          </div>
        </Modal>
      )}

      {rolesTarget && (
        <Modal
          title={`调整岗位：${rolesTarget.display_name}（${rolesTarget.username}）`}
          onClose={() => setRolesTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRolesTarget(null)}>取消</button>
              <button className="btn btn-primary" onClick={saveRoles}>保存</button>
            </>
          }
        >
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>岗位（可兼岗，保存后对该账号的现有会话即时生效）</label>
            {roleChecks(rolesSel, setRolesSel)}
          </div>
        </Modal>
      )}

      {pwdTarget && (
        <Modal
          title={`重置密码：${pwdTarget.display_name}（${pwdTarget.username}）`}
          onClose={() => setPwdTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPwdTarget(null)}>取消</button>
              <button className="btn btn-primary" onClick={resetPwd}>重置</button>
            </>
          }
        >
          <div className="form-row">
            <label>新密码 *</label>
            <input className="input" type="password" placeholder="至少 6 位" value={pwdValue}
              onChange={(e) => setPwdValue(e.target.value)} />
          </div>
          <div className="alert-item warn" style={{ marginBottom: 0 }}>
            <span className="alert-icon"><KeyRound size={16} /></span>
            <div className="alert-msg">重置后该账号的<b>全部会话将被撤销</b>，需使用新密码重新登录。</div>
          </div>
        </Modal>
      )}

      {sessTarget && (
        <Modal
          title={`会话管理：${sessTarget.display_name}（${sessTarget.username}）`}
          width={560}
          onClose={() => setSessTarget(null)}
          footer={<button className="btn" onClick={() => setSessTarget(null)}>关闭</button>}
        >
          {sessions.length === 0 ? <Empty text="暂无会话记录" /> : (
            <table className="tbl">
              <thead>
                <tr><th>会话</th><th>登录时间</th><th>过期时间</th><th>状态</th><th></th></tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.id.slice(0, 8)}…{s.current && <span className="text-muted">（当前）</span>}</td>
                    <td className="mono text-muted">{fmtDateTime(s.created_at)}</td>
                    <td className="mono text-muted">{fmtDateTime(s.expires_at)}</td>
                    <td>
                      {s.active
                        ? <Badge conf={{ label: '有效', color: '#15803d', bg: '#dcfce7' }} />
                        : <Badge conf={{ label: s.revoked_at ? '已撤销' : '已过期', color: '#64748b', bg: '#f1f5f9' }} />}
                    </td>
                    <td>
                      {s.active && (
                        <button className="btn btn-danger btn-sm" onClick={() => revoke(s.id)}>
                          <MonitorX size={13} /> 撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ── 操作日志 ── */

// 字段中文名
const FIELD_LABEL = {
  status: '状态', roles: '岗位', plate_no: '车牌号', route_code: '线路', driver_name: '司机',
  tracking_no: '运单号', destination: '目的地', weight_kg: '重量', vehicle_id: '车辆ID',
  abnormal_type: '异常类型', note: '备注', username: '账号', display_name: '姓名',
  planned_arrival: '计划到车', planned_departure: '计划发车',
  unload_timeout_min: '卸车时限(分)', sort_timeout_min: '分拣时限(分)', warn_ratio: '预警阈值',
  is_abnormal: '异常标记', action: '操作', reason: '原因', session: '会话',
  auto_sorted_packages: '自动分拣件数', auto_loaded_packages: '自动装车件数',
};

const fmtVal = (k, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'roles') return v.length ? v.map((r) => ROLE_LABEL[r] || r).join('、') : '（无岗位）';
  if (k === 'status') {
    return VEHICLE_STATUS[v]?.label || PACKAGE_STATUS[v]?.label
      || { active: '启用', disabled: '已停用' }[v] || v;
  }
  if (k === 'abnormal_type') return ABNORMAL_TYPES[v] || v;
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

// 变更前后对比：before → after
function DetailView({ detail }) {
  const d = typeof detail === 'string' ? JSON.parse(detail) : detail;
  if (!d) return <span className="text-muted">—</span>;
  const { before, after, extra } = d;
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const rows = keys
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
    .map((k) => ({ k, b: before?.[k], a: after?.[k] }));
  return (
    <div className="diff">
      {rows.map((r) => (
        <div key={r.k} className="diff-row">
          <span className="diff-field">{FIELD_LABEL[r.k] || r.k}</span>
          {before && <span className="diff-old">{fmtVal(r.k, r.b)}</span>}
          {before && <span className="diff-arrow">→</span>}
          <span className="diff-new">{fmtVal(r.k, r.a)}</span>
        </div>
      ))}
      {extra && Object.entries(extra).map(([k, v]) => (
        <div key={k} className="diff-row text-muted">
          <span className="diff-field">{FIELD_LABEL[k] || k}</span>
          <span>{fmtVal(k, v)}</span>
        </div>
      ))}
      {rows.length === 0 && !extra && <span className="text-muted">—</span>}
    </div>
  );
}

const TARGET_LABEL = { vehicle: '班次', package: '包裹', settings: '超时规则', user: '账号' };

function AuditPanel() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ action: '', actor: '' });
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api.auditLogs({ ...filters, page, pageSize: PAGE_SIZE }));
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);

  const setF = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="card">
      <div className="card-header">
        <div className="filter-bar">
          <select className="input" value={filters.action} onChange={(e) => setF({ action: e.target.value })}>
            <option value="">全部动作</option>
            {Object.entries(AUDIT_ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="input" style={{ width: 160 }} placeholder="按操作者搜索"
            value={filters.actor} onChange={(e) => setF({ actor: e.target.value })} />
          <span className="text-muted">共 {data.total} 条</span>
        </div>
        <button className="btn btn-sm" onClick={load}><RefreshCw size={13} /> 刷新</button>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>变更内容（变更前 → 变更后）</th></tr>
          </thead>
          <tbody>
            {data.items.map((it) => (
              <tr key={it.id}>
                <td className="mono text-muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(it.created_at)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{it.actor_name}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span className="badge" style={{ color: '#1d4ed8', background: '#dbeafe' }}>
                    {AUDIT_ACTIONS[it.action] || it.action}
                  </span>
                </td>
                <td className="text-muted" style={{ whiteSpace: 'nowrap' }}>
                  {it.target_type ? `${TARGET_LABEL[it.target_type] || it.target_type} #${it.target_id}` : '—'}
                </td>
                <td><DetailView detail={it.detail} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.items.length === 0 && <Empty text="暂无操作日志" />}
      </div>
      {data.total > 0 && (
        <div className="card-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
          <span className="text-muted">
            第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} 条，共 {data.total} 条
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
  );
}

export default function Admin() {
  const { hasPerm } = useAuth();
  const canUsers = hasPerm('user:manage');
  const canAudit = hasPerm('audit:view');
  const [tab, setTab] = useState(canUsers ? 'users' : 'audit');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>系统管理</h1>
          <div className="sub">账号与岗位授权、会话管理、关键业务操作留痕</div>
        </div>
      </div>
      <div className="tabs">
        {canUsers && (
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            <Users size={15} /> 账号与岗位
          </button>
        )}
        {canAudit && (
          <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
            <ScrollText size={15} /> 操作日志
          </button>
        )}
      </div>
      {tab === 'users' && canUsers && <UsersPanel />}
      {tab === 'audit' && canAudit && <AuditPanel />}
    </div>
  );
}
