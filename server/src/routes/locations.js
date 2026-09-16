// 场区库位路由：库位维护、容量/占用、包裹上架与移位
import { Router } from 'express';
import { query } from '../db.js';
import { YARD_LOCATION_TYPES, getActiveLocation, recordMovement } from '../inventory.js';

const router = Router();

const LOCATION_SUMMARY_SELECT = `
  SELECT l.*,
    COUNT(p.id)::int AS occupied,
    COUNT(p.id) FILTER (WHERE p.status = 'pending' AND p.intercept_status <> 'held')::int AS pending,
    COUNT(p.id) FILTER (WHERE p.status = 'sorted' AND p.intercept_status <> 'held')::int AS sorted,
    COUNT(p.id) FILTER (WHERE p.status IN ('pending','sorted'))::int AS backlog,
    COUNT(p.id) FILTER (WHERE p.intercept_status = 'held')::int AS held,
    COALESCE(l.capacity, 0) AS capacity_num,
    EXISTS (
      SELECT 1 FROM stocktakes s
      WHERE s.location_id = l.id AND s.status = 'counting'
    ) AS counting
  FROM locations l
  LEFT JOIN packages p ON p.current_location_id = l.id
`;

// 库位列表；默认仅场区可用库位
router.get('/', async (req, res) => {
  const { type, active = 'true', includeVehicles = 'false', q } = req.query;
  const conds = [];
  const params = [];
  const add = (clause, val) => { params.push(val); conds.push(clause.replace('?', `$${params.length}`)); };

  if (active === 'true') add('l.is_active = ?', true);
  if (type) add('l.loc_type = ?', type);
  if (includeVehicles !== 'true') {
    params.push(YARD_LOCATION_TYPES);
    conds.push(`l.loc_type = ANY($${params.length})`);
  }
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    conds.push(`(l.code ILIKE $${params.length - 1} OR l.name ILIKE $${params.length})`);
  }

  const rows = await query(
    `${LOCATION_SUMMARY_SELECT}
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     GROUP BY l.id
     ORDER BY
       array_position(ARRAY['receiving','sorting','storage','intercept','vehicle','lost'], l.loc_type),
       l.code`,
    params
  );
  res.json(rows);
});

// 新增场区库位
router.post('/', async (req, res) => {
  const { code, name, loc_type = 'storage', zone = '场区', capacity } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: '库位编码和名称不能为空' });
  if (!YARD_LOCATION_TYPES.includes(loc_type)) {
    return res.status(400).json({ error: '仅允许创建到件、分拣、存储或拦截隔离类场区库位' });
  }
  try {
    const rows = await query(
      `INSERT INTO locations (code, name, loc_type, zone, capacity, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *`,
      [code.trim(), name.trim(), loc_type, zone || '场区', capacity || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e.message))) {
      return res.status(409).json({ error: '库位编码已存在' });
    }
    throw e;
  }
});

// 库位详情及在库件
router.get('/:id', async (req, res) => {
  const [location] = await query(`${LOCATION_SUMMARY_SELECT} WHERE l.id = $1 GROUP BY l.id`, [req.params.id]);
  if (!location) return res.status(404).json({ error: '库位不存在' });
  const packages = await query(
    `SELECT p.*, v.plate_no, v.route_code
     FROM packages p LEFT JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.current_location_id = $1
     ORDER BY p.status, p.created_at DESC`,
    [location.id]
  );
  res.json({ location, packages });
});

// 停用空库位（流水和盘点仍保留历史）
router.post('/:id/disable', async (req, res) => {
  const [location] = await query('SELECT * FROM locations WHERE id = $1', [req.params.id]);
  if (!location) return res.status(404).json({ error: '库位不存在' });
  if (!YARD_LOCATION_TYPES.includes(location.loc_type)) {
    return res.status(409).json({ error: '系统/车辆库位不能停用' });
  }
  const [{ occupied }] = await query(
    'SELECT COUNT(*)::int AS occupied FROM packages WHERE current_location_id = $1',
    [location.id]
  );
  if (occupied > 0) return res.status(409).json({ error: '库位仍有包裹，请先移位' });
  await query('UPDATE locations SET is_active = FALSE WHERE id = $1', [location.id]);
  res.json({ ok: true });
});

// 包裹上架/移位：只改“唯一有效位置”，不改变拦截处置状态
router.post('/move', async (req, res) => {
  const { package_id, target_location_id, note } = req.body || {};
  if (!package_id || !target_location_id) {
    return res.status(400).json({ error: '包裹和目标库位不能为空' });
  }
  const [pkg] = await query('SELECT * FROM packages WHERE id = $1', [package_id]);
  if (!pkg) return res.status(404).json({ error: '包裹不存在' });
  if (['loaded', 'departed', 'lost'].includes(pkg.status)) {
    return res.status(409).json({ error: '已装车、已离场或盘亏件不能通过场区移位操作变更位置' });
  }
  const target = await getActiveLocation(target_location_id, { yardOnly: true });
  if (!target) return res.status(400).json({ error: '目标场区库位不存在或不可用' });
  if (pkg.current_location_id === target.id) {
    return res.status(409).json({ error: '包裹已在该库位' });
  }
  if (target.capacity) {
    const [{ occupied }] = await query(
      'SELECT COUNT(*)::int AS occupied FROM packages WHERE current_location_id = $1',
      [target.id]
    );
    if (occupied >= target.capacity) return res.status(409).json({ error: '目标库位已满' });
  }

  const fromId = pkg.current_location_id;
  const [from] = fromId ? await query('SELECT loc_type FROM locations WHERE id = $1', [fromId]) : [null];
  const movementType = from?.loc_type === 'receiving' ? 'putaway' : 'relocate';
  await query('UPDATE packages SET current_location_id = $1 WHERE id = $2', [target.id, pkg.id]);
  const movement = await recordMovement({
    packageId: pkg.id,
    fromLocationId: fromId,
    toLocationId: target.id,
    movementType,
    note: note || null,
  });
  res.json({ ok: true, movement, target_location_id: target.id });
});

export default router;
