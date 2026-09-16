import React from 'react';
import { AlertOctagon, Ban, Truck, ArrowRightCircle, HelpCircle } from 'lucide-react';
import { Modal } from '../components/common.jsx';
import { SCAN_OP, CONFLICT_CODE, RESOLUTION_LABEL } from './useQueue.js';
import { fmtLocal } from './ui.js';

// 冲突图标：拦截 / 已发车 / 状态推进 等
function ConflictIcon({ code }) {
  if (code === 'pkg_intercepted') return <Ban size={26} />;
  if (code === 'vehicle_departed' || code === 'vehicle_mismatch') return <Truck size={26} />;
  if (code === 'state_advanced') return <ArrowRightCircle size={26} />;
  return <AlertOctagon size={26} />;
}

export default function ConflictModal({ scan, onResolve, onClose }) {
  if (!scan) return null;
  const op = SCAN_OP[scan.op];
  const r = scan.result || {};
  const server = scan.server || r.server || {};
  const choices = scan.choices?.length ? scan.choices : r.choices || [];

  return (
    <Modal
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--red)' }}><ConflictIcon code={scan.conflict_code} /></span>
          冲突扫描 · {op.label}
        </span>
      }
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>关闭</button>}
    >
      <div className="conflict-box">
        <div className="conflict-code">
          {CONFLICT_CODE[scan.conflict_code] || scan.conflict_code}
        </div>
        <div className="conflict-msg">{scan.conflict_message}</div>
      </div>

      <div className="conflict-detail">
        <div><span>运单号</span><b className="mono">{scan.tracking_no}</b></div>
        <div><span>扫描设备</span><b>{scan.device_id}{scan.device_name ? `（${scan.device_name}）` : ''}</b></div>
        <div><span>扫描时间</span><b className="mono">{fmtLocal(scan.occurred_at)}</b></div>
        {server.status && (
          <div>
            <span>服务器当前</span>
            <b>{server.status}{server.is_abnormal ? ' · 异常件' : ''}</b>
          </div>
        )}
        {server.vehicle && (
          <div>
            <span>所属班次</span>
            <b>{server.vehicle.plate_no}（{server.vehicle.route_code}）· {server.vehicle.status}</b>
          </div>
        )}
      </div>

      <div className="alert-item warn" style={{ marginBottom: 14 }}>
        <span className="alert-icon"><HelpCircle size={16} /></span>
        <div className="alert-msg">
          本次扫描<b>不会覆盖服务器的新状态</b>。请选择处理方式后，该批次可继续补传剩余扫描。
        </div>
      </div>

      {scan.resolution && (
        <div className="conflict-resolved">
          当前处理：{RESOLUTION_LABEL[scan.resolution] || scan.resolution}
          {!scan.resolution_synced ? '（待下次补传回传服务器）' : '（已回传服务器，仍可改选）'}
        </div>
      )}
      <div className="conflict-actions">
        {choices.map((c) => {
          const value = c.key === 'discard' ? 'discarded' : c.key === 'retry' ? 'retried' : 'kept';
          const selected = scan.resolution === value;
          return (
            <button
              key={c.key}
              className={`btn conflict-btn ${c.key === 'discard' ? 'btn-danger' : c.key === 'retry' ? 'btn-primary' : ''} ${selected ? 'conflict-btn-selected' : ''}`}
              onClick={() => onResolve(scan.scan_id, value)}
            >
              {c.key === 'discard' && <Ban size={14} />}
              {c.key === 'retry' && <ArrowRightCircle size={14} />}
              {c.key === 'keep' && <HelpCircle size={14} />}
              {c.label}
              {selected && <span className="conflict-current">当前选择</span>}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
