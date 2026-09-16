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

-- 账号：status = active启用 / disabled停用
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,   -- 登录账号
  display_name  VARCHAR(50) NOT NULL,          -- 姓名
  password_hash TEXT NOT NULL,                 -- scrypt: salt:hash
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 岗位（一人可兼多岗，权限取并集）
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    VARCHAR(20) NOT NULL,                -- dispatcher调度/sorter分拣/exception异常处理/admin管理员
  PRIMARY KEY (user_id, role)
);

-- 登录会话（服务端会话，可撤销；权限按请求实时校验，不随会话缓存）
CREATE TABLE IF NOT EXISTS sessions (
  id            VARCHAR(64) PRIMARY KEY,       -- 访问令牌
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,                   -- 撤销时间（NULL=有效）
  revoke_reason VARCHAR(50)                    -- logout手动退出/account_disabled账号停用/password_reset密码重置/revoked_by_admin管理员撤销
);

-- 操作审计：关键业务动作的操作者与变更前后记录
CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  actor_id    INTEGER,                         -- 操作者账号ID（登录失败等场景可为空）
  actor_name  VARCHAR(120) NOT NULL,           -- 操作者显示名(账号)
  action      VARCHAR(50) NOT NULL,            -- 动作标识，如 package.intercept
  target_type VARCHAR(30),                     -- 对象类型：vehicle/package/settings/user
  target_id   VARCHAR(50),                     -- 对象ID
  detail      JSONB,                           -- { before, after, extra } 变更前后内容
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_logs(action);
