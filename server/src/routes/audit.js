// 操作日志查询（需 audit:view 权限）
import { Router } from 'express';
import { query } from '../db.js';
import { requirePerm } from '../auth.js';

const router = Router();
router.use(requirePerm('audit:view'));

// 操作日志列表（分页，支持动作/操作者筛选）
router.get('/', async (req, res) => {
  const { action, actor, page = 1, pageSize = 50 } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  if (action) add('action = ?', action);
  if (actor) add('actor_name ILIKE ?', `%${actor}%`);

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);

  const [{ count }] = await query(`SELECT COUNT(*)::int AS count FROM audit_logs ${where}`, params);
  params.push(size, (pageNum - 1) * size);
  const items = await query(
    `SELECT * FROM audit_logs ${where}
     ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
});

export default router;
