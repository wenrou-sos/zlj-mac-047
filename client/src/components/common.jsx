import React, { useState } from 'react';
import { X, Inbox } from 'lucide-react';

export function Badge({ conf, children }) {
  if (!conf) return null;
  return (
    <span className="badge" style={{ color: conf.color, background: conf.bg }}>
      <span className="dot" />
      {children || conf.label}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, width }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function StatCard({ icon, label, value, iconBg, iconColor }) {
  return (
    <div className="stat-card">
      <div className="stat-icon" style={{ background: iconBg, color: iconColor }}>{icon}</div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

export function Empty({ text = '暂无数据' }) {
  return (
    <div className="empty">
      <Inbox size={36} />
      <div>{text}</div>
    </div>
  );
}

// 必须填写原因的操作（插队/召回/取消/停用），强制留痕
export function ReasonModal({
  title, label = '原因（必填）', placeholder, confirmText = '确认', danger, onClose, onConfirm, children,
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = () => {
    if (!reason.trim()) { setErr('请填写原因'); return; }
    onConfirm(reason.trim());
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={submit}>{confirmText}</button>
        </>
      }
    >
      {children}
      <div className="form-row">
        <label>{label}</label>
        <textarea
          className="input"
          rows={3}
          autoFocus
          placeholder={placeholder || '请说明原因，操作将记录在案'}
          value={reason}
          onChange={(e) => { setReason(e.target.value); setErr(''); }}
        />
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 5 }}>{err}</div>}
      </div>
    </Modal>
  );
}
