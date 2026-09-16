// 滚动盘点：按库位发起、期间流转核对、差异复核、复核后调账
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { getActiveLocation, recordMovement } from '../inventory.js';

const router = Router();

async function getStocktake(id) {
  const [stocktake] = await query(
    `SELECT s.*, l.code AS location_code, l.name AS location_name, l.loc_type AS location_type
     FROM stocktakes s JOIN locations l ON l.id = s.location_id
     WHERE s.id = $1`,
    [id]
  );
  return stocktake || null;
}

async function buildDetail(stocktakeId) {
  const stocktake = await getStocktake(stocktakeId);
  if (!stocktake) return null;

  const [snapshotSummary] = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE result = 'matched')::int AS matched,
       COUNT(*) FILTER (WHERE result = 'shortage')::int AS shortage,
       COUNT(*) FILTER (WHERE result = 'period_out')::int AS period_out,
       COUNT(*) FILTER (WHERE result = 'shipped')::int AS shipped,
       COUNT(*) FILTER (WHERE result = 'pending')::int AS pending
     FROM stocktake_snapshots WHERE stocktake_id = $1`,
    [stocktakeId]
  );
  const [scanSummary] = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE result = 'matched')::int AS matched,
       COUNT(*) FILTER (WHERE result = 'misplaced')::int AS misplaced,
       COUNT(*) FILTER (WHERE result = 'surplus')::int AS surplus,
       COUNT(*) FILTER (WHERE result IN ('period_in','period_out','shipped'))::int AS period
     FROM stocktake_scans WHERE stocktake_id = $1`,
    [stocktakeId]
  );
  const [diffSummary] = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE diff_type = 'surplus')::int AS surplus,
       COUNT(*) FILTER (WHERE diff_type = 'shortage')::int AS shortage,
       COUNT(*) FILTER (WHERE diff_type = 'misplaced')::int AS misplaced,
       COUNT(*) FILTER (WHERE resolution = 'pending')::int AS pending_review,
       COUNT(*) FILTER (WHERE resolution = 'confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE resolution = 'dismissed')::int AS dismissed
     FROM stocktake_differences WHERE stocktake_id = $1`,
    [stocktakeId]
  );
  const differences = await query(
    `SELECT d.*,
            el.code AS expected_code, el.name AS expected_name,
            al.code AS actual_code, al.name AS actual_name,
            p.destination, p.status AS package_status, p.intercept_status
     FROM stocktake_differences d
     LEFT JOIN locations el ON el.id = d.expected_location_id
     LEFT JOIN locations al ON al.id = d.actual_location_id
     LEFT JOIN packages p ON p.id = d.package_id
     WHERE d.stocktake_id = $1
     ORDER BY
       array_position(ARRAY['shortage','misplaced','surplus'], d.diff_type),
       array_position(ARRAY['pending','confirmed','dismissed'], d.resolution),
       d.id`,
    [stocktakeId]
  );
  const recentScans = await query(
    `SELECT sc.*, p.destination, p.status AS package_status,
            l.code AS observed_code, l.name AS observed_name
     FROM stocktake_scans sc
     LEFT JOIN packages p ON p.id = sc.package_id
     JOIN locations l ON l.id = sc.observed_location_id
     WHERE sc.stocktake_id = $1
     ORDER BY sc.observed_at DESC, sc.id DESC
     LIMIT 100`,
    [stocktakeId]
  );

  return {
    ...stocktake,
    snapshot_summary: snapshotSummary,
    scan_summary: scanSummary,
    diff_summary: diffSummary,
    differences,
    recent_scans: recentScans,
  };
}

async function findPeriodMove(packageId, stocktake, direction, locationId, executor = query) {
  const column = direction === 'from' ? 'from_location_id' : 'to_location_id';
  const [row] = await executor(
    `SELECT * FROM package_movements
     WHERE package_id = $1 AND ${column} = $2
       AND created_at >= $3 AND created_at <= COALESCE($4, NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [packageId, locationId, stocktake.snapshot_at, stocktake.completed_at]
  );
  return row || null;
}

