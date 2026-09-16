// 月台调度领域服务：预约签到、排队叫号、泊位占用/释放
// 核心不变量：
//   1. 预约（booked）只是计划，不占用月台；叫号成功才产生 dock_assignments 实际占用
//   2. 同一月台同时只能有一条未释放占用 —— 由数据库部分唯一索引 + 单条原子 SQL 双重保证
//   3. 泊位只在卸车结束时释放；叫号后未靠台的召回是唯一例外，且必须填写原因
import { query } from './db.js';

export const VEHICLE_TYPES = ['small', 'medium', 'large', 'extra_large'];

const ACTIVE_APPTS = `status IN ('booked','checked','called','unloading')`;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function getActiveAppointment(vehicleId) {
  const rows = await query(
    `SELECT * FROM appointments WHERE vehicle_id = $1 AND ${ACTIVE_APPTS}
     ORDER BY id DESC LIMIT 1`,
    [vehicleId]
  );
  return rows[0] || null;
}

// 预约签到：booked → checked，进入候叫队列
// 超过预约时段结束时间仍未到场的，标记迟到并排到队尾（重新排队）
async function enterQueue(appt) {
  const late = new Date() > new Date(appt.slot_end);
  const [seqRow] = await query(`SELECT nextval('appointment_queue_seq')::bigint AS seq`);
  const rows = await query(
    `UPDATE appointments
       SET status='checked', checked_at=NOW(), queued_at=NOW(),
           queue_seq=$2, is_late=$3, updated_at=NOW()
     WHERE id=$1 AND status IN ('booked','checked')
     RETURNING *`,
    [appt.id, seqRow.seq, late]
  );
  // 同步车辆状态：签到即到车
  await query(
    `UPDATE vehicles SET status='arrived', arrived_at=COALESCE(arrived_at, NOW())
     WHERE id=$1 AND status='expected'`,
    [appt.vehicle_id]
  );
  return rows[0];
}

// 车辆点「确认到车」：有预约就签到，无预约按临时到场（walk-in）直接入队
export async function checkInByVehicle(vehicleId) {
  const [vehicle] = await query('SELECT * FROM vehicles WHERE id = $1', [vehicleId]);
  if (!vehicle) throw new ApiError(404, '车辆不存在');

  const appt = await getActiveAppointment(vehicleId);
  if (!appt) {
    const [seqRow] = await query(`SELECT nextval('appointment_queue_seq')::bigint AS seq`);
    const now = new Date();
    const rows = await query(
      `INSERT INTO appointments
         (vehicle_id, vehicle_type, slot_start, slot_end, status, source,
          checked_at, queued_at, queue_seq, is_late)
       VALUES ($1,$2,$3,$4,'checked','walkin',NOW(),NOW(),$5,FALSE)
       RETURNING *`,
      [vehicleId, vehicle.vehicle_type, now, new Date(now.getTime() + 30 * 60_000), seqRow.seq]
    );
    return rows[0];
  }
  if (appt.status === 'booked') return enterQueue(appt);
  return appt;
}

export async function checkInAppointment(apptId) {
  const [appt] = await query('SELECT * FROM appointments WHERE id = $1', [apptId]);
  if (!appt) throw new ApiError(404, '预约不存在');
  if (!['booked', 'checked'].includes(appt.status)) {
    throw new ApiError(409, '仅已预约/候叫中的记录可以签到');
  }
  return appt.status === 'checked' ? appt : enterQueue(appt);
}

// 队列排序：
//  1) 叫号后被召回的车永远排最后（requeued）
//  2) 站长有理由插队（priority>100）是显式覆盖，可越过迟到惩罚
//  3) 同优先级内，迟到重排的车在正常车之后
//  4) 再按预约时段、到场先后
const QUEUE_ORDER = `ap.requeued ASC, ap.priority DESC, ap.is_late ASC, ap.slot_start ASC, ap.queue_seq ASC`;

