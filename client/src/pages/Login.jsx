import React, { useState } from 'react';
import { Boxes, LogIn } from 'lucide-react';
import { api, setToken } from '../api.js';

// 本地演示初始化账号（与后端 seed-users.js 一致）
const DEMO_ACCOUNTS = [
  { u: 'admin', p: 'admin123', label: '管理员' },
  { u: 'dispatcher', p: 'dispatch123', label: '调度' },
  { u: 'sorter', p: 'sort123', label: '分拣' },
  { u: 'exception', p: 'exception123', label: '异常处理' },
  { u: 'ops', p: 'ops123', label: '调度+分拣（兼岗）' },
];

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const data = await api.login({ username: form.username.trim(), password: form.password });
      setToken(data.token);
      onLogin(data.user);
    } catch (e2) {
      setError(e2.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <div className="logo-icon"><Boxes size={22} color="#fff" /></div>
          <div>
            <h1>快递分拨管理系统</h1>
            <div className="login-sub">EXPRESS HUB · 请使用岗位账号登录</div>
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>账号</label>
            <input
              className="input" autoFocus autoComplete="username"
              placeholder="登录账号"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>密码</label>
            <input
              className="input" type="password" autoComplete="current-password"
              placeholder="登录密码"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn-primary login-btn" type="submit" disabled={loading}>
            <LogIn size={15} /> {loading ? '登录中…' : '登 录'}
          </button>
        </form>
        <div className="login-demo">
          <div className="login-demo-title">本地演示账号（点击填充）</div>
          <div className="login-demo-list">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.u} type="button" className="login-demo-item"
                onClick={() => { setForm({ username: a.u, password: a.p }); setError(''); }}
              >
                <b>{a.label}</b>
                <span className="mono">{a.u}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
