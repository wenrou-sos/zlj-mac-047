// 本地模拟数据：生成车辆班次 + 包裹，覆盖各种业务状态（含超时、异常、库位场景）
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
const STORAGE_CODES = ['A-01-01', 'A-01-02', 'A-02-01', 'B-01-01', 'B-01-02'];

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

async function codeToLocationId(code) {
  const [row] = await query('SELECT id FROM locations WHERE code = $1', [code]);
  return row.id;
}

async function insertPackages(vehicleId, vehicleLocationId, count, stage, locations) {
  // stage 决定包裹作业状态分布；异常件仍保留其原位置与作业生命周期，仅进入拦截处置
  for (let i = 0; i < count; i++) {
    const abnormal = Math.random() < 0.05;
    let status = 'pending';
    let sortedAt = null;
    let loadedAt = null;
    if (!abnormal) {
      if (stage === 'departed') status = 'loaded';
      else if (stage === 'sorted') status = Math.random() < 0.7 ? 'loaded' : 'sorted';
      else if (stage === 'sorting') status = Math.random() < 0.5 ? 'sorted' : 'pending';
    }
    if (status === 'sorted' || status === 'loaded') {
      sortedAt = minutesAgo(rand(5, 90));
    }
    if (status === 'loaded') {
      loadedAt = minutesAgo(rand(1, 40));
    }

    let locationCode = locations.sorting;
    if (abnormal) locationCode = status === 'sorted' ? pick(STORAGE_CODES) : locations.sorting;
    else if (status === 'sorted') locationCode = pick(STORAGE_CODES);
    else if (status === 'loaded') locationCode = null;

    const type = abnormal ? pickAbnormalType() : null;
    const locationId = status === 'loaded'
      ? vehicleLocationId
      : await codeToLocationId(locationCode);
    const createdAt = minutesAgo(rand(60, 600));

    await query(
      `INSERT INTO packages (
         tracking_no, vehicle_id, destination, weight_kg, status, intercept_status,
         is_abnormal, abnormal_type, abnormal_note, intercepted_at, current_location_id,
         sorted_at, loaded_at, created_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        nextTrackingNo(), vehicleId, pick(DESTINATIONS), (rand(1, 3000) / 100).toFixed(2),
        status, abnormal ? 'held' : 'none',
        abnormal, type, abnormal ? abnormalNote(type) : null,
        abnormal ? minutesAgo(rand(10, 120)) : null,
        locationId, sortedAt, loadedAt, createdAt,
      ]
    );
  }
}

async function insertVehicle(v) {
  const res = await query(
    `INSERT INTO vehicles (plate_no, route_code, driver_name, planned_arrival, planned_departure,
      arrived_at, unload_start_at, unload_end_at, sort_start_at, sort_end_at, departed_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [v.plate_no, v.route_code, v.driver_name, v.planned_arrival, v.planned_departure,
     v.arrived_at, v.unload_start_at, v.unload_end_at, v.sort_start_at, v.sort_end_at,
     v.departed_at, v.status]
  );
  const vehicleId = res[0].id;
  const loc = await query(
    `INSERT INTO locations (code, loc_type, zone, name, ref_id, is_active)
     VALUES ($1,'vehicle','车辆月台',$2,$3,TRUE)
     ON CONFLICT (ref_id) WHERE loc_type = 'vehicle'
     DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [`VEH-${vehicleId}`, `${v.plate_no}（车辆库位）`, String(vehicleId)]
  );
  const locationId = loc[0].id;
  await query('UPDATE vehicles SET current_location_id = $1 WHERE id = $2', [locationId, vehicleId]);
  return { vehicleId, locationId };
}

export async function seedIfEmpty(force = false) {
  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM vehicles');
  if (count > 0 && !force) return false;
  if (force) {
    await query(`TRUNCATE TABLE
      stocktake_differences, stocktake_scans, stocktake_snapshots, stocktakes,
      package_movements, packages, vehicles, locations
      RESTART IDENTITY CASCADE`);
  }
  await query(
    `INSERT INTO locations (code, loc_type, zone, name, capacity)
     SELECT v.code, v.loc_type, v.zone, v.name, v.capacity
     FROM (VALUES
       ('RECV-01','receiving','收货区','到件暂存区',300),
       ('SORT-01','sorting','分拣区','分拣作业区',300),
       ('HOLD-01','intercept','异常处理区','拦截件隔离区',100),
       ('LOST-01','lost','虚拟库位','盘亏/失踪虚拟库位',NULL::int),
       ('A-01-01','storage','A区01架','A区 01 架 01 层',80),
       ('A-01-02','storage','A区01架','A区 01 架 02 层',80),
       ('A-02-01','storage','A区02架','A区 02 架 01 层',80),
       ('B-01-01','storage','B区01架','B区 01 架 01 层',80),
       ('B-01-02','storage','B区01架','B区 01 架 02 层',80)
     ) AS v(code, loc_type, zone, name, capacity)
     WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.code = v.code)`
  );

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
    planned_arrival: minutesAgo(150), planned_departure: minutesAgo(20),
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
    sort_start_at: minutesAgo(150),
  }), 'sorting', 50]);
  vehicles.push([base(R[6], 'sorting', {
    planned_arrival: minutesAgo(70), planned_departure: minutesFromNow(90),
    arrived_at: minutesAgo(65), unload_start_at: minutesAgo(60), unload_end_at: minutesAgo(40),
    sort_start_at: minutesAgo(35),
  }), 'sorting', 45]);

  // ── 已卸车待分拣 ──
  vehicles.push([base(R[7], 'unloaded', {
    planned_arrival: minutesAgo(130), planned_departure: minutesFromNow(60),
    arrived_at: minutesAgo(125), unload_start_at: minutesAgo(120), unload_end_at: minutesAgo(90),
  }), 'unloaded', 40]);

  // ── 卸车中 ──
  vehicles.push([base(R[0], 'unloading', {
    planned_arrival: minutesAgo(80), planned_departure: minutesFromNow(70),
    arrived_at: minutesAgo(75), unload_start_at: minutesAgo(70),
  }), 'unloading', 48]);
  vehicles.push([base(R[1], 'unloading', {
    planned_arrival: minutesAgo(20), planned_departure: minutesFromNow(150),
    arrived_at: minutesAgo(18), unload_start_at: minutesAgo(15),
  }), 'unloading', 44]);

  // ── 已到车未卸车 ──
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

  const commonLocations = { sorting: 'SORT-01' };
  for (const [v, stage, pkgCount] of vehicles) {
    const { vehicleId, locationId } = await insertVehicle(v);
    if (pkgCount > 0) await insertPackages(vehicleId, locationId, pkgCount, stage, commonLocations);
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
