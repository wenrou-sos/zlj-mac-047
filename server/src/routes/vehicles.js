// 车辆班次路由：到车、卸车、分拣、发车全流程
import { Router } from 'express';
import { query } from '../db.js';
import { VEHICLE_FLOW } from '../helpers.js';
import {
  ApiError, VEHICLE_TYPES, getActiveAppointment,
  checkInByVehicle, markUnloadStarted, releaseByUnloadEnd,
} from '../dockService.js';

const router = Router();

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e) });

// 车辆列表（含包裹统计 + 月台预约/排队信息）
router.get('/', async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE v.status = $1';
  }
  const rows = await query(
    `SELECT v.*,
       (SELECT COUNT(*)::int FROM packages p WHERE p.vehicle_id = v.id) AS package_count,
       (SELECT COUNT(*)::int FROM packages p WHERE p.vehicle_id = v.id AND p.status = 'pending')     AS pending_count,
       (SELECT COUNT(*)::int FROM packages p WHERE p.vehicle_id = v.id AND p.status = 'sorted')      AS sorted_count,
       (SELECT COUNT(*)::int FROM packages p WHERE p.vehicle_id = v.id AND p.status = 'loaded')      AS loaded_count,
       (SELECT COUNT(*)::int FROM packages p WHERE p.vehicle_id = v.id AND p.status = 'intercepted') AS intercepted_count,
       ap.id                  AS appointment_id,
       ap.status              AS appointment_status,
       ap.is_late             AS is_late,
       ap.requeued            AS requeued,
       ap.queue_seq           AS queue_seq,
       ap.slot_start          AS slot_start,
       ap.slot_end            AS slot_end,
       ap.checked_at          AS checked_at,
       ap.queued_at           AS queued_at,
       ap.called_at           AS called_at,
       ap.priority_reason     AS priority_reason,
       d.id                   AS dock_id,
       d.code                 AS dock_code
     FROM vehicles v
     LEFT JOIN LATERAL (
       SELECT * FROM appointments
        WHERE vehicle_id = v.id AND status IN ('booked','checked','called','unloading')
        ORDER BY id DESC LIMIT 1
     ) ap ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM dock_assignments WHERE vehicle_id = v.id AND released_at IS NULL LIMIT 1
     ) x ON TRUE
     LEFT JOIN docks d ON d.id = x.dock_id
     ${where}
     ORDER BY v.created_at DESC`,
    params
  );
  res.json(rows);
});

// 新增车辆（到车预报，可同时登记月台预约）
router.post('/', async (req, res) => {
  const {
    plate_no, route_code, driver_name, vehicle_type = 'medium',
    planned_arrival, planned_departure,
    slot_start, slot_end,
  } = req.body || {};
  if (!plate_no || !route_code) {
    return res.status(400).json({ error: '车牌号和线路不能为空' });
  }
  if (!VEHICLE_TYPES.includes(vehicle_type)) {
    return res.status(400).json({ error: '车型不合法' });
  }
  if (slot_start && !slot_end) {
    return res.status(400).json({ error: '预约时段需填写开始与结束时间' });
  }
  if (slot_start && slot_end && new Date(slot_end) <= new Date(slot_start)) {
    return res.status(400).json({ error: '预约时段结束时间必须晚于开始时间' });
  }

  try {
    const rows = await query(
      `INSERT INTO vehicles (plate_no, route_code, driver_name, vehicle_type,
                              planned_arrival, planned_departure)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [plate_no, route_code, driver_name || null, vehicle_type,
       planned_arrival || null, planned_departure || null]
    );
    const vehicle = rows[0];

    // 预约只是计划：此时月台没有任何占用
    if (slot_start && slot_end) {
      await query(
        `INSERT INTO appointments (vehicle_id, vehicle_type, slot_start, slot_end)
         VALUES ($1,$2,$3,$4)`,
        [vehicle.id, vehicle_type, slot_start, slot_end]
      );
    }
    res.status(201).json(vehicle);
  } catch (e) {
    fail(res, e);
  }
});

// 状态推进：到车 / 开始卸车 / 完成卸车 / 开始分拣 / 完成分拣 / 发车
router.post('/:id/action/:action', async (req, res) => {
  const { id, action } = req.params;
  const flow = VEHICLE_FLOW[action];
  if (!flow) return res.status(400).json({ error: `未知操作: ${action}` });

  const [vehicle] = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
  if (!vehicle) return res.status(404).json({ error: '车辆不存在' });
  if (!flow.from.includes(vehicle.status)) {
    return res.status(409).json({ error: `当前状态不允许「${flow.label}」操作` });
  }

  try {
    if (action === 'arrive') {
      // 确认到车：有预约则签到排队，无预约按临时到场入队；迟到预约自动排到队尾
      await checkInByVehicle(Number(id));
    }
    if (action === 'unload-start') {
      // 没有叫号靠台不允许开始卸车（不能直接占用一个看不见的月台）
      await markUnloadStarted(Number(id));
    }

    const rows = await query(
      `UPDATE vehicles SET status = $1, ${flow.set} = NOW() WHERE id = $2 RETURNING *`,
      [flow.to, id]
    );

    if (action === 'unload-end') {
      // 卸车结束才释放泊位
      await releaseByUnloadEnd(Number(id));
    }

    // 完成分拣：车上所有待分拣包裹自动标记为已分拣（拦截件除外）
    if (action === 'sort-end') {
      await query(
        `UPDATE packages SET status = 'sorted', sorted_at = NOW()
         WHERE vehicle_id = $1 AND status = 'pending'`,
        [id]
      );
    }
    // 发车：已分拣包裹自动装车；拦截件留在场地，不随车发走
    if (action === 'depart') {
      await query(
        `UPDATE packages SET status = 'loaded' WHERE vehicle_id = $1 AND status = 'sorted'`,
        [id]
      );
    }

    res.json(rows[0]);
  } catch (e) {
    fail(res, e);
  }
});

// 删除未到车的预报班次（预约随外键级联删除）
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const [vehicle] = await query('SELECT status FROM vehicles WHERE id = $1', [id]);
  if (!vehicle) return res.status(404).json({ error: '车辆不存在' });
  if (vehicle.status !== 'expected') {
    return res.status(409).json({ error: '仅待到车状态的班次可以删除' });
  }
  const appt = await getActiveAppointment(Number(id));
  if (appt && appt.status !== 'booked') {
    return res.status(409).json({ error: '车辆已签到排队，不能删除，请先取消预约' });
  }
  await query('DELETE FROM vehicles WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
export { ApiError };
