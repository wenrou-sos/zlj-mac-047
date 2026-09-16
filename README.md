# 快递分拨管理系统 (Express Hub)

记录分拨中心 **到车 → 卸车 → 分拣 → 发车** 全流程时间节点，提供 **超时预警、积压统计、异常件拦截** 能力。
系统需登录使用，按 **调度 / 分拣 / 异常处理 / 管理员** 岗位授权，关键业务动作全程留痕。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + Recharts + lucide-react |
| 后端 | Node.js + Express |
| 数据库 | PostgreSQL（默认 PGlite 嵌入式，无需安装；支持切换真实 PostgreSQL） |
| 认证 | 服务端会话（Bearer Token）+ scrypt 密码散列（Node 内置，无额外依赖） |

## 快速开始

```bash
# 1. 启动后端（首次启动自动建表 + 灌入模拟数据 + 创建演示账号）
cd server && npm install && npm start        # http://localhost:3001

# 2. 启动前端（另开终端）
cd client && npm install && npm run dev      # http://localhost:5173
```

浏览器打开 http://localhost:5173 ，使用演示账号登录。

## 演示账号（首次启动自动创建）

| 账号 | 密码 | 岗位 | 可执行操作 |
|---|---|---|---|
| `admin` | `admin123` | 管理员 | 全部业务 + 超时规则 + 账号/岗位/会话管理 + 操作日志 |
| `dispatcher` | `dispatch123` | 调度 | 到车预报、班次推进（到车/卸车/分拣/发车）、删除预报 |
| `sorter` | `sort123` | 分拣 | 到件登记、分拣、装车 |
| `exception` | `exception123` | 异常处理 | 异常拦截、解除拦截 |
| `ops` | `ops123` | 调度+分拣（兼岗示例） | 调度与分拣两类操作 |

## 权限与账号体系

- **岗位授权**：页面按钮与后端接口双重校验，直接调用 API 同样按岗位鉴权（401 未登录 / 403 无权限）。
- **兼岗**：一个账号可挂多个岗位，权限取并集。
- **权限即时生效**：权限不随会话缓存，每次请求实时校验 —— 管理员调岗、停用账号、撤销会话后，旧会话下一次请求即按新授权执行，无法继续越权。
- **账号安全**：停用账号自动撤销其全部会话；重置密码同样强制重新登录；普通岗位无法访问账号管理接口，不能为自己授权。
- **最后管理员保护**：系统不允许停用或移除「最后一个可用管理员」的岗位，防止误操作导致无人可管。
- **操作留痕**：登记、发车、拦截/解除、修改时限、账号与权限变更等关键动作均记录操作者与变更前后内容，可在「系统管理 → 操作日志」查询。

## 功能说明

### 1. 监控总览
- 在场车辆、待分拣、已装车、拦截件、超时预警 实时指标卡
- 超时预警列表（红色=已超时，黄色=即将超时）
- 包裹状态分布饼图，每 15 秒自动刷新

### 2. 车辆班次（时间记录）
- 班次状态机：`待到车 → 已到车 → 卸车中 → 待分拣 → 分拣中 → 待发车 → 已发车`
- 每个环节一键打卡，自动记录时间戳，四阶段时间线可视化
- 完成分拣时车上待分拣包裹自动转为已分拣；发车时自动装车，**拦截件留置不发**
- 支持到车预报登记与删除

### 3. 超时预警
- **卸车超时**：到车后超过 N 分钟未完成卸车（默认 30）
- **分拣超时**：卸车完成后超过 N 分钟未完成分拣（默认 60）
- **发车超时**：超过计划发车时间未发车
- 达到时限 80% 触发黄色预警；规则可在「积压统计」页在线调整（仅管理员），实时生效

### 4. 积压统计
- 近 24 小时到件/分拣趋势图
- 按目的地、按车辆的积压分布
- 在场车辆积压明细表

### 5. 异常件拦截
- 五种异常类型：外包装破损 / 错分线路 / 超重超限 / 疑似违禁品 / 地址信息异常
- 拦截后**禁止装车**（后端强制校验），处理完成后可解除拦截
- 异常类型分布统计与最近拦截记录

### 6. 系统管理（管理员）
- 账号管理：新建账号、调整岗位（支持兼岗）、停用/启用、重置密码
- 会话管理：查看账号活跃会话、强制撤销会话
- 操作日志：按动作/操作者筛选，查看变更前后对比

## 切换真实 PostgreSQL

```bash
cd server
npm i pg
DATABASE_URL=postgres://user:pass@localhost:5432/express_hub npm start
```

不设置 `DATABASE_URL` 时使用嵌入式 PGlite，数据持久化在 `server/data/`。

## 重置模拟数据

```bash
cd server && npm run seed -- --force
```

（仅重置车辆与包裹业务数据，账号与操作日志保留。）

## API 一览

| 方法 | 路径 | 说明 | 所需权限 |
|---|---|---|---|
| POST | `/api/auth/login` `/logout` | 登录 / 退出 | 公开 / 登录 |
| GET | `/api/auth/me` | 当前会话用户信息 | 登录 |
| GET | `/api/overview` | 总览指标 | 登录 |
| GET | `/api/alerts` | 超时预警列表 | 登录 |
| GET | `/api/settings` | 查询超时规则 | 登录 |
| PUT | `/api/settings` | 修改超时规则 | 管理员 |
| GET | `/api/vehicles` | 班次列表 | 登录 |
| POST | `/api/vehicles` | 到车预报 | 调度 |
| POST | `/api/vehicles/:id/action/:action` | 状态推进（arrive / unload-start / unload-end / sort-start / sort-end / depart） | 调度 |
| DELETE | `/api/vehicles/:id` | 删除预报班次 | 调度 |
| GET | `/api/packages` | 包裹查询 | 登录 |
| POST | `/api/packages` | 到件登记 | 分拣 |
| POST | `/api/packages/:id/sort` `/load` | 分拣 / 装车 | 分拣 |
| POST | `/api/packages/:id/intercept` `/release` | 拦截 / 解除拦截 | 异常处理 |
| GET | `/api/stats/backlog` `/api/stats/abnormal` | 积压 / 异常统计 | 登录 |
| GET/POST | `/api/users` | 账号列表 / 新建账号 | 管理员 |
| PUT | `/api/users/:id/roles` `/status` `/password` | 调岗 / 停用启用 / 重置密码 | 管理员 |
| GET/DELETE | `/api/users/:id/sessions` `(/:sid)` | 会话列表 / 撤销会话 | 管理员 |
| GET | `/api/audit-logs` | 操作日志 | 管理员 |

除登录外所有接口需携带请求头：`Authorization: Bearer <token>`。

## 目录结构

```
express-hub/
├── server/                 # Express 后端
│   └── src/
│       ├── index.js        # 入口
│       ├── db.js           # PGlite / PostgreSQL 适配层
│       ├── schema.sql      # 表结构（业务 + 账号/岗位/会话/审计）
│       ├── auth.js         # 密码散列、会话、鉴权中间件
│       ├── permissions.js  # 岗位-权限定义
│       ├── audit.js        # 操作审计
│       ├── seed.js         # 模拟业务数据
│       ├── seed-users.js   # 演示账号
│       ├── helpers.js      # 超时预警计算、状态机
│       └── routes/         # auth / users / audit / vehicles / packages / stats
└── client/                 # React 前端
    └── src/
        ├── pages/          # 登录 / 总览 / 车辆 / 包裹 / 统计 / 系统管理
        └── components/     # 通用组件
```
