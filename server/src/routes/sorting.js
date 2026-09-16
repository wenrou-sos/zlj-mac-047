// 分拣规则与格口路由：格口维护（停用可改道）、规则草稿维护、试算、发布
import { Router } from 'express';
import { query } from '../db.js';
import { evaluate } from '../sorting.js';

const router = Router();

const RULES_WITH_CHUTE = `
  SELECT r.*, c.code AS chute_code, c.name AS chute_name, c.status AS chute_status
  FROM sort_rules r JOIN chutes c ON c.id = r.chute_id`;

async function getDraft() {
  const [draft] = await query(`SELECT * FROM rule_versions WHERE status = 'draft' LIMIT 1`);
  return draft || null;
}

// 确保草稿存在：没有则基于当前发布版复制一份
async function ensureDraft() {
  const existing = await getDraft();
  if (existing) return { draft: existing, created: false };
  const [published] = await query(`SELECT * FROM rule_versions WHERE status = 'published' LIMIT 1`);
  const [draft] = await query(
    `INSERT INTO rule_versions (version_no, status) VALUES (0, 'draft') RETURNING *`
  );
  if (published) {
    await query(
      `INSERT INTO sort_rules (version_id, priority, destination, min_weight, max_weight, chute_id)
       SELECT $1, priority, destination, min_weight, max_weight, chute_id
       FROM sort_rules WHERE version_id = $2`,
      [draft.id, published.id]
    );
  }
  return { draft, created: true };
}

// 草稿规则发生变更后，此前的试算结果作废，需重新试算才能发布
async function invalidateSimulation(versionId) {
  await query('UPDATE rule_versions SET simulated_at = NULL WHERE id = $1', [versionId]);
}

// ── 格口 ────────────────────────────────────────────────────────

// 格口列表（附发布/草稿规则引用数与在格件数）
router.get('/chutes', async (req, res) => {
  const rows = await query(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM sort_rules r JOIN rule_versions v ON v.id = r.version_id
         WHERE r.chute_id = c.id AND v.status = 'published') AS published_rule_count,
       (SELECT COUNT(*)::int FROM sort_rules r JOIN rule_versions v ON v.id = r.version_id
         WHERE r.chute_id = c.id AND v.status = 'draft')     AS draft_rule_count,
       (SELECT COUNT(*)::int FROM packages p
         WHERE p.chute_id = c.id AND p.status = 'sorted')    AS sorted_count
     FROM chutes c ORDER BY c.code`
  );
  res.json(rows);
});

// 新增格口
router.post('/chutes', async (req, res) => {
  const { code, name } = req.body || {};
  if (!code?.trim() || !name?.trim()) {
    return res.status(400).json({ error: '格口编码和名称不能为空' });
  }
  try {
    const rows = await query(
      `INSERT INTO chutes (code, name) VALUES ($1, $2) RETURNING *`,
      [code.trim().toUpperCase(), name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
      return res.status(409).json({ error: '格口编码已存在' });
    }
    throw e;
  }
});

// 修改格口名称
router.put('/chutes/:id', async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: '名称不能为空' });
  const rows = await query(
    `UPDATE chutes SET name = $1 WHERE id = $2 RETURNING *`,
    [name.trim(), req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: '格口不存在' });
  res.json(rows[0]);
});

// 停用格口：可选 reroute_chute_id 改道。已发布版本不可变，改道只写入草稿
// （没有草稿则自动基于发布版创建），需试算发布后生效；停用期间扫描落空进待判区
router.post('/chutes/:id/disable', async (req, res) => {
  const { reroute_chute_id } = req.body || {};
  const [chute] = await query('SELECT * FROM chutes WHERE id = $1', [req.params.id]);
  if (!chute) return res.status(404).json({ error: '格口不存在' });
  if (chute.status === 'disabled') return res.status(409).json({ error: '格口已处于停用状态' });

  let rerouted = 0;
  let draftCreated = false;
  if (reroute_chute_id) {
    if (Number(reroute_chute_id) === chute.id) {
      return res.status(400).json({ error: '改道目标不能是即将停用的格口本身' });
    }
    const [target] = await query(
      `SELECT * FROM chutes WHERE id = $1 AND status = 'active'`,
      [reroute_chute_id]
    );
    if (!target) return res.status(400).json({ error: '改道目标格口不存在或已停用' });

    // 只改草稿：无草稿且发布版有规则指向本格口时，先基于发布版建草稿
    let draft = await getDraft();
    if (!draft) {
      const [{ c }] = await query(
        `SELECT COUNT(*)::int AS c FROM sort_rules r
         JOIN rule_versions v ON v.id = r.version_id
         WHERE r.chute_id = $1 AND v.status = 'published'`,
        [chute.id]
      );
      if (c > 0) {
        ({ draft } = await ensureDraft());
        draftCreated = true;
      }
    }
    if (draft) {
      const moved = await query(
        `UPDATE sort_rules SET chute_id = $1 WHERE chute_id = $2 AND version_id = $3 RETURNING id`,
        [target.id, chute.id, draft.id]
      );
      rerouted = moved.length;
    }
  }

  await query(`UPDATE chutes SET status = 'disabled', disabled_at = NOW() WHERE id = $1`, [chute.id]);
  // 格口状态已变化，草稿此前的试算结果不再有效，需重新试算才能发布
  const draft = await getDraft();
  if (draft) await invalidateSimulation(draft.id);
  res.json({ ok: true, rerouted_rules: rerouted, draft_created: draftCreated });
});

// 启用格口（同样会使草稿试算过时，需重新试算）
router.post('/chutes/:id/enable', async (req, res) => {
  const rows = await query(
    `UPDATE chutes SET status = 'active', disabled_at = NULL
     WHERE id = $1 AND status = 'disabled' RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: '格口不存在或未处于停用状态' });
  const draft = await getDraft();
  if (draft) await invalidateSimulation(draft.id);
  res.json(rows[0]);
});