// 原子叫号：一条 INSERT...SELECT 完成「挑月台 + 占泊位」，
// 配合 uq_active_dock_assignment 部分唯一索引，并发叫号绝不会把同一月台派给两辆车
async function atomicCall(apptJoinSql, params) {
  const sql = `
    WITH ins AS (
      INSERT INTO dock_assignments (dock_id, vehicle_id, appointment_id)
      ${apptJoinSql}
      RETURNING id AS assignment_id, appointment_id, dock_id
    )
    UPDATE appointments a
      SET status='called', called_at=NOW(), updated_at=NOW()
    FROM ins
    WHERE a.id = ins.appointment_id
    RETURNING a.*, ins.assignment_id, ins.dock_id`;
  try {
    return await query(sql, params);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e.message))) {
      throw new ApiError(409, '该月台刚被其他车辆叫走，请重新叫号');
    }
    throw e;
  }
}

// 指定预约叫号；dockId 为空时自动挑选适配车型的空闲月台
export async function callAppointment(apptId, dockId = null) {
  const [appt] = await query('SELECT * FROM appointments WHERE id = $1', [apptId]);
  if (!appt) throw new ApiError(404, '预约不存在');
  if (appt.status !== 'checked') throw new ApiError(409, '仅候叫中的车辆可以叫号');

  const free = await query(
    `SELECT id FROM docks
      WHERE status='active' AND $1 = ANY(allowed_types)
        AND ($2::int IS NULL OR id = $2)
        AND NOT EXISTS (SELECT 1 FROM dock_assignments x WHERE x.dock_id = docks.id AND x.released_at IS NULL)
      ORDER BY id LIMIT 1`,
    [appt.vehicle_type, dockId]
  );
  if (!free.length) {
    throw new ApiError(409, dockId ? '该月台已占用或不适配此车型' : '暂无可适配该车型的空闲月台');
  }

  const rows = await atomicCall(
    `SELECT d.id, ap.vehicle_id, ap.id
       FROM appointments ap
       JOIN docks d ON d.status='active'
                  AND ap.vehicle_type = ANY(d.allowed_types)
                  AND ($2::int IS NULL OR d.id = $2)
      WHERE ap.id = $1 AND ap.status = 'checked'
        AND NOT EXISTS (SELECT 1 FROM dock_assignments x WHERE x.dock_id = d.id AND x.released_at IS NULL)
      ORDER BY d.id
      LIMIT 1`,
    [apptId, dockId]
  );
  if (!rows.length) throw new ApiError(409, '叫号失败，请刷新队列后重试');
  return rows[0];
}

// 月台「叫下一位」：从适配该月台的候叫队列头部派车
export async function callNextForDock(dockId) {
  const [dock] = await query(`SELECT * FROM docks WHERE id = $1`, [dockId]);
  if (!dock) throw new ApiError(404, '月台不存在');
  if (dock.status !== 'active') throw new ApiError(409, '月台已停用，不能叫号');

  const rows = await atomicCall(
    `SELECT $1, ap.vehicle_id, ap.id
       FROM appointments ap
      WHERE ap.status = 'checked'
        AND ap.vehicle_type = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM dock_assignments x WHERE x.dock_id = $1 AND x.released_at IS NULL)
      ORDER BY ${QUEUE_ORDER.replaceAll('ap.', 'ap.')}
      LIMIT 1`,
    [dockId, dock.allowed_types]
  );
  if (!rows.length) throw new ApiError(409, '该月台没有适配车型的候叫车辆');
  return rows[0];
}

// 有理由的插队：只影响候叫队列中的优先级
export async function setPriority(apptId, priority, reason) {
  if (!reason || !String(reason).trim()) throw new ApiError(400, '插队必须填写原因');
  const p = Number(priority);
  if (!Number.isFinite(p)) throw new ApiError(400, '优先级数值不合法');
  const rows = await query(
    `UPDATE appointments SET priority=$2, priority_reason=$3, updated_at=NOW()
     WHERE id=$1 AND status='checked' RETURNING *`,
    [apptId, p, String(reason).trim()]
  );
  if (!rows.length) throw new ApiError(409, '仅候叫中的车辆可以调整插队优先级');
  return rows[0];
}

