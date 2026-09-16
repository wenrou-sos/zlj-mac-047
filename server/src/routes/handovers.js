// 班次交接单路由
// 草稿生成 → 交班补充 → 提交签收 → 逐项接收/退回（交接期间作业可继续）→ 签收冻结
// 已签收单据除查询外全部拒绝写入，刷新不会改写历史交接结果
import { Router } from 'express';
import { query } from '../db.js';
import {
  buildLiveItems, getLatestOwnerMap, getSourceItemIds, getBusyItemKeys,
  syncResolved, evaluateItem, buildFollowups, nextHandoverNo,
} from '../handover.js';

const router = Router();

const OPEN_STATUSES = ['draft', 'pending'];

function dateYMD(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

async function getDoc(id) {
  const rows = await query(
    `SELECT h.*, s.work_date AS shift_work_date, s.name AS shift_name, s.shift_code,
            t.name AS to_shift_name, t.work_date AS to_shift_work_date
     FROM shift_handovers h
     JOIN shifts s ON s.id = h.shift_id
     JOIN shifts t ON t.id = h.to_shift_id
     WHERE h.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// 交接单列表（可按班次过滤）
router.get('/', async (req, res) => {
  const { shift_id, status } = req.query;
  const conds = [];
  const params = [];
  if (shift_id) {
    params.push(shift_id);
    conds.push(`(h.shift_id = $1 OR h.to_shift_id = $1)`);
  }
  if (status) {
    params.push(status);
    conds.push(`h.status = $${params.length}`);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const sql = `SELECT h.*,
           s.name AS shift_name, s.work_date AS shift_work_date,
           t.name AS to_shift_name, t.work_date AS to_shift_work_date,
           COUNT(i.id)::int AS item_total,
           COUNT(i.id) FILTER (WHERE i.status = 'pending')::int    AS item_pending,
           COUNT(i.id) FILTER (WHERE i.status = 'accepted')::int   AS item_accepted,
           COUNT(i.id) FILTER (WHERE i.status = 'returned')::int   AS item_returned,
           COUNT(i.id) FILTER (WHERE i.status = 'resolved')::int   AS item_resolved
         FROM shift_handovers h
         JOIN shifts s ON s.id = h.shift_id
         JOIN shifts t ON t.id = h.to_shift_id
         LEFT JOIN shift_handover_items i ON i.handover_id = h.id
         ${where}
         GROUP BY h.id, s.name, s.work_date, t.name, t.work_date
         ORDER BY h.created_at DESC`;
  const rows = await query(sql, params);
  res.json(rows.map((r) => ({
    ...r,
    shift_work_date: dateYMD(r.shift_work_date),
    to_shift_work_date: dateYMD(r.to_shift_work_date),
  })));
});

// 待处理交接单数量（导航角标）：我作为接班人且尚未签收
router.get('/pending-count', async (req, res) => {
  const rows = await query(
    `SELECT COUNT(*)::int AS count FROM shift_handovers WHERE status = 'pending'`
  );
  res.json(rows[0]);
});

// 生成交接单（草稿）：自动汇集现场快照
// body: { shift_id, to_shift_id, summary_note?, created_by? }
router.post('/', async (req, res) => {
  const { shift_id, to_shift_id, summary_note = '', created_by = '交班人' } = req.body || {};
  if (!shift_id || !to_shift_id) {
    return res.status(400).json({ error: '请选择交出班次和接班班次' });
  }
  if (Number(shift_id) === Number(to_shift_id)) {
    return res.status(400).json({ error: '交出班次和接班班次不能是同一个班次' });
  }
  const shifts = await query(`SELECT * FROM shifts WHERE id IN ($1,$2)`, [shift_id, to_shift_id]);
  if (shifts.length !== 2) return res.status(404).json({ error: '班次不存在' });

  // 同一班次已存在未完成交接单时，不允许重复建单（避免同一批事项被两份单同时移交）
  const dup = await query(
    `SELECT id FROM shift_handovers
     WHERE shift_id = $1 AND status IN ('draft','pending')
     ORDER BY id DESC LIMIT 1`,
    [shift_id]
  );
  if (dup.length) {
    return res.status(409).json({ error: '该班次已有未完成的交接单，请继续签收或取消后再建单', handover_id: dup[0].id });
  }

  const [fromShift] = shifts.filter((s) => s.id === Number(shift_id));
  const liveItems = await buildLiveItems();
  const ownerMap = await getLatestOwnerMap();
  const busySet = await getBusyItemKeys(); // 已在其他未签收单中，不能重复汇集
  const sourceMap = await getSourceItemIds(liveItems.map((i) => i.item_key));

  const handoverNo = await nextHandoverNo(fromShift.work_date);
  const doc = await query(
    `INSERT INTO shift_handovers (handover_no, shift_id, to_shift_id, status, summary_note, created_by)
     VALUES ($1,$2,$3,'draft',$4,$5) RETURNING *`,
    [handoverNo, shift_id, to_shift_id, summary_note || null, created_by]
  );
  const handoverId = doc[0].id;

  let appended = 0;
  const skipped = [];
  for (const it of liveItems) {
    // 责任归属：最近一次签收若明确归接班班次所有，则不计入本交出班次的交接单
    const owner = ownerMap[it.item_key];
    if (owner != null && owner !== Number(shift_id)) continue;
    // 该事项已在另一张未签收交接单中 → 不重复汇集，记录归属以便提示
    if (busySet.has(it.item_key)) {
      skipped.push(it.item_key);
      continue;
    }
    await query(
      `INSERT INTO shift_handover_items
         (handover_id, item_type, item_key, ref_id, title, subtitle, detail, snapshot, source_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        handoverId, it.item_type, it.item_key, it.ref_id,
        it.title, it.subtitle, it.detail,
        JSON.stringify(it.snapshot), sourceMap[it.item_key] || null,
      ]
    );
    appended += 1;
  }

  res.status(201).json({ ...doc[0], collected: appended, skipped_count: skipped.length, skipped_keys: skipped });
});

