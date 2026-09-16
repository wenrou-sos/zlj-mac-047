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
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_vehicle   ON packages(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_dest      ON packages(destination);
CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status);

-- ── 分拣规则与格口 ──────────────────────────────────────────────

-- 格口（分拣流向的物理出口）
CREATE TABLE IF NOT EXISTS chutes (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(20) UNIQUE NOT NULL,       -- 格口编码，如 A01
  name        VARCHAR(50) NOT NULL,              -- 格口名称/方向说明
  status      VARCHAR(20) NOT NULL DEFAULT 'active', -- active启用 / disabled停用
  disabled_at TIMESTAMPTZ,                       -- 停用时间
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 规则版本：draft草稿（试算中）→ published已发布 → archived已归档
-- 同一时间最多一个草稿、一个发布版；已分拣包裹通过 rule_version_id 保留当时版本
CREATE TABLE IF NOT EXISTS rule_versions (
  id           SERIAL PRIMARY KEY,
  version_no   INTEGER NOT NULL DEFAULT 0,       -- 发布时分配的递增版本号（草稿为 0）
  status       VARCHAR(20) NOT NULL DEFAULT 'draft',
  simulated_at TIMESTAMPTZ,                      -- 最近试算时间（规则变更即清空，未试算不得发布）
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rule_versions ADD COLUMN IF NOT EXISTS simulated_at TIMESTAMPTZ;

-- 分拣规则：按目的地 + 包裹属性（重量区间）匹配，指向目标格口
CREATE TABLE IF NOT EXISTS sort_rules (
  id          SERIAL PRIMARY KEY,
  version_id  INTEGER NOT NULL REFERENCES rule_versions(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 100,      -- 优先级，数字小者优先；同级多规则命中即冲突
  destination VARCHAR(50),                       -- 目的地（NULL = 任意目的地）
  min_weight  NUMERIC(8,2),                      -- 重量下限 kg（含，NULL = 不限）
  max_weight  NUMERIC(8,2),                      -- 重量上限 kg（不含，NULL = 不限）
  chute_id    INTEGER NOT NULL REFERENCES chutes(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sort_rules_version ON sort_rules(version_id);

-- 包裹表扩展：分拣决策与待判区（对已有数据库幂等）
ALTER TABLE packages ADD COLUMN IF NOT EXISTS chute_id        INTEGER REFERENCES chutes(id); -- 目标格口
ALTER TABLE packages ADD COLUMN IF NOT EXISTS rule_id         INTEGER;   -- 命中的规则（快照）
ALTER TABLE packages ADD COLUMN IF NOT EXISTS rule_version_id INTEGER;   -- 命中时的规则版本
ALTER TABLE packages ADD COLUMN IF NOT EXISTS hit_reason      TEXT;      -- 命中原因（文本快照，规则删改后仍可追溯）
ALTER TABLE packages ADD COLUMN IF NOT EXISTS needs_review    BOOLEAN NOT NULL DEFAULT FALSE; -- 待判区标记
ALTER TABLE packages ADD COLUMN IF NOT EXISTS review_note     TEXT;      -- 复核备注
ALTER TABLE packages ADD COLUMN IF NOT EXISTS resorted_at     TIMESTAMPTZ; -- 最近重分时间（首分为 NULL）
-- 完成量口径：sorted_at 仅在首次分拣时写入，回流重分不覆盖、不重复计数

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
