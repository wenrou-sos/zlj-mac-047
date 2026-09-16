import React, { useMemo, useState } from 'react';
import {
  ArrowLeft, Truck, Package, Ban, AlertTriangle, FileText, Plus,
  Check, Undo2, Send, PenLine, CheckCircle2, History, ClipboardList, XCircle,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Empty, Modal } from '../components/common.jsx';
import { HANDOVER_STATUS, HANDOVER_ITEM_STATUS, HANDOVER_ITEM_TYPES, fmtFull, fmtShift } from '../utils.js';

const TYPE_ICON = {
  vehicle: Truck, package: Package, intercept: Ban, alert: AlertTriangle, note: FileText,
};

// 一组（车辆/包裹/拦截件/超时/补充）
function ItemGroup({ type, items, open: isOpen, openGroup, followups, onDecide, receiverName }) {
  const conf = HANDOVER_ITEM_TYPES[type];
  const Icon = TYPE_ICON[type];
  const counts = items.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] || 0) + 1 }), {});
  const subtitle = ['pending', 'accepted', 'returned', 'resolved']
    .filter((s) => counts[s])
    .map((s) => `${HANDOVER_ITEM_STATUS[s].label} ${counts[s]}`)
    .join(' · ');

  return (
    <div className="ho-group">
      <button className="ho-group-title" onClick={openGroup}>
        <span className="ho-type-icon" style={{ color: conf.color, background: conf.bg }}><Icon size={15} /></span>
        <b>{conf.label}</b>
        <span className="ho-count">{items.length}</span>
        <span className="text-muted" style={{ marginLeft: 8 }}>{subtitle}</span>
        <Plus size={14} className="ho-chevron" style={{ transform: isOpen ? 'rotate(45deg)' : 'none' }} />
      </button>
      {isOpen && (
        <div className="ho-items">
          {items.map((it) => (
            <ItemRow
              key={it.id} item={it} followup={followups ? followups[String(it.id)] : null}
              onDecide={onDecide} onChanged={onChanged} receiverName={receiverName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, followup, onDecide, onChanged, receiverName }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(item.item_note || '');
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const signed = onDecide == null; // 已签收视图无决定回调

  const saveNote = async () => {
    try {
      await api.setItemNote(item.id, note);
      toast('补充说明已保存', 'success');
      setEditing(false);
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className={`ho-item ho-item-${item.status}`}>
      <div className="ho-item-main">
        <div className="ho-item-title">
          <span className="mono">{item.title}</span>
          {item.is_appended && <span className="ho-appended">交接中追加</span>}
          {item.source_item_id && (
            <span className="ho-chain-tag" title="该事项来自上一张交接单"><History size={11} /> 转交办</span>
          )}
        </div>
        {item.subtitle && <div className="ho-item-sub">{item.subtitle}</div>}
        {item.detail && <div className="ho-item-detail">{item.detail}</div>}

        {item.item_note && !editing && (
          <div className="ho-note"><PenLine size={12} /> 交班说明：{item.item_note}</div>
        )}
        {editing ? (
          <div className="ho-note-edit">
            <input className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="补充该事项的处理进展、注意事项…" />
            <button className="btn btn-sm btn-primary" onClick={saveNote}>保存</button>
            <button className="btn btn-sm" onClick={() => { setEditing(item.item_note || ''); setEditing(false); }}>取消</button>
          </div>
        ) : item.status === 'pending' && !signed && (
          <button className="btn btn-sm ho-add-note" onClick={() => setEditing(true)}>
            <PenLine size={12} /> {item.item_note ? '改说明' : '补说明'}
          </button>
        )}

        {item.decision_note && (
          <div className="ho-note ho-return-note"><Undo2 size={12} /> 退回原因：{item.decision_note}</div>
        )}
        {item.resolved_note && item.status === 'resolved' && (
          <div className="ho-resolved-note"><CheckCircle2 size={12} /> {item.resolved_note}（{fmtFull(item.resolved_at)} 自动确认）</div>
        )}
        {item.live_change && (
          <div className="ho-live-change"><AlertTriangle size={12} /> 交接期间变化：{item.live_change}</div>
        )}

        {/* 签收后：后续处理去向 */}
        {signed && followup && item.status !== 'resolved' && (
          <div className={`ho-followup ho-followup-${followup.state}`}>
            {followup.state === 'done' ? <CheckCircle2 size={12} /> : followup.state === 'changed' ? <AlertTriangle size={12} /> : <History size={12} />}
            后续去向：{followup.label}
            {followup.chain?.map((c, i) => (
              <span key={i} className="ho-chain-link">→ {c.handover_no} {c.decision}</span>
            ))}
          </div>
        )}
      </div>

      <div className="ho-item-side">
        <Badge conf={HANDOVER_ITEM_STATUS[item.status]} />
        {!signed && item.status === 'pending' && (
          <div className="ho-decide">
            <button className="btn btn-sm btn-accept" onClick={() => onDecide(item, 'accepted')}>
              <Check size={13} /> 接收
            </button>
            <button className="btn btn-sm btn-return" onClick={() => setReturning(true)}>
              <Undo2 size={13} /> 退回
            </button>
          </div>
        )}
        {!signed && (item.status === 'accepted' || item.status === 'returned') && (
          <button className="btn btn-sm" onClick={() => onDecide(item, 'pending')}>撤回决定</button>
        )}
      </div>

      {returning && (
        <Modal
          title={`退回 · ${item.title}`}
          onClose={() => { setReturning(false); setReason(''); }}
          width={420}
          footer={
            <>
              <button className="btn" onClick={() => { setReturning(false); setReason(''); }}>取消</button>
              <button className="btn btn-danger"
                onClick={async () => {
                  if (!reason.trim()) { toast('请填写退回原因', 'error'); return; }
                  try {
                    await api.decideItem(item.id, { status: 'returned', decision_note: reason, decided_by: receiverName });
                    toast('已退回，仍由交出班次负责', 'success');
                    setReturning(false); setReason('');
                    onChanged();
                  } catch (e) {
                    toast(e.message, 'error');
                    setReturning(false); setReason('');
                    onChanged();
                  }
                }}>
                <Undo2 size={13} /> 确认退回
              </button>
            </>
          }
        >
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>退回原因 *（签收后该事项责任仍归交出班次）</label>
            <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="如：信息不全/责任不清，需交班继续处理" />
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function HandoverDetail({ detail, onBack, onChanged }) {
  const toast = useToast();
  const [openGroups, setOpenGroups] = useState({ vehicle: true, package: false, intercept: true, alert: true, note: true });
  const [showAppend, setShowAppend] = useState(false);
  const [customNote, setCustomNote] = useState({ title: '', detail: '' });
  const [signing, setSigning] = useState(false);
  const [receiverName, setReceiverName] = useState('接班人');
  const { doc, items, followups, appendable } = detail;

  const open = doc.status === 'draft' || doc.status === 'pending';
  const signed = doc.status === 'signed';
  const canSubmit = doc.status === 'draft';
  const canSign = doc.status === 'pending';

  const groups = useMemo(() => {
    const g = { vehicle: [], package: [], intercept: [], alert: [], note: [] };
    for (const it of items) (g[it.item_type] || g.note).push(it);
    return g;
  }, [items]);

  const counts = useMemo(() => items.reduce(
    (acc, i) => ({ ...acc, [i.status]: (acc[i.status] || 0) + 1 }), {}), [items]);

  const decide = async (item, status) => {
    try {
      await api.decideItem(item.id, status === 'pending'
        ? { status: 'pending' }
        : { status, decided_by: receiverName });
      toast(status === 'accepted' ? '已接收' : status === 'pending' ? '已撤回' : '已处理', 'success');
      onChanged();
    } catch (e) {
      // 现场在点击瞬间已完成等情况：服务端已自动确认，刷新让该项变为"作业已完成"
      toast(e.message, 'error');
      onChanged();
    }
  };

  const appendLive = async (it) => {
    try {
      await api.appendItem(doc.id, {
        item_type: it.item_type, item_key: it.item_key, ref_id: it.ref_id,
        title: it.title, subtitle: it.subtitle, detail: it.detail,
        snapshot: it.snapshot, source_item_id: it.source_item_id,
      });
      toast('已追加到交接单', 'success');
      onChanged();
    } catch (e) { toast(e.message, 'error'); }
  };

  const appendCustom = async () => {
    if (!customNote.title.trim()) { toast('请填写事项标题', 'error'); return; }
    try {
      await api.appendItem(doc.id, {
        item_type: 'note',
        item_key: `note:manual:${Date.now()}`,
        title: customNote.title.trim(),
        detail: customNote.detail || null,
        snapshot: { manual: true },
      });
      toast('补充事项已加入', 'success');
      setCustomNote({ title: '', detail: '' });
      setShowAppend(false);
      onChanged();
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn" onClick={onBack}><ArrowLeft size={14} /> 返回</button>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {doc.handover_no}
              <Badge conf={HANDOVER_STATUS[doc.status]} />
            </h1>
            <div className="sub">
              {fmtShift(doc.shift_work_date, doc.shift_name)} 交班 → {fmtShift(doc.to_shift_work_date, doc.to_shift_name)} 接班
            </div>
          </div>
        </div>
        {open && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setShowAppend(true)}><Plus size={14} /> 追加事项</button>
            {canSubmit && <button className="btn btn-primary" onClick={async () => {
              try {
                await api.submitHandover(doc.id);
                toast('已提交，请接班人逐项签收', 'success'); onChanged();
              } catch (e) { toast(e.message, 'error'); }
            }}><Send size={14} /> 提交签收</button>}
            {canSign && (
              <button className="btn btn-sign" disabled={counts.pending > 0} onClick={() => setSigning(true)}>
                <CheckCircle2 size={15} /> 签收{counts.pending > 0 ? `（剩${counts.pending}项）` : ''}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 单据头：说明 + 签收信息 */}
      <div className="card section-gap">
        <div className="card-body">
          <SummaryBlock doc={doc} onChanged={onChanged} />
          <div className="ho-meta">
            <span>建单：{doc.created_by} · {fmtFull(doc.created_at)}</span>
            {doc.submitted_at && <span>提交：{fmtFull(doc.submitted_at)}</span>}
            {signed && <span className="ho-signed-meta">签收：{doc.signed_by} · {fmtFull(doc.signed_at)}（结果已冻结，不可修改）</span>}
            {doc.status === 'cancelled' && <span>作废：{doc.cancelled_by} · {fmtFull(doc.cancelled_at)}（{doc.cancel_reason || '无'}）</span>}
          </div>
        </div>
      </div>

      {/* 统计条 */}
      <div className="ho-stat-bar">
        <div className="ho-stat"><b>{items.length}</b><span>合计</span></div>
        <div className="ho-stat ho-stat-pending"><b>{counts.pending || 0}</b><span>待接收</span></div>
        <div className="ho-stat ho-stat-accepted"><b>{counts.accepted || 0}</b><span>已接收</span></div>
        <div className="ho-stat ho-stat-returned"><b>{counts.returned || 0}</b><span>已退回（归原班）</span></div>
        <div className="ho-stat ho-stat-resolved"><b>{counts.resolved || 0}</b><span>交接期间完成</span></div>
      </div>

      {canSign && counts.pending > 0 && (
        <div className="alert-item warn" style={{ marginBottom: 14 }}>
          <span className="alert-icon"><ClipboardList size={16} /></span>
          <div className="alert-msg">
            还有 <b>{counts.pending}</b> 项未处理。交接期间已完成的作业会<b>自动确认</b>，其余请逐项「接收」或「退回」，全部处理完才能签收。
          </div>
        </div>
      )}
      {signed && (counts.returned > 0) && (
        <div className="alert-item overdue" style={{ marginBottom: 14 }}>
          <span className="alert-icon"><XCircle size={16} /></span>
          <div className="alert-msg">本单有 <b>{counts.returned}</b> 项被退回，责任仍归{doc.shift_name}，已自动带入该班次下一张交接单。</div>
        </div>
      )}

      {/* 现场新出现、可追加的事项 */}
      {open && appendable?.length > 0 && (
        <div className="card section-gap ho-appendable">
          <div className="card-header">
            <h3><Plus size={15} /> 交接期间现场新出现（{appendable.length}）</h3>
            <span className="text-muted">属于交出班次责任，可追加到本单一起交接</span>
          </div>
          <div className="card-body" style={{ paddingTop: 10 }}>
            {appendable.slice(0, 8).map((it) => (
              <div key={it.item_key} className="ho-append-row">
                <span className="badge" style={{ color: HANDOVER_ITEM_TYPES[it.item_type].color, background: HANDOVER_ITEM_TYPES[it.item_type].bg }}>
                  {HANDOVER_ITEM_TYPES[it.item_type].label}
                </span>
                <span className="mono">{it.title}</span>
                <span className="text-muted">{it.subtitle}</span>
                <button className="btn btn-sm btn-next" onClick={() => appendLive(it)}>加入交接</button>
              </div>
            ))}
            {appendable.length > 8 && <div className="text-muted" style={{ padding: '4px 2px' }}>其余 {appendable.length - 8} 项可在页面刷新后继续追加…</div>}
          </div>
        </div>
      )}

      {/* 事项分组 */}
      {Object.entries(groups).map(([type, list]) => list.length > 0 && (
        <div className="card section-gap" key={type}>
          <ItemGroup
            type={type} items={list} open={openGroups[type]}
            openGroup={() => setOpenGroups((s) => ({ ...s, [type]: !s[type] }))}
            followups={followups} onDecide={open ? decide : null} receiverName={receiverName}
          />
        </div>
      ))}

      {items.length === 0 && <Empty text="本交接单没有事项（建单时现场无积压，之后可追加）" />}

      {/* 追加事项弹窗 */}
      {showAppend && (
        <Modal title="追加交接事项" onClose={() => setShowAppend(false)} width={460}
          footer={<>
            <button className="btn" onClick={() => setShowAppend(false)}>关闭</button>
            <button className="btn btn-primary" onClick={appendCustom} disabled={!customNote.title.trim()}>
              <Plus size={14} /> 加入补充事项
            </button>
          </>}>
          <div className="form-row">
            <label>口头/现场补充事项</label>
            <input className="input" placeholder="如：西门卷帘门故障、等待客服回复"
              value={customNote.title} onChange={(e) => setCustomNote({ ...customNote, title: e.target.value })} />
          </div>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>详细说明</label>
            <input className="input" placeholder="进展、联系人、注意事项（选填）"
              value={customNote.detail} onChange={(e) => setCustomNote({ ...customNote, detail: e.target.value })} />
          </div>
          <div className="text-muted" style={{ marginTop: 10 }}>
            现场新出现的车辆/包裹/拦截件显示在页面「交接期间现场新出现」区域，可一键加入。
          </div>
        </Modal>
      )}

      {/* 签收弹窗 */}
      {signing && (
        <Modal title="交接签收" onClose={() => setSigning(false)} width={440}
          footer={<>
            <button className="btn" onClick={() => setSigning(false)}>再核对一下</button>
            <button className="btn btn-sign" onClick={async () => {
              try {
                await api.signHandover(doc.id, receiverName || '接班人');
                toast('签收完成，交接单已归档冻结', 'success');
                setSigning(false); onChanged();
              } catch (e) { toast(e.message, 'error'); }
            }}><CheckCircle2 size={15} /> 确认签收</button>
          </>}>
          <div className="ho-sign-summary">
            <div><b>{items.length}</b> 项交接事项</div>
            <div className="ho-sign-acc"><b>{counts.accepted || 0}</b> 项接收</div>
            <div className="ho-sign-res"><b>{counts.resolved || 0}</b> 项交接期间已完成</div>
            {counts.returned > 0 && <div className="ho-sign-ret"><b>{counts.returned}</b> 项退回，责任仍归{doc.shift_name}</div>}
          </div>
          <div className="form-row" style={{ marginBottom: 0, marginTop: 12 }}>
            <label>接班人签名</label>
            <input className="input" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} placeholder="接班人姓名" />
          </div>
          <div className="text-muted" style={{ marginTop: 10 }}>
            签收后本单内容与逐项结果<b>立即冻结为历史快照</b>，之后现场变化只记录在「后续去向」中，不改变交接结果；跨午夜及再次转交均可凭单号追溯。
          </div>
        </Modal>
      )}
    </div>
  );
}

// 总体说明（草稿可编辑）
function SummaryBlock({ doc, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(doc.summary_note || '');

  if (doc.status !== 'draft') {
    return (
      <div className="ho-summary">
        <FileText size={15} className="ho-summary-icon" />
        <div style={{ flex: 1 }}>
          <div className="text-muted" style={{ marginBottom: 3 }}>交班总体说明</div>
          {doc.summary_note ? doc.summary_note : <span className="text-muted">（交班人未填写总体说明）</span>}
        </div>
      </div>
    );
  }
  if (!editing) {
    return (
      <div className="ho-summary">
        <FileText size={15} className="ho-summary-icon" />
        <div style={{ flex: 1 }}>
          <div className="text-muted" style={{ marginBottom: 3 }}>交班总体说明</div>
          {doc.summary_note || <span className="text-muted">点击右侧按钮补充本班作业总体情况…</span>}
        </div>
        <button className="btn btn-sm" onClick={() => { setText(doc.summary_note || ''); setEditing(true); }}>
          <PenLine size={12} /> {doc.summary_note ? '编辑' : '补充说明'}
        </button>
      </div>
    );
  }
  return (
    <div>
      <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="总体作业进展、需接班人重点关注的问题、待回复事项…" />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm" onClick={() => setEditing(false)}>取消</button>
        <button className="btn btn-sm btn-primary" onClick={async () => {
          try {
            await api.saveSummary(doc.id, text);
            toast('总体说明已保存', 'success');
            setEditing(false); onChanged();
          } catch (e) { toast(e.message, 'error'); }
        }}>保存</button>
      </div>
    </div>
  );
}