// 交接单详情（含事项实时变化提示 / 签收后去向）
router.get('/:id', async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: '交接单不存在' });

  let items = await query(
    `SELECT * FROM shift_handover_items WHERE handover_id = $1 ORDER BY
       CASE item_type WHEN 'vehicle' THEN 1 WHEN 'package' THEN 2 WHEN 'intercept' THEN 3 WHEN 'alert' THEN 4 ELSE 5 END,
       id`,
    [doc.id]
  );

  const now = new Date();
  let followups = null;

  if (OPEN_STATUSES.includes(doc.status)) {
    // 未签收：同步已完成事项（自动确认，幂等），并给出实时变化提示
    await syncResolved(doc.id, now);
    items = await query(
      `SELECT * FROM shift_handover_items WHERE handover_id = $1 ORDER BY
         CASE item_type WHEN 'vehicle' THEN 1 WHEN 'package' THEN 2 WHEN 'intercept' THEN 3 WHEN 'alert' THEN 4 ELSE 5 END,
         id`,
      [doc.id]
    );
    for (const it of items) {
      if (it.status !== 'pending' || it.item_type === 'note') continue;
      const { state, changeLabel } = await evaluateItem(it, now);
      if (state === 'changed') it.live_change = changeLabel;
    }
  } else if (doc.status === 'signed') {
    // 已签收：快照冻结，仅附加"后续处理去向"与再次转交链
    followups = await buildFollowups(items, now);
  }

  // 现场可追加的新事项（交接期间新出现、责任属于交出班次、且未在其他未签收单中）
  let appendable = [];
  if (OPEN_STATUSES.includes(doc.status)) {
    const liveItems = await buildLiveItems(now);
    const ownerMap = await getLatestOwnerMap();
    const busySet = await getBusyItemKeys(doc.id); // 排除本单自身，其余未签收单中的事项不可再追加
    const existing = new Set(items.map((i) => i.item_key));
    const sourceMap = await getSourceItemIds(liveItems.map((i) => i.item_key));
    appendable = liveItems
      .filter((it) => !existing.has(it.item_key))
      .filter((it) => !busySet.has(it.item_key))
      .filter((it) => ownerMap[it.item_key] == null || ownerMap[it.item_key] === doc.shift_id)
      .map((it) => ({ ...it, source_item_id: sourceMap[it.item_key] || null }));
  }

  res.json({
    doc: { ...doc, shift_work_date: dateYMD(doc.shift_work_date), to_shift_work_date: dateYMD(doc.to_shift_work_date) },
    items,
    followups,
    appendable,
  });
});

