// 本地模拟数据：生成车辆班次 + 包裹 + 异常处置工单，覆盖各种业务状态（含超时、异常场景）
import { query } from './db.js';
import { CONCLUSION_LABEL } from './helpers.js';

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
const STAFF = ['王芳', '李强', '赵敏', '陈晨', '刘佳', '周涛'];
const RETURN_DESTS = ['退回发件人', '退回始发分拨中心', '退回寄件网点'];
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

// 工单场景：open待认领 / processing处理中 / pending_review待复核
//          closed_repair修复放行 / closed_return退回 / closed_isolate继续隔离
function pickScenario() {
  const r = Math.random();
  if (r < 0.30) return 'open';
  if (r < 0.55) return 'processing';
  if (r < 0.70) return 'pending_review';
  if (r < 0.85) return 'closed_repair';
  if (r < 0.93) return 'closed_return';
  return 'closed_isolate';
}

// 生成一张工单及其完整流转留档（interceptedAt 为拦截时间，事件时间顺推）
async function insertWorkOrderFlow(packageId, type, note, scenario, interceptedAt, returnDestination) {
  const creator = pick(STAFF);
  const assignee = pick(STAFF);
  const reviewer = pick(STAFF.filter((s) => s !== assignee));
  const at = (m) => new Date(interceptedAt.getTime() + m * 60_000);

  const claimed = scenario !== 'open';
  const submitted = ['pending_review', 'closed_repair', 'closed_return', 'closed_isolate'].includes(scenario);
  const closed = scenario.startsWith('closed_');
  const conclusion = closed
    ? { closed_repair: 'repair_release', closed_return: 'return', closed_isolate: 'isolate' }[scenario]
    : submitted ? pick(['repair_release', 'return', 'isolate']) : null;
  // 部分结案工单曾被打回补充证据
  const rejected = closed && Math.random() < 0.4;

  const status = closed ? 'closed' : submitted ? 'pending_review' : claimed ? 'processing' : 'open';
  const claimedAt = claimed ? at(5) : null;
  const submittedAt = submitted ? at(rejected ? 55 : 35) : null;
  const reviewedAt = closed || rejected ? at(rejected ? 80 : 55) : null;
  const closedAt = closed ? reviewedAt : null;

  const [wo] = await query(
    `INSERT INTO work_orders (package_id, abnormal_type, note, status, conclusion, conclusion_note,
       return_destination, created_by, assignee, submitted_by, reviewed_by, review_note, reject_count,
       claimed_at, submitted_at, reviewed_at, closed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [
      packageId, type, note, status, conclusion,
      submitted ? '现场处置完毕，申请结案' : null,
      conclusion === 'return' ? returnDestination || pick(RETURN_DESTS) : null,
      creator, claimed ? assignee : null, submitted ? assignee : null,
      closed || rejected ? reviewer : null,
      closed ? '复核通过' : rejected ? '证据不足，补充后重新提交' : null,
      rejected ? 1 : 0,
      claimedAt, submittedAt, reviewedAt, closedAt, interceptedAt,
    ]
  );

  const events = [['create', creator, `拦截登记：${note}`, interceptedAt]];
  if (claimed) events.push(['claim', assignee, `${assignee} 认领了工单`, at(5)]);
  if (claimed && Math.random() < 0.6) {
    events.push(['evidence', assignee, '现场照片 2 张，异常位置已标注', at(15)]);
  }
  if (rejected) {
    events.push(['submit', assignee, `提交结论：${CONCLUSION_LABEL[conclusion]}`, at(25)]);
    events.push(['reject', reviewer, '复核驳回：证据不足，补充后重新提交', at(40)]);
    events.push(['evidence', assignee, '补充称重记录与监控截图', at(50)]);
  }
  if (submitted) {
    events.push(['submit', assignee, `提交结论：${CONCLUSION_LABEL[conclusion]}（现场处置完毕，申请结案）`, submittedAt]);
  }
  if (closed) {
    events.push(['approve', reviewer, `复核通过，结论「${CONCLUSION_LABEL[conclusion]}」已生效`, closedAt]);
  }
  for (const [action, actor, detail, ts] of events) {
    await query(
      'INSERT INTO work_order_events (work_order_id, action, actor, detail, created_at) VALUES ($1,$2,$3,$4,$5)',
      [wo.id, action, actor, detail, ts]
    );
  }
}

// 异常包裹：按工单场景决定包裹当前状态，并生成对应工单
async function insertAbnormalPackage(vehicleId, stage) {
  const type = pickAbnormalType();
  const note = abnormalNote(type);
  const scenario = pickScenario();
  const createdAt = minutesAgo(rand(60, 600));

  let status = 'intercepted';
  let isAbnormal = true;
  let sortedAt = null;
  let releasedAt = null;
  let returnedAt = null;
  let returnDestination = null;
  let interceptedAt;

  if (scenario === 'closed_repair') {
    // 修复放行：包裹已恢复正常流转
    interceptedAt = minutesAgo(rand(150, 400));
    releasedAt = minutesAgo(rand(30, 140));
    status = stage === 'departed' ? 'loaded' : Math.random() < 0.6 ? 'sorted' : 'pending';
    if (status !== 'pending') sortedAt = releasedAt;
    isAbnormal = false;
  } else if (scenario === 'closed_return') {
    // 退回：独立去向，退出正常待发库存
    interceptedAt = minutesAgo(rand(150, 400));
    status = 'returned';
    returnDestination = pick(RETURN_DESTS);
    returnedAt = minutesAgo(rand(30, 140));
  } else if (scenario === 'closed_isolate') {
    interceptedAt = minutesAgo(rand(150, 400));
  } else if (scenario === 'pending_review') {
    interceptedAt = minutesAgo(rand(60, 200));
  } else if (scenario === 'processing') {
    interceptedAt = minutesAgo(rand(30, 150));
  } else {
    interceptedAt = minutesAgo(rand(5, 90));
  }

  const [pkg] = await query(
    `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, status,
      is_abnormal, abnormal_type, abnormal_note, intercepted_at, intercept_released_at,
      return_destination, returned_at, sorted_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      nextTrackingNo(), vehicleId, pick(DESTINATIONS), (rand(1, 3000) / 100).toFixed(2),
      status, isAbnormal, type, note, interceptedAt, releasedAt,
      returnDestination, returnedAt, sortedAt, createdAt,
    ]
  );
  await insertWorkOrderFlow(pkg.id, type, note, scenario, interceptedAt, returnDestination);
}

