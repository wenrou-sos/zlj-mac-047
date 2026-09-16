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
    // 事件表通过外键引用 vehicles，必须一同清空；settings 重置为 schema.sql 中的默认值
    await query('TRUNCATE alert_event_logs, alert_events, packages, vehicles, settings_history, settings RESTART IDENTITY');
    await query(
      `INSERT INTO settings (key, value) VALUES
        ('unload_timeout_min', 30), ('sort_timeout_min', 60), ('warn_ratio', 0.8),
        ('response_timeout_min', 15), ('escalation_grace_min', 15)
       ON CONFLICT (key) DO NOTHING`
    );
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

  // ── 已卸车待分拣 ── 卸完后即将到分拣时限 → 黄色预警，待认领
  vehicles.push([base(R[7], 'unloaded', {
    planned_arrival: minutesAgo(75), planned_departure: minutesFromNow(60),
    arrived_at: minutesAgo(70), unload_start_at: minutesAgo(65), unload_end_at: minutesAgo(55),
  }), 'unloaded', 40]);

  // ── 卸车中 ── 其中一辆刚跨过卸车时限（红色，已有人认领，尚在宽限期内）
  vehicles.push([base(R[0], 'unloading', {
    planned_arrival: minutesAgo(40), planned_departure: minutesFromNow(120),
    arrived_at: minutesAgo(34), unload_start_at: minutesAgo(32),
  }), 'unloading', 48]);
  vehicles.push([base(R[1], 'unloading', {
    planned_arrival: minutesAgo(30), planned_departure: minutesFromNow(150),
    arrived_at: minutesAgo(26), unload_start_at: minutesAgo(24), // 24 分钟达预警线 → 黄色待认领
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

  const insertedIds = [];
  for (const [v, stage, pkgCount] of vehicles) {
    const id = await insertVehicle(v);
    if (pkgCount > 0) await insertPackages(id, pkgCount, stage);
    insertedIds.push(id);
  }
  // 车辆顺序与上面 vehicles.push 顺序一致
  const [d1, d2, d3, sortedOverdue, , sortOverdue, , sortStuck, unloadOverdue, , arrivedStuck] = insertedIds;

  // ── 已恢复的历史预警事件（演示「车辆恢复后结束事件、再次超时另起新事件」与台账）──
  const ruleSnap = { unload_timeout_min: 30, sort_timeout_min: 60, warn_ratio: 0.8,
    response_timeout_min: 15, escalation_grace_min: 15 };
  for (const vid of [d1, d2, d3]) {
    await insertRecoveredEvent(vid, 'unload', ruleSnap, 30);
    await insertRecoveredEvent(vid, 'sort', ruleSnap, 60);
  }

  // ── 当前未关闭事件：覆盖待认领 / 已认领跟进中 / 已升级主管（未认领、已认领已改派）/ 已处理待恢复 ──
  // ① 已升级主管：分拣严重超时，响应期内无人认领（车辆 sort_start 150 分钟前，超时 90 分钟）
  await insertOpenEvent(sortOverdue, 'sort', {
    status: 'escalated', threshold: 60,
    firstAt: minutesAgo(102), warnAt: minutesAgo(102), overdueAt: minutesAgo(90),
    escalatedAt: minutesAgo(87),
    reason: '触发后 15 分钟内无人确认，自动升级主管',
  }, ruleSnap, [
    ['trigger', 'system', '分拣预警首次触发（黄色，达时限 80%）'],
    ['overdue', 'system', '已超过分拣时限（60 分钟），升级为红色超时'],
    ['escalated', 'system', '触发后 15 分钟内无人确认，自动升级主管'],
  ]);

  // ② 已认领跟进中：卸车刚超红色时限，响应期内已确认，不升级
  await insertOpenEvent(unloadOverdue, 'unload', {
    status: 'open', threshold: 30, assigned: '王强',
    firstAt: minutesAgo(10), warnAt: minutesAgo(10), overdueAt: minutesAgo(4), ackAt: minutesAgo(8),
  }, ruleSnap, [
    ['trigger', 'system', '卸车预警首次触发（黄色，达时限 80%）'],
    ['overdue', 'system', '已超过卸车时限（30 分钟），升级为红色超时'],
    ['claim', '王强', '认领并确认处理'],
    ['comment', '王强', '叉车故障，已联系维修组支援，预计 20 分钟恢复'],
  ]);

  // ③ 已升级主管且已改派：超过计划发车时间，处理人确认后仍超时，宽限期到自动升级、主管改派
  await insertOpenEvent(sortedOverdue, 'departure', {
    status: 'escalated', threshold: 0, assigned: '赵磊',
    firstAt: minutesAgo(20), warnAt: minutesAgo(20), overdueAt: minutesAgo(20),
    ackAt: minutesAgo(19), escalatedAt: minutesAgo(5),
    reason: '超时后 15 分钟仍未恢复，主管督办',
  }, ruleSnap, [
    ['trigger', 'system', '发车超时首次触发（红色），规则快照已冻结'],
    ['overdue', 'system', '已超过计划发车时间'],
    ['claim', '李军', '认领并确认处理'],
    ['comment', '李军', '等待装车尾单，已与场站协调'],
    ['escalated', 'system', '超时后 15 分钟仍未恢复，主管督办'],
    ['reassign', '周斌', '改派给 赵磊（夜班主管周斌操作）'],
  ]);

  // ④ 已处理、待恢复：到车后久未卸车；已确认但车没恢复，仍留在待办直到真正恢复
  await insertOpenEvent(arrivedStuck, 'unload', {
    status: 'resolved', threshold: 30, assigned: '刘洋',
    firstAt: minutesAgo(41), warnAt: minutesAgo(41), overdueAt: minutesAgo(15), ackAt: minutesAgo(38),
    resolvedAt: minutesAgo(6), resolvedBy: '刘洋',
    closeNote: '已增派卸车组，等待车辆恢复',
  }, ruleSnap, [
    ['trigger', 'system', '卸车预警首次触发（黄色，达时限 80%）'],
    ['overdue', 'system', '已超过卸车时限（30 分钟），升级为红色超时'],
    ['claim', '刘洋', '认领并确认处理'],
    ['comment', '刘洋', '夜班人手不足，申请增援'],
    ['resolve', '刘洋', '已处理：已增派卸车组，等待车辆恢复'],
  ]);

  const [v] = await query('SELECT COUNT(*)::int AS c FROM vehicles');
  const [p] = await query('SELECT COUNT(*)::int AS c FROM packages');
  const [e] = await query('SELECT COUNT(*)::int AS c FROM alert_events');
  console.log(`[seed] 已生成模拟数据：车辆 ${v.c} 辆，包裹 ${p.c} 件，预警事件 ${e.c} 起`);
  return true;
}

// 插入一条已恢复的历史事件（配合演示车辆生命周期内可能多次触发、多次恢复）
const actor2 = () => pick(['张伟', '王强', '李军']);

async function insertRecoveredEvent(vehicleId, stage, snapshot, threshold) {
  const first = minutesAgo(rand(200, 420));                                   // 首次触发（80% 预警时刻）
  const deadline = new Date(first.getTime() + threshold * (1 - snapshot.warn_ratio) * 60_000); // 时限时刻
  const claim = new Date(first.getTime() + rand(2, 6) * 60_000);
  const recovered = new Date(deadline.getTime() + rand(8, 40) * 60_000);
  const handler = actor2();
  const rows = await query(
    `INSERT INTO alert_events
       (vehicle_id, stage, initial_level, status, rule_snapshot, threshold_min, due_at,
        first_triggered_at, warn_at, overdue_at, acknowledged_at, assigned_to,
        resolved_at, resolved_by, recovered_at, last_seen_at)
     VALUES ($1,$2,'warn','recovered',$3,$4,$5,$6,$6,$7,$8,$9,$10,$9,$11,$11)
     RETURNING id`,
    [vehicleId, stage, JSON.stringify(snapshot), threshold, deadline,
     first, deadline, claim, handler, recovered, recovered]
  );
  const eid = rows[0].id;
  const logRows = [
    ['trigger', 'system', '预警首次触发（黄色）', first],
    ['overdue', 'system', `超过 ${threshold} 分钟时限，红色超时`, deadline],
    ['claim', handler, '认领并确认处理', claim],
    ['resolve', handler, '已处理，等待车辆恢复', new Date(recovered.getTime() - 5 * 60_000)],
    ['recovered', handler, '条件消除，车辆恢复，事件关闭', recovered],
  ];
  for (const [action, actor, note, at] of logRows) {
    await query(
      `INSERT INTO alert_event_logs (event_id, action, actor, note, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [eid, action, actor, note, at]
    );
  }
}

// 插入一条未关闭事件（open / escalated / resolved）
async function insertOpenEvent(vehicleId, stage, e, snap, logs) {
  const due = stage === 'departure' ? e.firstAt
    : new Date(e.firstAt.getTime() + (e.threshold - e.threshold * snap.warn_ratio) * 60_000);
  const rows = await query(
    `INSERT INTO alert_events
       (vehicle_id, stage, initial_level, status, rule_snapshot, threshold_min, due_at,
        first_triggered_at, warn_at, overdue_at, acknowledged_at, assigned_to,
        escalated_at, escalation_reason, resolved_at, resolved_by, close_note, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     RETURNING id`,
    [vehicleId, stage, stage === 'departure' ? 'overdue' : 'warn', e.status,
     JSON.stringify(snap), e.threshold, due,
     e.firstAt, e.warnAt || null, e.overdueAt || null, e.ackAt || null, e.assigned || null,
     e.escalatedAt || null, e.reason || null, e.resolvedAt || null, e.resolvedBy || null,
     e.closeNote || null]
  );
  const eid = rows[0].id;
  for (const [action, actor, note] of logs) {
    const at = action === 'trigger' ? e.firstAt
      : action === 'overdue' ? (e.overdueAt || e.firstAt)
      : action === 'escalated' ? (e.escalatedAt || e.firstAt)
      : action === 'resolve' ? (e.resolvedAt || new Date())
      : action === 'claim' ? (e.ackAt || e.firstAt)
      : new Date();
    await query(
      `INSERT INTO alert_event_logs (event_id, action, actor, note, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [eid, action, actor, note, at]
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
