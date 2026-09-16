// 本地模拟数据：月台、车辆班次（含预约/排队/占用）+ 包裹，覆盖各种业务状态
import { query } from './db.js';

const ROUTES = [
  { code: 'BJ-SH',  from: '北京', to: '上海' },
  { code: 'SH-GZ',  from: '上海', to: '广州' },
  { code: 'GZ-SZ',  from: '广州', to: '深圳' },
  { code: 'HZ-BJ',  from: '杭州', to: '北京' },
  { code: 'CD-CQ',  from: '成都', to: '重庆' },
  { code: 'WH-CS',  from: '武汉', to: '长沙' },
  { code: 'NJ-HZ',  from: '南京', to: '杭州' },
  { code: 'XA-LZ',  from: '西安', to: '兰州' },
];
const DESTINATIONS = ['上海', '北京', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆', '长沙', '苏州'];
const DRIVERS = ['张伟', '王强', '李军', '刘洋', '陈杰', '杨帆', '赵磊', '黄勇', '周斌', '吴涛', '徐明', '孙浩', '马飞'];
const ABNORMAL = [
  ['damaged', '外包装破损', 0.35],
  ['wrong_route', '错分线路', 0.25],
  ['overweight', '超重超限', 0.15],
  ['address_issue', '地址信息异常', 0.15],
  ['prohibited', '疑似违禁品', 0.10],
];
const DOCKS = [
  { code: 'D01', name: '1号月台', types: ['small', 'medium'] },
  { code: 'D02', name: '2号月台', types: ['small', 'medium'] },
  { code: 'D03', name: '3号月台', types: ['medium', 'large'] },
  { code: 'D04', name: '4号月台', types: ['medium', 'large'] },
  { code: 'D05', name: '5号重车月台', types: ['large', 'extra_large'] },
  { code: 'D06', name: '6号月台', types: ['small', 'medium', 'large'] },
];

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const minutesAgo = (n) => new Date(Date.now() - n * 60_000);
const minutesFromNow = (n) => new Date(Date.now() + n * 60_000);

function pickAbnormalType() {
  let r = Math.random();
  for (const [type, , w] of ABNORMAL) {
    if ((r -= w) <= 0) return type;
  }
  return 'damaged';
}
const abnormalNote = (type) => ABNORMAL.find(([t]) => t === type)[1];

let trackingSeq = 100000;
const nextTrackingNo = () => `SF${Date.now().toString().slice(-8)}${(trackingSeq++).toString().slice(-6)}`;

async function insertPackages(vehicleId, count, stage) {
  // stage 决定包裹状态分布
  for (let i = 0; i < count; i++) {
    const abnormal = Math.random() < 0.05;
    let status = 'pending';
    let sortedAt = null;
    if (!abnormal) {
      if (stage === 'departed') status = 'loaded';
      else if (stage === 'sorted') status = Math.random() < 0.7 ? 'loaded' : 'sorted';
      else if (stage === 'sorting') status = Math.random() < 0.5 ? 'sorted' : 'pending';
    }
    if (status === 'sorted' || status === 'loaded') {
      sortedAt = minutesAgo(rand(5, 90));
    }
    const type = abnormal ? pickAbnormalType() : null;
    await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, status,
        is_abnormal, abnormal_type, abnormal_note, intercepted_at, sorted_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        nextTrackingNo(), vehicleId, pick(DESTINATIONS), (rand(1, 3000) / 100).toFixed(2),
        abnormal ? 'intercepted' : status,
        abnormal, type, abnormal ? abnormalNote(type) : null,
        abnormal ? minutesAgo(rand(10, 120)) : null,
        sortedAt, minutesAgo(rand(60, 600)),
      ]
    );
  }
}

