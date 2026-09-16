// 月台路由：月台维护、临时停用、月台叫下一位
import { Router } from 'express';
import { query } from '../db.js';
import { ApiError, VEHICLE_TYPES, callNextForDock } from '../dockService.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  res.status(e.status || 500).json({ error: e.message || '服务器内部错误' });
});

// 月台总览：状态、适配车型、当前占用车辆与占用开始时间
router.get('/', wrap(async (req, res) => {
  const rows = await query(
    `SELECT d.*,
       x.id              AS assignment_id,
       x.status          AS assignment_status,
       x.assigned_at     AS assigned_at,
       x.unload_start_at AS assignment_unload_start_at,
       v.id              AS vehicle_id,
       v.plate_no        AS plate_no,
       v.route_code      AS route_code,
       v.vehicle_type    AS vehicle_type,
       ap.status         AS appointment_status,
       ap.is_late        AS vehicle_is_late,
       ap.priority_reason AS priority_reason
     FROM docks d
     LEFT JOIN dock_assignments x ON x.dock_id = d.id AND x.released_at IS NULL
     LEFT JOIN vehicles v ON v.id = x.vehicle_id
     LEFT JOIN appointments ap ON ap.id = x.appointment_id
     ORDER BY d.id`
  );
  res.json(rows);
}));

// 新增月台
router.post('/', wrap(async (req, res) => {
  const { code, dock_name, allowed_types } = req.body || {};
  if (!code || !dock_name) return res.status(400).json({ error: '月台编号和名称不能为空' });
  const types = Array.isArray(allowed_types) && allowed_types.length ? allowed_types : VEHICLE_TYPES;
  const bad = types.filter((t) => !VEHICLE_TYPES.includes(t));
  if (bad.length) return res.status(400).json({ error: `车型不合法: ${bad.join(',')}` });
  try {
    const rows = await query(
      `INSERT INTO docks (code, dock_name, allowed_types) VALUES ($1,$2,$3) RETURNING *`,
      [code, dock_name, types]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e.message))) {
      return res.status(409).json({ error: '月台编号已存在' });
    }
    throw e;
  }
}));

// 修改月台（名称/适配车型）
router.put('/:id', wrap(async (req, res) => {
  const { dock_name, allowed_types } = req.body || {};
  if (Array.isArray(allowed_types)) {
    const bad = allowed_types.filter((t) => !VEHICLE_TYPES.includes(t));
    if (bad.length) return res.status(400).json({ error: `车型不合法: ${bad.join(',')}` });
    if (!allowed_types.length) return res.status(400).json({ error: '至少保留一种适配车型' });
  }
  const rows = await query(
    `UPDATE docks SET
       dock_name = COALESCE($2, dock_name),
       allowed_types = COALESCE($3, allowed_types)
     WHERE id=$1 RETURNING *`,
    [req.params.id, dock_name || null, Array.isArray(allowed_types) ? allowed_types : null]
  );
  if (!rows.length) return res.status(404).json({ error: '月台不存在' });
  res.json(rows[0]);
}));

// 临时停用 / 恢复启用。占用中的月台不能停用，避免在途作业失去泊位
router.post('/:id/disable', wrap(async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: '停用月台必须填写原因' });
  const [dock] = await query('SELECT * FROM docks WHERE id=$1', [req.params.id]);
  if (!dock) return res.status(404).json({ error: '月台不存在' });
  const [busy] = await query(
    `SELECT 1 FROM dock_assignments WHERE dock_id=$1 AND released_at IS NULL`,
    [req.params.id]
  );
  if (busy) return res.status(409).json({ error: '月台有车辆靠台或卸车中，不能停用' });
  const rows = await query(
    `UPDATE docks SET status='disabled', disabled_reason=$2, disabled_at=NOW()
     WHERE id=$1 RETURNING *`,
    [req.params.id, String(reason).trim()]
  );
  res.json(rows[0]);
}));

router.post('/:id/enable', wrap(async (req, res) => {
  const rows = await query(
    `UPDATE docks SET status='active', disabled_reason=NULL, disabled_at=NULL
     WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: '月台不存在' });
  res.json(rows[0]);
}));

// 月台叫下一位：按车型适配 + 预约时段 + 到场顺序（迟到车排尾）派车
router.post('/:id/call-next', wrap(async (req, res) => {
  const row = await callNextForDock(Number(req.params.id));
  res.status(201).json(row);
}));

export default router;
export { ApiError };