// 发起盘点：冻结该库位在盘点时点的账面快照；不阻断到件、上架、移位、装车
router.post('/', async (req, res) => {
  const { location_id, note, created_by } = req.body || {};
  if (!location_id) return res.status(400).json({ error: '请选择要盘点的场区库位' });
  const location = await getActiveLocation(location_id, { yardOnly: true });
  if (!location) return res.status(400).json({ error: '库位不存在、不可用或不是场区库位' });

  const [open] = await query(
    `SELECT id FROM stocktakes WHERE location_id = $1 AND status = 'counting'`,
    [location.id]
  );
  if (open) return res.status(409).json({ error: '该库位已有进行中的滚动盘点，请先结束或取消' });

  const [stocktake] = await query(
    `INSERT INTO stocktakes (location_id, note, created_by, snapshot_at)
     VALUES ($1,$2,$3,NOW()) RETURNING *`,
    [location.id, note || null, created_by || '现场员']
  );
  await query(
    `INSERT INTO stocktake_snapshots (stocktake_id, package_id, expected_location_id)
     SELECT $1, id, current_location_id
     FROM packages
     WHERE current_location_id = $2 AND status <> 'lost'`,
    [stocktake.id, location.id]
  );
  res.status(201).json(await buildDetail(stocktake.id));
});

router.get('/', async (req, res) => {
  const { status, location_id } = req.query;
  const conds = [];
  const params = [];
  if (status) {
    params.push(status);
    conds.push(`s.status = $${params.length}`);
  }
  if (location_id) {
    params.push(location_id);
    conds.push(`s.location_id = $${params.length}`);
  }
  const rows = await query(
    `SELECT s.*, l.code AS location_code, l.name AS location_name,
            (SELECT COUNT(*)::int FROM stocktake_snapshots x WHERE x.stocktake_id = s.id) AS snapshot_count,
            (SELECT COUNT(*)::int FROM stocktake_scans x WHERE x.stocktake_id = s.id) AS scan_count,
            (SELECT COUNT(*)::int FROM stocktake_differences x
              WHERE x.stocktake_id = s.id AND x.resolution = 'pending') AS pending_review,
            (SELECT COUNT(*)::int FROM stocktake_differences x
              WHERE x.stocktake_id = s.id) AS diff_count
     FROM stocktakes s
     JOIN locations l ON l.id = s.location_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT 100`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const detail = await buildDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: '盘点单不存在' });
  res.json(detail);
});

