-- 快递分拨管理系统 数据库结构

-- 车辆班次：记录到车、卸车、分拣、发车全流程时间
CREATE TABLE IF NOT EXISTS vehicles (
  id                SERIAL PRIMARY KEY,
  plate_no          VARCHAR(20) NOT NULL,          -- 车牌号
  route_code        VARCHAR(20) NOT NULL,          -- 线路编码
  driver_name       VARCHAR(50),                   -- 司机
  planned_arrival   TIMESTAMPTZ,                   -- 计划到车时间
  planned_departure TIMESTAMPTZ,                   -- 计划发车时间
  arrived_at        TIMESTAMPTZ,                   -- 实际到车时间
  unload_start_at   TIMESTAMPTZ,                   -- 卸车开始
  unload_end_at     TIMESTAMPTZ,                   -- 卸车完成
  sort_start_at     TIMESTAMPTZ,                   -- 分拣开始
  sort_end_at       TIMESTAMPTZ,                   -- 分拣完成
  departed_at       TIMESTAMPTZ,                   -- 实际发车时间
  current_location_id INTEGER,                    -- 车辆库位（装车后包裹的有效位置）
  -- 状态机: expected待到车 → arrived已到车 → unloading卸车中 → unloaded待分拣
  --        → sorting分拣中 → sorted待发车 → departed已发车
  status            VARCHAR(20) NOT NULL DEFAULT 'expected',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 场区库位/车辆库位。同一件包裹在任一时刻只能指向一个 current_location_id。
CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(40) NOT NULL,
  loc_type    VARCHAR(20) NOT NULL,               -- receiving/sorting/storage/intercept/vehicle/lost
  zone        VARCHAR(50) NOT NULL DEFAULT '场区',
  name        VARCHAR(80) NOT NULL,
  ref_id      VARCHAR(40),                        -- 车辆库位对应 vehicles.id
  capacity    INTEGER,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT locations_type_chk CHECK (
    loc_type IN ('receiving','sorting','storage','intercept','vehicle','lost')
  )
);
-- 统一唯一编码：场区库位与 VEH-* 车辆库位共用同一命名空间
DROP INDEX IF EXISTS uq_locations_yard_code;
DROP INDEX IF EXISTS uq_locations_vehicle_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_code ON locations(code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_vehicle_ref
  ON locations(ref_id) WHERE loc_type = 'vehicle';
CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(loc_type, is_active);

-- 包裹
CREATE TABLE IF NOT EXISTS packages (
  id                    SERIAL PRIMARY KEY,
  tracking_no           VARCHAR(32) UNIQUE NOT NULL, -- 运单号
  vehicle_id            INTEGER REFERENCES vehicles(id),
  destination           VARCHAR(50) NOT NULL,        -- 目的地（城市）
  weight_kg             NUMERIC(8,2) NOT NULL DEFAULT 1,
  -- 作业生命周期：pending待分拣 → sorted已分拣 → loaded已装车 → departed随单车离场；lost盘亏
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- 拦截处置状态与位置/生命周期分离：none未拦截 / held拦截中 / released已解除
  intercept_status      VARCHAR(20) NOT NULL DEFAULT 'none',
  is_abnormal           BOOLEAN NOT NULL DEFAULT FALSE,
  abnormal_type         VARCHAR(30),                 -- damaged破损/wrong_route错分/overweight超重/prohibited违禁品/address_issue地址异常
  abnormal_note         TEXT,
  intercepted_at        TIMESTAMPTZ,                 -- 拦截时间
  intercept_released_at TIMESTAMPTZ,                 -- 解除拦截时间
  current_location_id   INTEGER REFERENCES locations(id),
  sorted_at             TIMESTAMPTZ,                 -- 分拣完成时间
  loaded_at             TIMESTAMPTZ,                 -- 装车时间
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 兼容旧库：新列存在后再补充字段
ALTER TABLE packages ADD COLUMN IF NOT EXISTS intercept_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE packages ADD COLUMN IF NOT EXISTS current_location_id INTEGER;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMPTZ;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS current_location_id INTEGER;

-- 旧版本用 status='intercepted' 同时表达位置与处置；迁移后二者分离
UPDATE packages
SET intercept_status = 'held',
    is_abnormal = TRUE,
    status = CASE WHEN sorted_at IS NOT NULL THEN 'sorted' ELSE 'pending' END
WHERE status = 'intercepted';
UPDATE packages SET intercept_status = 'released'
WHERE intercept_status = 'active' AND intercepted_at IS NOT NULL AND intercept_released_at IS NOT NULL;
UPDATE packages SET intercept_status = 'none'
WHERE intercepted_at IS NULL AND intercept_status = 'active';
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_intercept_status_chk;
ALTER TABLE packages ADD CONSTRAINT packages_intercept_status_chk
  CHECK (intercept_status IN ('none','held','released'));

CREATE INDEX IF NOT EXISTS idx_packages_vehicle   ON packages(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_dest      ON packages(destination);
CREATE INDEX IF NOT EXISTS idx_packages_location  ON packages(current_location_id);
CREATE INDEX IF NOT EXISTS idx_packages_held      ON packages(intercept_status) WHERE intercept_status = 'held';
CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status);

-- 包裹位置流水：到件、上架、移位、装车、盘点调整都保留不可变轨迹
CREATE TABLE IF NOT EXISTS package_movements (
  id               SERIAL PRIMARY KEY,
  package_id       INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  from_location_id INTEGER REFERENCES locations(id),
  to_location_id   INTEGER REFERENCES locations(id),
  movement_type    VARCHAR(30) NOT NULL,          -- receive/putaway/relocate/load/adjust-surplus/adjust-shortage/adjust-misplace
  stocktake_id     INTEGER,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_movements_package ON package_movements(package_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_stocktake ON package_movements(stocktake_id);
CREATE INDEX IF NOT EXISTS idx_movements_time ON package_movements(created_at);

-- 滚动盘点单
CREATE TABLE IF NOT EXISTS stocktakes (
  id              SERIAL PRIMARY KEY,
  location_id     INTEGER NOT NULL REFERENCES locations(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'counting', -- counting/reviewing/adjusted/cancelled
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  reviewed_at     TIMESTAMPTZ,
  adjusted_at     TIMESTAMPTZ,
  created_by      VARCHAR(50),
  reviewed_by     VARCHAR(50),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stocktakes_location_status ON stocktakes(location_id, status);
CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status);

-- 盘点时点账面快照
CREATE TABLE IF NOT EXISTS stocktake_snapshots (
  id                SERIAL PRIMARY KEY,
  stocktake_id      INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  package_id        INTEGER NOT NULL REFERENCES packages(id),
  expected_location_id INTEGER NOT NULL REFERENCES locations(id),
  result            VARCHAR(20) NOT NULL DEFAULT 'pending', -- matched/shortage/period_out/shipped
  UNIQUE (stocktake_id, package_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_stocktake ON stocktake_snapshots(stocktake_id, result);

-- 实盘扫描
CREATE TABLE IF NOT EXISTS stocktake_scans (
  id                SERIAL PRIMARY KEY,
  stocktake_id      INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  package_id        INTEGER REFERENCES packages(id),
  tracking_no       VARCHAR(32) NOT NULL,
  observed_location_id INTEGER NOT NULL REFERENCES locations(id),
  result            VARCHAR(20) NOT NULL DEFAULT 'pending', -- matched/misplaced/surplus/period_in/period_out
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_stocktake ON stocktake_scans(stocktake_id, result);
CREATE INDEX IF NOT EXISTS idx_scans_package ON stocktake_scans(package_id);

-- 盘点差异：盘盈/盘亏/错位；复核后才允许调整账面
CREATE TABLE IF NOT EXISTS stocktake_differences (
  id                SERIAL PRIMARY KEY,
  stocktake_id      INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  package_id        INTEGER REFERENCES packages(id),
  tracking_no       VARCHAR(32) NOT NULL,
  diff_type         VARCHAR(20) NOT NULL,          -- surplus/shortage/misplaced
  expected_location_id INTEGER REFERENCES locations(id),
  actual_location_id   INTEGER REFERENCES locations(id),
  actual_destination   VARCHAR(50),
  resolution        VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending/confirmed/dismissed
  resolution_note   TEXT,
  reviewed_by       VARCHAR(50),
  reviewed_at       TIMESTAMPTZ,
  adjusted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_diffs_stocktake ON stocktake_differences(stocktake_id, resolution, diff_type);

-- 初始化场区默认库位（不用 ON CONFLICT 推断，兼容已存在数据的旧库）
INSERT INTO locations (code, loc_type, zone, name, capacity)
SELECT v.code, v.loc_type, v.zone, v.name, v.capacity
FROM (VALUES
  ('RECV-01', 'receiving', '收货区', '到件暂存区', 300),
  ('SORT-01', 'sorting', '分拣区', '分拣作业区', 300),
  ('HOLD-01', 'intercept', '异常处理区', '拦截件隔离区', 100),
  ('LOST-01', 'lost', '虚拟库位', '盘亏/失踪虚拟库位', NULL::int),
  ('A-01-01', 'storage', 'A区01架', 'A区 01 架 01 层', 80),
  ('A-01-02', 'storage', 'A区01架', 'A区 01 架 02 层', 80),
  ('A-02-01', 'storage', 'A区02架', 'A区 02 架 01 层', 80),
  ('B-01-01', 'storage', 'B区01架', 'B区 01 架 01 层', 80),
  ('B-01-02', 'storage', 'B区01架', 'B区 01 架 02 层', 80)
) AS v(code, loc_type, zone, name, capacity)
WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.code = v.code);

-- 兼容旧车辆数据：每辆车对应一个车辆库位，保证“同一件只有一个有效位置”
INSERT INTO locations (code, loc_type, zone, name, ref_id, is_active)
SELECT 'VEH-' || v.id, 'vehicle', '车辆月台', v.plate_no || '（车辆库位）', v.id::text, TRUE
FROM vehicles v
WHERE NOT EXISTS (
  SELECT 1 FROM locations l WHERE l.loc_type = 'vehicle' AND l.ref_id = v.id::text
);

UPDATE vehicles v
SET current_location_id = l.id
FROM locations l
WHERE l.loc_type = 'vehicle' AND l.ref_id = v.id::text AND v.current_location_id IS NULL;

-- 兼容旧包裹数据：按原状态补齐唯一有效位置
UPDATE packages p
SET current_location_id = COALESCE(
  CASE
    WHEN p.status = 'loaded' THEN (
      SELECT l.id FROM locations l WHERE l.loc_type = 'vehicle' AND l.ref_id = p.vehicle_id::text
    )
    WHEN p.intercept_status = 'held' THEN (SELECT id FROM locations WHERE code = 'HOLD-01')
    WHEN p.status = 'pending' THEN (SELECT id FROM locations WHERE code = 'SORT-01')
    WHEN p.status = 'sorted' THEN (SELECT id FROM locations WHERE code = CASE p.id % 3 WHEN 0 THEN 'A-01-01' WHEN 1 THEN 'A-01-02' ELSE 'A-02-01' END)
    ELSE (SELECT id FROM locations WHERE code = 'RECV-01')
  END,
  (SELECT id FROM locations WHERE code = 'RECV-01')
)
WHERE p.current_location_id IS NULL;

-- 超时规则配置（分钟），可在页面上调整
CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(50) PRIMARY KEY,
  value NUMERIC NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('unload_timeout_min', 30),   -- 到车后 N 分钟内应完成卸车
  ('sort_timeout_min',   60),   -- 卸车完成后 N 分钟内应完成分拣
  ('warn_ratio',         0.8)   -- 达到时限 80% 触发黄色预警
ON CONFLICT (key) DO NOTHING;
