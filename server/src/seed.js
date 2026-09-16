// 本地模拟数据：生成车辆班次 + 包裹，覆盖各种业务状态（含超时、异常场景）
import { query } from './db.js';
import { findCandidates, computeCutoff } from './helpers.js';

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

async function insertPackages(vehicleId, count, stage, destPool = DESTINATIONS) {
  // stage 决定包裹状态分布
  // sorted-out：出港班次级件以前两个目的地（线路承运城市）为主，确保能演示按目的地归集与溢出
  const primary = stage === 'sorted-out' && destPool.length >= 2 ? destPool.slice(0, 2) : null;
  const pickDest = () => {
    if (primary && Math.random() < 0.85) return pick(primary);
    return pick(destPool);
  };
  for (let i = 0; i < count; i++) {
    const abnormal = Math.random() < 0.05;
    let status = 'pending';
    let sortedAt = null;
    let loadedAt = null;
    if (!abnormal) {
      if (stage === 'departed') status = 'loaded';
      else if (stage === 'sorted') status = Math.random() < 0.7 ? 'loaded' : 'sorted';
      else if (stage === 'sorted-out') status = Math.random() < 0.92 ? 'sorted' : 'pending';
      else if (stage === 'sorting') status = Math.random() < 0.5 ? 'sorted' : 'pending';
    }
    if (status === 'sorted' || status === 'loaded') {
      sortedAt = minutesAgo(rand(5, 90));
    }
    if (status === 'loaded') {
      loadedAt = new Date(sortedAt.getTime() + rand(2, 20) * 60_000);
    }
    const type = abnormal ? pickAbnormalType() : null;
    await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, status,
        is_abnormal, abnormal_type, abnormal_note, intercepted_at, sorted_at, loaded_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        nextTrackingNo(), vehicleId, pickDest(), (rand(500, 9000) / 100).toFixed(2),
        abnormal ? 'intercepted' : status,
        abnormal, type, abnormal ? abnormalNote(type) : null,
        abnormal ? minutesAgo(rand(10, 120)) : null,
        sortedAt, loadedAt, minutesAgo(rand(60, 600)),
      ]
    );
  }
}

// 为出港班次建立配载单：自动按目的地/截单/载重分配，装不下的留待下一班
async function seedLoadPlan(vehicle, { destination, capacityKg, sealed }) {
  // 种子演示：用计划发车前的时间视角取候选（模拟调度在截单前完成了配载）
  const viewTime = vehicle.planned_departure
    ? new Date(Math.min(Date.now() - 60_000, new Date(vehicle.planned_departure).getTime() - 31 * 60_000))
    : new Date();
  const candidates = await findCandidates(vehicle, { destination, limitKg: capacityKg, now: viewTime });
  if (!candidates.length) return null;
  const cutoff = await computeCutoff(vehicle);
  const [r] = await query(`SELECT COUNT(*)::int AS c FROM load_plans`);
  const planNo = `LPSEED-${String(r.c + 1).padStart(3, '0')}`;
  const [plan] = await query(
    `INSERT INTO load_plans (plan_no, vehicle_id, destination, cutoff_at, capacity_kg, status, created_by, sealed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'seed',$7) RETURNING *`,
    [planNo, vehicle.id, destination, cutoff, capacityKg, sealed ? 'sealed' : 'draft', sealed ? new Date() : null]
  );
  for (const p of candidates) {
    await query(
      `INSERT INTO load_plan_items (plan_id, package_id, added_by) VALUES ($1,$2,'auto')
       ON CONFLICT (plan_id, package_id) DO NOTHING`,
      [plan.id, p.id]
    );
  }
  return plan;
}