// 改约：仅未到场（booked）可改，必须填原因，保留改约次数
export async function reschedule(apptId, slotStart, slotEnd, reason) {
  if (!reason || !String(reason).trim()) throw new ApiError(400, '改约必须填写原因');
  if (!slotStart || !slotEnd) throw new ApiError(400, '请选择新的预约时段');
  if (new Date(slotEnd) <= new Date(slotStart)) throw new ApiError(400, '时段结束时间必须晚于开始时间');
  const rows = await query(
    `UPDATE appointments
       SET slot_start=$2, slot_end=$3, reschedule_count=reschedule_count+1,
           reschedule_reason=$4, updated_at=NOW()
     WHERE id=$1 AND status='booked' RETURNING *`,
    [apptId, slotStart, slotEnd, String(reason).trim()]
  );
  if (!rows.length) throw new ApiError(409, '车辆已到场或作业已开始，不能改约；如需调整请取消后重新预约');
  return rows[0];
}

// 取消预约：未叫号前可取消，必须填原因
export async function cancelAppointment(apptId, reason) {
  if (!reason || !String(reason).trim()) throw new ApiError(400, '取消预约必须填写原因');
  const rows = await query(
    `UPDATE appointments SET status='cancelled', cancel_reason=$2, updated_at=NOW()
     WHERE id=$1 AND status IN ('booked','checked') RETURNING *`,
    [apptId, String(reason).trim()]
  );
  if (!rows.length) throw new ApiError(409, '已叫号或作业中的预约不能取消');
  return rows[0];
}

// 召回：已叫号但尚未开始卸车，带原因收回泊位，车辆重新排队尾
export async function recallAppointment(apptId, reason) {
  if (!reason || !String(reason).trim()) throw new ApiError(400, '召回必须填写原因');
  const released = await query(
    `UPDATE dock_assignments
       SET status='cancelled', released_at=NOW(), cancel_reason=$2
     WHERE appointment_id=$1 AND released_at IS NULL AND status='assigned'
     RETURNING id`,
    [apptId, String(reason).trim()]
  );
  if (!released.length) {
    throw new ApiError(409, '车辆已开始卸车，泊位只能在卸车结束后释放，不能召回');
  }
  const [seqRow] = await query(`SELECT nextval('appointment_queue_seq')::bigint AS seq`);
  const rows = await query(
    `UPDATE appointments
       SET status='checked', called_at=NULL, queued_at=NOW(), queue_seq=$2,
           priority=100, priority_reason=NULL, requeued=TRUE,
           recall_reason=$3, updated_at=NOW()
     WHERE id=$1 AND status='called' RETURNING *`,
    [apptId, seqRow.seq, String(reason).trim()]
  );
  return rows[0];
}

// 开始卸车：占用进入 in_use
export async function markUnloadStarted(vehicleId) {
  const [asgn] = await query(
    `SELECT * FROM dock_assignments WHERE vehicle_id=$1 AND released_at IS NULL`,
    [vehicleId]
  );
  if (!asgn) throw new ApiError(409, '车辆尚未叫号靠台，不能开始卸车');
  await query(
    `UPDATE dock_assignments SET status='in_use', unload_start_at=COALESCE(unload_start_at, NOW())
     WHERE id=$1`,
    [asgn.id]
  );
  await query(
    `UPDATE appointments SET status='unloading', updated_at=NOW()
     WHERE id=$1 AND status IN ('called','unloading')`,
    [asgn.appointment_id]
  );
  return asgn;
}

// 卸车结束：这是泊位正常释放的唯一时机
export async function releaseByUnloadEnd(vehicleId) {
  const released = await query(
    `UPDATE dock_assignments SET status='released', released_at=NOW()
     WHERE vehicle_id=$1 AND released_at IS NULL
     RETURNING appointment_id`,
    [vehicleId]
  );
  if (!released.length) throw new ApiError(409, '车辆没有进行中的月台占用，无法完成卸车');
  await query(
    `UPDATE appointments SET status='completed', updated_at=NOW()
     WHERE id=$1 AND status IN ('called','unloading')`,
    [released[0].appointment_id]
  );
}
