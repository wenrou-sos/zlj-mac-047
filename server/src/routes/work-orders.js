// 异常处置工单路由：认领、转交、补充证据、提交结论、复核
import { Router } from 'express';
import { query } from '../db.js';
import { OPEN_WO_STATUSES, CONCLUSION_LABEL } from '../helpers.js';

const router = Router();

// 工单列表（联查包裹/车辆信息，未结工单排在前面）
router.get('/', async (req, res) => {
  const { status, assignee, package_id, q, page = 1, pageSize = 50 } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  if (status === 'open_all') {
    conds.push(`w.status IN (${OPEN_WO_STATUSES.map((s) => `'${s}'`).join(',')})`);
  } else if (status) {
    add('w.status = ?', status);
  }
  if (assignee) add('w.assignee = ?', assignee);
  if (package_id) add('w.package_id = ?', package_id);
  if (q) add('p.tracking_no ILIKE ?', `%${q}%`);

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);

  const [{ count }] = await query(
    `SELECT COUNT(*)::int AS count FROM work_orders w JOIN packages p ON p.id = w.package_id ${where}`,
    params
  );
  params.push(size, (pageNum - 1) * size);
  const items = await query(
    `SELECT w.*, p.tracking_no, p.destination, p.status AS package_status,
            v.plate_no, v.route_code
     FROM work_orders w
     JOIN packages p ON p.id = w.package_id
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     ${where}
     ORDER BY (w.status = 'closed') ASC, w.created_at DESC, w.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
});

// 工单详情：含流转记录 + 同包裹的其他工单（多次异常分别留档）
router.get('/:id', async (req, res) => {
  const [wo] = await query(
    `SELECT w.*, p.tracking_no, p.destination, p.status AS package_status, p.weight_kg,
            v.plate_no, v.route_code
     FROM work_orders w
     JOIN packages p ON p.id = w.package_id
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     WHERE w.id = $1`,
    [req.params.id]
  );
  if (!wo) return res.status(404).json({ error: '工单不存在' });

  const events = await query(
    'SELECT * FROM work_order_events WHERE work_order_id = $1 ORDER BY created_at, id',
    [wo.id]
  );
  const siblings = await query(
    `SELECT id, abnormal_type, status, conclusion, created_by, assignee, created_at, closed_at
     FROM work_orders WHERE package_id = $1 AND id <> $2 ORDER BY id DESC`,
    [wo.package_id, wo.id]
  );
  res.json({ ...wo, events, siblings });
});

// 认领：待认领 → 处理中
router.post('/:id/claim', async (req, res) => {
  const operator = (req.body?.operator || '').trim();
  if (!operator) return res.status(400).json({ error: '请填写操作人' });

  const [wo] = await query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
  if (!wo) return res.status(404).json({ error: '工单不存在' });
  if (wo.status !== 'open') return res.status(409).json({ error: '仅待认领工单可认领' });

  const rows = await query(
    `UPDATE work_orders SET status = 'processing', assignee = $1, claimed_at = NOW()
     WHERE id = $2 RETURNING *`,
    [operator, wo.id]
  );
  await addEvent(wo.id, 'claim', operator, `${operator} 认领了工单`);
  res.json(rows[0]);
});

// 转交：处理中 → 处理中（仅当前处理人可转交）
router.post('/:id/transfer', async (req, res) => {
  const operator = (req.body?.operator || '').trim();
  const to = (req.body?.to || '').trim();
  if (!operator) return res.status(400).json({ error: '请填写操作人' });
  if (!to) return res.status(400).json({ error: '请填写转交对象' });
  if (to === operator) return res.status(400).json({ error: '不能转交给自己' });

  const [wo] = await query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
  if (!wo) return res.status(404).json({ error: '工单不存在' });
  if (wo.status !== 'processing') return res.status(409).json({ error: '仅处理中的工单可转交' });
  if (wo.assignee !== operator) return res.status(409).json({ error: '仅当前处理人可转交该工单' });

  const rows = await query(
    `UPDATE work_orders SET assignee = $1 WHERE id = $2 RETURNING *`,
    [to, wo.id]
  );
  await addEvent(wo.id, 'transfer', operator, `由 ${operator} 转交给 ${to}`);
  res.json(rows[0]);
});

// 补充证据：处理中，可多次补充
router.post('/:id/evidence', async (req, res) => {
  const operator = (req.body?.operator || '').trim();
  const content = (req.body?.content || '').trim();
  if (!operator) return res.status(400).json({ error: '请填写操作人' });
  if (!content) return res.status(400).json({ error: '请填写证据内容' });

  const [wo] = await query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
  if (!wo) return res.status(404).json({ error: '工单不存在' });
  if (wo.status !== 'processing') return res.status(409).json({ error: '仅处理中的工单可补充证据' });
  if (wo.assignee !== operator) return res.status(409).json({ error: '仅当前处理人可补充证据' });

  await addEvent(wo.id, 'evidence', operator, content);
  res.json({ ok: true });
});

// 提交处理结论：处理中 → 待复核
router.post('/:id/submit', async (req, res) => {
  const { conclusion, conclusion_note, return_destination } = req.body || {};
  const operator = (req.body?.operator || '').trim();
  if (!operator) return res.status(400).json({ error: '请填写操作人' });
  if (!CONCLUSION_LABEL[conclusion]) return res.status(400).json({ error: '请选择处理结论' });
  if (conclusion === 'return' && !(return_destination || '').trim()) {
    return res.status(400).json({ error: '结论为退回时必须填写退回去向' });
  }

  const [wo] = await query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
  if (!wo) return res.status(404).json({ error: '工单不存在' });
  if (wo.status !== 'processing') return res.status(409).json({ error: '仅处理中的工单可提交结论' });
  if (wo.assignee !== operator) return res.status(409).json({ error: '仅当前处理人可提交结论' });

  const rows = await query(
    `UPDATE work_orders
     SET status = 'pending_review', conclusion = $1, conclusion_note = $2,
         return_destination = $3, submitted_by = $4, submitted_at = NOW()
     WHERE id = $5 RETURNING *`,
    [conclusion, conclusion_note || null,
     conclusion === 'return' ? return_destination.trim() : null, operator, wo.id]
  );
  await addEvent(wo.id, 'submit', operator,
    `提交结论：${CONCLUSION_LABEL[conclusion]}${conclusion_note ? `（${conclusion_note}）` : ''}`);
  res.json(rows[0]);
});

// 复核：待复核 → 已结案（通过）/ 处理中（驳回，继续处理）
router.post('/:id/review', async (req, res) => {
  const { decision, review_note } = req.body || {};
  const operator = (req.body?.operator || '').trim();
  if (!operator) return res.status(400).json({ error: '请填写操作人' });
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: '复核决定必须为 approve（通过）或 reject（驳回）' });
  }

  const [wo] = await query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
  if (!wo) return res.status(404).json({ error: '工单不存在' });
  if (wo.status !== 'pending_review') return res.status(409).json({ error: '仅待复核工单可复核' });
  // 提交人与复核人不能是同一人
  if (wo.submitted_by === operator) {
    return res.status(409).json({ error: '提交人与复核人不能是同一人' });
  }

  if (decision === 'reject') {
    // 驳回：回到处理中，由处理人补充证据后重新提交
    const rows = await query(
      `UPDATE work_orders
       SET status = 'processing', reviewed_by = $1, review_note = $2,
           reviewed_at = NOW(), reject_count = reject_count + 1
       WHERE id = $3 RETURNING *`,
      [operator, review_note || null, wo.id]
    );
    await addEvent(wo.id, 'reject', operator,
      `复核驳回${review_note ? `：${review_note}` : ''}，退回继续处理`);
    return res.json(rows[0]);
  }

  // 通过：结案并落实结论
  const rows = await query(
    `UPDATE work_orders
     SET status = 'closed', reviewed_by = $1, review_note = $2,
         reviewed_at = NOW(), closed_at = NOW()
     WHERE id = $3 RETURNING *`,
    [operator, review_note || null, wo.id]
  );
  const effect = await applyConclusion(rows[0], operator);
  await addEvent(wo.id, 'approve', operator,
    `复核通过，结论「${CONCLUSION_LABEL[wo.conclusion]}」已生效。${effect}`);
  res.json(rows[0]);
});

// 落实复核通过的结论，返回执行说明（写入流转记录）
async function applyConclusion(wo, reviewer) {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [wo.package_id]);
  if (!pkg) return '包裹不存在';

  if (wo.conclusion === 'repair_release') {
    // 修复放行：尚有其他未结工单时不能恢复装车，继续留置
    const [{ count }] = await query(
      `SELECT COUNT(*)::int AS count FROM work_orders
       WHERE package_id = $1 AND id <> $2 AND status IN ('open','processing','pending_review')`,
      [pkg.id, wo.id]
    );
    if (count > 0) {
      return `该包裹尚有 ${count} 张未结工单，继续留置拦截，待全部结案后方可装车`;
    }
    if (pkg.status === 'intercepted') {
      const backTo = pkg.sorted_at ? 'sorted' : 'pending';
      await query(
        `UPDATE packages SET status = $1, is_abnormal = FALSE, intercept_released_at = NOW()
         WHERE id = $2`,
        [backTo, pkg.id]
      );
      return `包裹已解除拦截，恢复为「${backTo === 'sorted' ? '已分拣' : '待分拣'}」`;
    }
    return `包裹当前状态为「${pkg.status}」，无需恢复`;
  }

  if (wo.conclusion === 'return') {
    // 退回：独立去向，退出正常待发库存；同包裹其他未结工单自动结案
    if (pkg.status === 'intercepted') {
      await query(
        `UPDATE packages SET status = 'returned', return_destination = $1, returned_at = NOW()
         WHERE id = $2`,
        [wo.return_destination, pkg.id]
      );
    }
    const others = await query(
      `UPDATE work_orders SET status = 'closed', closed_at = NOW(), review_note = '包裹已退回，自动结案'
       WHERE package_id = $1 AND id <> $2 AND status IN ('open','processing','pending_review')
       RETURNING id`,
      [pkg.id, wo.id]
    );
    for (const o of others) {
      await addEvent(o.id, 'auto_close', reviewer, '包裹已退回，该工单自动结案');
    }
    return `包裹已退回（去向：${wo.return_destination}），退出正常待发库存` +
      (others.length ? `；关联的 ${others.length} 张未结工单已自动结案` : '');
  }

  // isolate 继续隔离：包裹维持拦截状态
  return '包裹维持拦截隔离状态，后续处置需重新登记异常工单';
}

async function addEvent(workOrderId, action, actor, detail) {
  await query(
    'INSERT INTO work_order_events (work_order_id, action, actor, detail) VALUES ($1,$2,$3,$4)',
    [workOrderId, action, actor, detail || null]
  );
}

export default router;