async function insertVehicle(v) {
  const res = await query(
    `INSERT INTO vehicles (plate_no, route_code, driver_name, vehicle_type,
       planned_arrival, planned_departure,
       arrived_at, unload_start_at, unload_end_at, sort_start_at, sort_end_at, departed_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [v.plate_no, v.route_code, v.driver_name, v.vehicle_type,
     v.planned_arrival, v.planned_departure,
     v.arrived_at, v.unload_start_at, v.unload_end_at, v.sort_start_at, v.sort_end_at,
     v.departed_at, v.status]
  );
  return res[0].id;
}

let queueSeq = 0;
const nextQueueSeq = () => ++queueSeq;

// 已完成的历史预约 + 已释放占用（用于卸车后各阶段的车辆）
async function insertCompletedFlow(vehicleId, v) {
  const assignedAt = new Date(v.unload_start_at.getTime() - 5 * 60_000);
  await query(
    `INSERT INTO appointments
       (vehicle_id, vehicle_type, slot_start, slot_end, status, source,
        checked_at, queued_at, queue_seq, called_at)
     VALUES ($1,$2,$3,$4,'completed','appointment',$5,$6,$7,$8)`,
    [vehicleId, v.vehicle_type,
     new Date(v.arrived_at.getTime() - 30 * 60_000),
     new Date(v.arrived_at.getTime() + 30 * 60_000),
     v.arrived_at, v.arrived_at, nextQueueSeq(), assignedAt]
  );
  const [appt] = await query(`SELECT id FROM appointments WHERE vehicle_id=$1`, [vehicleId]);
  const [dock] = await query(
    `SELECT id FROM docks WHERE $1 = ANY(allowed_types) ORDER BY id LIMIT 1`,
    [v.vehicle_type]
  );
  await query(
    `INSERT INTO dock_assignments
       (dock_id, vehicle_id, appointment_id, status, assigned_at, unload_start_at, released_at)
     VALUES ($1,$2,$3,'released',$4,$5,$6)`,
    [dock.id, vehicleId, appt.id, assignedAt, v.unload_start_at, v.unload_end_at]
  );
}

// 候叫队列中的车辆
async function insertQueued(vehicleId, v, { late = false, priority = 100, reason = null } = {}) {
  const slotStart = late ? minutesAgo(70) : minutesFromNow(5);
  const slotEnd = late ? minutesAgo(40) : minutesFromNow(35);
  await query(
    `INSERT INTO appointments
       (vehicle_id, vehicle_type, slot_start, slot_end, status, source,
        checked_at, queued_at, queue_seq, is_late, priority, priority_reason)
     VALUES ($1,$2,$3,$4,'checked','appointment',$5,$5,$6,$7,$8,$9)`,
    [vehicleId, v.vehicle_type, slotStart, slotEnd,
     v.arrived_at, nextQueueSeq(), late, priority, reason]
  );
}

// 已叫号靠台（未卸车）：真实占用月台
async function insertCalled(vehicleId, v, dockCode) {
  const calledAt = minutesAgo(3);
  await query(
    `INSERT INTO appointments
       (vehicle_id, vehicle_type, slot_start, slot_end, status, source,
        checked_at, queued_at, queue_seq, called_at)
     VALUES ($1,$2,$3,$4,'called','appointment',$5,$6,$7,$8)`,
    [vehicleId, v.vehicle_type, minutesFromNow(-10), minutesFromNow(20),
     minutesAgo(8), minutesAgo(8), nextQueueSeq(), calledAt]
  );
  const [appt] = await query(`SELECT id FROM appointments WHERE vehicle_id=$1`, [vehicleId]);
  const [dock] = await query(`SELECT id FROM docks WHERE code=$1`, [dockCode]);
  await query(
    `INSERT INTO dock_assignments (dock_id, vehicle_id, appointment_id, status, assigned_at)
     VALUES ($1,$2,$3,'assigned',$4)`,
    [dock.id, vehicleId, appt.id, calledAt]
  );
}

// 卸车中：in_use 占用，泊位尚未释放
async function insertUnloading(vehicleId, v, dockCode) {
  const calledAt = new Date(v.unload_start_at.getTime() - 4 * 60_000);
  await query(
    `INSERT INTO appointments
       (vehicle_id, vehicle_type, slot_start, slot_end, status, source,
        checked_at, queued_at, queue_seq, called_at)
     VALUES ($1,$2,$3,$4,'unloading','appointment',$5,$6,$7,$8)`,
    [vehicleId, v.vehicle_type,
     new Date(v.arrived_at.getTime() - 25 * 60_000),
     new Date(v.arrived_at.getTime() + 25 * 60_000),
     v.arrived_at, v.arrived_at, nextQueueSeq(), calledAt]
  );
  const [appt] = await query(`SELECT id FROM appointments WHERE vehicle_id=$1`, [vehicleId]);
  const [dock] = await query(`SELECT id FROM docks WHERE code=$1`, [dockCode]);
  await query(
    `INSERT INTO dock_assignments (dock_id, vehicle_id, appointment_id, status, assigned_at, unload_start_at)
     VALUES ($1,$2,$3,'in_use',$4,$5)`,
    [dock.id, vehicleId, appt.id, calledAt, v.unload_start_at]
  );
}

async function seedDocks() {
  for (const d of DOCKS) {
    await query(
      `INSERT INTO docks (code, dock_name, allowed_types) VALUES ($1,$2,$3)`,
      [d.code, d.name, d.types]
    );
  }
  // 一个临时停用月台，用于演示停用原因与恢复
  await query(
    `INSERT INTO docks (code, dock_name, allowed_types, status, disabled_reason, disabled_at)
     VALUES ('D07','7号月台','{small,medium,large,extra_large}','disabled','升降平台故障维修',NOW())`
  );
}

export async function seedIfEmpty(force = false) {
  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM vehicles');
  if (count > 0 && !force) return false;
  if (force) {
    await query(
      `TRUNCATE packages, dock_assignments, appointments, vehicles, docks RESTART IDENTITY CASCADE`
    );
    await query(`ALTER SEQUENCE appointment_queue_seq RESTART WITH 1`);
  }

  const anyDocks = await query('SELECT COUNT(*)::int AS c FROM docks');
  if (anyDocks[0].c === 0) await seedDocks();

  const plate = () => `沪A·${String(rand(10000, 99999))}`;
  const base = (route, status, vehicle_type, extra = {}) => ({
    plate_no: plate(),
    route_code: route.code,
    driver_name: pick(DRIVERS),
    vehicle_type,
    status,
    planned_arrival: null, planned_departure: null,
    arrived_at: null, unload_start_at: null, unload_end_at: null,
    sort_start_at: null, sort_end_at: null, departed_at: null,
    ...extra,
  });

  // [车辆, 阶段, 包裹数, 月台流程]
  const vehicles = [];
  const R = ROUTES;

  // ── 已发车（完整生命周期，历史班次）──
  for (let i = 0; i < 3; i++) {
    const arrived = minutesAgo(rand(300, 480));
    vehicles.push([base(R[i], 'departed', i === 2 ? 'large' : 'medium', {
      planned_arrival: minutesAgo(rand(300, 480)),
      planned_departure: minutesAgo(rand(60, 120)),
      arrived_at: arrived,
      unload_start_at: new Date(arrived.getTime() + 5 * 60_000),
      unload_end_at: new Date(arrived.getTime() + 25 * 60_000),
      sort_start_at: new Date(arrived.getTime() + 30 * 60_000),
      sort_end_at: new Date(arrived.getTime() + 80 * 60_000),
      departed_at: new Date(arrived.getTime() + rand(100, 150) * 60_000),
    }), 'departed', rand(35, 55), 'completed']);
  }

  // ── 待发车（分拣已完成）── 其中一辆已超过计划发车时间 → 触发发车超时预警
  vehicles.push([base(R[3], 'sorted', 'medium', {
    planned_arrival: minutesAgo(150), planned_departure: minutesAgo(20),
    arrived_at: minutesAgo(140), unload_start_at: minutesAgo(135), unload_end_at: minutesAgo(110),
    sort_start_at: minutesAgo(105), sort_end_at: minutesAgo(50),
  }), 'sorted', 42, 'completed']);
  vehicles.push([base(R[4], 'sorted', 'large', {
    planned_arrival: minutesAgo(120), planned_departure: minutesFromNow(40),
    arrived_at: minutesAgo(115), unload_start_at: minutesAgo(110), unload_end_at: minutesAgo(85),
    sort_start_at: minutesAgo(80), sort_end_at: minutesAgo(30),
  }), 'sorted', 38, 'completed']);

  // ── 分拣中 ── 其中一辆分拣严重超时
  vehicles.push([base(R[5], 'sorting', 'medium', {
    planned_arrival: minutesAgo(200), planned_departure: minutesFromNow(30),
    arrived_at: minutesAgo(195), unload_start_at: minutesAgo(190), unload_end_at: minutesAgo(160),
    sort_start_at: minutesAgo(150),
  }), 'sorting', 50, 'completed']);
  vehicles.push([base(R[6], 'sorting', 'small', {
    planned_arrival: minutesAgo(70), planned_departure: minutesFromNow(90),
    arrived_at: minutesAgo(65), unload_start_at: minutesAgo(60), unload_end_at: minutesAgo(40),
    sort_start_at: minutesAgo(35),
  }), 'sorting', 45, 'completed']);

  // ── 已卸车待分拣 ──
  vehicles.push([base(R[7], 'unloaded', 'medium', {
    planned_arrival: minutesAgo(130), planned_departure: minutesFromNow(60),
    arrived_at: minutesAgo(125), unload_start_at: minutesAgo(120), unload_end_at: minutesAgo(90),
  }), 'unloaded', 40, 'completed']);

  // ── 卸车中（泊位被实际占用）── 其中一辆卸车超时
  vehicles.push([base(R[0], 'unloading', 'large', {
    planned_arrival: minutesAgo(80), planned_departure: minutesFromNow(70),
    arrived_at: minutesAgo(75), unload_start_at: minutesAgo(70),
  }), 'unloading', 48, { kind: 'unloading', dock: 'D04' }]);
  vehicles.push([base(R[1], 'unloading', 'medium', {
    planned_arrival: minutesAgo(20), planned_departure: minutesFromNow(150),
    arrived_at: minutesAgo(18), unload_start_at: minutesAgo(15),
  }), 'unloading', 44, { kind: 'unloading', dock: 'D02' }]);

  // ── 已叫号靠台，尚未开始卸车（占用 D01）──
  vehicles.push([base(R[2], 'arrived', 'medium', {
    planned_arrival: minutesAgo(15), planned_departure: minutesFromNow(160),
    arrived_at: minutesAgo(8),
  }), 'arrived', 36, { kind: 'called', dock: 'D01' }]);

  // ── 候叫队列 ──
  // 迟到车：超过预约时段才到场，重新排队尾（在入队顺序上最后体现）
  vehicles.push([base(R[3], 'arrived', 'medium', {
    planned_arrival: minutesAgo(50), planned_departure: minutesFromNow(120),
    arrived_at: minutesAgo(45),
  }), 'arrived', 40, { kind: 'queued', late: true }]);
  // 有理由的插队车（冷链优先）
  vehicles.push([base(R[4], 'arrived', 'small', {
    planned_arrival: minutesAgo(12), planned_departure: minutesFromNow(140),
    arrived_at: minutesAgo(10),
  }), 'arrived', 18, { kind: 'queued', priority: 200, reason: '冷链货物，站长批准优先卸车' }]);
  // 普通候叫
  vehicles.push([base(R[6], 'arrived', 'large', {
    planned_arrival: minutesAgo(6), planned_departure: minutesFromNow(180),
    arrived_at: minutesAgo(5),
  }), 'arrived', 0, { kind: 'queued' }]);

  // ── 待到车（已预约，未占用月台）──
  vehicles.push([base(R[3], 'expected', 'medium', {
    planned_arrival: minutesFromNow(30), planned_departure: minutesFromNow(180),
  }), 'expected', 0, { kind: 'booked', slotStart: minutesFromNow(30), slotEnd: minutesFromNow(60) }]);
  vehicles.push([base(R[5], 'expected', 'extra_large', {
    planned_arrival: minutesFromNow(90), planned_departure: minutesFromNow(240),
  }), 'expected', 0, { kind: 'booked', slotStart: minutesFromNow(90), slotEnd: minutesFromNow(130) }]);

  for (const [v, stage, pkgCount, dockFlow] of vehicles) {
    const id = await insertVehicle(v);
    if (pkgCount > 0) await insertPackages(id, pkgCount, stage);

    if (dockFlow === 'completed') await insertCompletedFlow(id, v);
    else if (dockFlow?.kind === 'unloading') await insertUnloading(id, v, dockFlow.dock);
    else if (dockFlow?.kind === 'called') await insertCalled(id, v, dockFlow.dock);
    else if (dockFlow?.kind === 'queued') {
      await insertQueued(id, v, { late: dockFlow.late, priority: dockFlow.priority ?? 100, reason: dockFlow.reason ?? null });
    } else if (dockFlow?.kind === 'booked') {
      await query(
        `INSERT INTO appointments (vehicle_id, vehicle_type, slot_start, slot_end, status)
         VALUES ($1,$2,$3,$4,'booked')`,
        [id, v.vehicle_type, dockFlow.slotStart, dockFlow.slotEnd]
      );
    }
  }

  const [v] = await query('SELECT COUNT(*)::int AS c FROM vehicles');
  const [p] = await query('SELECT COUNT(*)::int AS c FROM packages');
  const [d] = await query('SELECT COUNT(*)::int AS c FROM docks');
  console.log(`[seed] 已生成模拟数据：月台 ${d.c} 个，车辆 ${v.c} 辆，包裹 ${p.c} 件`);
  return true;
}

// 直接运行: node src/seed.js [--force]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { initSchema } = await import('./schema.js');
  await initSchema();
  const done = await seedIfEmpty(process.argv.includes('--force'));
  if (!done) console.log('[seed] 已有数据，跳过（使用 --force 重新生成）');
  process.exit(0);
}
