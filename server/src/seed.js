// 本地模拟数据：生成车辆班次 + 包裹，覆盖各种业务状态（含超时、异常场景）
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
    `INSERT INTO vehicles (plate_no, route_code, driver_name, planned_arrival, planned_departure,
      arrived_at, unload_start_at, unload_end_at, sort_start_at, sort_end_at, departed_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [v.plate_no, v.route_code, v.driver_name, v.planned_arrival, v.planned_departure,
     v.arrived_at, v.unload_start_at, v.unload_end_at, v.sort_start_at, v.sort_end_at,
     v.departed_at, v.status]
  );
  return res[0].id;
}

export async function seedIfEmpty(force = false) {
  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM vehicles');
  if (count > 0 && !force) return false;
  if (force) {
    await query('TRUNCATE shift_handover_items, shift_handovers, shifts, packages, vehicles RESTART IDENTITY CASCADE');
  }

  const plate = () => `沪A·${String(rand(10000, 99999))}`;
  const base = (route, status, extra = {}) => ({
    plate_no: plate(),
    route_code: route.code,
    driver_name: pick(DRIVERS),
    status,
    planned_arrival: null, planned_departure: null,
    arrived_at: null, unload_start_at: null, unload_end_at: null,
    sort_start_at: null, sort_end_at: null, departed_at: null,
    ...extra,
  });

  const vehicles = [];
  const R = ROUTES;

  // ── 已发车（完整生命周期，历史班次）──
  for (let i = 0; i < 3; i++) {
    const arrived = minutesAgo(rand(300, 480));
    vehicles.push([base(R[i], 'departed', {
      planned_arrival: minutesAgo(rand(300, 480)),
      planned_departure: minutesAgo(rand(60, 120)),
      arrived_at: arrived,
      unload_start_at: new Date(arrived.getTime() + 5 * 60_000),
      unload_end_at: new Date(arrived.getTime() + 25 * 60_000),
      sort_start_at: new Date(arrived.getTime() + 30 * 60_000),
      sort_end_at: new Date(arrived.getTime() + 80 * 60_000),
      departed_at: new Date(arrived.getTime() + rand(100, 150) * 60_000),
    }), 'departed', rand(35, 55)]);
  }

  // ── 待发车（分拣已完成）── 其中一辆已超过计划发车时间 → 触发发车超时预警
  vehicles.push([base(R[3], 'sorted', {
    planned_arrival: minutesAgo(150), planned_departure: minutesAgo(20), // 已超计划发车
    arrived_at: minutesAgo(140), unload_start_at: minutesAgo(135), unload_end_at: minutesAgo(110),
    sort_start_at: minutesAgo(105), sort_end_at: minutesAgo(50),
  }), 'sorted', 42]);
  vehicles.push([base(R[4], 'sorted', {
    planned_arrival: minutesAgo(120), planned_departure: minutesFromNow(40),
    arrived_at: minutesAgo(115), unload_start_at: minutesAgo(110), unload_end_at: minutesAgo(85),
    sort_start_at: minutesAgo(80), sort_end_at: minutesAgo(30),
  }), 'sorted', 38]);

  // ── 分拣中 ── 其中一辆分拣严重超时
  vehicles.push([base(R[5], 'sorting', {
    planned_arrival: minutesAgo(200), planned_departure: minutesFromNow(30),
    arrived_at: minutesAgo(195), unload_start_at: minutesAgo(190), unload_end_at: minutesAgo(160),
    sort_start_at: minutesAgo(150), // 分拣已进行 150 分钟 → 超时
  }), 'sorting', 50]);
  vehicles.push([base(R[6], 'sorting', {
    planned_arrival: minutesAgo(70), planned_departure: minutesFromNow(90),
    arrived_at: minutesAgo(65), unload_start_at: minutesAgo(60), unload_end_at: minutesAgo(40),
    sort_start_at: minutesAgo(35),
  }), 'sorting', 45]);

  // ── 已卸车待分拣 ── 卸完很久未开始分拣 → 分拣超时预警
  vehicles.push([base(R[7], 'unloaded', {
    planned_arrival: minutesAgo(130), planned_departure: minutesFromNow(60),
    arrived_at: minutesAgo(125), unload_start_at: minutesAgo(120), unload_end_at: minutesAgo(90),
  }), 'unloaded', 40]);

  // ── 卸车中 ── 其中一辆卸车超时
  vehicles.push([base(R[0], 'unloading', {
    planned_arrival: minutesAgo(80), planned_departure: minutesFromNow(70),
    arrived_at: minutesAgo(75), unload_start_at: minutesAgo(70), // 卸车 70 分钟未完成 → 超时
  }), 'unloading', 48]);
  vehicles.push([base(R[1], 'unloading', {
    planned_arrival: minutesAgo(20), planned_departure: minutesFromNow(150),
    arrived_at: minutesAgo(18), unload_start_at: minutesAgo(15),
  }), 'unloading', 44]);

  // ── 已到车未卸车 ── 到车很久没开始卸车 → 卸车超时预警
  vehicles.push([base(R[2], 'arrived', {
    planned_arrival: minutesAgo(50), planned_departure: minutesFromNow(120),
    arrived_at: minutesAgo(45),
  }), 'arrived', 40]);

  // ── 待到车（预报）──
  vehicles.push([base(R[3], 'expected', {
    planned_arrival: minutesFromNow(30), planned_departure: minutesFromNow(180),
  }), 'expected', 0]);
  vehicles.push([base(R[5], 'expected', {
    planned_arrival: minutesFromNow(90), planned_departure: minutesFromNow(240),
  }), 'expected', 0]);

  for (const [v, stage, pkgCount] of vehicles) {
    const id = await insertVehicle(v);
    if (pkgCount > 0) await insertPackages(id, pkgCount, stage);
  }

  await seedShiftsAndHandover();

  const [v] = await query('SELECT COUNT(*)::int AS c FROM vehicles');
  const [p] = await query('SELECT COUNT(*)::int AS c FROM packages');
  console.log(`[seed] 已生成模拟数据：车辆 ${v.c} 辆，包裹 ${p.c} 件`);
  return true;
}

// 班次与一份历史交接单（演示跨班次追溯链与"退回仍归原班"）
async function seedShiftsAndHandover() {
  // 以本地日历生成班次：白班/中班/夜班
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const atToday = (h, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const nightStart = new Date(yesterday);
  nightStart.setHours(22, 0, 0, 0);
  const nightEnd = new Date();
  nightEnd.setHours(6, 0, 0, 0);

  const dayStart = atToday(8), dayEnd = atToday(16);
  const swingStart = atToday(16), swingEnd = atToday(24, 0);

  const shiftRows = await query(
    `INSERT INTO shifts (name, shift_code, work_date, start_at, end_at)
     VALUES
       ('夜班', 'night', $1::date, $2, $3),
       ('白班', 'day',   $4::date, $5, $6),
       ('中班', 'swing', $4::date, $7, $8)
     ON CONFLICT (work_date, shift_code) DO NOTHING
     RETURNING id, name, shift_code, work_date`,
    [ymd(yesterday), nightStart, nightEnd,
     ymd(new Date()), dayStart, dayEnd, swingStart, swingEnd]
  );

  // 强制重置时若 ON CONFLICT 未返回行（表被 TRUNCATE 但序列/约束竞态），补查一次
  let dayShift = shiftRows.find((s) => s.shift_code === 'day');
  let swingShift = shiftRows.find((s) => s.shift_code === 'swing');
  if (!dayShift || !swingShift) {
    const rows = await query(`SELECT id, name, shift_code FROM shifts WHERE work_date = $1::date`, [ymd(new Date())]);
    dayShift = dayShift || rows.find((s) => s.shift_code === 'day');
    swingShift = swingShift || rows.find((s) => s.shift_code === 'swing');
  }
  if (!dayShift || !swingShift) return;

  // 历史交接单：白班 → 中班（数小时前已签收）
  const signedAt = new Date(Date.now() - 3 * 3600_000);
  const doc = await query(
    `INSERT INTO shift_handovers
       (handover_no, shift_id, to_shift_id, status, summary_note, created_by, created_at, submitted_at, signed_by, signed_at)
     VALUES ($1,$2,$3,'signed','白班作业正常，分拣超时车辆需中班重点跟进；违禁品件待客服回复。','李建国',$4,$4,'赵晓敏',$4)
     RETURNING id`,
    [`JD-${ymd(new Date()).replace(/-/g, '')}-001`, dayShift.id, swingShift.id, signedAt]
  );
  const handoverId = doc[0].id;

  // 选取当前仍在场的真实车辆/包裹/超时事项写入历史快照，保证追溯链能串到现场数据
  const liveVehicles = await query(
    `SELECT * FROM vehicles WHERE status IN ('sorting','unloading','sorted') ORDER BY id LIMIT 3`
  );
  const livePkgs = await query(
    `SELECT * FROM packages WHERE status IN ('pending','sorted') ORDER BY id LIMIT 4`
  );
  const liveIntercept = await query(
    `SELECT * FROM packages WHERE status = 'intercepted' ORDER BY intercepted_at DESC LIMIT 1`
  );

  let seq = 0;
  const insertItem = async (type, key, refId, title, subtitle, detail, snapshot, status, decisionNote = null) => {
    seq += 1;
    await query(
      `INSERT INTO shift_handover_items
         (handover_id, item_type, item_key, ref_id, title, subtitle, detail, snapshot,
          status, decision_note, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [handoverId, type, key, refId, title, subtitle, detail, JSON.stringify(snapshot),
       status, decisionNote, '赵晓敏', status === 'pending' ? null : signedAt]
    );
  };

  for (const v of liveVehicles) {
    // 分拣超时的那辆退回（仍归白班），其余中班接收
    const isTimeoutSorting = v.status === 'sorting';
    await insertItem(
      'vehicle', `veh:${v.id}`, v.id,
      `${v.plate_no} · ${v.route_code}`,
      isTimeoutSorting ? '分拣中' : v.status,
      isTimeoutSorting ? '分拣时长异常，需持续跟进' : '正常在途作业',
      v,
      isTimeoutSorting ? 'returned' : 'accepted',
      isTimeoutSorting ? '该车辆分拣责任由白班继续跟进至完成' : null
    );
  }
  for (const p of livePkgs) {
    await insertItem(
      'package', `pkg:${p.id}`, p.id,
      p.tracking_no, `待处理 · ${p.destination}`,
      p.vehicle_id ? '在车上待分拣' : '未分配车辆',
      p, 'accepted'
    );
  }
  for (const p of liveIntercept) {
    await insertItem(
      'intercept', `itc:${p.id}`, p.id,
      p.tracking_no, `${p.abnormal_type} · ${p.destination}`,
      p.abnormal_note || '等待客服确认处理方案',
      p, 'accepted'
    );
  }
}

// 直接运行: node src/seed.js [--force]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { initSchema } = await import('./schema.js');
  await initSchema();
  const done = await seedIfEmpty(process.argv.includes('--force'));
  if (!done) console.log('[seed] 已有数据，跳过（使用 --force 重新生成）');
  process.exit(0);
}
