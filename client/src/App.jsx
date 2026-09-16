import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Truck, Package, ClipboardList, BarChart3, CheckCircle2, XCircle, Boxes, UserRound, LogOut, LogIn } from 'lucide-react';
import { api } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import Vehicles from './pages/Vehicles.jsx';
import Packages from './pages/Packages.jsx';
import WorkOrders from './pages/WorkOrders.jsx';
import Stats from './pages/Stats.jsx';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

// 当前登录用户（工单认领/提交/复核的身份由服务端会话决定，前端仅保存 token）
const AuthCtx = createContext({ user: null, login: async () => {}, logout: async () => {} });
export const useAuth = () => useContext(AuthCtx);

const PAGES = [
  { key: 'dashboard', label: '监控总览', icon: LayoutDashboard },
  { key: 'vehicles', label: '车辆班次', icon: Truck },
  { key: 'packages', label: '包裹与拦截', icon: Package },
  { key: 'workorders', label: '异常工单', icon: ClipboardList },
  { key: 'stats', label: '积压统计', icon: BarChart3 },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [toasts, setToasts] = useState([]);
  const [badges, setBadges] = useState({ alerts: 0, workOrders: 0 });
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
  });
  const idRef = useRef(0);

  const toast = useCallback((msg, type = 'info') => {
    const id = ++idRef.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
  }, []);

  const saveSession = (token, u) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(u));
    setUser(u);
  };
  const clearSession = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password);
    saveSession(data.token, data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* 会话可能已失效，本地照常清除 */ }
    clearSession();
  }, []);

  // 启动时校验本地会话（服务端重启后内存会话失效，需重新登录）
  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    api.me().catch(() => clearSession());
  }, []);

  // 导航徽标：超时预警数 + 未结工单数
  useEffect(() => {
    const load = () =>
      api.overview()
        .then((ov) => setBadges({ alerts: ov.alert_count, workOrders: ov.work_orders?.open ?? 0 }))
        .catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      <AuthCtx.Provider value={{ user, login, logout }}>
        <div className="layout">
          <aside className="sidebar">
            <div className="logo">
              <div className="logo-icon"><Boxes size={20} color="#fff" /></div>
              <div>
                分拨管理系统
                <small>EXPRESS HUB</small>
              </div>
            </div>
            <nav className="nav">
              {PAGES.map(({ key, label, icon: Icon }) => (
                <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
                  <Icon size={17} />
                  {label}
                  {key === 'dashboard' && badges.alerts > 0 && (
                    <span className="nav-badge">{badges.alerts}</span>
                  )}
                  {key === 'workorders' && badges.workOrders > 0 && (
                    <span className="nav-badge">{badges.workOrders}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-footer">
              <AuthBox user={user} login={login} logout={logout} />
              华东转运中心 · 1号分拨场
              <br />
              数据每 15 秒自动刷新
            </div>
          </aside>

          <main className="main">
            {page === 'dashboard' && <Dashboard goVehicles={() => setPage('vehicles')} />}
            {page === 'vehicles' && <Vehicles />}
            {page === 'packages' && <Packages goWorkOrders={() => setPage('workorders')} />}
            {page === 'workorders' && <WorkOrders />}
            {page === 'stats' && <Stats />}
          </main>
        </div>

        <div className="toast-wrap">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.type}`}>
              {t.type === 'success' ? <CheckCircle2 size={16} /> : t.type === 'error' ? <XCircle size={16} /> : null}
              {t.msg}
            </div>
          ))}
        </div>
      </AuthCtx.Provider>
    </ToastCtx.Provider>
  );
}

// 侧边栏登录区：未登录显示账号密码登录，已登录显示姓名与注销
function AuthBox({ user, login, logout }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const submit = async () => {
    if (!form.username.trim() || !form.password) {
      setError('请输入账号和密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const u = await login(form.username.trim(), form.password);
      toast(`已登录：${u.display_name}`, 'success');
      setForm({ username: '', password: '' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <div className="operator-box">
        <UserRound size={13} /> 当前操作员
        <div className="operator-user">
          <b>{user.display_name}</b>
          <span className="mono">@{user.username}</span>
          <button title="注销" onClick={logout}><LogOut size={13} /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="operator-box">
      <LogIn size={13} /> 操作员登录
      <input
        placeholder="账号（如 wangfang）"
        value={form.username}
        onChange={(e) => setForm({ ...form, username: e.target.value })}
      />
      <input
        type="password"
        placeholder="密码（默认 123456）"
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <div className="operator-error">{error}</div>}
      <button className="operator-login" disabled={busy} onClick={submit}>
        {busy ? '登录中…' : '登录'}
      </button>
    </div>
  );
}
