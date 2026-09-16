import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Truck, Package, BarChart3, CheckCircle2, XCircle, Boxes, ShieldCheck, LogOut } from 'lucide-react';
import Dashboard from './pages/Dashboard.jsx';
import Vehicles from './pages/Vehicles.jsx';
import Packages from './pages/Packages.jsx';
import Stats from './pages/Stats.jsx';
import Admin from './pages/Admin.jsx';
import Login from './pages/Login.jsx';
import { api, getToken, setToken, onUnauthorized, onForbidden } from './api.js';
import { ROLE_LABEL } from './utils.js';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

// 当前登录用户与权限
const AuthCtx = createContext({ user: null, hasPerm: () => false });
export const useAuth = () => useContext(AuthCtx);

const PAGES = [
  { key: 'dashboard', label: '监控总览', icon: LayoutDashboard },
  { key: 'vehicles', label: '车辆班次', icon: Truck },
  { key: 'packages', label: '包裹与拦截', icon: Package },
  { key: 'stats', label: '积压统计', icon: BarChart3 },
  { key: 'admin', label: '系统管理', icon: ShieldCheck, anyPerm: ['user:manage', 'audit:view'] },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [page, setPage] = useState('dashboard');
  const [toasts, setToasts] = useState([]);
  const [alertCount, setAlertCount] = useState(0);
  const idRef = useRef(0);

  const toast = useCallback((msg, type = 'info') => {
    const id = ++idRef.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
  }, []);

  // 拉取当前会话用户（含最新岗位权限）
  const refreshMe = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      /* 401 已由全局处理清理会话 */
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => { setUser(null); setPage('dashboard'); });
    onForbidden(() => refreshMe()); // 权限被调整后，用最新权限刷新界面
    if (getToken()) refreshMe().finally(() => setBooting(false));
  }, [refreshMe]);

  // 窗口重新聚焦时同步一次权限，管理员调岗后界面及时更新
  useEffect(() => {
    const onFocus = () => { if (getToken()) refreshMe(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshMe]);

  const hasPerm = useCallback((p) => !!user?.permissions?.includes(p), [user]);
  const visiblePages = PAGES.filter((p) => !p.anyPerm || p.anyPerm.some(hasPerm));

  // 岗位被收回后，若当前页面已不可见则退回总览
  useEffect(() => {
    if (user && !visiblePages.some((p) => p.key === page)) setPage('dashboard');
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const logout = async () => {
    try { await api.logout(); } catch { /* 会话可能已失效 */ }
    setToken(null);
    setUser(null);
    setPage('dashboard');
  };

  if (booting) return <div className="empty" style={{ paddingTop: 120 }}>加载中…</div>;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <AuthCtx.Provider value={{ user, hasPerm }}>
      <ToastCtx.Provider value={toast}>
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
              {visiblePages.map(({ key, label, icon: Icon }) => (
                <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
                  <Icon size={17} />
                  {label}
                  {key === 'dashboard' && alertCount > 0 && (
                    <span className="nav-badge">{alertCount}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="user-box">
              <div className="user-avatar">{user.display_name?.slice(0, 1) || '?'}</div>
              <div className="user-info">
                <div className="user-name">{user.display_name}</div>
                <div className="user-roles">
                  {user.roles.length ? user.roles.map((r) => ROLE_LABEL[r] || r).join(' · ') : '仅查看'}
                </div>
              </div>
              <button className="logout-btn" title="退出登录" onClick={logout}><LogOut size={15} /></button>
            </div>
            <div className="sidebar-footer">
              华东转运中心 · 1号分拨场
              <br />
              数据每 15 秒自动刷新
            </div>
          </aside>

          <main className="main">
            {page === 'dashboard' && <Dashboard onAlertCount={setAlertCount} goVehicles={() => setPage('vehicles')} />}
            {page === 'vehicles' && <Vehicles />}
            {page === 'packages' && <Packages />}
            {page === 'stats' && <Stats />}
            {page === 'admin' && <Admin />}
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
      </ToastCtx.Provider>
    </AuthCtx.Provider>
  );
}