async function insertVehicle(v) {
  const res = await query(
    `INSERT INTO vehicles (plate_no, route_code, driver_name, planned_arrival, planned_departure,
      arrived_at, unload_start_at, unload_end_at, sort_start_at, sort_end_at, departed_at, status,
      capacity_kg, cutoff_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [v.plate_no, v.route_code, v.driver_name, v.planned_arrival, v.planned_departure,
     v.arrived_at, v.unload_start_at, v.unload_end_at, v.sort_start_at, v.sort_end_at,
     v.departed_at, v.status, v.capacity_kg ?? 8000, v.cutoff_min ?? null]
  );
  // 按线路编码回填可达目的地
  const map = { SH: '上海', GZ: '广州', SZ: '深圳', BJ: '北京', CQ: '重庆', CS: '长沙',
    HZ: '杭州', LZ: '兰州', XA: '西安', NJ: '南京', WH: '武汉', CD: '成都' };
  const [from, to] = v.route_code.split('-');
  const dests = [...new Set([map[to], map[from]].filter(Boolean))];
  if (dests.length) await query(`UPDATE vehicles SET destinations = $1 WHERE id = $2`, [dests, res[0].id]);
  return res[0].id;
}

export async function seedIfEmpty(force = false) {
  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM vehicles');
  if (count > 0 && !force) return false;
  if (force) {
    await query('TRUNCATE load_plan_items, load_plans, packages, vehicles RESTART IDENTITY CASCADE');
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
    capacity_kg: rand(60, 120) * 100,  // 6000~12000kg 额定载重
    cutoff_min: 30,
    ...extra,
  });
  // 线路可达目的地：终点 + 沿途/回程城市
  const destOf = (route, ...extra) => [route.to, ...extra];

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
    }), 'departed', rand(35, 55), destOf(R[i], pick(DESTINATIONS))]);
  }

  // ── 待发车（分拣已完成）── 其中一辆已超过计划发车时间 → 触发发车超时预警
  // 出港班次：包裹目的地以线路终点为主，便于演示配载按目的地归集
  vehicles.push([base(R[3], 'sorted', {
    planned_arrival: minutesAgo(150), planned_departure: minutesAgo(20), // 已超计划发车
    arrived_at: minutesAgo(140), unload_start_at: minutesAgo(135), unload_end_at: minutesAgo(110),
    sort_start_at: minutesAgo(105), sort_end_at: minutesAgo(50),
  }), 'sorted-out', 60, destOf(R[3], '天津', '济南')]);
  vehicles.push([base(R[4], 'sorted', {
    planned_arrival: minutesAgo(120), planned_departure: minutesFromNow(40),
    arrived_at: minutesAgo(115), unload_start_at: minutesAgo(110), unload_end_at: minutesAgo(85),
    sort_start_at: minutesAgo(80), sort_end_at: minutesAgo(30),
  }), 'sorted-out', 56, destOf(R[4], '贵阳', '昆明')]);

  // ── 分拣中 ── 其中一辆分拣严重超时
  vehicles.push([base(R[5], 'sorting', {
    planned_arrival: minutesAgo(200), planned_departure: minutesFromNow(30),
    arrived_at: minutesAgo(195), unload_start_at: minutesAgo(190), unload_end_at: minutesAgo(160),
    sort_start_at: minutesAgo(150), // 分拣已进行 150 分钟 → 超时
  }), 'sorting', 50, DESTINATIONS]);
  vehicles.push([base(R[6], 'sorting', {
    planned_arrival: minutesAgo(70), planned_departure: minutesFromNow(90),
    arrived_at: minutesAgo(65), unload_start_at: minutesAgo(60), unload_end_at: minutesAgo(40),
    sort_start_at: minutesAgo(35),
  }), 'sorting', 45, DESTINATIONS]);

  // ── 已卸车待分拣 ── 卸完很久未开始分拣 → 分拣超时预警
  vehicles.push([base(R[7], 'unloaded', {
    planned_arrival: minutesAgo(130), planned_departure: minutesFromNow(60),
    arrived_at: minutesAgo(125), unload_start_at: minutesAgo(120), unload_end_at: minutesAgo(90),
  }), 'unloaded', 40, DESTINATIONS]);

  // ── 卸车中 ── 其中一辆卸车超时
  vehicles.push([base(R[0], 'unloading', {
    planned_arrival: minutesAgo(80), planned_departure: minutesFromNow(70),
    arrived_at: minutesAgo(75), unload_start_at: minutesAgo(70), // 卸车 70 分钟未完成 → 超时
  }), 'unloading', 48, DESTINATIONS]);
  vehicles.push([base(R[1], 'unloading', {
    planned_arrival: minutesAgo(20), planned_departure: minutesFromNow(150),
    arrived_at: minutesAgo(18), unload_start_at: minutesAgo(15),
  }), 'unloading', 44, DESTINATIONS]);

  // ── 已到车未卸车 ── 到车很久没开始卸车 → 卸车超时预警
  vehicles.push([base(R[2], 'arrived', {
    planned_arrival: minutesAgo(50), planned_departure: minutesFromNow(120),
    arrived_at: minutesAgo(45),
  }), 'arrived', 40, DESTINATIONS]);

  // ── 待到车（预报）──
  vehicles.push([base(R[3], 'expected', {
    planned_arrival: minutesFromNow(30), planned_departure: minutesFromNow(180),
  }), 'expected', 0, DESTINATIONS]);
  vehicles.push([base(R[5], 'expected', {
    planned_arrival: minutesFromNow(90), planned_departure: minutesFromNow(240),
  }), 'expected', 0, DESTINATIONS]);

  const outVehicles = {};
  for (const [v, stage, pkgCount, destPool] of vehicles) {
    const id = await insertVehicle(v);
    if (pkgCount > 0) await insertPackages(id, pkgCount, stage, destPool || DESTINATIONS);
    if (stage === 'sorted-out') outVehicles[v.route_code] = id;
  }

  // ── 出港配载单演示 ──────────────────────────────────────────────
  // 待发车班次的包裹以 sorted 为主（insertPackages 对 'sorted-out' 不造 loaded 件）
  const fullVehicles = await query(
    `SELECT * FROM vehicles WHERE id = ANY($1::int[]) ORDER BY id`,
    [Object.values(outVehicles)]
  );
  for (const [idx, v] of fullVehicles.entries()) {
    const route = ROUTES.find((r) => r.code === v.route_code);
    const cap = Number(v.capacity_kg);
    // 主单：线路终点，草稿态，小容量 → 部分件装不下、留待下一班
    await seedLoadPlan(v, { destination: route.to, capacityKg: Math.round(cap * 0.12), sealed: false });
    // 第二张：同车承运的回程城市，封车态（演示发车前已锁定的单）
    if (v.destinations?.length > 1) {
      const second = v.destinations.find((d) => d !== route.to);
      await seedLoadPlan(v, { destination: second, capacityKg: Math.round(cap * 0.1), sealed: idx % 2 === 1 });
    }
  }

  const [v] = await query('SELECT COUNT(*)::int AS c FROM vehicles');
  const [p] = await query('SELECT COUNT(*)::int AS c FROM packages');
  console.log(`[seed] 已生成模拟数据：车辆 ${v.c} 辆，包裹 ${p.c} 件`);
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
