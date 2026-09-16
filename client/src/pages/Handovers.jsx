import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Plus, ClipboardList, ArrowRight, XCircle, ChevronRight, Moon, Sun, Sunset } from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Empty, Modal } from '../components/common.jsx';
import { HANDOVER_STATUS, fmtFull, fmtShift } from '../utils.js';
import HandoverDetail from '../components/HandoverDetail.jsx';

const SHIFT_ICON = { day: Sun, swing: Sunset, night: Moon };

function localYMD(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftRange(s) {
  const f = (t) => {
    if (!t) return '开放';
    const d = new Date(t);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `${f(s.start_at)} – ${f(s.end_at)}`;
}

export default function Handovers({ pendingCount }) {
  const [shifts, setShifts] = useState([]);
  const [handovers, setHandovers] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showShift, setShowShift] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      const [ss, hs] = await Promise.all([api.shifts(), api.handovers()]);
      setShifts(ss);
      setHandovers(hs);
    } catch (e) { toast(e.message, 'error'); }
  };

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (openId) api.handoverDetail(openId).then(setDetail).catch(() => {});
      else load();
    }, 15000);
    return () => clearInterval(timer);
  }, [openId]);

  const loadDetail = async (id) => {
    try { setDetail(await api.handoverDetail(id)); }
    catch (e) { toast(e.message, 'error'); }
  };

  const openHandover = (id) => { setOpenId(id); loadDetail(id); };
  const back = () => { setOpenId(null); setDetail(null); load(); };

  const activeShift = useMemo(() => shifts.find((s) => s.is_active) || null, [shifts]);

  if (openId && detail) {
    return <HandoverDetail detail={detail} onBack={back} onChanged={() => loadDetail(openId)} />;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>班次交接</h1>
          <div className="sub">按作业班次生成交接单：未发车车辆 · 待处理包裹 · 拦截件 · 超时事项，逐项接收或退回</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
          <button className="btn" onClick={() => setShowShift(true)}><Plus size={14} /> 新建班次</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)} disabled={shifts.length < 2}>
            <ClipboardList size={15} /> 生成交接单
          </button>
        </div>
      </div>

      {/* 当前班次 + 班次条 */}
      <div className="card section-gap">
        <div className="card-header"><h3>作业班次</h3></div>
        <div className="card-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {shifts.length === 0 && <Empty text="还没有班次，先新建白班/中班/夜班" />}
          {shifts.map((s) => {
            const Icon = SHIFT_ICON[s.shift_code] || Sun;
            return (
              <div key={s.id} className={`shift-chip ${s.is_active ? 'active' : ''}`}>
                <Icon size={16} />
                <div>
                  <b>{fmtShift(s.work_date, s.name)}</b>
                  <div className="text-muted">{shiftRange(s)}</div>
                </div>
                {s.is_active && <span className="shift-live">在岗</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 交接单列表 */}
      <div className="card">
        <div className="card-header">
          <h3>交接单台账</h3>
          {pendingCount > 0 && <span className="text-muted">有 {pendingCount} 张待签收交接单</span>}
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>交接单号</th><th>交班 → 接班</th><th>状态</th>
                <th>事项</th><th>交班说明</th><th>建单/签收时间</th><th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {handovers.map((h) => (
                <tr key={h.id} className={h.status === 'pending' ? 'row-warn' : h.status === 'cancelled' ? 'row-cancel' : ''}>
                  <td className="mono" style={{ fontWeight: 600 }}>{h.handover_no}</td>
                  <td>
                    <span>{fmtShift(h.shift_work_date, h.shift_name)}</span>
                    <ArrowRight size={12} style={{ margin: '0 6px', color: '#94a3b8' }} />
                    <span>{fmtShift(h.to_shift_work_date, h.to_shift_name)}</span>
                  </td>
                  <td><Badge conf={HANDOVER_STATUS[h.status]} /></td>
                  <td>
                    <div className="ho-mini-counts">
                      <span>{h.item_total} 项</span>
                      {h.item_accepted > 0 && <span className="mc mc-acc">接 {h.item_accepted}</span>}
                      {h.item_returned > 0 && <span className="mc mc-ret">退 {h.item_returned}</span>}
                      {h.item_resolved > 0 && <span className="mc mc-done">完成 {h.item_resolved}</span>}
                      {h.item_pending > 0 && <span className="mc mc-pen">待处理 {h.item_pending}</span>}
                    </div>
                  </td>
                  <td className="text-muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.summary_note || '—'}
                  </td>
                  <td className="text-muted mono" style={{ fontSize: 12 }}>
                    {h.status === 'signed'
                      ? <>签收 {fmtFull(h.signed_at)}</>
                      : h.status === 'cancelled'
                        ? <>作废 {fmtFull(h.cancelled_at)}</>
                        : <>建单 {fmtFull(h.created_at)}</>}
                  </td>
                  <td><button className="btn btn-sm" onClick={() => openHandover(h.id)}>
                    {h.status === 'signed' ? <HistoryLink /> : '处理'} <ChevronRight size={13} />
                  </button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {handovers.length === 0 && <Empty text="还没有交接单，交班时点「生成交接单」自动汇集现场积压" />}
        </div>
      </div>

      {showCreate && (
        <CreateHandoverModal
          shifts={shifts} activeShift={activeShift}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); load(); openHandover(id); }}
        />
      )}
      {showShift && (
        <CreateShiftModal onClose={() => setShowShift(false)} onDone={() => { setShowShift(false); load(); }} />
      )}
    </div>
  );
}

function HistoryLink() {
  return <><ClipboardList size={12} /> 追溯</>;
}

// 生成交接单：选择交出/接班班次 + 交班人
function CreateHandoverModal({ shifts, activeShift, onClose, onCreated }) {
  const sorted = [...shifts].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const idx = sorted.findIndex((s) => s.id === activeShift?.id);
  const [fromId, setFromId] = useState(activeShift?.id || sorted[0]?.id || '');
  const [toId, setToId] = useState(idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1].id : sorted.find((s) => s.id !== activeShift?.id)?.id || '');
  const [createdBy, setCreatedBy] = useState('交班人');
  const [note, setNote] = useState('');
  const toast = useToast();

  const create = async () => {
    if (!fromId || !toId) { toast('请选择交出和接班班次', 'error'); return; }
    if (Number(fromId) === Number(toId)) { toast('交出与接班班次不能相同', 'error'); return; }
    try {
      const d = await api.createHandover({ shift_id: fromId, to_shift_id: toId, summary_note: note, created_by: createdBy });
      toast(`交接单 ${d.handover_no} 已生成，汇集 ${d.collected} 项`, 'success');
      onCreated(d.id);
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <Modal title="生成班次交接单" onClose={onClose} width={480}
      footer={<>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={create}><ClipboardList size={14} /> 生成（自动汇集现场）</button>
      </>}>
      <div className="form-row">
        <label>交出班次 *</label>
        <select className="input" value={fromId} onChange={(e) => setFromId(Number(e.target.value))}>
          {sorted.map((s) => <option key={s.id} value={s.id}>{fmtShift(s.work_date, s.name)}（{shiftRange(s)}）</option>)}
        </select>
      </div>
      <div className="form-row">
        <label>接班班次 *</label>
        <select className="input" value={toId} onChange={(e) => setToId(Number(e.target.value))}>
          {sorted.map((s) => <option key={s.id} value={s.id}>{fmtShift(s.work_date, s.name)}（{shiftRange(s)}）</option>)}
        </select>
      </div>
      <div className="form-row">
        <label>交班人</label>
        <input className="input" value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} />
      </div>
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>交班总体说明（可稍后补充）</label>
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="本班总体情况、重点关注事项…" />
      </div>
      <div className="text-muted" style={{ marginTop: 10 }}>
        系统将自动汇集未发车车辆、待分拣/已分拣包裹、拦截件和当前超时事项；上一班退回的事项责任仍在本班，会一并带入。
      </div>
    </Modal>
  );
}

// 新建班次（白班/中班/夜班预设，支持跨午夜）
function CreateShiftModal({ onClose, onDone }) {
  const today = localYMD();
  const [preset, setPreset] = useState('day');
  const [name, setName] = useState('白班');
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('16:00');
  const toast = useToast();

  const applyPreset = (code) => {
    setPreset(code);
    const map = {
      day: { name: '白班', start: '08:00', end: '16:00' },
      swing: { name: '中班', start: '16:00', end: '24:00' },
      night: { name: '夜班', start: '22:00', end: '06:00' },
      custom: { name: '自定义', start: '09:00', end: '18:00' },
    }[code];
    setName(map.name); setStart(map.start); setEnd(map.end);
  };

  const submit = async () => {
    try {
      // 结束时间早于/等于开始 → 跨午夜，结束日 = 次日
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end === '24:00' ? [24, 0] : end.split(':').map(Number);
      const startDt = new Date(`${date}T00:00:00`);
      startDt.setHours(sh, sm, 0, 0);
      let endDt = new Date(startDt);
      if (end === '24:00') { endDt = new Date(startDt); endDt.setHours(23, 59, 0, 0); endDt.setDate(endDt.getDate() + 1); }
      else {
        endDt.setHours(eh, em, 0, 0);
        if (endDt <= startDt) endDt.setDate(endDt.getDate() + 1);
      }
      await api.createShift({
        name: name.trim(), shift_code: preset, work_date: date,
        start_at: startDt.toISOString(), end_at: endDt.toISOString(),
      });
      toast('班次已创建', 'success');
      onDone();
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <Modal title="新建作业班次" onClose={onClose} width={440}
      footer={<>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={submit}>创建</button>
      </>}>
      <div className="form-row">
        <label>班次类型</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['day', '白班 08-16'], ['swing', '中班 16-24'], ['night', '夜班 22-06'], ['custom', '自定义']].map(([k, label]) => (
            <button key={k} type="button" className={`preset-btn ${preset === k ? 'active' : ''}`} onClick={() => applyPreset(k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>班次名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={preset !== 'custom'} />
      </div>
      <div className="form-row">
        <label>作业日期（夜班归实际上班那天，可跨午夜追溯）</label>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="form-row" style={{ flex: 1 }}>
          <label>上班时间</label>
          <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="form-row" style={{ flex: 1 }}>
          <label>下班时间</label>
          <input className="input" type="time" step="60" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div className="text-muted">下班时间早于上班时间时自动按跨午夜处理（结束于次日）。</div>
    </Modal>
  );
}
