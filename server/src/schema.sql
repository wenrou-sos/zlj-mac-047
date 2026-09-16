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

-- ── 预警事件：一次超时 = 一个可认领、可追溯的事件 ──
-- 一辆车在一个环节的超时对应一行；环节完成（恢复）后关闭，再次超时另起新事件
CREATE TABLE IF NOT EXISTS alert_events (
  id                  SERIAL PRIMARY KEY,
  vehicle_id          INTEGER NOT NULL REFERENCES vehicles(id),
  stage               VARCHAR(20) NOT NULL,           -- unload卸车 / sort分拣 / departure发车
  initial_level       VARCHAR(10) NOT NULL,           -- warn预警 / overdue超时，首次触发时级别
  -- open待处理 / escalated已升级主管 / resolved已处理待恢复 / recovered已恢复关闭
  status              VARCHAR(12) NOT NULL DEFAULT 'open',
  -- 规则快照：事件创建时采用的阈值，落库冻结；之后调规则不影响本事件、只作用于新事件
  rule_snapshot       JSONB NOT NULL,
  threshold_min       NUMERIC NOT NULL,               -- 采用的时限（分钟）；发车环节为 0（以计划发车时间为准）
  due_at              TIMESTAMPTZ NOT NULL,           -- 按快照规则算出的截止时刻
  first_triggered_at  TIMESTAMPTZ NOT NULL,           -- 首次触发时间（黄色预警时刻）
  warn_at             TIMESTAMPTZ,                    -- 进入黄色预警时间
  overdue_at          TIMESTAMPTZ,                    -- 升级为红色超时时间
  acknowledged_at     TIMESTAMPTZ,                    -- 处理人确认时间
  assigned_to         VARCHAR(50),                    -- 处理人
  escalated_at        TIMESTAMPTZ,                    -- 升级到主管待办时间
  escalation_reason   VARCHAR(200),
  resolved_at         TIMESTAMPTZ,                    -- 处理人标记处理完成时间
  resolved_by         VARCHAR(50),
  recovered_at        TIMESTAMPTZ,                    -- 车辆恢复、事件结束时间
  close_note          TEXT,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 同一车辆同一环节，未关闭事件全局唯一：刷新/并发都不会重复生成
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_event_open
  ON alert_events(vehicle_id, stage) WHERE status <> 'recovered';
CREATE INDEX IF NOT EXISTS idx_alert_events_status ON alert_events(status);

-- 事件处理记录（台账：触发/升级/认领/备注/处理/恢复全程留痕）
CREATE TABLE IF NOT EXISTS alert_event_logs (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  action      VARCHAR(20) NOT NULL,   -- trigger/overdue/escalated/claim/comment/resolve/reassign/recovered
  actor       VARCHAR(50),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_logs_event ON alert_event_logs(event_id, id);

-- 超时规则调整台账：阈值每次修改都留痕，事件按 rule_snapshot 可反查采用的是哪版规则
CREATE TABLE IF NOT EXISTS settings_history (
  id          SERIAL PRIMARY KEY,
  key         VARCHAR(50) NOT NULL,
  old_value   NUMERIC,
  new_value   NUMERIC NOT NULL,
  changed_by  VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settings_history_key ON settings_history(key, id);

INSERT INTO settings (key, value) VALUES
  ('response_timeout_min', 15),   -- 响应期限：触发后 N 分钟无人确认 → 自动进主管待办
  ('escalation_grace_min', 15)    -- 升级宽限：红色超时后 N 分钟仍未恢复 → 自动进主管待办
ON CONFLICT (key) DO NOTHING;
