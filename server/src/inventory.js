// 库位与包裹位置通用逻辑
import { query } from './db.js';

export const YARD_LOCATION_TYPES = ['receiving', 'sorting', 'storage', 'intercept'];

export async function ensureVehicleLocation(vehicleId) {
  const [vehicle] = await query('SELECT * FROM vehicles WHERE id = $1', [vehicleId]);
  if (!vehicle) return null;
  if (vehicle.current_location_id) {
    const [loc] = await query('SELECT * FROM locations WHERE id = $1', [vehicle.current_location_id]);
    if (loc) return loc;
  }
  const rows = await query(
    `INSERT INTO locations (code, loc_type, zone, name, ref_id, is_active)
     VALUES ($1,'vehicle','车辆月台',$2,$3,TRUE)
     ON CONFLICT (ref_id) WHERE loc_type = 'vehicle'
     DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [`VEH-${vehicle.id}`, `${vehicle.plate_no}（车辆库位）`, String(vehicle.id)]
  );
  const loc = rows[0];
  await query('UPDATE vehicles SET current_location_id = $1 WHERE id = $2', [loc.id, vehicle.id]);
  return loc;
}

export async function getActiveLocation(id, { yardOnly = false } = {}) {
  const [loc] = await query('SELECT * FROM locations WHERE id = $1 AND is_active = TRUE', [id]);
  if (!loc) return null;
  if (yardOnly && !YARD_LOCATION_TYPES.includes(loc.loc_type)) return null;
  return loc;
}

export async function recordMovement(
  {
    packageId, fromLocationId = null, toLocationId = null,
    movementType, stocktakeId = null, note = null,
  },
  executor = query
) {
  const rows = await executor(
    `INSERT INTO package_movements
       (package_id, from_location_id, to_location_id, movement_type, stocktake_id, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [packageId, fromLocationId, toLocationId, movementType, stocktakeId, note]
  );
  return rows[0];
}