// 修改总体说明（仅草稿）
router.put('/:id/summary', async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: '交接单不存在' });
  if (doc.status !== 'draft') return res.status(409).json({ error: '交接单已提交或已签收，总体说明不能修改' });
  await query(`UPDATE shift_handovers SET summary_note = $1 WHERE id = $2`, [req.body?.summary_note || '', doc.id]);
  res.json({ ok: true });
});

// 交班人逐条补充说明（草稿/待签收阶段均可，已做决定的事项不再改备注）
router.put('/items/:itemId/note', async (req, res) => {
  const [item] = await query(`SELECT * FROM shift_handover_items WHERE id = $1`, [req.params.itemId]);
  if (!item) return res.status(404).json({ error: '事项不存在' });
  const doc = await getDoc(item.handover_id);
  if (!OPEN_STATUSES.includes(doc.status)) return res.status(409).json({ error: '交接单已签收，事项备注不可修改' });
  if (item.status !== 'pending') return res.status(409).json({ error: '该事项已做接收决定，备注不可修改' });
  await query(`UPDATE shift_handover_items SET item_note = $1 WHERE id = $2`, [req.body?.note || '', item.id]);
  res.json({ ok: true });
});

// 追加事项：现场新出现的作业（按 item_key）或口头补充（item_type=note）
router.post('/:id/items', async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: '交接单不存在' });
  if (!OPEN_STATUSES.includes(doc.status)) return res.status(409).json({ error: '交接单已签收，不能追加事项' });

  const { item_type, item_key, title, subtitle, detail, snapshot, source_item_id } = req.body || {};
  if (!item_type || !item_key || !title) {
    return res.status(400).json({ error: '事项类型、标识和标题不能为空' });
  }
  const exists = await query(
    `SELECT 1 FROM shift_handover_items WHERE handover_id = $1 AND item_key = $2`,
    [doc.id, item_key]
  );
  if (exists.length) return res.status(409).json({ error: '该事项已在交接单中' });

  // 现场事项（非口头补充）若已在另一张未签收单中，不允许重复加入
  if (item_type !== 'note') {
    const busy = await query(
      `SELECT 1 FROM shift_handover_items i
       JOIN shift_handovers h ON h.id = i.handover_id
       WHERE i.item_key = $1 AND h.status IN ('draft','pending') AND h.id <> $2
       LIMIT 1`,
      [item_key, doc.id]
    );
    if (busy.length) return res.status(409).json({ error: '该事项已在另一张未签收交接单中，不能重复移交' });
  }

  const rows = await query(
    `INSERT INTO shift_handover_items
       (handover_id, item_type, item_key, ref_id, title, subtitle, detail, snapshot, source_item_id, is_appended)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,TRUE) RETURNING *`,
    [
      doc.id, item_type, item_key, req.body.ref_id || null, title,
      subtitle || null, detail || null,
      JSON.stringify(snapshot ?? {}), source_item_id || null,
    ]
  );
  res.status(201).json(rows[0]);
});

