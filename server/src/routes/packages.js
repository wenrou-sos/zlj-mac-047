// 包裹路由：查询、分拣、上架、装车、异常拦截/解除
import { Router } from 'express';
import { query } from '../db.js';
import { ensureVehicleLocation, getActiveLocation, recordMovement, YARD_LOCATION_TYPES } from '../inventory.js';

const router = Router();

async function getReceivingLocation() {
  const [loc] = await query(`SELECT * FROM locations WHERE code = 'RECV-01' AND is_active = TRUE`);
  if (!loc) throw new Error('默认到件暂存库位 RECV-01 不存在');
  return loc;
}

async function pickStorageLocation(preferredId = null) {
  if (preferredId) {
    const loc = await getActiveLocation(preferredId, { yardOnly: true });
    if (loc && loc.loc_type === 'storage') return loc;
    throw new Error('上架目标必须是可用场区存储库位');
  }
  const [loc] = await query(
    `SELECT l.*, COUNT(p.id)::int AS occupied
     FROM locations l LEFT JOIN packages p ON p.current_location_id = l.id
     WHERE l.loc_type = 'storage' AND l.is_active = TRUE
     GROUP BY l.id
     HAVING l.capacity IS NULL OR COUNT(p.id) < l.capacity
     ORDER BY COUNT(p.id), l.code
     LIMIT 1`
  );
  return loc || null;
}