// ── 分拣规则 ────────────────────────────────────────────────────

// 当前规则状态：发布版 + 草稿（各带规则明细）
router.get('/sort-rules', async (req, res) => {
  const versions = await query(
    `SELECT * FROM rule_versions WHERE status IN ('published','draft') ORDER BY version_no DESC`
  );
  const result = { published: null, draft: null };
  for (const v of versions) {
    const rules = await query(`${RULES_WITH_CHUTE} WHERE r.version_id = $1 ORDER BY r.priority, r.id`, [v.id]);
    result[v.status] = { ...v, rules };
  }
  res.json(result);
});

// 新建草稿（基于当前发布版复制；已有草稿则直接返回）
router.post('/sort-rules/draft', async (req, res) => {
  const { draft, created } = await ensureDraft();
  res.status(created ? 201 : 200).json(draft);
});

// 放弃草稿
router.delete('/sort-rules/draft', async (req, res) => {
  const draft = await getDraft();
  if (!draft) return res.status(409).json({ error: '当前没有草稿' });
  await query('DELETE FROM rule_versions WHERE id = $1', [draft.id]); // 规则随 ON DELETE CASCADE 删除
  res.json({ ok: true });
});

// 校验规则表单
function validateRuleBody(body) {
  const { priority, destination, min_weight, max_weight, chute_id } = body || {};
  if (!chute_id) return { error: '请选择目标格口' };
  const minW = min_weight === '' || min_weight == null ? null : Number(min_weight);
  const maxW = max_weight === '' || max_weight == null ? null : Number(max_weight);
  if (minW != null && (Number.isNaN(minW) || minW < 0)) return { error: '重量下限不合法' };
  if (maxW != null && (Number.isNaN(maxW) || maxW <= 0)) return { error: '重量上限不合法' };
  if (minW != null && maxW != null && minW >= maxW) return { error: '重量下限必须小于上限' };
  const prio = priority === '' || priority == null ? 100 : Number(priority);
  if (!Number.isInteger(prio) || prio < 0) return { error: '优先级必须是不小于 0 的整数' };
  return {
    value: {
      priority: prio,
      destination: destination?.trim() || null,
      min_weight: minW,
      max_weight: maxW,
      chute_id: Number(chute_id),
    },
  };
}

