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

-- 已装车时间（用于交接后追溯"后续处理去向"）；IF NOT EXISTS 兼容旧库
ALTER TABLE packages ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────
-- 班次交接
-- ─────────────────────────────────────────────────────────────

-- 作业班次实例：白班/中班/夜班，夜班可跨午夜
CREATE TABLE IF NOT EXISTS shifts (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(30) NOT NULL,                 -- 班次名称（白班/夜班/…）
  shift_code  VARCHAR(20) NOT NULL DEFAULT 'custom',-- day/swing/night/custom
  work_date   DATE NOT NULL,                        -- 作业归属日期（按当地日历，跨午夜的夜班归开始日）
  start_at    TIMESTAMPTZ NOT NULL,                 -- 上班时间
  end_at      TIMESTAMPTZ,                          -- 下班时间（开放班可为空）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_date, shift_code)
);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(start_at);

-- 交接单：一次班次间移交的单据头，状态机 draft草稿 → pending待签收 → signed已签收 / cancelled已取消
-- 签收后除查询外不允许任何写操作（刷新不能改写历史交接结果）
CREATE TABLE IF NOT EXISTS shift_handovers (
  id            SERIAL PRIMARY KEY,
  handover_no   VARCHAR(40) UNIQUE NOT NULL,        -- 交接单号 JD-YYYYMMDD-序号
  shift_id      INTEGER NOT NULL REFERENCES shifts(id),  -- 交出班次
  to_shift_id   INTEGER NOT NULL REFERENCES shifts(id),  -- 接班班次
  status        VARCHAR(20) NOT NULL DEFAULT 'draft',
  summary_note  TEXT,                               -- 交班总体说明
  created_by    VARCHAR(50) NOT NULL DEFAULT '交班人',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at  TIMESTAMPTZ,                        -- 交班人提交（开始接班签收）
  signed_by     VARCHAR(50),                        -- 签收人
  signed_at     TIMESTAMPTZ,                        -- 签收时间（快照冻结点）
  cancelled_by  VARCHAR(50),
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_ho_fromshift ON shift_handovers(shift_id);
CREATE INDEX IF NOT EXISTS idx_ho_toshift   ON shift_handovers(to_shift_id);
CREATE INDEX IF NOT EXISTS idx_ho_status    ON shift_handovers(status);

-- 交接事项：车辆/包裹/拦截件/超时/自定义补充，逐条接收或退回
CREATE TABLE IF NOT EXISTS shift_handover_items (
  id              SERIAL PRIMARY KEY,
  handover_id     INTEGER NOT NULL REFERENCES shift_handovers(id) ON DELETE CASCADE,
  item_type       VARCHAR(20) NOT NULL,             -- vehicle/package/intercept/alert/note
  item_key        VARCHAR(40) NOT NULL,             -- veh:<id> / pkg:<id> / itc:<id> / alt:<vid>:<stage> / note:<id>
  ref_id          INTEGER,
  title           VARCHAR(100) NOT NULL,
  subtitle        VARCHAR(200),
  detail          TEXT,
  item_note       TEXT,                             -- 交班人逐条补充说明
  snapshot        JSONB NOT NULL,                   -- 建单时快照（签收后永久保留，不再变更）
  source_item_id  INTEGER REFERENCES shift_handover_items(id), -- 上一交接单同一事项（再次转交追溯链）
  -- pending待接收 → accepted已接收 / returned已退回；交接期间作业完成 → resolved（无需再移交）
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  decision_note   TEXT,                             -- 退回原因等
  decided_by      VARCHAR(50),
  decided_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,                      -- 交接期间被完成的时间
  resolved_note   TEXT,                             -- 变化说明（如"已发车离场"）
  is_appended     BOOLEAN NOT NULL DEFAULT FALSE,   -- 交接进行中由交班人追加
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (handover_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_hi_handover ON shift_handover_items(handover_id);
CREATE INDEX IF NOT EXISTS idx_hi_key      ON shift_handover_items(item_key);
CREATE INDEX IF NOT EXISTS idx_hi_source   ON shift_handover_items(source_item_id);

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
