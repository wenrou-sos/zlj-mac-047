// 包裹路由：查询、扫描分拣决策、分拣、装车、异常拦截/解除（错分件复核回流）
import { Router } from 'express';
import { query } from '../db.js';
import { getPublishedRules, evaluate } from '../sorting.js';
import { ABNORMAL_TYPE_LABEL } from '../helpers.js';

const router = Router();

// 包裹列表（分页，支持状态/目的地/异常/待判/车辆/单号筛选）
router.get('/', async (req, res) => {
  const { status, destination, abnormal, review, vehicle_id, q, page = 1, pageSize = 50 } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  if (status) add('p.status = ?', status);
  if (destination) add('p.destination = ?', destination);
  if (vehicle_id) add('p.vehicle_id = ?', vehicle_id);
  if (abnormal === 'true') conds.push('p.is_abnormal = TRUE');
  if (review === 'true') conds.push('p.needs_review = TRUE');
  if (q) add('p.tracking_no ILIKE ?', `%${q}%`);

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);

  const [{ count }] = await query(
    `SELECT COUNT(*)::int AS count FROM packages p ${where}`,
    params
  );
  params.push(size, (pageNum - 1) * size);
  const items = await query(
    `SELECT p.*, v.plate_no, v.route_code,
            c.code AS chute_code, c.name AS chute_name, rv.version_no AS rule_version_no
     FROM packages p
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     LEFT JOIN chutes c ON c.id = p.chute_id
     LEFT JOIN rule_versions rv ON rv.id = p.rule_version_id
     ${where}
     ORDER BY p.needs_review DESC, p.created_at DESC, p.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
});

// 新增包裹（模拟到件扫描）
router.post('/', async (req, res) => {
  const { tracking_no, vehicle_id, destination, weight_kg } = req.body || {};
  if (!tracking_no || !destination) {
    return res.status(400).json({ error: '运单号和目的地不能为空' });
  }
  try {
    const rows = await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tracking_no, vehicle_id || null, destination, weight_kg || 1]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
      return res.status(409).json({ error: '运单号已存在' });
    }
    throw e;
  }
});

// 扫描分拣：评估并返回目标格口与命中原因；冲突/无匹配的包裹当场转入待判区
router.post('/scan', async (req, res) => {
  const { tracking_no } = req.body || {};
  if (!tracking_no?.trim()) return res.status(400).json({ error: '请扫描或输入运单号' });
  const [pkg] = await query(
    `SELECT p.*, c.code AS chute_code, c.name AS chute_name
     FROM packages p LEFT JOIN chutes c ON c.id = p.chute_id
     WHERE p.tracking_no = $1`,
    [tracking_no.trim()]
  );
  if (!pkg) return res.status(404).json({ error: `运单 ${tracking_no} 不存在` });

  // 拦截件禁止分拣，不能绕过异常拦截
  if (pkg.status === 'intercepted') {
    return res.json({
      package: pkg,
      decision: {
        outcome: 'blocked',
        reason: `该件已被拦截（${ABNORMAL_TYPE_LABEL[pkg.abnormal_type] || '异常'}），禁止分拣，请先处理异常并解除拦截`,
      },
    });
  }
  if (pkg.status !== 'pending') {
    return res.json({
      package: pkg,
      decision: {
        outcome: 'already_done',
        reason: `该件已${pkg.status === 'sorted' ? '分拣' : '装车'}${pkg.chute_code ? `，格口 ${pkg.chute_code}` : ''}`,
      },
    });
  }

  const { version, rules } = await getPublishedRules();
  const decision = evaluate(pkg, version, rules);
  // 规则冲突或无匹配：扫描当场转入待判区，等待人工判定
  if (decision.outcome === 'conflict' || decision.outcome === 'unmatched') {
    const rows = await query(
      `UPDATE packages SET needs_review = TRUE, hit_reason = $2, rule_version_id = $3
       WHERE id = $1 RETURNING *`,
      [pkg.id, decision.reason, version?.id ?? null]
    );
    return res.json({
      package: { ...rows[0], chute_code: pkg.chute_code, chute_name: pkg.chute_name },
      decision,
    });
  }
  res.json({ package: pkg, decision });
});

// 分拣完成：默认按已发布规则自动路由；传 chute_id 为人工指定（待判区改判/现场改道）
router.post('/:id/sort', async (req, res) => {
  const { chute_id } = req.body || {};
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'intercepted') {
    return res.status(409).json({ error: '该件已被拦截，请先处理异常并解除拦截' });
  }
  if (pkg.status !== 'pending') {
    return res.status(409).json({ error: '仅待分拣包裹可执行分拣操作' });
  }

  // sorted_at 只在首次分拣写入：回流重分不重复增加完成量；resorted_at 记录重分时间
  const SORT_SQL = `
    UPDATE packages SET status = 'sorted',
      sorted_at   = COALESCE(sorted_at, NOW()),
      resorted_at = CASE WHEN sorted_at IS NOT NULL THEN NOW() ELSE resorted_at END,
      chute_id = $2, rule_id = $3, rule_version_id = $4, hit_reason = $5, needs_review = FALSE
    WHERE id = $1 RETURNING *`;

  // 人工指定格口
  if (chute_id) {
    const [chute] = await query('SELECT * FROM chutes WHERE id = $1', [chute_id]);
    if (!chute) return res.status(404).json({ error: '格口不存在' });
    if (chute.status !== 'active') {
      return res.status(409).json({ error: `格口 ${chute.code} 已停用，请改道其他格口` });
    }
    const { version } = await getPublishedRules();
    const reason = `人工指定格口 ${chute.code}`;
    const rows = await query(SORT_SQL, [pkg.id, chute.id, null, version?.id ?? null, reason]);
    return res.json({
      outcome: 'sorted',
      package: rows[0],
      decision: { outcome: 'manual', chute: { id: chute.id, code: chute.code, name: chute.name }, reason },
    });
  }

  // 按规则自动路由
  const { version, rules } = await getPublishedRules();
  const decision = evaluate(pkg, version, rules);
  if (decision.outcome !== 'routed') {
    // 规则冲突或无匹配 → 待判区，等待人工判定
    const rows = await query(
      `UPDATE packages SET needs_review = TRUE, hit_reason = $2, rule_version_id = $3
       WHERE id = $1 RETURNING *`,
      [pkg.id, decision.reason, version?.id ?? null]
    );
    return res.json({ outcome: 'pending_review', package: rows[0], decision });
  }

  const rows = await query(SORT_SQL, [pkg.id, decision.chute.id, decision.rule.id, version.id, decision.reason]);
  res.json({ outcome: 'sorted', package: rows[0], decision });
});

// 装车（拦截件禁止装车；未分配格口的件禁止装车）
router.post('/:id/load', async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'intercepted') {
    return res.status(409).json({ error: '该件已被拦截，禁止装车' });
  }
  if (pkg.status !== 'sorted') {
    return res.status(409).json({ error: '仅已分拣包裹可装车' });
  }
  if (!pkg.chute_id) {
    return res.status(409).json({ error: '该件尚未分配目标格口，请先完成分拣路由再装车' });
  }
  const rows = await query(`UPDATE packages SET status = 'loaded' WHERE id = $1 RETURNING *`, [pkg.id]);
  res.json(rows[0]);
});

// 异常拦截
router.post('/:id/intercept', async (req, res) => {
  const { abnormal_type, note } = req.body || {};
  if (!abnormal_type) return res.status(400).json({ error: '请选择异常类型' });
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'loaded') {
    return res.status(409).json({ error: '包裹已装车，无法拦截' });
  }
  if (pkg.status === 'intercepted') {
    return res.status(409).json({ error: '包裹已处于拦截状态' });
  }
  const rows = await query(
    `UPDATE packages
     SET status = 'intercepted', is_abnormal = TRUE, abnormal_type = $1,
         abnormal_note = $2, intercepted_at = NOW()
     WHERE id = $3 RETURNING *`,
    [abnormal_type, note || null, pkg.id]
  );
  res.json(rows[0]);
});

// 解除拦截（复核）：错分件回流待分拣重新分拣（不重复计完成量）；其他异常回到原状态
router.post('/:id/release', async (req, res) => {
  const { review_note } = req.body || {};
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status !== 'intercepted') {
    return res.status(409).json({ error: '包裹未处于拦截状态' });
  }
  const isWrongRoute = pkg.abnormal_type === 'wrong_route';
  // 错分件：回流重分，清空错误的分拣决策（sorted_at 保留首分时间，完成量不重复计）
  // 其他异常：已分拣过回已分拣，否则回待分拣
  const backTo = isWrongRoute ? 'pending' : pkg.sorted_at ? 'sorted' : 'pending';
  const rows = await query(
    `UPDATE packages
     SET status = $1, is_abnormal = FALSE, intercept_released_at = NOW(), review_note = $3,
         chute_id = CASE WHEN $4 THEN NULL ELSE chute_id END,
         rule_id  = CASE WHEN $4 THEN NULL ELSE rule_id END,
         hit_reason = CASE WHEN $4 THEN NULL ELSE hit_reason END,
         needs_review = FALSE
     WHERE id = $2 RETURNING *`,
    [backTo, pkg.id, review_note || null, isWrongRoute]
  );
  res.json(rows[0]);
});

export default router;
