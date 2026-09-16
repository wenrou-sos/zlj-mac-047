// 本地模拟数据：生成车辆班次 + 包裹 + 格口与分拣规则，覆盖各种业务状态（含超时、异常场景）
import { query } from './db.js';
import { evaluate } from './sorting.js';

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

// 格口与分拣规则（发布版 v1）
const CHUTES = [
  ['A01', '华东向（上海/苏州）'],
  ['A02', '苏浙向（南京/杭州）'],
  ['A03', '北京向'],
  ['A04', '华南向（广州/深圳）'],
  ['A05', '西南向（成都/重庆）'],
  ['A06', '华中向（武汉/长沙）'],
  ['A07', '西北向（西安）'],
  ['B01', '大件格口（超重件）'],
  ['C02', '备用格口（设备维护中）', 'disabled'],
];
// [priority, destination(null=任意), minWeight, maxWeight, chuteCode]
const RULES = [
  [5,   null,   20,   null, 'B01'], // 超重件优先进大件格口
  [10,  '上海', null, null, 'A01'],
  [10,  '苏州', null, null, 'A01'],
  [10,  '南京', null, null, 'A02'],
  [10,  '杭州', null, null, 'A02'],
  [10,  '北京', null, null, 'A03'],
  [10,  '广州', null, null, 'A04'],
  [10,  '深圳', null, null, 'A04'],
  [10,  '成都', null, null, 'A05'],
  [10,  '重庆', null, null, 'A05'],
  [10,  '武汉', null, null, 'A06'],
  [10,  '长沙', null, null, 'A06'],
  [10,  '西安', null, null, 'A07'],
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

// 灌入格口与发布版规则（幂等：已有格口则跳过，供老库升级）
async function seedChutesAndRules() {
  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM chutes');
  if (count > 0) {
    const [version] = await query(`SELECT * FROM rule_versions WHERE status = 'published' LIMIT 1`);
    if (!version) return null;
    const rules = await query(
      `SELECT r.*, c.code AS chute_code, c.name AS chute_name, c.status AS chute_status
       FROM sort_rules r JOIN chutes c ON c.id = r.chute_id WHERE r.version_id = $1
       ORDER BY r.priority, r.id`,
      [version.id]
    );
    return { version, rules };
  }

  const chuteIds = {};
  for (const [code, name, status] of CHUTES) {
    const rows = await query(
      `INSERT INTO chutes (code, name, status, disabled_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [code, name, status || 'active', status === 'disabled' ? minutesAgo(600) : null]
    );
    chuteIds[code] = rows[0].id;
  }
  const [version] = await query(
    `INSERT INTO rule_versions (version_no, status, published_at) VALUES (1, 'published', NOW()) RETURNING *`
  );
  for (const [priority, destination, minW, maxW, chuteCode] of RULES) {
    await query(
      `INSERT INTO sort_rules (version_id, priority, destination, min_weight, max_weight, chute_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [version.id, priority, destination, minW, maxW, chuteIds[chuteCode]]
    );
  }
  const rules = await query(
    `SELECT r.*, c.code AS chute_code, c.name AS chute_name, c.status AS chute_status
     FROM sort_rules r JOIN chutes c ON c.id = r.chute_id WHERE r.version_id = $1
     ORDER BY r.priority, r.id`,
    [version.id]
  );
  console.log(`[seed] 已生成格口 ${CHUTES.length} 个、分拣规则 ${RULES.length} 条（发布版 v1）`);
  return { version, rules };
}

async function insertPackages(vehicleId, count, stage, ruleCtx) {
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
    const destination = pick(DESTINATIONS);
    const weight = (rand(1, 3000) / 100).toFixed(2);

    // 已分拣/已装车：按发布版规则写入当时的格口与规则版本快照
    let chuteId = null, ruleId = null, ruleVersionId = null, hitReason = null;
    if (sortedAt && ruleCtx) {
      const d = evaluate({ destination, weight_kg: weight }, ruleCtx.version, ruleCtx.rules);
      if (d.outcome === 'routed') {
        chuteId = d.chute.id;
        ruleId = d.rule.id;
        ruleVersionId = ruleCtx.version.id;
        hitReason = d.reason;
      }
    }
    // 少量待分拣包裹落在待判区（冲突/无匹配的历史遗留）
    const needsReview = status === 'pending' && !abnormal && Math.random() < 0.06;
    if (needsReview) {
      hitReason = pick([
        '没有匹配的分拣规则',
        '规则冲突：多条规则优先级相同且均匹配，需人工判定',
      ]);
    }

    const type = abnormal ? pickAbnormalType() : null;
    await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, status,
        is_abnormal, abnormal_type, abnormal_note, intercepted_at, sorted_at, created_at,
        chute_id, rule_id, rule_version_id, hit_reason, needs_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        nextTrackingNo(), vehicleId, destination, weight,
        abnormal ? 'intercepted' : status,
        abnormal, type, abnormal ? abnormalNote(type) : null,
        abnormal ? minutesAgo(rand(10, 120)) : null,
        sortedAt, minutesAgo(rand(60, 600)),
        chuteId, ruleId, ruleVersionId, hitReason, needsReview,
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
  if (force) {
    await query('TRUNCATE packages, vehicles, sort_rules, rule_versions, chutes RESTART IDENTITY');
  }
  // 格口与规则独立灌入：老库升级时即使已有车辆包裹数据，也能补上规则基础数据
  const ruleCtx = await seedChutesAndRules();

  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM vehicles');
  if (count > 0 && !force) return false;

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
    if (pkgCount > 0) await insertPackages(id, pkgCount, stage, ruleCtx);
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
