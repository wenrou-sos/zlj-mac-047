import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, ShieldCheck, Ban, Clock } from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Empty } from '../components/common.jsx';
import { SCAN_OP } from './useQueue.js';
import { fmtLocal } from './ui.js';

const LEDGER_STATUS = {
  applied:  { label: '已记账', color: '#15803d', bg: '#dcfce7' },
  conflict: { label: '冲突暂停', color: '#b91c1c', bg: '#fee2e2' },
};
const RESOLUTION = {
  discarded: '已放弃',
  kept: '人工暂留',
  retried: '已重扫',
};

export default function LedgerTab() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.scanLedger({ status, tracking_no: q, limit: 200 }));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [status, q, toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="card">
      <div className="card-header">
        <h3>
          <ShieldCheck size={16} /> 扫描补传台账
          <span className="text-muted">服务器记账明细 · 每条扫描（scan_id）只记账一次，刷新/重复补传均回放首次结果</span>
        </h3>
        <div className="filter-bar">
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }} />
            <input
              className="input" style={{ paddingLeft: 30, width: 180 }}
              placeholder="搜索运单号" value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部结果</option>
            <option value="applied">已记账</option>
            <option value="conflict">冲突暂停</option>
          </select>
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> 刷新
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>作业</th><th>运单号</th><th>设备</th><th>扫描发生时间</th>
              <th>结果</th><th>冲突说明 / 处理</th><th>记账时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const op = SCAN_OP[l.op];
              const st = LEDGER_STATUS[l.status];
              return (
                <tr key={l.id} className={l.status === 'conflict' && !l.resolution ? 'row-alert' : ''}>
                  <td><span className="badge" style={{ color: op.color, background: op.bg }}>{op.label}</span></td>
                  <td className="mono">{l.tracking_no}</td>
                  <td className="text-muted">{l.device_id}</td>
                  <td className="mono">{fmtLocal(l.occurred_at)}</td>
                  <td>
                    <span className="badge" style={{ color: st.color, background: st.bg }}>
                      {l.status === 'conflict' ? <Ban size={11} /> : <ShieldCheck size={11} />}
                      {st.label}
                    </span>
                    {l.resolution && (
                      <div className="text-muted" style={{ marginTop: 3 }}>{RESOLUTION[l.resolution] || l.resolution}</div>
                    )}
                  </td>
                  <td style={{ maxWidth: 340 }}>
                    {l.status === 'conflict' ? (
                      <>
                        <div>{l.conflict_message}</div>
                        {!l.resolution && <div className="text-muted" style={{ color: 'var(--red)' }}><Clock size={11} /> 待人工选择处理</div>}
                      </>
                    ) : (
                      <span className="text-muted">
                        {l.result?.message || '记账成功'}
                        {l.result?.replayed ? '（重复补传已忽略）' : ''}
                      </span>
                    )}
                  </td>
                  <td className="mono text-muted">{l.applied_at ? fmtLocal(l.applied_at) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <Empty text="暂无台账记录（在线扫描或补传成功后在此可查）" />}
      </div>
    </div>
  );
}