// 实盘扫描：滚动盘点期间继续作业，系统用 snapshot_at ~ completed_at 位置流水核掉期间流转
router.post('/:id/scan', async (req, res) => {
  const stocktake = await getStocktake(req.params.id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status !== 'counting') {
    return res.status(409).json({ error: '盘点已结束，不能继续扫描' });
  }

  const trackingNo = String(req.body?.tracking_no || '').trim();
  if (!trackingNo) return res.status(400).json({ error: '请扫描或输入运单号' });
  const observedLocationId = Number(req.body?.observed_location_id || stocktake.location_id);
  const observed = await getActiveLocation(observedLocationId, { yardOnly: true });
  if (!observed || observed.id !== stocktake.location_id) {
    return res.status(400).json({ error: '本次盘点只能登记所选库位的实盘结果' });
  }

  try {
    await withTransaction(async (tq) => {
      const [pkg] = await tq('SELECT * FROM packages WHERE tracking_no = $1', [trackingNo]);
      if (pkg) {
        const [dup] = await tq(
          'SELECT id FROM stocktake_scans WHERE stocktake_id = $1 AND package_id = $2 LIMIT 1',
          [stocktake.id, pkg.id]
        );
        if (dup) throw Object.assign(new Error('该件在本盘点单已扫描，请勿重复计数'), { status: 409 });
      }

      let result;
      let snapshot = null;
      let diffType = null;

      if (pkg) {
        [snapshot] = await tq(
          'SELECT * FROM stocktake_snapshots WHERE stocktake_id = $1 AND package_id = $2',
          [stocktake.id, pkg.id]
        );
      }

      if (!pkg) {
        // 系统中无运单：账外实盘件，形成盘盈，等待复核补账
        result = 'surplus';
        diffType = 'surplus';
      } else if (snapshot) {
        if (pkg.current_location_id === stocktake.location_id) {
          result = 'matched';
        } else if (pkg.status === 'loaded' || pkg.status === 'departed') {
          const moved = await findPeriodMove(pkg.id, stocktake, 'from', stocktake.location_id, tq);
          result = moved ? 'shipped' : 'misplaced';
          if (!moved) diffType = 'misplaced';
        } else {
          const movedOut = await findPeriodMove(pkg.id, stocktake, 'from', stocktake.location_id, tq);
          if (movedOut && pkg.current_location_id !== stocktake.location_id) {
            result = 'period_out';
          } else {
            result = 'misplaced';
            diffType = 'misplaced';
          }
        }
      } else {
        const movedIn = await findPeriodMove(pkg.id, stocktake, 'to', stocktake.location_id, tq);
        if (pkg.current_location_id === stocktake.location_id) {
          // 盘点时点之后才移入/到件，不属于本次账存，也不算盘盈
          result = movedIn ? 'period_in' : 'misplaced';
          if (!movedIn) diffType = 'misplaced';
        } else if (pkg.status === 'loaded' || pkg.status === 'departed') {
          result = 'period_out';
        } else {
          result = 'misplaced';
          diffType = 'misplaced';
        }
      }

      await tq(
        `INSERT INTO stocktake_scans
           (stocktake_id, package_id, tracking_no, observed_location_id, result, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [stocktake.id, pkg?.id || null, trackingNo, observed.id, result, req.body?.note || null]
      );

      if (snapshot && ['matched', 'shipped', 'period_out'].includes(result)) {
        await tq('UPDATE stocktake_snapshots SET result = $1 WHERE id = $2', [result, snapshot.id]);
      }
      if (snapshot && result === 'misplaced') {
        await tq("UPDATE stocktake_snapshots SET result = 'misplaced' WHERE id = $1", [snapshot.id]);
      }

      if (diffType === 'surplus') {
        await tq(
          `INSERT INTO stocktake_differences
             (stocktake_id, package_id, tracking_no, diff_type, expected_location_id,
              actual_location_id, actual_destination)
           VALUES ($1,NULL,$2,'surplus',NULL,$3,$4)`,
          [stocktake.id, trackingNo, observed.id, req.body?.destination || '待确认']
        );
      } else if (diffType === 'misplaced') {
        const [misDiff] = await tq(
          `INSERT INTO stocktake_differences
             (stocktake_id, package_id, tracking_no, diff_type, expected_location_id,
              actual_location_id, actual_destination)
           VALUES ($1,$2,$3,'misplaced',$4,$5,$6)
           RETURNING *`,
          [stocktake.id, pkg.id, trackingNo, pkg.current_location_id, observed.id, pkg.destination]
        );
        // 其他未完成库位盘点可能已把同一件列为盘亏；实物已扫到，自动驳回对应待复核盘亏
        const linkedShortages = await tq(
          `UPDATE stocktake_differences
           SET resolution = 'dismissed',
               resolution_note = COALESCE(resolution_note, $1),
               reviewed_by = COALESCE(reviewed_by, '系统核销'),
               reviewed_at = NOW()
           WHERE package_id = $2 AND diff_type = 'shortage' AND resolution = 'pending'
             AND stocktake_id <> $3
           RETURNING id`,
          [`盘点单 #${stocktake.id} 在 ${stocktake.location_code} 扫到该件，自动核销盘亏`, pkg.id, stocktake.id]
        );
        if (linkedShortages.length) {
          await tq(
            `UPDATE stocktake_differences SET resolution_note = COALESCE(resolution_note, $1)
             WHERE id = $2`,
            [`已核销其他盘点单的 ${linkedShortages.length} 条盘亏候选`, misDiff.id]
          );
        }
      }
    });
    res.status(201).json(await buildDetail(stocktake.id));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// 结束实盘：只对“未扫到”的快照按期间流水判定盘亏/移位/发车
router.post('/:id/complete', async (req, res) => {
  const stocktake = await getStocktake(req.params.id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status !== 'counting') return res.status(409).json({ error: '盘点当前状态不允许结束' });

  try {
    await withTransaction(async (tq) => {
      const pending = await tq(
        `SELECT sp.*, p.status, p.current_location_id, p.tracking_no, p.destination
         FROM stocktake_snapshots sp
         JOIN packages p ON p.id = sp.package_id
         WHERE sp.stocktake_id = $1 AND sp.result = 'pending'`,
        [stocktake.id]
      );

      for (const snap of pending) {
        if (snap.current_location_id === stocktake.location_id) {
          await tq("UPDATE stocktake_snapshots SET result = 'shortage' WHERE id = $1", [snap.id]);
          await tq(
            `INSERT INTO stocktake_differences
               (stocktake_id, package_id, tracking_no, diff_type, expected_location_id, actual_destination)
             VALUES ($1,$2,$3,'shortage',$4,$5)
             ON CONFLICT DO NOTHING`,
            [stocktake.id, snap.package_id, snap.tracking_no, stocktake.location_id, snap.destination]
          );
        } else if (snap.status === 'loaded' || snap.status === 'departed') {
          const moved = await findPeriodMove(snap.package_id, stocktake, 'from', stocktake.location_id, tq);
          await tq("UPDATE stocktake_snapshots SET result = 'shipped' WHERE id = $1", [snap.id]);
          if (!moved) {
            // 没有流水却在车辆/离场位置，保守列入盘亏交复核，不直接静默核销
            await tq(
              `INSERT INTO stocktake_differences
                 (stocktake_id, package_id, tracking_no, diff_type, expected_location_id, actual_destination)
               VALUES ($1,$2,$3,'shortage',$4,$5) ON CONFLICT DO NOTHING`,
              [stocktake.id, snap.package_id, snap.tracking_no, stocktake.location_id, snap.destination]
            );
          }
        } else {
          const moved = await findPeriodMove(snap.package_id, stocktake, 'from', stocktake.location_id, tq);
          await tq(
            "UPDATE stocktake_snapshots SET result = CASE WHEN $2 THEN 'period_out' ELSE 'shortage' END WHERE id = $1",
            [snap.id, !!moved]
          );
          if (!moved) {
            await tq(
              `INSERT INTO stocktake_differences
                 (stocktake_id, package_id, tracking_no, diff_type, expected_location_id, actual_destination)
               VALUES ($1,$2,$3,'shortage',$4,$5) ON CONFLICT DO NOTHING`,
              [stocktake.id, snap.package_id, snap.tracking_no, stocktake.location_id, snap.destination]
            );
          }
        }
      }

      await tq(
        `UPDATE stocktakes SET status = 'reviewing', completed_at = NOW()
         WHERE id = $1`,
        [stocktake.id]
      );
    });
    res.json(await buildDetail(stocktake.id));
  } catch (e) {
    throw e;
  }
});

// 复核单条差异：确认才调账，也可驳回（如找到实物/扫描重复）
router.put('/:id/differences/:diffId/review', async (req, res) => {
  const stocktake = await getStocktake(req.params.id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (!['reviewing', 'adjusted'].includes(stocktake.status)) {
    return res.status(409).json({ error: '请先结束实盘，进入差异复核' });
  }
  const { decision, note, reviewed_by } = req.body || {};
  if (!['confirmed', 'dismissed'].includes(decision)) {
    return res.status(400).json({ error: '复核结论必须是 confirmed 或 dismissed' });
  }
  const changed = await query(
    `UPDATE stocktake_differences
     SET resolution = $1, resolution_note = $2, reviewed_by = $3, reviewed_at = NOW()
     WHERE id = $4 AND stocktake_id = $5 RETURNING *`,
    [decision, note || null, reviewed_by || '复核员', req.params.diffId, stocktake.id]
  );
  if (!changed.length) return res.status(404).json({ error: '差异不存在' });
  res.json(await buildDetail(stocktake.id));
});

// 复核全部通过后统一调整账面；已在期间发走/移走且有流水的件不会进入调账
router.post('/:id/adjust', async (req, res) => {
  const stocktake = await getStocktake(req.params.id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status !== 'reviewing') return res.status(409).json({ error: '只有待复核盘点单可以调整账面' });

  const [lostLoc] = await query(`SELECT * FROM locations WHERE code = 'LOST-01'`);
  if (!lostLoc) return res.status(500).json({ error: '盘亏虚拟库位 LOST-01 不存在' });

  try {
    await withTransaction(async (tq) => {
      // 行锁放在事务内，防止复核后到调账前仍有移位/装车写入
      const diffs = await tq(
        'SELECT * FROM stocktake_differences WHERE stocktake_id = $1 ORDER BY id FOR UPDATE',
        [stocktake.id]
      );
      const pending = diffs.filter((d) => d.resolution === 'pending');
      if (pending.length) {
        throw Object.assign(new Error(`还有 ${pending.length} 条差异未复核，不能调账`), { status: 409 });
      }

      for (const d of diffs) {
        if (d.resolution !== 'confirmed' || d.adjusted_at) continue;

        if (d.diff_type === 'surplus') {
          const rows = await tq(
            `INSERT INTO packages
               (tracking_no, destination, weight_kg, status, intercept_status,
                is_abnormal, current_location_id)
             VALUES ($1,$2,1,'pending','none',FALSE,$3)
             ON CONFLICT (tracking_no) DO UPDATE SET current_location_id = EXCLUDED.current_location_id
             RETURNING id, current_location_id`,
            [d.tracking_no, d.actual_destination || '待确认', d.actual_location_id]
          );
          const pkgId = rows[0].id;
          await tq('UPDATE stocktake_differences SET package_id = $1, adjusted_at = NOW() WHERE id = $2', [pkgId, d.id]);
          await recordMovement({
            packageId: pkgId,
            toLocationId: d.actual_location_id,
            movementType: 'adjust-surplus',
            stocktakeId: stocktake.id,
            note: '盘盈复核后补账',
          }, tq);
        }

        if (d.diff_type === 'shortage') {
          if (!d.package_id) throw Object.assign(new Error('盘亏差异缺少包裹ID'), { status: 400 });
          const [pkg] = await tq('SELECT * FROM packages WHERE id = $1', [d.package_id]);
          if (!pkg) throw Object.assign(new Error(`运单 ${d.tracking_no} 不存在`), { status: 400 });
          const movedDuringCount = await findPeriodMove(pkg.id, stocktake, 'from', d.expected_location_id, tq);
          if (movedDuringCount) {
            throw Object.assign(
              new Error(`运单 ${d.tracking_no} 在盘点期间存在移位/装车流水，不能判为盘亏；请重新复盘`),
              { status: 409 }
            );
          }
          if (pkg.current_location_id !== d.expected_location_id) {
            throw Object.assign(
              new Error(`运单 ${d.tracking_no} 复核后账面位置已变化，请重新复盘`),
              { status: 409 }
            );
          }
          const from = pkg.current_location_id;
          await tq(`UPDATE packages SET status = 'lost', current_location_id = $1 WHERE id = $2`, [lostLoc.id, pkg.id]);
          await tq('UPDATE stocktake_differences SET adjusted_at = NOW() WHERE id = $1', [d.id]);
          await recordMovement({
            packageId: pkg.id,
            fromLocationId: from,
            toLocationId: lostLoc.id,
            movementType: 'adjust-shortage',
            stocktakeId: stocktake.id,
            note: d.resolution_note || '盘亏复核后调账',
          }, tq);
        }

        if (d.diff_type === 'misplaced') {
          const [pkg] = await tq('SELECT * FROM packages WHERE id = $1', [d.package_id]);
          if (!pkg) throw Object.assign(new Error(`运单 ${d.tracking_no} 不存在`), { status: 400 });
          if (pkg.current_location_id === d.actual_location_id) {
            await tq('UPDATE stocktake_differences SET adjusted_at = NOW() WHERE id = $1', [d.id]);
            continue;
          }
          const movedAfterFreeze = await tq(
            `SELECT 1 FROM package_movements
             WHERE package_id = $1 AND created_at > $2 LIMIT 1`,
            [pkg.id, stocktake.completed_at]
          );
          if (movedAfterFreeze.length) {
            throw Object.assign(
              new Error(`运单 ${d.tracking_no} 在实盘冻结后发生移动，请重新复盘`),
              { status: 409 }
            );
          }
          const from = pkg.current_location_id;
          await tq('UPDATE packages SET current_location_id = $1 WHERE id = $2', [d.actual_location_id, pkg.id]);
          await tq('UPDATE stocktake_differences SET adjusted_at = NOW() WHERE id = $1', [d.id]);
          await recordMovement({
            packageId: pkg.id,
            fromLocationId: from,
            toLocationId: d.actual_location_id,
            movementType: 'adjust-misplace',
            stocktakeId: stocktake.id,
            note: d.resolution_note || '错位复核后调整到实盘库位',
          }, tq);
        }
      }

      await tq(
        `UPDATE stocktakes SET status = 'adjusted', adjusted_at = NOW(), reviewed_at = COALESCE(reviewed_at, NOW())
         WHERE id = $1`,
        [stocktake.id]
      );
    });
    res.json(await buildDetail(stocktake.id));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.post('/:id/cancel', async (req, res) => {
  const stocktake = await getStocktake(req.params.id);
  if (!stocktake) return res.status(404).json({ error: '盘点单不存在' });
  if (stocktake.status === 'adjusted') return res.status(409).json({ error: '已调账盘点单不能取消' });
  await query("UPDATE stocktakes SET status = 'cancelled' WHERE id = $1", [stocktake.id]);
  res.json(await buildDetail(stocktake.id));
});

export default router;