// 接班人逐项决定：accepted 接收 / returned 退回（带原因）/ pending 撤回决定
router.put('/items/:itemId/decision', async (req, res) => {
  const { status, decision_note = '', decided_by = '接班人' } = req.body || {};
  if (!['accepted', 'returned', 'pending'].includes(status)) {
    return res.status(400).json({ error: '决定只能是 accepted / returned / pending' });
  }
  const [item] = await query(`SELECT * FROM shift_handover_items WHERE id = $1`, [req.params.itemId]);
  if (!item) return res.status(404).json({ error: '事项不存在' });
  const doc = await getDoc(item.handover_id);
  if (doc.status === 'signed') return res.status(409).json({ error: '交接单已签收，接收结果不可更改' });
  if (doc.status !== 'pending') return res.status(409).json({ error: '交接单尚未提交签收，或已取消' });
  if (item.status === 'resolved') return res.status(409).json({ error: '该事项已在交接期间完成，无需接收' });

  // 提交签收后现场作业仍在继续：决定的瞬间必须实时核对现场，
  // 不能只看库里事项的旧状态（GET 自动确认可能尚未跑）。
  if (status !== 'pending' && item.item_type !== 'note') {
    const { state, changeLabel } = await evaluateItem(item, new Date());
    if (state === 'resolved') {
      // 作业已完成（如已装车、已发车、拦截已解除）→ 自动确认，拒绝按旧状态接收
      await query(
        `UPDATE shift_handover_items
         SET status = 'resolved', resolved_at = NOW(), resolved_note = $1
         WHERE id = $2 AND status = 'pending'`,
        [changeLabel, item.id]
      );
      return res.status(409).json({
        error: `该事项已在交接期间完成（${changeLabel}），系统已自动确认，无需${status === 'accepted' ? '接收' : '退回'}`,
        code: 'ITEM_AUTO_RESOLVED',
      });
    }
  }

  if (status === 'pending') {
    await query(
      `UPDATE shift_handover_items SET status = 'pending', decision_note = NULL, decided_by = NULL, decided_at = NULL
       WHERE id = $1`,
      [item.id]
    );
  } else if (status === 'returned') {
    if (!decision_note.trim()) return res.status(400).json({ error: '退回必须填写退回原因' });
    await query(
      `UPDATE shift_handover_items SET status = 'returned', decision_note = $1, decided_by = $2, decided_at = NOW()
       WHERE id = $3`,
      [decision_note, decided_by, item.id]
    );
  } else {
    await query(
      `UPDATE shift_handover_items SET status = 'accepted', decision_note = $1, decided_by = $2, decided_at = NOW()
       WHERE id = $3`,
      [decision_note || null, decided_by, item.id]
    );
  }
  res.json({ ok: true });
});

// 交班人提交，开始接班签收
router.post('/:id/submit', async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: '交接单不存在' });
  if (doc.status !== 'draft') return res.status(409).json({ error: '只有草稿状态的交接单可以提交' });
  await syncResolved(doc.id);
  const rows = await query(
    `UPDATE shift_handovers SET status = 'pending', submitted_at = NOW() WHERE id = $1 RETURNING *`,
    [doc.id]
  );
  res.json(rows[0]);
});

// 签收：所有事项必须已有结论（接收/退回/完成），退回项仍归原班负责
router.post('/:id/sign', async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: '交接单不存在' });
  if (doc.status !== 'pending') return res.status(409).json({ error: '交接单当前状态不允许签收' });
  await syncResolved(doc.id);
  const [counts] = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
       COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
       COUNT(*) FILTER (WHERE status = 'returned')::int AS returned,
       COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved
     FROM shift_handover_items WHERE handover_id = $1`,
    [doc.id]
  );
  if (counts.pending > 0) {
    return res.status(409).json({ error: `还有 ${counts.pending} 项未处理，请逐项接收或退回后再签收` });
  }
  const { signed_by = '接班人' } = req.body || {};
  // 只更新一次；之后任何修改接口均被状态校验拒绝 → 历史不可改写
  const rows = await query(
    `UPDATE shift_handovers SET status = 'signed', signed_by = $1, signed_at = NOW()
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [signed_by, doc.id]
  );
  if (!rows.length) return res.status(409).json({ error: '交接单状态已变化，请刷新查看' });
  res.json({ ...rows[0], counts });
});

// 取消未完成交接单（作废，不影响已签收历史）
router.post('/:id/cancel', async (req, res) => {
  const doc = await getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: '交接单不存在' });
  if (!OPEN_STATUSES.includes(doc.status)) return res.status(409).json({ error: '已签收交接单不能取消' });
  const { reason = '', cancelled_by = '交班人' } = req.body || {};
  const rows = await query(
    `UPDATE shift_handovers SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW(), cancel_reason = $2
     WHERE id = $3 RETURNING *`,
    [cancelled_by, reason || null, doc.id]
  );
  res.json(rows[0]);
});

export default router;
