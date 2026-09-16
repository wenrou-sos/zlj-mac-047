import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, RefreshCw, ClipboardList, Lock, Unlock, Split, Shuffle, XCircle,
  Truck, PackageCheck, Weight, Timer, MapPin, ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { Badge, Modal, Empty } from '../components/common.jsx';
import { PLAN_STATUS, VEHICLE_STATUS, fmtDateTime, fmtAgo, fmtKg } from '../utils.js';

export default function LoadPlans({ presetVehicleId, onConsumePreset }) {
  const [plans, setPlans] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [filterVehicle, setFilterVehicle] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [ps, vs] = await Promise.all([
        api.loadPlans(filterVehicle ? { vehicle_id: filterVehicle } : {}),
        api.vehicles(),
      ]);
      setPlans(ps);
      setVehicles(vs);
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [filterVehicle, toast]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (presetVehicleId) {
      setFilterVehicle(String(presetVehicleId));
      setShowCreate(true);
      onConsumePreset?.();
    }
  }, [presetVehicleId, onConsumePreset]);

  const action = async (fn, ok) => {
    try { await fn(); toast(ok, 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const departable = vehicles.filter((v) => v.status === 'sorted');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>出港配载</h1>
          <div className="sub">从在场已分拣件按目的地、截单时间、载重建立配载单；支持发车前拆单、撤配、改配，确认发车后锁定实际清单</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={load}><RefreshCw size={14} /> 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={15} /> 新建配载单</button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="filter-bar">
            <select className="input" value={filterVehicle} onChange={(e) => setFilterVehicle(e.target.value)}>
              <option value="">全部出港班次</option>
              {vehicles.filter((v) => v.status !== 'departed' && v.status !== 'expected').map((v) => (
                <option key={v.id} value={v.id}>{v.plate_no} · {v.route_code}</option>
              ))}
            </select>
            <span className="text-muted">共 {plans.length} 张配载单</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>配载单号</th><th>出港班次</th><th>目的地</th><th>状态</th>
                <th>实际清单</th><th>载重 / 额定</th><th>截单时间</th><th style={{ width: 230 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const pct = p.capacity_kg ? Math.min(100, Math.round((p.loaded_kg / p.capacity_kg) * 100)) : 0;
                const over = p.loaded_kg > p.capacity_kg;
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>{p.plan_no}</div>
                      <div className="text-muted">{fmtDateTime(p.created_at)} · {p.created_by === 'auto' ? '自动配载' : p.created_by === 'seed' ? '系统' : '手工'}</div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.plate_no}</div>
                      <div className="text-muted">{p.route_code} <Badge conf={VEHICLE_STATUS[p.vehicle_status]} /></div>
                    </td>
                    <td><MapPin size={13} style={{ verticalAlign: -2 }} /> <b>{p.destination || '混装'}</b></td>
                    <td><Badge conf={PLAN_STATUS[p.status]} /></td>
                    <td>
                      <b className="mono">{p.item_count}</b> <span className="text-muted">件</span>
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="progress-bar" style={{ flex: 1 }}>
                          <div style={{ width: `${pct}%`, background: over ? 'var(--red)' : undefined }} />
                        </div>
                        <span className="mono text-muted" style={{ whiteSpace: 'nowrap' }}>
                          {fmtKg(p.loaded_kg)}/{fmtKg(p.capacity_kg)}
                        </span>
                      </div>
                    </td>
                    <td className="text-muted">{p.cutoff_at ? `${fmtDateTime(p.cutoff_at)}（${fmtAgo(p.cutoff_at)}）` : '不限'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-next btn-sm" onClick={() => setDetailId(p.id)}>
                          <ClipboardList size={13} /> 清单
                        </button>
                        {p.status === 'draft' && (
                          <button className="btn btn-sm" onClick={() => action(() => api.planSeal(p.id), `${p.plan_no} 已封车`)}>
                            <Lock size={13} /> 封车
                          </button>
                        )}
                        {p.status === 'sealed' && (
                          <button className="btn btn-sm" onClick={() => action(() => api.planUnseal(p.id), `${p.plan_no} 已解封`)}>
                            <Unlock size={13} /> 解封
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plans.length === 0 && <Empty text="暂无配载单，选择待发车班次新建" />}
        </div>
      </div>

      {showCreate && (
        <CreatePlanModal
          vehicles={departable}
          defaultVehicleId={filterVehicle}
          onClose={() => setShowCreate(false)}
          onCreated={(r) => {
            setShowCreate(false);
            if (r.overflow_count) {
              toast(`${r.plan.plan_no} 已建立：配载 ${r.plan.item_count} 件 / ${fmtKg(r.plan.loaded_kg)}，${r.overflow_count} 件装不下已留待下一班`, 'success');
            } else {
              toast(`${r.plan.plan_no} 已建立，配载 ${r.plan.item_count} 件 / ${fmtKg(r.plan.loaded_kg)}`, 'success');
            }
            load();
            setDetailId(r.plan.id);
          }}
        />
      )}
      {detailId && (
        <PlanDetail id={detailId} vehicles={vehicles} onClose={() => setDetailId(null)} onChanged={load} />
      )}
    </div>
  );
}

// ── 新建配载单：选班次/目的地，实时预览自动分配结果与装不下的积压 ──
function CreatePlanModal({ vehicles, defaultVehicleId, onClose, onCreated }) {
  const [vehicleId, setVehicleId] = useState(defaultVehicleId || vehicles[0]?.id || '');
  const [destination, setDestination] = useState('');
  const [capacity, setCapacity] = useState('');
  const [auto, setAuto] = useState(true);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const vehicle = vehicles.find((v) => String(v.id) === String(vehicleId));

  const loadPreview = useCallback(async () => {
    if (!vehicleId || !auto) { setPreview(null); return; }
    try {
      setPreview(await api.previewCandidates({
        vehicle_id: vehicleId, destination: destination || undefined, limit_kg: capacity || undefined,
      }));
    } catch (e) { setPreview(null); }
  }, [vehicleId, destination, capacity, auto]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  useEffect(() => {
    if (vehicle && !capacity) setCapacity('');
  }, [vehicleId]); // 切班次时容量回到"自动占用剩余载重"

  const submit = async () => {
    if (!vehicleId) { toast('请选择出港班次', 'error'); return; }
    setSubmitting(true);
    try {
      const r = await api.createLoadPlan({
        vehicle_id: Number(vehicleId),
        destination: destination || null,
        capacity_kg: capacity ? Number(capacity) : null,
        auto_load: auto,
      });
      onCreated(r);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建出港配载单"
      onClose={onClose}
      width={620}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" disabled={submitting} onClick={submit}>建立配载单</button></>}
    >
      <div className="form-row">
        <label>出港班次 *（仅列出已分拣完成、待发车的班次）</label>
        <select className="input" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">请选择</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.plate_no} · {v.route_code}（计划发车 {fmtDateTime(v.planned_departure)}，额定 {fmtKg(v.capacity_kg)}）
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>目的地（一张单一个流向；留空=混装）</label>
        <input className="input" list="dest-options" placeholder="如 重庆" value={destination} onChange={(e) => setDestination(e.target.value.trim())} />
        <datalist id="dest-options">
          {vehicle?.destinations?.map((d) => <option key={d} value={d} />)}
        </datalist>
        {vehicle?.destinations?.length > 0 && (
          <div className="text-muted" style={{ marginTop: 4 }}>
            <Truck size={11} style={{ verticalAlign: -1 }} /> 本班可承运：{vehicle.destinations.join('、')}
          </div>
        )}
      </div>
      <div className="form-row">
        <label>配载载重上限 kg（留空 = 车辆额定载重 − 其它生效单已占）</label>
        <input className="input" type="number" min="0" placeholder={vehicle ? `额定 ${fmtKg(vehicle.capacity_kg)}` : ''} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </div>
      <div className="form-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动从在场已分拣件中按 FIFO 配载（装不下的留待下一班）
        </label>
      </div>
      {preview && (
        <div className="plan-preview">
          <div className="plan-preview-row">
            <span><Timer size={13} /> 截单：{preview.cutoff_at ? `${fmtDateTime(preview.cutoff_at)}（${fmtAgo(preview.cutoff_at)}）` : '不限'}</span>
            <span><PackageCheck size={13} /> 可配 <b>{preview.fitted_count}</b> 件 / {fmtKg(preview.fitted_kg)}</span>
          </div>
          <div className="plan-preview-row">
            <span style={{ color: preview.overflow_count ? 'var(--red)' : undefined }}>
              <Weight size={13} /> 装不下留待下一班：<b>{preview.overflow_count}</b> 件 / {fmtKg(preview.overflow_kg)}
            </span>
            {preview.remaining_kg != null && <span className="text-muted">剩余载重 {fmtKg(preview.remaining_kg)}</span>}
          </div>
          {preview.fitted_count === 0 && <div className="text-muted">当前没有满足目的地/截单条件的未占用已分拣件，可先建空单再手工补配。</div>}
        </div>
      )}
    </Modal>
  );
}

// ── 配载单详情：实际清单、拆单/撤配/改配/封车/撤单/发车锁定 ──
function PlanDetail({ id, vehicles, onClose, onChanged }) {
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [targets, setTargets] = useState([]);
  const [reassignTarget, setReassignTarget] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [p, ps] = await Promise.all([api.loadPlan(id), api.loadPlans()]);
      setPlan(p);
      setTargets(ps.filter((x) => x.status === 'draft' && x.id !== id));
    } catch (e) { toast(e.message, 'error'); }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  const act = (fn, ok, reload = true) => (async () => {
    try { await fn(); toast(ok, 'success'); setSelected(new Set()); if (reload) { await load(); onChanged(); } }
    catch (e) { toast(e.message, 'error'); throw e; }
  })();

  const ids = useMemo(() => plan?.items.map((i) => i.package_id) || [], [plan]);
  const toggle = (pid) => setSelected((s) => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });
  const allChecked = ids.length > 0 && ids.every((i) => selected.has(i));

  if (!plan) return <Modal title="加载中…" onClose={onClose}><Empty text="加载中…" /></Modal>;

  const editable = plan.status === 'draft';
  const selIds = [...selected];

  return (
    <Modal
      title={`配载单 ${plan.plan_no}`}
      onClose={onClose}
      width={860}
      footer={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {editable && (
            <>
              <select className="input" value={reassignTarget} onChange={(e) => setReassignTarget(e.target.value)} style={{ marginRight: 'auto' }}>
                <option value="">改配到其它配载单…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.plan_no} · {t.plate_no} · {t.destination || '混装'}（剩 {fmtKg(t.capacity_kg - t.loaded_kg)}）</option>)}
              </select>
              <button className="btn btn-sm" disabled={!selIds.length || !reassignTarget}
                onClick={() => act(() => api.planReassign(id, { target_plan_id: Number(reassignTarget), package_ids: selIds }), `已改配 ${selIds.length} 件`)}>
                <Shuffle size={13} /> 改配
              </button>
              <button className="btn btn-danger btn-sm" disabled={!selIds.length}
                onClick={() => act(() => api.planRemoveItems(id, selIds), `已撤配 ${selIds.length} 件`)}>
                <Split size={13} /> 拆单/撤配
              </button>
              <button className="btn btn-danger btn-sm" onClick={async () => {
                if (!confirm('确认整单撤销？清单内全部包裹将回到在场、可配其它班次。')) return;
                try {
                  await act(() => api.planCancel(id), '配载单已撤销', false);
                  onClose(); onChanged();
                } catch { /* 错误已提示 */ }
              }}><XCircle size={13} /> 撤单</button>
              <button className="btn btn-primary btn-sm" onClick={() => act(() => api.planSeal(id), '已封车，发车前如需调整可解封')}>
                <Lock size={13} /> 封车
              </button>
            </>
          )}
          {plan.status === 'sealed' && (
            <>
              <span className="text-muted" style={{ marginRight: 'auto' }}>已封车，清单锁定；调度确认无误后由车辆班次「确认发车」</span>
              <button className="btn btn-sm" onClick={() => act(() => api.planUnseal(id), '已解封，可继续调整')}><Unlock size={13} /> 解封调整</button>
            </>
          )}
          {plan.status === 'departed' && <span className="text-muted" style={{ marginRight: 'auto' }}>已随班发车，实际清单已锁定不可修改（{fmtDateTime(plan.departed_at)}）</span>}
          {plan.status === 'cancelled' && <span className="text-muted" style={{ marginRight: 'auto' }}>该单已撤销{plan.cancel_reason ? `：${plan.cancel_reason}` : ''}</span>}
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      }
    >
      <div className="plan-meta">
        <div><Truck size={14} /> <b>{plan.plate_no}</b> · {plan.route_code}</div>
        <div><MapPin size={14} /> {plan.destination || '混装'}</div>
        <div><Badge conf={PLAN_STATUS[plan.status]} /></div>
        <div><PackageCheck size={14} /> {plan.item_count} 件</div>
        <div><Weight size={14} /> {fmtKg(plan.loaded_kg)} / {fmtKg(plan.capacity_kg)}</div>
        <div><Timer size={14} /> {plan.cutoff_at ? fmtDateTime(plan.cutoff_at) : '截单不限'}</div>
      </div>

      <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table className="tbl">
          <thead style={{ position: 'sticky', top: 0, background: '#fff' }}>
            <tr>
              {editable && (
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(ids))} />
                </th>
              )}
              <th>运单号</th><th>目的地</th><th>重量</th><th>进港来源</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {plan.items.map((it) => (
              <tr key={it.package_id}>
                {editable && (
                  <td><input type="checkbox" checked={selected.has(it.package_id)} onChange={() => toggle(it.package_id)} /></td>
                )}
                <td className="mono">{it.tracking_no}</td>
                <td>{it.destination}</td>
                <td className="mono">{fmtKg(it.weight_kg)}</td>
                <td>
                  {it.source_plate_no
                    ? <>{it.source_plate_no} <span className="text-muted">{it.source_route_code}</span></>
                    : <span className="text-muted">无进港班次</span>}
                </td>
                <td>
                  {it.package_status === 'intercepted'
                    ? <Badge conf={{ label: '拦截件', color: '#b91c1c', bg: '#fee2e2' }} />
                    : <span className="text-muted">已分拣</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {plan.items.length === 0 && <Empty text="配载单为空" />}
      </div>

      {editable && (
        <AddItemsPanel plan={plan} onAdded={load} />
      )}
      {plan.status !== 'draft' && (
        <div className="text-muted" style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          {selIds.length > 0 ? `已选 ${selIds.length} 件` : <><ChevronRight size={13} /> 进港来源列保留每件的来源班次，发车后按本单实际去向更新积压与班次进度</>}
        </div>
      )}
    </Modal>
  );
}

// 手工补配：搜索在场已分拣件加入本单（同一件不能被两张生效单占用，后端强校验）
function AddItemsPanel({ plan, onAdded }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const toast = useToast();

  const search = async () => {
    if (!q.trim()) return;
    try {
      const r = await api.packages({ q: q.trim(), status: 'sorted', pageSize: 10 });
      setResults(r.items);
    } catch (e) { toast(e.message, 'error'); }
  };

  const add = async (pid) => {
    try {
      await api.planAddItems(plan.id, [pid]);
      toast('已补配到本单', 'success');
      setResults((rs) => rs.filter((p) => p.id !== pid));
      onAdded();
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="filter-bar">
        <input className="input" style={{ width: 240 }} placeholder="扫描/输入运单号补配" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button className="btn btn-sm" onClick={search}>搜索在场件</button>
      </div>
      {results.length > 0 && (
        <table className="tbl" style={{ marginTop: 8 }}>
          <tbody>
            {results.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.tracking_no}</td>
                <td>{p.destination}</td>
                <td className="mono">{fmtKg(p.weight_kg)}</td>
                <td>
                  {p.plan_no
                    ? <span className="text-muted">已在 {p.plan_no}（{p.out_plate_no}）</span>
                    : <button className="btn btn-next btn-sm" onClick={() => add(p.id)}><Plus size={12} /> 加入本单</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
