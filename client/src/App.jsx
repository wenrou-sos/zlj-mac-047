import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { LayoutDashboard, Truck, Package, BarChart3, CheckCircle2, XCircle, Boxes, ScanLine } from 'lucide-react';
import Dashboard from './pages/Dashboard.jsx';
import Vehicles from './pages/Vehicles.jsx';
import Packages from './pages/Packages.jsx';
import Stats from './pages/Stats.jsx';
import Handheld from './handheld/Handheld.jsx';
import { queueStore } from './handheld/scanQueue.js';
import { useQueue } from './handheld/useQueue.js';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

const PAGES = [
  { key: 'dashboard', label: '监控总览', icon: LayoutDashboard },
  { key: 'vehicles', label: '车辆班次', icon: Truck },
  { key: 'packages', label: '包裹与拦截', icon: Package },
  { key: 'handheld', label: '手持扫描台', icon: ScanLine },
  { key: 'stats', label: '积压统计', icon: BarChart3 },
];

function HandheldBadge() {
  const snap = useQueue();
  const n = snap.scans.filter(
    (s) => s.state === 'pending' || s.state === 'error' || (s.state === 'conflict' && !s.resolution)
  ).length;
  return n > 0 ? <span className="nav-badge nav-badge-amber">{n}</span> : null;
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [toasts, setToasts] = useState([]);
  const [alertCount, setAlertCount] = useState(0);
  const idRef = useRef(0);

  React.useEffect(() => { queueStore.init(); }, []);

  const toast = useCallback((msg, type = 'info') => {
    const id = ++idRef.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
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
            {PAGES.map(({ key, label, icon: Icon }) => (
              <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
                <Icon size={17} />
                {label}
                {key === 'dashboard' && alertCount > 0 && (
                  <span className="nav-badge">{alertCount}</span>
                )}
                {key === 'handheld' && <HandheldBadge />}
              </button>
            ))}
          </nav>
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
          {page === 'handheld' && <Handheld />}
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
    </ToastCtx.Provider>
  );
}
