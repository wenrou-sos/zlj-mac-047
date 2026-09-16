// 手持扫描工作台路由
// - 断网期间手持端把到件/分拣/装车扫描暂存在本地，恢复网络后批量补传
// - 每条扫描带设备号、实际扫描时间、客户端幂等键 scan_id
// - 服务端以 scan_id 去重：同一条扫描无论补传多少次，只记账一次，重复请求回放首次结果
// - 补传时服务器状态已变化（包裹被拦截 / 班次已发车 / 状态已推进）→ 记为冲突并暂停，
//   绝不覆盖服务器新状态；由人工选择放弃（以服务器为准）、暂留或调整后重扫
import { Router } from 'express';
import { query, withTransaction } from '../db.js';

const router = Router();

const OPS = ['arrive', 'sort', 'load'];

// 冲突时可供手持端展示的处理选择
const CHOICES = {
  discard: { key: 'discard', label: '放弃本次扫描（以服务器当前状态为准）' },
  keep:    { key: 'keep',    label: '暂留，稍后人工处理' },
  retry:   { key: 'retry',   label: '调整后重新补扫' },
};

function pkgSummary(p, v) {
  return {
    package_id: p ? p.id : null,
    tracking_no: p?.tracking_no || null,
    status: p ? p.status : null,
    is_abnormal: p ? p.is_abnormal : null,
    abnormal_type: p?.abnormal_type || null,
    sorted_at: p?.sorted_at || null,
    loaded_at: p?.loaded_at || null,
    vehicle: v ? { id: v.id, plate_no: v.plate_no, route_code: v.route_code, status: v.status } : null,
  };
}

