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
  -- 出港配载参数
  capacity_kg       NUMERIC(10,2) NOT NULL DEFAULT 8000,  -- 额定载重
  cutoff_min        INTEGER,        -- 截单时间：计划发车前 N 分钟停止自动配载（NULL=不限制）
  destinations      TEXT[],         -- 本班次可承载的目的地（NULL 或空=不限制）
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
  loaded_at             TIMESTAMPTZ,                 -- 实际装车（随配载单发车）时间
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_vehicle   ON packages(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_dest      ON packages(destination);
CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status);

-- ── 出港配载单（调度在场包裹 → 出港班次）─────────────────────────────
-- 状态机: draft草稿(可拆单/撤配/改配) → sealed封车(待发车，不可改)
--        → departed随班发车(实际清单锁定) → cancelled撤单
CREATE TABLE IF NOT EXISTS load_plans (
  id             SERIAL PRIMARY KEY,
  plan_no        VARCHAR(32) UNIQUE NOT NULL,
  vehicle_id     INTEGER NOT NULL REFERENCES vehicles(id),
  destination    VARCHAR(50),                        -- 配载目的地（一张单一个流向；NULL=混装）
  cutoff_at      TIMESTAMPTZ,                        -- 截单时间（发车前截止自动配载）
  capacity_kg    NUMERIC(10,2) NOT NULL,             -- 本单配载上限（默认取车辆剩余载重）
  status         VARCHAR(20) NOT NULL DEFAULT 'draft',
  sealed_at      TIMESTAMPTZ,
  departed_at    TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  cancel_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     VARCHAR(50)                         -- 调度（manual / auto）
);
CREATE INDEX IF NOT EXISTS idx_load_plans_vehicle ON load_plans(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_load_plans_status  ON load_plans(status);

-- 配载明细：包裹与配载单的占用关系
CREATE TABLE IF NOT EXISTS load_plan_items (
  id          SERIAL PRIMARY KEY,
  plan_id     INTEGER NOT NULL REFERENCES load_plans(id) ON DELETE CASCADE,
  package_id  INTEGER NOT NULL REFERENCES packages(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by    VARCHAR(50),
  removed_at  TIMESTAMPTZ,                            -- 改配/撤单时置位（历史留痕），生效占用只看 NULL
  UNIQUE (plan_id, package_id)
);
CREATE INDEX IF NOT EXISTS idx_lpi_package ON load_plan_items(package_id);
CREATE INDEX IF NOT EXISTS idx_lpi_active  ON load_plan_items(package_id) WHERE removed_at IS NULL;

-- 超时规则配置（分钟），可在页面上调整
CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(50) PRIMARY KEY,
  value NUMERIC NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('unload_timeout_min', 30),   -- 到车后 N 分钟内应完成卸车
  ('sort_timeout_min',   60),   -- 卸车完成后 N 分钟内应完成分拣
  ('warn_ratio',         0.8),  -- 达到时限 80% 触发黄色预警
  ('cutoff_lead_min',    30)    -- 默认截单提前量：计划发车前 N 分钟
ON CONFLICT (key) DO NOTHING;

-- 旧库平滑升级（列/表已存在时不报错）
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS capacity_kg  NUMERIC(10,2) NOT NULL DEFAULT 8000;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS cutoff_min   INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS destinations TEXT[];
ALTER TABLE packages ADD COLUMN IF NOT EXISTS loaded_at    TIMESTAMPTZ;

-- 已有班次按线路编码回填可达目的地（仅在未设置时）
UPDATE vehicles SET destinations = array_remove(ARRAY[
  CASE split_part(route_code, '-', 2)
    WHEN 'SH' THEN '上海' WHEN 'GZ' THEN '广州' WHEN 'SZ' THEN '深圳'
    WHEN 'BJ' THEN '北京' WHEN 'CQ' THEN '重庆' WHEN 'CS' THEN '长沙'
    WHEN 'HZ' THEN '杭州' WHEN 'LZ' THEN '兰州' END,
  CASE split_part(route_code, '-', 1)
    WHEN 'SH' THEN '上海' WHEN 'GZ' THEN '广州' WHEN 'SZ' THEN '深圳'
    WHEN 'BJ' THEN '北京' WHEN 'CQ' THEN '重庆' WHEN 'CS' THEN '长沙'
    WHEN 'HZ' THEN '杭州' WHEN 'XA' THEN '西安' WHEN 'NJ' THEN '南京'
    WHEN 'WH' THEN '武汉' WHEN 'CD' THEN '成都' END
], NULL)
WHERE destinations IS NULL AND route_code LIKE '%-%';
