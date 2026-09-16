import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw, Plus, Play, UploadCloud, Trash2, Pencil, Ban, CheckCircle2,
  AlertTriangle, Route, Boxes, X,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { CHUTE_STATUS, fmtDateTime } from '../utils.js';

const EMPTY_RULE_FORM = { priority: '100', destination: '', min_weight: '', max_weight: '', chute_id: '' };

const fmtWeightRange = (r) => {
  if (r.min_weight == null && r.max_weight == null) return '不限';
  return `${r.min_weight ?? 0} ~ ${r.max_weight ?? '∞'} kg`;
};

export default function SortRules() {
  const [data, setData] = useState({ published: null, draft: null });
  const [chutes, setChutes] = useState([]);
  const [sim, setSim] = useState(null);
  const [ruleForm, setRuleForm] = useState(EMPTY_RULE_FORM);
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [chuteForm, setChuteForm] = useState({ code: '', name: '' });
  const [disableTarget, setDisableTarget] = useState(null);
  const [rerouteId, setRerouteId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [sr, cs] = await Promise.all([api.sortRules(), api.chutes()]);
      setData(sr);
      setChutes(cs);
    } catch (e) {
      toast(e.message, 'error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'success');
      await load();
      return r;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const activeChutes = chutes.filter((c) => c.status === 'active');
  const { published, draft } = data;

  // ── 草稿规则编辑 ──
  const startEdit = (r) => {
    setEditingRuleId(r.id);
    setRuleForm({
      priority: String(r.priority),
      destination: r.destination || '',
      min_weight: r.min_weight ?? '',
      max_weight: r.max_weight ?? '',
      chute_id: String(r.chute_id),
    });
  };
  const resetRuleForm = () => { setEditingRuleId(null); setRuleForm(EMPTY_RULE_FORM); };

  const saveRule = async () => {
    if (!ruleForm.chute_id) { toast('请选择目标格口', 'error'); return; }
    const body = { ...ruleForm, chute_id: Number(ruleForm.chute_id) };
    await run(
      () => (editingRuleId ? api.updateRule(editingRuleId, body) : api.addRule(body)),
      editingRuleId ? '规则已更新' : '规则已加入草稿'
    );
    resetRuleForm();
    setSim(null); // 规则变了，旧试算结果作废
  };

  const simulate = async () => {
    setBusy(true);
    try {
      setSim(await api.simulateDraft());
      await load(); // 刷新草稿的试算时间，解锁发布按钮
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    await run(() => api.publishDraft(), '新版本已发布，扫描分拣即刻生效');
    setSim(null);
  };

  const disableChute = async () => {
    const r = await run(
      () => api.disableChute(disableTarget.id, rerouteId ? { reroute_chute_id: Number(rerouteId) } : {}),
      rerouteId
        ? `格口 ${disableTarget.code} 已停用，改道已写入草稿，试算发布后生效`
        : `格口 ${disableTarget.code} 已停用`
    );
    if (r) { setDisableTarget(null); setRerouteId(''); }
  };

  const createChute = async () => {
    if (!chuteForm.code.trim() || !chuteForm.name.trim()) { toast('请填写格口编码和名称', 'error'); return; }
    await run(() => api.createChute(chuteForm), '格口已创建');
    setChuteForm({ code: '', name: '' });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>分拣规则与格口</h1>
          <div className="sub">维护格口与分拣规则，草稿先试算影响再发布；扫描时按发布版给出目标格口</div>
        </div>
        <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
      </div>

      {/* 版本状态条 */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}><Route size={22} /></div>
          <div>
            <div className="stat-value">{published ? `v${published.version_no}` : '—'}</div>
            <div className="stat-label">
              当前发布版{published ? ` · ${published.rules.length} 条规则 · ${fmtDateTime(published.published_at)} 发布` : '（尚未发布）'}
            </div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: draft ? '#fef3c7' : '#f1f5f9', color: draft ? '#b45309' : '#94a3b8' }}>
            <Pencil size={22} />
          </div>
          <div>
            <div className="stat-value">{draft ? `${draft.rules.length} 条` : '无'}</div>
            <div className="stat-label">草稿（{draft ? '编辑中，未生效' : '新建草稿后开始调整规则'}）</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#dbeafe', color: '#1d4ed8' }}><Boxes size={22} /></div>
          <div>
            <div className="stat-value">{activeChutes.length}<span style={{ fontSize: 14, color: 'var(--text-3)' }}> / {chutes.length}</span></div>
            <div className="stat-label">启用格口 / 格口总数</div>
          </div>
        </div>
      </div>

      {/* ── 草稿编辑 ── */}
      <div className="card section-gap">
        <div className="card-header">
          <h3><Pencil size={16} color="#b45309" /> 规则草稿{draft ? `（基于 v${published?.version_no ?? 0}，共 ${draft.rules.length} 条）` : ''}</h3>
          {draft ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {!draft.simulated_at && (
                <span className="text-muted" style={{ color: '#b45309' }}>试算后才能发布</span>
              )}
              <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.discardDraft(), '草稿已放弃').then((r) => r && setSim(null))}>
                <X size={13} /> 放弃草稿
              </button>
              <button className="btn btn-next btn-sm" disabled={busy} onClick={simulate}><Play size={13} /> 试算影响</button>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || !draft.rules.length || !draft.simulated_at}
                title={draft.simulated_at ? '' : '请先对当前草稿试算影响'}
                onClick={publish}
              >
                <UploadCloud size={13} /> 发布新版本
              </button>
            </div>
          ) : (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api.createDraft(), '已基于当前发布版创建草稿')}>
              <Plus size={14} /> 新建草稿
            </button>
          )}
        </div>

        {draft && (
          <>
            {/* 规则编辑表单 */}
            <div className="card-body" style={{ borderBottom: '1px solid var(--border)', background: '#f8fafc' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-row" style={{ marginBottom: 0, width: 110 }}>
                  <label>优先级</label>
                  <input className="input" type="number" min="0" value={ruleForm.priority}
                    onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })} />
                </div>
                <div className="form-row" style={{ marginBottom: 0, width: 140 }}>
                  <label>目的地（空=任意）</label>
                  <input className="input" placeholder="如 上海" value={ruleForm.destination}
                    onChange={(e) => setRuleForm({ ...ruleForm, destination: e.target.value })} />
                </div>
                <div className="form-row" style={{ marginBottom: 0, width: 120 }}>
                  <label>重量下限 kg</label>
                  <input className="input" type="number" min="0" step="0.1" placeholder="不限" value={ruleForm.min_weight}
                    onChange={(e) => setRuleForm({ ...ruleForm, min_weight: e.target.value })} />
                </div>
                <div className="form-row" style={{ marginBottom: 0, width: 120 }}>
                  <label>重量上限 kg</label>
                  <input className="input" type="number" min="0" step="0.1" placeholder="不限" value={ruleForm.max_weight}
                    onChange={(e) => setRuleForm({ ...ruleForm, max_weight: e.target.value })} />
                </div>
                <div className="form-row" style={{ marginBottom: 0, width: 200 }}>
                  <label>目标格口</label>
                  <select className="input" value={ruleForm.chute_id}
                    onChange={(e) => setRuleForm({ ...ruleForm, chute_id: e.target.value })}>
                    <option value="">请选择</option>
                    {chutes.map((c) => (
                      <option key={c.id} value={c.id} disabled={c.status !== 'active'}>
                        {c.code} · {c.name}{c.status !== 'active' ? '（已停用）' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn btn-primary" disabled={busy} onClick={saveRule}>
                  {editingRuleId ? <><CheckCircle2 size={14} /> 保存修改</> : <><Plus size={14} /> 添加规则</>}
                </button>
                {editingRuleId && <button className="btn" onClick={resetRuleForm}>取消编辑</button>}
              </div>
              <div className="text-muted" style={{ marginTop: 8 }}>
                优先级数字小者优先；同一包裹命中多条同级规则即判为「冲突」进入待判区；重量区间为 下限 ≤ 重量 &lt; 上限。
              </div>
            </div>

            {/* 草稿规则表 */}
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>优先级</th><th>目的地</th><th>重量区间</th><th>目标格口</th><th style={{ width: 140 }}>操作</th></tr>
                </thead>
                <tbody>
                  {draft.rules.map((r) => (
                    <tr key={r.id} className={r.chute_status !== 'active' ? 'row-warn' : ''}>
                      <td className="mono">{r.priority}</td>
                      <td>{r.destination || <span className="text-muted">任意目的地</span>}</td>
                      <td className="mono">{fmtWeightRange(r)}</td>
                      <td>
                        <b>{r.chute_code}</b> <span className="text-muted">{r.chute_name}</span>
                        {r.chute_status !== 'active' && <span style={{ color: 'var(--red)', fontSize: 12 }}>（已停用）</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-sm" onClick={() => startEdit(r)}><Pencil size={13} /> 编辑</button>
                          <button className="btn btn-danger btn-sm" disabled={busy}
                            onClick={() => run(() => api.deleteRule(r.id), '规则已删除').then((r2) => r2 && setSim(null))}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {draft.rules.length === 0 && <Empty text="草稿还没有规则，请在上方添加" />}
            </div>
          </>
        )}
        {!draft && (
          <div className="card-body text-muted" style={{ lineHeight: 1.8 }}>
            规则调整采用「草稿 → 试算 → 发布」流程：新建草稿后修改规则，先用当前待分拣包裹试算影响（命中率、冲突、无匹配、各格口负荷），确认无误再发布生效。已分拣的包裹仍保留当时的规则版本，不受新版本影响。
          </div>
        )}
      </div>

      {/* ── 试算结果 ── */}
      {sim && (
        <div className="card section-gap">
          <div className="card-header">
            <h3><Play size={16} color="#1d4ed8" /> 试算结果（对当前 {sim.stats.total} 件待分拣包裹）</h3>
            <button className="modal-close" onClick={() => setSim(null)}><X size={16} /></button>
          </div>
          <div className="card-body">
            <div className="stat-grid" style={{ marginBottom: 14 }}>
              <div className="stat-card"><div><div className="stat-value" style={{ color: 'var(--green)' }}>{sim.stats.routed}</div><div className="stat-label">可自动路由</div></div></div>
              <div className="stat-card"><div><div className="stat-value" style={{ color: sim.stats.conflict ? 'var(--amber)' : 'inherit' }}>{sim.stats.conflict}</div><div className="stat-label">规则冲突 → 待判区</div></div></div>
              <div className="stat-card"><div><div className="stat-value" style={{ color: sim.stats.unmatched ? 'var(--amber)' : 'inherit' }}>{sim.stats.unmatched}</div><div className="stat-label">无匹配规则 → 待判区</div></div></div>
              <div className="stat-card"><div><div className="stat-value">{sim.stats.total ? Math.round((sim.stats.routed / sim.stats.total) * 100) : 0}%</div><div className="stat-label">自动路由覆盖率</div></div></div>
            </div>

            <div className="grid-2">
              <div>
                <h4 style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-2)' }}>各格口预计负荷</h4>
                {sim.per_chute.length === 0 && <div className="text-muted">无包裹被路由</div>}
                {sim.per_chute.map((c) => (
                  <div key={c.code} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span className="mono" style={{ width: 40, fontWeight: 700 }}>{c.code}</span>
                    <div className="progress-bar" style={{ flex: 1 }}>
                      <div style={{ width: `${sim.stats.routed ? (c.count / sim.stats.routed) * 100 : 0}%` }} />
                    </div>
                    <span className="mono text-muted" style={{ width: 50, textAlign: 'right' }}>{c.count} 件</span>
                  </div>
                ))}
              </div>
              <div>
                <h4 style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-2)' }}>规则命中排行</h4>
                {sim.per_rule.length === 0 && <div className="text-muted">没有规则被命中</div>}
                {sim.per_rule.slice(0, 8).map((r) => (
                  <div key={r.rule_id} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                    <span className="mono text-muted">#{r.rule_id}</span>
                    <span style={{ flex: 1 }}>
                      {r.destination || '任意目的地'}
                      {(r.min_weight != null || r.max_weight != null) && <span className="text-muted">（{fmtWeightRange(r)}）</span>}
                      → <b>{r.chute_code}</b>
                    </span>
                    <b className="mono">{r.count}</b>
                  </div>
                ))}
              </div>
            </div>

            {(sim.conflicts.length > 0 || sim.unmatched.length > 0) && (
              <div style={{ marginTop: 14 }}>
                {sim.conflicts.length > 0 && (
                  <div className="alert-item warn">
                    <span className="alert-icon"><AlertTriangle size={16} /></span>
                    <div className="alert-msg">
                      <b>{sim.stats.conflict} 件规则冲突</b>（进待判区），示例：
                      {sim.conflicts.slice(0, 3).map((c) => `${c.tracking_no}（${c.destination}）`).join('、')}
                    </div>
                  </div>
                )}
                {sim.unmatched.length > 0 && (
                  <div className="alert-item warn" style={{ marginBottom: 0 }}>
                    <span className="alert-icon"><AlertTriangle size={16} /></span>
                    <div className="alert-msg">
                      <b>{sim.stats.unmatched} 件无匹配规则</b>（进待判区），示例：
                      {sim.unmatched.slice(0, 3).map((c) => `${c.tracking_no}（${c.destination}）`).join('、')}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid-32">
        {/* ── 发布版规则（只读）── */}
        <div className="card section-gap">
          <div className="card-header">
            <h3><Route size={16} color="#7c3aed" /> 当前生效规则{published ? `（v${published.version_no}）` : ''}</h3>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>优先级</th><th>目的地</th><th>重量区间</th><th>目标格口</th></tr>
              </thead>
              <tbody>
                {(published?.rules || []).map((r) => (
                  <tr key={r.id} className={r.chute_status !== 'active' ? 'row-warn' : ''}>
                    <td className="mono">{r.priority}</td>
                    <td>{r.destination || <span className="text-muted">任意目的地</span>}</td>
                    <td className="mono">{fmtWeightRange(r)}</td>
                    <td>
                      <b>{r.chute_code}</b>
                      {r.chute_status !== 'active' && <span style={{ color: 'var(--red)', fontSize: 12 }}>（已停用，扫描将落空）</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!published && <Empty text="尚未发布任何规则版本" />}
            {published && published.rules.length === 0 && <Empty text="当前版本没有规则" />}
          </div>
        </div>

        {/* ── 格口管理 ── */}
        <div className="card section-gap">
          <div className="card-header"><h3><Boxes size={16} color="#1d4ed8" /> 格口管理</h3></div>
          <div className="card-body" style={{ borderBottom: '1px solid var(--border)', background: '#f8fafc' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-row" style={{ marginBottom: 0, width: 110 }}>
                <label>格口编码</label>
                <input className="input" placeholder="如 A08" value={chuteForm.code}
                  onChange={(e) => setChuteForm({ ...chuteForm, code: e.target.value })} />
              </div>
              <div className="form-row" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
                <label>名称 / 方向</label>
                <input className="input" placeholder="如 华北向（北京/天津）" value={chuteForm.name}
                  onChange={(e) => setChuteForm({ ...chuteForm, name: e.target.value })} />
              </div>
              <button className="btn btn-primary" disabled={busy} onClick={createChute}><Plus size={14} /> 新增格口</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>格口</th><th>名称</th><th>状态</th><th>引用规则</th><th>在格件</th><th style={{ width: 110 }}>操作</th></tr>
              </thead>
              <tbody>
                {chutes.map((c) => (
                  <tr key={c.id} className={c.status === 'disabled' ? 'row-alert' : ''}>
                    <td className="mono" style={{ fontWeight: 700 }}>{c.code}</td>
                    <td>{c.name}</td>
                    <td><Badge conf={CHUTE_STATUS[c.status]} /></td>
                    <td className="mono">
                      {c.published_rule_count}
                      {c.draft_rule_count > 0 && <span className="text-muted">（草稿 +{c.draft_rule_count}）</span>}
                    </td>
                    <td className="mono">{c.sorted_count}</td>
                    <td>
                      {c.status === 'active' ? (
                        <button className="btn btn-danger btn-sm" onClick={() => { setDisableTarget(c); setRerouteId(''); }}>
                          <Ban size={13} /> 停用
                        </button>
                      ) : (
                        <button className="btn btn-next btn-sm" disabled={busy}
                          onClick={() => run(() => api.enableChute(c.id), `格口 ${c.code} 已启用`)}>
                          <CheckCircle2 size={13} /> 启用
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {chutes.length === 0 && <Empty text="还没有格口，请先新增" />}
          </div>
        </div>
      </div>

      {/* 停用格口弹窗（可改道） */}
      {disableTarget && (
        <Modal
          title={`停用格口 ${disableTarget.code}`}
          onClose={() => setDisableTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDisableTarget(null)}>取消</button>
              <button className="btn btn-danger" disabled={busy} onClick={disableChute}><Ban size={14} /> 确认停用</button>
            </>
          }
        >
          {disableTarget.published_rule_count + disableTarget.draft_rule_count > 0 ? (
            <>
              <div className="alert-item warn">
                <span className="alert-icon"><AlertTriangle size={16} /></span>
                <div className="alert-msg">
                  有 <b>{disableTarget.published_rule_count}</b> 条生效规则
                  {disableTarget.draft_rule_count > 0 && <>、<b>{disableTarget.draft_rule_count}</b> 条草稿规则</>}
                  指向该格口。停用后生效规则在扫描时将落空（包裹进入待判区）。
                  选择改道后，变更会写入<b>规则草稿</b>（无草稿则自动基于发布版创建），试算发布后生效，已发布版本不被直接改写。
                </div>
              </div>
              <div className="form-row">
                <label>改道目标格口（可选，写入草稿）</label>
                <select className="input" value={rerouteId} onChange={(e) => setRerouteId(e.target.value)}>
                  <option value="">不改道，规则保留指向已停用格口</option>
                  {activeChutes.filter((c) => c.id !== disableTarget.id).map((c) => (
                    <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div className="text-muted" style={{ lineHeight: 1.8 }}>
              没有规则指向该格口。停用后扫描分拣不会再路由到 {disableTarget.code}，已分拣到该格口的包裹记录保留。
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