// 包裹列表（分页，支持状态/目的地/异常/车辆/库位/单号筛选）
router.get('/', async (req, res) => {
  const { status, destination, held, vehicle_id, location_id, q, page = 1, pageSize = 50 } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  if (status) add('p.status = ?', status);
  if (destination) add('p.destination = ?', destination);
  if (vehicle_id) add('p.vehicle_id = ?', vehicle_id);
  if (location_id) add('p.current_location_id = ?', location_id);
  if (held === 'true') add('p.intercept_status = ?', 'held');
  if (held === 'false') add('p.intercept_status <> ?', 'held');
  if (q) add('p.tracking_no ILIKE ?', `%${q}%`);

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);

  const [{ count }] = await query(
    `SELECT COUNT(*)::int AS count FROM packages p ${where}`,
    params
  );
  params.push(size, (pageNum - 1) * size);
  const items = await query(
    `SELECT p.*, v.plate_no, v.route_code,
            l.code AS location_code, l.name AS location_name, l.loc_type AS location_type
     FROM packages p
     LEFT JOIN vehicles v ON v.id = p.vehicle_id
     LEFT JOIN locations l ON l.id = p.current_location_id
     ${where}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items, total: count, page: pageNum, pageSize: size });
});

// 新增包裹（模拟到件扫描）：到件即落到唯一有效库位 RECV-01
router.post('/', async (req, res) => {
  const { tracking_no, vehicle_id, destination, weight_kg, location_id } = req.body || {};
  if (!tracking_no || !destination) {
    return res.status(400).json({ error: '运单号和目的地不能为空' });
  }
  const receiving = location_id
    ? await getActiveLocation(location_id, { yardOnly: true })
    : await getReceivingLocation();
  if (!receiving || !YARD_LOCATION_TYPES.includes(receiving.loc_type)) {
    return res.status(400).json({ error: '到件位置必须是可用场区库位' });
  }
  try {
    const rows = await query(
      `INSERT INTO packages (tracking_no, vehicle_id, destination, weight_kg, current_location_id, intercept_status)
       VALUES ($1,$2,$3,$4,$5,'none') RETURNING *`,
      [tracking_no, vehicle_id || null, destination, weight_kg || 1, receiving.id]
    );
    await recordMovement({
      packageId: rows[0].id,
      toLocationId: receiving.id,
      movementType: 'receive',
      note: '到件扫描',
    });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e.message))) {
      return res.status(409).json({ error: '运单号已存在' });
    }
    throw e;
  }
});

// 分拣完成并上架到场区库位；可传 target_location_id，否则自动分配最空存储位
router.post('/:id/sort', async (req, res) => {
  const { target_location_id } = req.body || {};
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.intercept_status === 'held') {
    return res.status(409).json({ error: '拦截件不能分拣，请先完成异常处置并解除拦截' });
  }
  if (pkg.status !== 'pending') {
    return res.status(409).json({ error: '仅待分拣包裹可执行分拣操作' });
  }
  let target;
  try {
    target = await pickStorageLocation(target_location_id || null);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!target) return res.status(409).json({ error: '没有可用且未满的场区存储库位' });

  const rows = await query(
    `UPDATE packages SET status = 'sorted', sorted_at = NOW(), current_location_id = $1
     WHERE id = $2 RETURNING *`,
    [target.id, pkg.id]
  );
  await recordMovement({
    packageId: pkg.id,
    fromLocationId: pkg.current_location_id,
    toLocationId: target.id,
    movementType: 'putaway',
    note: '分拣完成自动上架',
  });
  res.json(rows[0]);
});

// 装车（拦截件禁止装车）；车辆即包裹的唯一有效位置
router.post('/:id/load', async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.intercept_status === 'held') {
    return res.status(409).json({ error: '该件为拦截中状态，禁止装车' });
  }
  if (pkg.status !== 'sorted') {
    return res.status(409).json({ error: '仅已分拣包裹可装车' });
  }
  if (!pkg.vehicle_id) return res.status(409).json({ error: '包裹未关联车辆，不能装车' });
  const [vehicle] = await query('SELECT status FROM vehicles WHERE id = $1', [pkg.vehicle_id]);
  if (!vehicle) return res.status(404).json({ error: '关联车辆不存在' });
  if (vehicle.status === 'departed' || vehicle.status === 'expected') {
    return res.status(409).json({ error: '车辆尚未到场或已发车，不能装车' });
  }

  const vehicleLoc = await ensureVehicleLocation(pkg.vehicle_id);
  if (!vehicleLoc) return res.status(404).json({ error: '关联车辆不存在' });

  const rows = await query(
    `UPDATE packages
     SET status = 'loaded', loaded_at = NOW(), current_location_id = $1
     WHERE id = $2 RETURNING *`,
    [vehicleLoc.id, pkg.id]
  );
  await recordMovement({
    packageId: pkg.id,
    fromLocationId: pkg.current_location_id,
    toLocationId: vehicleLoc.id,
    movementType: 'load',
    note: '装车扫描',
  });
  res.json(rows[0]);
});

// 异常拦截：只改变处置状态，包裹仍停留在当前物理位置
router.post('/:id/intercept', async (req, res) => {
  const { abnormal_type, note } = req.body || {};
  if (!abnormal_type) return res.status(400).json({ error: '请选择异常类型' });
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.status === 'loaded' || pkg.status === 'departed') {
    return res.status(409).json({ error: '包裹已装车/离场，无法在本环节拦截' });
  }
  if (pkg.intercept_status === 'held') {
    return res.status(409).json({ error: '包裹已处于拦截中状态' });
  }
  const rows = await query(
    `UPDATE packages
     SET intercept_status = 'held', is_abnormal = TRUE, abnormal_type = $1,
         abnormal_note = $2, intercepted_at = COALESCE(intercepted_at, NOW()),
         intercept_released_at = NULL
     WHERE id = $3 RETURNING *`,
    [abnormal_type, note || null, pkg.id]
  );
  res.json(rows[0]);
});

// 解除拦截：仅恢复处置状态；作业状态和位置沿用拦截前/处置后的实际值
router.post('/:id/release', async (req, res) => {
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [req.params.id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (pkg.intercept_status !== 'held') {
    return res.status(409).json({ error: '包裹未处于拦截中状态' });
  }
  const rows = await query(
    `UPDATE packages
     SET intercept_status = 'released', intercept_released_at = NOW()
     WHERE id = $1 RETURNING *`,
    [pkg.id]
  );
  res.json(rows[0]);
});

// 包内复用：车辆批量分拣/发车时使用
export async function bulkSortVehiclePackages(vehicleId) {
  const pending = await query(
    `SELECT id, current_location_id
     FROM packages
     WHERE vehicle_id = $1 AND status = 'pending' AND intercept_status <> 'held'
     ORDER BY id`,
    [vehicleId]
  );
  let count = 0;
  for (const pkg of pending) {
    // 逐件分配可容纳的存储库位，避免车辆批量分拣时超过库位容量
    const target = await pickStorageLocation();
    if (!target) break;
    await query(
      `UPDATE packages SET status = 'sorted', sorted_at = NOW(), current_location_id = $1
       WHERE id = $2 AND status = 'pending' AND intercept_status <> 'held'`,
      [target.id, pkg.id]
    );
    await recordMovement({
      packageId: pkg.id,
      fromLocationId: pkg.current_location_id,
      toLocationId: target.id,
      movementType: 'putaway',
      note: '车辆分拣完成批量上架',
    });
    count++;
  }
  return count;
}

export async function bulkLoadVehiclePackages(vehicleId) {
  const loc = await ensureVehicleLocation(vehicleId);
  if (!loc) throw new Error('车辆库位不存在');
  const changed = await query(
    `WITH picked AS (
       SELECT id, current_location_id
       FROM packages
       WHERE vehicle_id = $1 AND status = 'sorted' AND intercept_status <> 'held'
     ), upd AS (
       UPDATE packages p
       SET status = 'loaded', loaded_at = NOW(), current_location_id = $2
       FROM picked WHERE p.id = picked.id
       RETURNING p.id, picked.current_location_id
     )
     INSERT INTO package_movements (package_id, from_location_id, to_location_id, movement_type, note)
     SELECT id, current_location_id, $2, 'load', '车辆发车批量装车' FROM upd
     RETURNING id`,
    [vehicleId, loc.id]
  );
  return changed.length;
}

export default router;