// 草稿中新增规则
router.post('/sort-rules/draft/rules', async (req, res) => {
  const draft = await getDraft();
  if (!draft) return res.status(409).json({ error: '当前没有草稿，请先新建草稿' });
  const { error, value } = validateRuleBody(req.body);
  if (error) return res.status(400).json({ error });
  const [chute] = await query('SELECT id FROM chutes WHERE id = $1', [value.chute_id]);
  if (!chute) return res.status(404).json({ error: '目标格口不存在' });
  const rows = await query(
    `INSERT INTO sort_rules (version_id, priority, destination, min_weight, max_weight, chute_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [draft.id, value.priority, value.destination, value.min_weight, value.max_weight, value.chute_id]
  );
  await invalidateSimulation(draft.id);
  res.status(201).json(rows[0]);
});

// 修改草稿规则
router.put('/sort-rules/draft/rules/:id', async (req, res) => {
  const draft = await getDraft();
  if (!draft) return res.status(409).json({ error: '当前没有草稿，请先新建草稿' });
  const { error, value } = validateRuleBody(req.body);
  if (error) return res.status(400).json({ error });
  const rows = await query(
    `UPDATE sort_rules
     SET priority = $1, destination = $2, min_weight = $3, max_weight = $4, chute_id = $5
     WHERE id = $6 AND version_id = $7 RETURNING *`,
    [value.priority, value.destination, value.min_weight, value.max_weight, value.chute_id, req.params.id, draft.id]
  );
  if (!rows.length) return res.status(404).json({ error: '规则不存在或不属于当前草稿' });
  await invalidateSimulation(draft.id);
  res.json(rows[0]);
});

// 删除草稿规则
router.delete('/sort-rules/draft/rules/:id', async (req, res) => {
  const draft = await getDraft();
  if (!draft) return res.status(409).json({ error: '当前没有草稿，请先新建草稿' });
  const rows = await query(
    'DELETE FROM sort_rules WHERE id = $1 AND version_id = $2 RETURNING id',
    [req.params.id, draft.id]
  );
  if (!rows.length) return res.status(404).json({ error: '规则不存在或不属于当前草稿' });
  await invalidateSimulation(draft.id);
  res.json({ ok: true });
});

// 试算：用草稿规则对当前全部待分拣包裹模拟分拣，输出影响面（记录试算时间，发布前置要求）
router.post('/sort-rules/draft/simulate', async (req, res) => {
  const draft = await getDraft();
  if (!draft) return res.status(409).json({ error: '当前没有草稿，请先新建草稿' });
  const rules = await query(`${RULES_WITH_CHUTE} WHERE r.version_id = $1 ORDER BY r.priority, r.id`, [draft.id]);
  const pending = await query(`SELECT id, tracking_no, destination, weight_kg FROM packages WHERE status = 'pending'`);

  const stats = { total: pending.length, routed: 0, conflict: 0, unmatched: 0 };
  const perRule = new Map();   // rule_id -> { rule, count }
  const perChute = new Map();  // chute_code -> { code, name, count }
  const conflicts = [];
  const unmatched = [];

  for (const pkg of pending) {
    const d = evaluate(pkg, draft, rules);
    if (d.outcome === 'routed') {
      stats.routed++;
      const r = perRule.get(d.rule.id) || { rule: d.rule, count: 0 };
      r.count++;
      perRule.set(d.rule.id, r);
      const c = perChute.get(d.chute.code) || { code: d.chute.code, name: d.chute.name, count: 0 };
      c.count++;
      perChute.set(d.chute.code, c);
    } else if (d.outcome === 'conflict') {
      stats.conflict++;
      if (conflicts.length < 10) conflicts.push({ tracking_no: pkg.tracking_no, destination: pkg.destination, reason: d.reason });
    } else {
      stats.unmatched++;
      if (unmatched.length < 10) unmatched.push({ tracking_no: pkg.tracking_no, destination: pkg.destination, reason: d.reason });
    }
  }

  await query('UPDATE rule_versions SET simulated_at = NOW() WHERE id = $1', [draft.id]);
  // 草稿中指向已停用格口的规则：试算按落空处理，单独列出提醒
  const disabledRules = rules
    .filter((r) => r.chute_status !== 'active')
    .map((r) => ({
      rule_id: r.id,
      priority: r.priority,
      destination: r.destination,
      chute_code: r.chute_code,
    }));
  res.json({
    stats,
    disabled_rules: disabledRules,
    per_rule: [...perRule.values()]
      .map(({ rule, count }) => ({
        rule_id: rule.id,
        priority: rule.priority,
        destination: rule.destination,
        min_weight: rule.min_weight,
        max_weight: rule.max_weight,
        chute_code: rule.chute_code,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    per_chute: [...perChute.values()].sort((a, b) => b.count - a.count),
    conflicts,
    unmatched,
  });
});

// 发布草稿：当前发布版归档，草稿成为新发布版（单 SQL 原子切换）。必须先试算
router.post('/sort-rules/draft/publish', async (req, res) => {
  const draft = await getDraft();
  if (!draft) return res.status(409).json({ error: '当前没有草稿，请先新建草稿' });
  const [{ c }] = await query('SELECT COUNT(*)::int AS c FROM sort_rules WHERE version_id = $1', [draft.id]);
  if (c === 0) return res.status(400).json({ error: '草稿没有任何规则，不能发布' });
  if (!draft.simulated_at) {
    return res.status(409).json({ error: '草稿尚未试算或试算后又有修改，请先试算影响再发布' });
  }
  const [{ maxv }] = await query(
    `SELECT COALESCE(MAX(version_no), 0)::int AS maxv FROM rule_versions WHERE status IN ('published','archived')`
  );
  const rows = await query(
    `WITH archived AS (UPDATE rule_versions SET status = 'archived' WHERE status = 'published')
     UPDATE rule_versions SET status = 'published', version_no = $1, published_at = NOW()
     WHERE id = $2 RETURNING *`,
    [maxv + 1, draft.id]
  );
  res.json(rows[0]);
});

export default router;
