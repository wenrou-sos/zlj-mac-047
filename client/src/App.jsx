import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Truck, Package, ClipboardList, BarChart3, CheckCircle2, XCircle, Boxes, UserRound } from 'lucide-react';
import { api } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import Vehicles from './pages/Vehicles.jsx';
import Packages from './pages/Packages.jsx';
import WorkOrders from './pages/WorkOrders.jsx';
import Stats from './pages/Stats.jsx';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

// 当前操作员（用于工单认领/转交/提交/复核的身份记录，持久化在浏览器）
const OperatorCtx = createContext({ operator: '', setOperator: () => {} });
export const useOperator = () => useContext(OperatorCtx);

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
  const [operator, setOperatorState] = useState(() => localStorage.getItem('operator') || '');
  const idRef = useRef(0);

  const toast = useCallback((msg, type = 'info') => {
    const id = ++idRef.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
  }, []);

  const setOperator = useCallback((name) => {
    localStorage.setItem('operator', name);
    setOperatorState(name);
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
      <OperatorCtx.Provider value={{ operator, setOperator }}>
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
              <div className="operator-box">
                <UserRound size={13} /> 当前操作员
                <input
                  value={operator}
                  placeholder="输入姓名以办理工单"
                  onChange={(e) => setOperator(e.target.value.trim())}
                />
              </div>
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
      </OperatorCtx.Provider>
    </ToastCtx.Provider>
  );
}
