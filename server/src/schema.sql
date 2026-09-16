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
  loaded_at             TIMESTAMPTZ,                 -- 装车时间（手持装车扫描补传 / 发车自动带出）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_vehicle   ON packages(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_dest      ON packages(destination);
CREATE INDEX IF NOT EXISTS idx_packages_tracking  ON packages(tracking_no);
CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status);

-- 手持扫描终端：每次在线/补传时心跳登记，台账可按设备追溯
CREATE TABLE IF NOT EXISTS devices (
  id           VARCHAR(40) PRIMARY KEY,             -- 设备号（手持端生成，长期保存）
  name         VARCHAR(80),                         -- 设备名称/备注
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 手持扫描台账：到件/分拣/装车扫描的幂等补传记账依据
-- 一条扫描（scan_id）在服务端只记账一次；重复补传直接回放首次结果，绝不重复作业
CREATE TABLE IF NOT EXISTS scan_ledger (
  id               BIGSERIAL PRIMARY KEY,
  scan_id          VARCHAR(64) UNIQUE NOT NULL,     -- 设备生成的扫描唯一ID（幂等键）
  device_id        VARCHAR(40) NOT NULL,            -- 扫描设备
  op               VARCHAR(10) NOT NULL,            -- arrive 到件 / sort 分拣 / load 装车
  tracking_no      VARCHAR(32) NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,            -- 扫描实际发生时间（设备时钟，断网期间也保留）
  payload          JSONB NOT NULL DEFAULT '{}',     -- 目的地/车辆/重量/重扫来源等
  -- applied 已入账；conflict 与服务器新状态冲突，已暂停等待人工选择（不会覆盖服务器状态）
  status           VARCHAR(12) NOT NULL DEFAULT 'applied',
  conflict_code    VARCHAR(30),
  conflict_message TEXT,
  package_id       INTEGER,
  server_snapshot  JSONB,                           -- 冲突时服务器快照（包裹/班次当前状态）
  result           JSONB NOT NULL DEFAULT '{}',     -- 首次记账结果（重复补传时原样回放）
  -- 冲突人工处理结论：discarded 放弃（以服务器为准）/ kept 暂留 / retried 已调整重扫
  resolution       VARCHAR(12),
  resolved_at      TIMESTAMPTZ,
  applied_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_device   ON scan_ledger(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_status   ON scan_ledger(status);
CREATE INDEX IF NOT EXISTS idx_scan_tracking ON scan_ledger(tracking_no);

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

-- 兼容已有库：CREATE TABLE IF NOT EXISTS 不会给旧表补列，这里幂等追加
ALTER TABLE packages ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMPTZ;