async function insertPackages(vehicleId, count, stage) {
  // stage 决定包裹状态分布
  for (let i = 0; i < count; i++) {
    if (Math.random() < 0.05) {
      await insertAbnormalPackage(vehicleId, stage);
      continue;
    }
    let status = 'pending';
    let sortedAt = null;
    if (stage === 'departed') status = 'loaded';
    else if (stage === 'sorted') status = Math.random() < 0.7 ? 'loaded' : 'sorted';
    else if (stage === 'sorting') status = Math.random() < 0.5 ? 'sorted' : 'pending';
    if (status === 'sorted' || status === 'loaded') {
      sortedAt = minutesAgo(rand(5, 90));
    }
    await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, status, sorted_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        nextTrackingNo(), vehicleId, pick(DESTINATIONS), (rand(1, 3000) / 100).toFixed(2),
        status, sortedAt, minutesAgo(rand(60, 600)),
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
    await query('TRUNCATE packages, vehicles, work_orders, work_order_events RESTART IDENTITY');
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

  // 同一包裹多次异常分别留档：为部分拦截中的包裹补一条更早的已结案工单
  const intercepted = await query(
    `SELECT id, intercepted_at FROM packages WHERE status = 'intercepted' ORDER BY id LIMIT 3`
  );
  for (const p of intercepted) {
    const earlier = new Date(new Date(p.intercepted_at).getTime() - rand(150, 400) * 60_000);
    await insertWorkOrderFlow(p.id, pickAbnormalType(), '历史异常，已修复放行', 'closed_repair', earlier, null);
  }

  const [v] = await query('SELECT COUNT(*)::int AS c FROM vehicles');
  const [p] = await query('SELECT COUNT(*)::int AS c FROM packages');
  const [w] = await query('SELECT COUNT(*)::int AS c FROM work_orders');
  console.log(`[seed] 已生成模拟数据：车辆 ${v.c} 辆，包裹 ${p.c} 件，工单 ${w.c} 张`);
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
