-- 快递分拨管理系统 数据库结构

-- 车辆班次：记录到车、卸车、分拣、发车全流程时间
CREATE TABLE IF NOT EXISTS vehicles (
  id                SERIAL PRIMARY KEY,
  plate_no          VARCHAR(20) NOT NULL,          -- 车牌号
  route_code        VARCHAR(20) NOT NULL,          -- 线路编码
  driver_name       VARCHAR(50),                   -- 司机
  vehicle_type      VARCHAR(20) NOT NULL DEFAULT 'medium', -- small小车 / medium中车 / large大车 / extra_large特大车
  planned_arrival   TIMESTAMPTZ,                   -- 计划到车时间
  planned_departure TIMESTAMPTZ,                   -- 计划发车时间
  arrived_at        TIMESTAMPTZ,                   -- 实际到车时间
  unload_start_at   TIMESTAMPTZ,                   -- 卸车开始
  unload_end_at     TIMESTAMPTZ,                   -- 卸车完成
  sort_start_at     TIMESTAMPTZ,                   -- 分拣开始
  sort_end_at       TIMESTAMPTZ,                   -- 分拣完成
  departed_at       TIMESTAMPTZ,                   -- 实际发车时间
  -- 状态机: expected待到车 → arrived已到车 → unloading卸车中 → unloaded待分拣
  --        → sorting分拣中 → sorted待发车 → departed已发车
  status            VARCHAR(20) NOT NULL DEFAULT 'expected',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 包裹
CREATE TABLE IF NOT EXISTS packages (
  id                    SERIAL PRIMARY KEY,
  tracking_no           VARCHAR(32) UNIQUE NOT NULL, -- 运单号
  vehicle_id            INTEGER REFERENCES vehicles(id),
  destination           VARCHAR(50) NOT NULL,        -- 目的地（城市）
  weight_kg             NUMERIC(8,2) NOT NULL DEFAULT 1,
  -- 状态机: pending待分拣 → sorted已分拣 → loaded已装车；intercepted已拦截（异常）
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  is_abnormal           BOOLEAN NOT NULL DEFAULT FALSE,
  abnormal_type         VARCHAR(30),                 -- damaged破损/wrong_route错分/overweight超重/prohibited违禁品/address_issue地址异常
  abnormal_note         TEXT,
  intercepted_at        TIMESTAMPTZ,                 -- 拦截时间
  intercept_released_at TIMESTAMPTZ,                 -- 解除拦截时间
  sorted_at             TIMESTAMPTZ,                 -- 分拣完成时间
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 月台：车型适配与临时停用
CREATE TABLE IF NOT EXISTS docks (
  id             SERIAL PRIMARY KEY,
  code           VARCHAR(20) UNIQUE NOT NULL,
  dock_name      VARCHAR(50) NOT NULL,
  allowed_types  TEXT[] NOT NULL DEFAULT '{small,medium,large,extra_large}',
  -- active启用 / disabled临时停用
  status         VARCHAR(20) NOT NULL DEFAULT 'active',
  disabled_reason TEXT,
  disabled_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 月台预约。预约只是计划，不代表车辆到场，更不代表月台被占用
CREATE TABLE IF NOT EXISTS appointments (
  id               SERIAL PRIMARY KEY,
  vehicle_id       INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  vehicle_type     VARCHAR(20) NOT NULL DEFAULT 'medium',
  slot_start       TIMESTAMPTZ NOT NULL,
  slot_end         TIMESTAMPTZ NOT NULL,
  -- booked已预约 / checked已到场候叫 / called已叫号靠台 / unloading卸车中 / completed已完成 / cancelled已取消
  status           VARCHAR(20) NOT NULL DEFAULT 'booked',
  source           VARCHAR(20) NOT NULL DEFAULT 'appointment', -- appointment预约 / walkin临时到场
  checked_at       TIMESTAMPTZ,
  queued_at        TIMESTAMPTZ,
  queue_seq        BIGINT,
  called_at        TIMESTAMPTZ,
  is_late          BOOLEAN NOT NULL DEFAULT FALSE,
  priority         INTEGER NOT NULL DEFAULT 100,    -- 数值越大越靠前；有理由插队时调整
  priority_reason  TEXT,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  reschedule_reason TEXT,
  recall_reason    TEXT,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (slot_end > slot_start),
  CHECK (status IN ('booked','checked','called','unloading','completed','cancelled'))
);

-- 实际月台占用：叫号成功才插入，卸车结束/召回后释放
CREATE TABLE IF NOT EXISTS dock_assignments (
  id             SERIAL PRIMARY KEY,
  dock_id        INTEGER NOT NULL REFERENCES docks(id),
  vehicle_id     INTEGER NOT NULL REFERENCES vehicles(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  -- assigned已叫号待靠台 / in_use卸车中 / released正常释放 / cancelled召回或取消
  status         VARCHAR(20) NOT NULL DEFAULT 'assigned',
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unload_start_at TIMESTAMPTZ,
  released_at    TIMESTAMPTZ,
  cancel_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_vehicle   ON packages(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_dest      ON packages(destination);
CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status);

CREATE INDEX IF NOT EXISTS idx_appointments_vehicle ON appointments(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_queue
  ON appointments(priority DESC, is_late ASC, slot_start ASC, queue_seq ASC)
  WHERE status = 'checked';

-- 同一月台同一时间只能有一条未释放占用；同一预约也不能重复占用月台
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_dock_assignment
  ON dock_assignments(dock_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_appointment_assignment
  ON dock_assignments(appointment_id) WHERE released_at IS NULL;

-- 一辆车只能保留一个未结束预约
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_vehicle_appointment
  ON appointments(vehicle_id)
  WHERE status IN ('booked','checked','called','unloading');

CREATE SEQUENCE IF NOT EXISTS appointment_queue_seq;

-- 兼容已存在数据库：补齐旧库新增列与约束
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vehicles' AND column_name='vehicle_type') THEN
    ALTER TABLE vehicles ADD COLUMN vehicle_type VARCHAR(20) NOT NULL DEFAULT 'medium';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_vehicles_type') THEN
    ALTER TABLE vehicles ADD CONSTRAINT ck_vehicles_type
      CHECK (vehicle_type IN ('small','medium','large','extra_large'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_docks_status') THEN
    ALTER TABLE docks ADD CONSTRAINT ck_docks_status CHECK (status IN ('active','disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_assignments_status') THEN
    ALTER TABLE dock_assignments
      ADD CONSTRAINT ck_assignments_status CHECK (status IN ('assigned','in_use','released','cancelled'));
  END IF;
END $$;

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
