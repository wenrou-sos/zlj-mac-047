import React from 'react';
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