// 在事务内评估并记账一条扫描。返回该条扫描的逐条结果。
// 关键约定：
//  - 所有写操作都是「条件 UPDATE」，只在预期前置状态下生效，不会覆盖服务器新状态
//  - applied 与 ledger 插入在同一事务内提交；冲突也写台账（conflict 状态），便于回放幂等结果
async function processOne(q, s, now) {
  const { scan_id, device_id, op, tracking_no, occurred_at } = s;
  const payload = s.payload || {};
  const occurred = occurred_at || now;

  const invalid = (message) => ({
    scan_id, status: 'error', error_code: 'invalid', message, applied: false,
  });

  if (!scan_id || !device_id || !tracking_no || !OPS.includes(op)) {
    return invalid('扫描记录缺少必要字段（设备号/运单号/扫描类型）');
  }

  const pkgRow = await q('SELECT * FROM packages WHERE tracking_no = $1', [tracking_no]);
  const pkg = pkgRow[0] || null;
  let vehicle = null;
  const vehicleId = payload.vehicle_id != null && payload.vehicle_id !== ''
    ? Number(payload.vehicle_id)
    : (pkg ? pkg.vehicle_id : null);
  if (vehicleId) {
    const vs = await q('SELECT * FROM vehicles WHERE id = $1', [vehicleId]);
    vehicle = vs[0] || null;
  }

  const conflict = (code, message, choices) => ({
    scan_id, status: 'conflict', conflict_code: code, message, applied: false, choices,
    tracking_no, op, device_id, occurred_at: occurred,
    server: pkgSummary(pkg, vehicle),
  });
  const applied = (extra = {}) => ({
    scan_id, status: 'applied', applied: true, tracking_no, op, device_id,
    occurred_at: occurred, package_id: pkg?.id ?? extra.package_id ?? null,
    ...extra,
  });

  let outcome;

  if (op === 'arrive') {
    const destination = (payload.destination || '').toString().trim();
    if (!destination) return invalid('到件扫描缺少目的地');
    const weight = Number(payload.weight_kg) || 1;
    if (pkg) {
      // 运单已到件：绝不能再插一条导致重复记账
      outcome = conflict(
        'already_arrived',
        `运单 ${tracking_no} 已在 ${new Date(pkg.created_at).toISOString()} 到件登记，当前状态：${pkg.status}`,
        [CHOICES.discard, CHOICES.keep]
      );
    } else {
      const rows = await q(
        `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, status, created_at)
         VALUES ($1,$2,$3,$4,'pending',$5)
         ON CONFLICT (tracking_no) DO NOTHING
         RETURNING *`,
        [tracking_no, vehicleId || null, destination, weight, occurred]
      );
      const np = rows[0];
      if (np) {
        outcome = applied({ package_id: np.id, message: `到件登记成功 → ${destination}` });
      } else {
        // 并发窗口：评估时不存在、插入时被别人先登记
        const [cur] = await q('SELECT * FROM packages WHERE tracking_no = $1', [tracking_no]);
        outcome = conflict(
          'already_arrived',
          `运单 ${tracking_no} 已存在到件记录（并发），当前状态：${cur?.status}`,
          [CHOICES.discard, CHOICES.keep]
        );
      }
    }
  } else if (op === 'sort') {
    if (!pkg) {
      outcome = conflict('pkg_not_found', `运单 ${tracking_no} 在服务器不存在，无法分拣`, [CHOICES.discard, CHOICES.keep]);
    } else if (pkg.status === 'intercepted') {
      // 断网期间该件被异常拦截：拦截件不得通过补传分拣
      outcome = conflict(
        'pkg_intercepted',
        `运单 ${tracking_no} 已被拦截（${pkg.abnormal_type || '异常'}），禁止分拣补传`,
        [CHOICES.discard, CHOICES.keep, CHOICES.retry]
      );
    } else if (vehicle && vehicle.status === 'departed') {
      // 断网期间班次已发车
      outcome = conflict(
        'vehicle_departed',
        `班次 ${vehicle.plate_no}（${vehicle.route_code}）已发车，分拣扫描无法补记`,
        [CHOICES.discard, CHOICES.keep]
      );
    } else if (pkg.status === 'pending') {
      await q(
        `UPDATE packages SET status = 'sorted', sorted_at = $1
         WHERE id = $2 AND status = 'pending'`,
        [occurred, pkg.id]
      );
      outcome = applied({ message: '分拣完成（按扫描实际发生时间记账）' });
    } else if (pkg.status === 'sorted') {
      outcome = conflict(
        'state_advanced',
        `运单 ${tracking_no} 在服务器已是「已分拣」，分拣扫描已被其他作业完成`,
        [CHOICES.discard, CHOICES.keep, CHOICES.retry]
      );
    } else {
      // loaded
      outcome = conflict(
        'state_advanced',
        `运单 ${tracking_no} 在服务器已「装车」，分拣扫描不可补记`,
        [CHOICES.discard, CHOICES.keep]
      );
    }
  } else {
    // op === 'load'
    if (!pkg) {
      outcome = conflict('pkg_not_found', `运单 ${tracking_no} 在服务器不存在，无法装车`, [CHOICES.discard, CHOICES.keep]);
    } else if (pkg.status === 'intercepted') {
      outcome = conflict(
        'pkg_intercepted',
        `运单 ${tracking_no} 已被拦截（${pkg.abnormal_type || '异常'}），拦截件留置不发，禁止装车`,
        [CHOICES.discard, CHOICES.keep, CHOICES.retry]
      );
    } else if (vehicle && vehicle.status === 'departed') {
      outcome = conflict(
        'vehicle_departed',
        `班次 ${vehicle.plate_no}（${vehicle.route_code}）已发车，装车扫描无法补记`,
        [CHOICES.discard, CHOICES.keep]
      );
    } else if (pkg.vehicle_id && vehicleId && pkg.vehicle_id !== vehicleId) {
      // 包裹已归属另一辆车：不能把件"扫"到别的车上
      const [other] = await q('SELECT plate_no, route_code, status FROM vehicles WHERE id = $1', [pkg.vehicle_id]);
      outcome = conflict(
        'vehicle_mismatch',
        `运单 ${tracking_no} 已归属班次 ${other?.plate_no || pkg.vehicle_id}（${other?.route_code || ''}），与本次装车班次不一致`,
        [CHOICES.discard, CHOICES.keep, CHOICES.retry]
      );
    } else if (pkg.status === 'sorted') {
      await q(
        `UPDATE packages SET status = 'loaded', loaded_at = $1, vehicle_id = COALESCE($2, vehicle_id)
         WHERE id = $3 AND status = 'sorted'`,
        [occurred, vehicleId || null, pkg.id]
      );
      outcome = applied({ message: '装车成功（按扫描实际发生时间记账）' });
    } else if (pkg.status === 'loaded') {
      outcome = conflict(
        'state_advanced',
        `运单 ${tracking_no} 在服务器已「装车」，装车扫描已被其他作业完成`,
        [CHOICES.discard, CHOICES.keep]
      );
    } else {
      // pending：服务器尚未分拣，不能把离线装车直接盖过去
      outcome = conflict(
        'state_not_ready',
        `运单 ${tracking_no} 在服务器仍是「待分拣」，尚未完成分拣不能装车`,
        [CHOICES.discard, CHOICES.keep, CHOICES.retry]
      );
    }
  }

  // 缺字段的请求错误不记账（客户端正常不会产生，也没有可追溯的合法 scan_id 语义）
  if (outcome.status === 'error') {
    return outcome;
  }

  // ── 记台账（与状态变更同事务）──
  let ledgerInserted;
  if (outcome.status === 'applied') {
    ledgerInserted = await q(
      `INSERT INTO scan_ledger
         (scan_id, device_id, op, tracking_no, occurred_at, payload, status, package_id, result, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,'applied',$7,$8,$9)
       ON CONFLICT (scan_id) DO NOTHING
       RETURNING scan_id`,
      [
        scan_id, device_id, op, tracking_no, occurred,
        JSON.stringify(payload), outcome.package_id ?? null,
        JSON.stringify(outcome), now,
      ]
    );
  } else {
    ledgerInserted = await q(
      `INSERT INTO scan_ledger
         (scan_id, device_id, op, tracking_no, occurred_at, payload, status,
          conflict_code, conflict_message, package_id, server_snapshot, result)
       VALUES ($1,$2,$3,$4,$5,$6,'conflict',$7,$8,$9,$10,$11)
       ON CONFLICT (scan_id) DO NOTHING
       RETURNING scan_id`,
      [
        scan_id, device_id, op, tracking_no, occurred,
        JSON.stringify(payload),
        outcome.conflict_code || 'invalid', outcome.message,
        pkg?.id ?? null, JSON.stringify(outcome.server || null),
        JSON.stringify(outcome),
      ]
    );
  }
  if (ledgerInserted.length === 0) {
    // 并发补传竞争：台账已被另一请求先写，回放其首次结果而不是本次的重算结果
    const [row] = await q('SELECT result FROM scan_ledger WHERE scan_id = $1', [scan_id]);
    const prev = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    return { ...prev, replayed: true };
  }
  return outcome;
}

