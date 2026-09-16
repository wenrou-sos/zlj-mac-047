// 作业班次路由：班次实例（白班/中班/夜班，夜班可跨午夜）
import { Router } from 'express';
import { query } from '../db.js';
import { SHIFT_PRESETS } from '../helpers.js';

const router = Router();

function dateYMD(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// 班次列表（附交班/接班次数与当前是否在岗）
router.get('/', async (req, res) => {
  const rows = await query(
    `SELECT s.*,
       (SELECT COUNT(*)::int FROM shift_handovers h WHERE h.shift_id = s.id AND h.status <> 'cancelled')    AS handover_out,
       (SELECT COUNT(*)::int FROM shift_handovers h WHERE h.to_shift_id = s.id AND h.status = 'signed')     AS handover_in,
       (s.start_at <= NOW() AND (s.end_at IS NULL OR s.end_at > NOW()))                                      AS is_active
     FROM shifts s
     ORDER BY s.work_date DESC, s.start_at DESC`
  );
  res.json(rows.map((r) => ({ ...r, work_date: dateYMD(r.work_date) })));
});

// 新建班次
// body: { name, shift_code, work_date, start_at, end_at }
// work_date 为当地日历 YYYY-MM-DD（跨午夜的夜班归开始上班的那一天）
router.post('/', async (req, res) => {
  const { name, shift_code = 'custom', work_date, start_at, end_at } = req.body || {};
  if (!name || !work_date || !start_at) {
    return res.status(400).json({ error: '班次名称、作业日期和上班时间不能为空' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date)) {
    return res.status(400).json({ error: '作业日期格式应为 YYYY-MM-DD' });
  }
  const preset = SHIFT_PRESETS.find((p) => p.shift_code === shift_code);
  try {
    const rows = await query(
      `INSERT INTO shifts (name, shift_code, work_date, start_at, end_at)
       VALUES ($1,$2,$3::date,$4,$5) RETURNING *`,
      [name, preset ? preset.shift_code : 'custom', work_date, start_at, end_at || null]
    );
    res.status(201).json({ ...rows[0], work_date: dateYMD(rows[0].work_date) });
  } catch (e) {
    if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
      return res.status(409).json({ error: '该作业日已存在相同班次' });
    }
    throw e;
  }
});

export default router;
