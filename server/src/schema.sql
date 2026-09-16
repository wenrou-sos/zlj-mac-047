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
  -- 状态机: pending待分拣 → sorted已分拣 → loaded已装车
  --        intercepted已拦截（存在未结工单）；returned已退回（独立去向，不计入待发库存）
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  is_abnormal           BOOLEAN NOT NULL DEFAULT FALSE,
  abnormal_type         VARCHAR(30),                 -- damaged破损/wrong_route错分/overweight超重/prohibited违禁品/address_issue地址异常
  abnormal_note         TEXT,
  intercepted_at        TIMESTAMPTZ,                 -- 最近一次拦截时间
  intercept_released_at TIMESTAMPTZ,                 -- 最近一次修复放行时间
  sorted_at             TIMESTAMPTZ,                 -- 分拣完成时间
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 退回件独立去向（存量库补充列）
ALTER TABLE packages ADD COLUMN IF NOT EXISTS return_destination VARCHAR(50); -- 退回去向
ALTER TABLE packages ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;        -- 退回时间

-- 异常处置工单：每次拦截生成一张独立工单，同一包裹多次异常分别留档
CREATE TABLE IF NOT EXISTS work_orders (
  id                 SERIAL PRIMARY KEY,
  package_id         INTEGER NOT NULL REFERENCES packages(id),
  abnormal_type      VARCHAR(30) NOT NULL,         -- 异常类型（拦截时快照）
  note               TEXT,                         -- 拦截备注
  -- 状态机: open待认领 → processing处理中 → pending_review待复核 → closed已结案
  --        （复核驳回退回 processing 继续处理）
  status             VARCHAR(20) NOT NULL DEFAULT 'open',
  conclusion         VARCHAR(20),                  -- repair_release修复放行 / return退回 / isolate继续隔离
  conclusion_note    TEXT,                         -- 处理结论说明
  return_destination VARCHAR(50),                  -- 结论为退回时的独立去向
  created_by         VARCHAR(50) NOT NULL,         -- 拦截登记人
  assignee           VARCHAR(50),                  -- 当前处理人（认领/转交后）
  submitted_by       VARCHAR(50),                  -- 结论提交人
  reviewed_by        VARCHAR(50),                  -- 复核人（不可与提交人相同）
  review_note        TEXT,                         -- 复核意见
  reject_count       INTEGER NOT NULL DEFAULT 0,   -- 被驳回次数
  claimed_at         TIMESTAMPTZ,
  submitted_at       TIMESTAMPTZ,
  reviewed_at        TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 工单流转留档：认领/转交/补充证据/提交结论/复核 全程留痕
CREATE TABLE IF NOT EXISTS work_order_events (
  id            SERIAL PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  -- create创建 / claim认领 / transfer转交 / evidence补充证据 / submit提交结论 / reject复核驳回 / approve复核通过 / auto_close自动结案
  action        VARCHAR(20) NOT NULL,
  actor         VARCHAR(50) NOT NULL,
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_packages_vehicle   ON packages(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_packages_status    ON packages(status);
CREATE INDEX IF NOT EXISTS idx_packages_dest      ON packages(destination);
CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_package ON work_orders(package_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status  ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_wo_events_order     ON work_order_events(work_order_id);

-- 操作用户：工单认领/提交/复核等动作的身份来源（服务端会话，非客户端自报）
CREATE TABLE IF NOT EXISTS users (
  username      VARCHAR(30) PRIMARY KEY,
  display_name  VARCHAR(50) NOT NULL,
  password_hash VARCHAR(64) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