// 设备心跳：手持端每次在线/补传时报到
router.post('/devices/heartbeat', async (req, res) => {
  const { device_id, name } = req.body || {};
  if (!device_id) return res.status(400).json({ error: '缺少设备号' });
  const rows = await query(
    `INSERT INTO devices (id, name, last_seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET name = COALESCE(EXCLUDED.name, devices.name), last_seen_at = NOW()
     RETURNING *`,
    [device_id, name || null]
  );
  res.json(rows[0]);
});

// 台账查询（补传结果逐条核对 / 按设备追溯）
router.get('/ledger', async (req, res) => {
  const { device_id, status, tracking_no, limit = 100 } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };
  if (device_id) add('l.device_id = ?', device_id);
  if (status) add('l.status = ?', status);
  if (tracking_no) add('l.tracking_no ILIKE ?', `%${tracking_no}%`);
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await query(
    `SELECT l.*, p.status AS package_status, v.plate_no, v.route_code
     FROM scan_ledger l
     LEFT JOIN packages p ON p.id = l.package_id
     LEFT JOIN vehicles v ON v.id = (l.payload->>'vehicle_id')::int
     ${where}
     ORDER BY l.id DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

// 手持端批量补传：每条扫描独立评估、独立记账，逐条返回结果
router.post('/sync', async (req, res) => {
  const { device_id, name, scans = [], resolutions = [] } = req.body || {};
  if (!device_id) return res.status(400).json({ error: '缺少设备号' });
  if (!Array.isArray(scans) || !Array.isArray(resolutions)) {
    return res.status(400).json({ error: 'scans / resolutions 必须是数组' });
  }
  const now = new Date();

  // 设备心跳随补传一起报到
  await query(
    `INSERT INTO devices (id, name, last_seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET name = COALESCE(EXCLUDED.name, devices.name), last_seen_at = NOW()`,
    [device_id, name || null]
  );

  // 先处理本次扫描（冲突也会立即落台账），再回传冲突处理结论，
  // 这样同一请求内"重扫 + 旧冲突放弃"也能正确落到旧条目上
  const results = [];
  for (const s of scans) {
    // 台账已存在（刷新页面/重复补传）：原样回放首次结果，绝不重复记账
    const [existing] = await query(
      'SELECT result FROM scan_ledger WHERE scan_id = $1',
      [s?.scan_id]
    );
    if (existing) {
      const replayed = typeof existing.result === 'string'
        ? JSON.parse(existing.result)
        : existing.result;
      results.push({ ...replayed, replayed: true });
      continue;
    }
    // 每条扫描独立事务：单条失败不影响本批其他扫描
    try {
      results.push(await withTransaction((q) => processOne(q, s, now)));
    } catch (e) {
      console.error('[scan-sync] 扫描记账失败:', s?.scan_id, e);
      results.push({
        scan_id: s?.scan_id, status: 'error', applied: false,
        error_code: 'server_error', message: '服务器处理失败，可重新补传（不会重复记账）',
      });
    }
  }

  // 冲突人工处理结论回写（discarded 放弃 / kept 暂留 / retried 已重扫）
  for (const r of resolutions) {
    if (!r?.scan_id || !['discarded', 'kept', 'retried'].includes(r.resolution)) continue;
    await query(
      `UPDATE scan_ledger SET resolution = $1, resolved_at = NOW()
       WHERE scan_id = $2 AND resolution IS NULL`,
      [r.resolution, r.scan_id]
    );
  }

  const counts = results.reduce(
    (acc, r) => {
      if (r.status === 'applied' && !r.replayed) acc.applied += 1;
      if (r.status === 'conflict') acc.conflict += 1;
      if (r.status === 'error') acc.error += 1;
      if (r.replayed) acc.replayed += 1;
      return acc;
    },
    { applied: 0, conflict: 0, error: 0, replayed: 0 }
  );
  res.json({ ok: true, server_time: now.toISOString(), counts, results });
});

export default router;
