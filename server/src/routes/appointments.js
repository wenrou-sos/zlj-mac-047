// 预约与叫号路由：预约登记、签到排队、叫号、插队、改约、取消、召回
import { Router } from 'express';
import { query } from '../db.js';
import {
  ApiError, VEHICLE_TYPES,
  checkInAppointment, callAppointment,
  setPriority, reschedule, cancelAppointment, recallAppointment,
} from '../dockService.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  res.status(e.status || 500).json({ error: e.message || '服务器内部错误' });
});

const VEHICLE_JOIN = `
  FROM appointments ap
  JOIN vehicles v ON v.id = ap.vehicle_id
  LEFT JOIN dock_assignments x ON x.appointment_id = ap.id AND x.released_at IS NULL
  LEFT JOIN docks d ON d.id = x.dock_id`;

// 预约列表（默认只返回进行中的记录）
router.get('/', wrap(async (req, res) => {
  const { status, active = 'true' } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };
  if (status) add('ap.status = ?', status);
  else if (active === 'true') conds.push(`ap.status IN ('booked','checked','called','unloading')`);
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows = await query(
    `SELECT ap.*, v.plate_no, v.route_code, v.driver_name,
       d.id AS dock_id, d.code AS dock_code
     ${VEHICLE_JOIN}
     ${where}
     ORDER BY ap.updated_at DESC, ap.id DESC`,
    params
  );
  res.json(rows);
}));

// 调度看板：候叫队列（含队列序号）+ 已叫号靠台/卸车中的车辆
router.get('/board', wrap(async (req, res) => {
  const queue = await query(
    `SELECT ap.*, v.plate_no, v.route_code, v.driver_name
     ${VEHICLE_JOIN}
     WHERE ap.status = 'checked'
     ORDER BY ap.requeued ASC, ap.priority DESC, ap.is_late ASC, ap.slot_start ASC, ap.queue_seq ASC`
  );
  const ranked = queue.map((q, i) => ({ ...q, rank: i + 1 }));

  const called = await query(
    `SELECT ap.*, v.plate_no, v.route_code, v.driver_name,
       d.id AS dock_id, d.code AS dock_code,
       x.assigned_at, x.unload_start_at AS assignment_unload_start_at
     ${VEHICLE_JOIN}
     WHERE ap.status IN ('called','unloading')
     ORDER BY x.assigned_at ASC`
  );

  res.json({ queue: ranked, called });
}));

// 为车辆登记预约（车辆未到场时预约，不占用任何月台）
router.post('/', wrap(async (req, res) => {
  const { vehicle_id, slot_start, slot_end } = req.body || {};
  if (!vehicle_id || !slot_start || !slot_end) {
    return res.status(400).json({ error: '车辆、预约开始与结束时间不能为空' });
  }
  if (new Date(slot_end) <= new Date(slot_start)) {
    return res.status(400).json({ error: '预约结束时间必须晚于开始时间' });
  }
  const [vehicle] = await query('SELECT * FROM vehicles WHERE id=$1', [vehicle_id]);
  if (!vehicle) return res.status(404).json({ error: '车辆不存在' });
  if (!['expected', 'arrived'].includes(vehicle.status)) {
    return res.status(409).json({ error: '车辆已开始作业，不能再登记预约' });
  }
  try {
    const alreadyArrived = vehicle.status === 'arrived';
    const rows = await query(
      `INSERT INTO appointments (vehicle_id, vehicle_type, slot_start, slot_end,
         status, source, checked_at)
       VALUES ($1,$2,$3,$4, $5, 'appointment', $6)
       RETURNING *`,
      [vehicle_id, vehicle.vehicle_type, slot_start, slot_end,
       alreadyArrived ? 'checked' : 'booked', alreadyArrived ? new Date() : null]
    );
    // 已到场车辆登记预约后直接进入候叫队列
    if (rows[0].status === 'checked') {
      const [seqRow] = await query(`SELECT nextval('appointment_queue_seq')::bigint AS seq`);
      const late = new Date() > new Date(slot_end);
      await query(
        `UPDATE appointments SET queued_at=NOW(), queue_seq=$2, is_late=$3 WHERE id=$1`,
        [rows[0].id, seqRow.seq, late]
      );
    }
    res.status(201).json(rows[0]);
  } catch (e) {
    if (/uq_active_vehicle_appointment|unique|duplicate/i.test(String(e.message))) {
      return res.status(409).json({ error: '该车已有进行中的预约' });
    }
    throw e;
  }
}));

router.post('/:id/check-in', wrap(async (req, res) => {
  res.json(await checkInAppointment(Number(req.params.id)));
}));

// 叫号：body.dock_id 可选，不传则按车型适配自动挑选空闲月台
router.post('/:id/call', wrap(async (req, res) => {
  const dockId = req.body?.dock_id ? Number(req.body.dock_id) : null;
  res.status(201).json(await callAppointment(Number(req.params.id), dockId));
}));

// 有理由的插队：priority 越大越靠前，默认提到 200
router.post('/:id/priority', wrap(async (req, res) => {
  const { priority = 200, reason } = req.body || {};
  res.json(await setPriority(Number(req.params.id), priority, reason));
}));

// 改约
router.post('/:id/reschedule', wrap(async (req, res) => {
  const { slot_start, slot_end, reason } = req.body || {};
  res.json(await reschedule(Number(req.params.id), slot_start, slot_end, reason));
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  res.json(await cancelAppointment(Number(req.params.id), req.body?.reason));
}));

// 召回：叫号后未卸车前收回泊位，车辆重新排队尾
router.post('/:id/recall', wrap(async (req, res) => {
  res.json(await recallAppointment(Number(req.params.id), req.body?.reason));
}));

export default router;
export { ApiError };
