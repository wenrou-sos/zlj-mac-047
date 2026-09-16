# 快递分拨管理系统 (Express Hub)

记录分拨中心 **到车 → 卸车 → 分拣 → 出港配载 → 发车** 全流程时间节点，提供 **超时预警、积压统计、异常件拦截、出港配载调度** 能力。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + Recharts + lucide-react |
| 后端 | Node.js + Express |
| 数据库 | PostgreSQL（默认 PGlite 嵌入式，无需安装；支持切换真实 PostgreSQL） |

## 快速开始

```bash
# 1. 启动后端（首次启动自动建表 + 灌入模拟数据）
cd server && npm install && npm start        # http://localhost:3001

# 2. 启动前端（另开终端）
cd client && npm install && npm run dev      # http://localhost:5173
```

浏览器打开 http://localhost:5173 。

## 功能说明

### 1. 监控总览
- 在场车辆、待分拣、已配载待发车、已装车、拦截件、超时预警 实时指标卡
- 超时预警列表（红色=已超时，黄色=即将超时）
- 包裹状态分布饼图（已分拣拆分为「未配载 / 已配载」），每 15 秒自动刷新

### 2. 车辆班次（时间记录）
- 班次状态机：`待到车 → 已到车 → 卸车中 → 待分拣 → 分拣中 → 待发车 → 已发车`
- 每个环节一键打卡，自动记录时间戳，四阶段时间线可视化
- 完成分拣时车上待分拣包裹自动转为已分拣
- 待发车班次可直接进入「出港配载」；**确认发车只锁定本班次生效配载单的实际去向**，进港来源为该车但已改配其它班次的件不会被误装
- 支持到车预报（可带额定载重、截单提前量、承运目的地）与删除

### 3. 出港配载
- 从**在场已分拣件**建立出港配载单，按 **目的地（单一流向）、班次截单时间、额定载重** 自动 FIFO 分配；装不下的件标记数量并**留待下一班**
- 一辆车可挂多张配载单（不同流向），容量取「额定载重 − 其它生效单已占」
- 发车前支持：
  - **拆单 / 撤配**：把勾选件从单上撤下（件回到在场，可再配下班）
  - **改配**：把件移到另一张草稿配载单（同车拆流或换班次），按目标单重新校验目的地、截单、载重
  - **撤单**：整张单作废
  - **封车 / 解封**：封车后清单锁定，发车前可解封调整
- 进港来源班次始终保留在包裹上，配载明细可查每件来源车
- **同一件不能被两张生效配载单占用**：数据库部分唯一索引 + 服务端双重强制
- **拦截件不能放行**：配载校验、封车、发车三处复查，拦截配载中件时自动撤配；已封车需先解封
- 确认发车后配载单置 `departed`，实际清单锁定不可改，包裹按实际去向标记装车时间

### 4. 超时预警
- **卸车超时**：到车后超过 N 分钟未完成卸车（默认 30）
- **分拣超时**：卸车完成后超过 N 分钟未完成分拣（默认 60）
- **发车超时**：超过计划发车时间未发车
- 达到时限 80% 触发黄色预警；规则可在「积压统计」页在线调整，实时生效

### 5. 积压统计
- 近 24 小时到件/分拣/**实际发车**趋势图
- 按目的地的积压分布（未配载=场地积压，已配载=待发车，双色堆叠）
- 在场车辆积压明细：进港待分拣、已分拣未配载、生效配载单数与配载重量

### 6. 异常件拦截
- 五种异常类型：外包装破损 / 错分线路 / 超重超限 / 疑似违禁品 / 地址信息异常
- 拦截后**禁止进入任何生效配载单、禁止发车**（后端强制校验）；拦截配载中件会自动撤配
- 处理完成后可解除拦截（回到已分拣，可重新配载）
- 异常类型分布统计与最近拦截记录

> **PGlite 数据目录**：默认 `server/data/`。若运行在网络挂载文件系统上（WASM Postgres 不支持），
> 可用 `PGDATA=/tmp/express-data npm start` 指定到本地磁盘。

## 切换真实 PostgreSQL

```bash
cd server
npm i pg
DATABASE_URL=postgres://user:pass@localhost:5432/express_hub npm start
```

不设置 `DATABASE_URL` 时使用嵌入式 PGlite，数据持久化在 `server/data/`（或 `$PGDATA`）。

## 重置模拟数据

```bash
cd server && npm run seed -- --force
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览指标（含已配载数） |
| GET | `/api/alerts` | 超时预警列表 |
| GET/PUT | `/api/settings` | 超时规则（含默认截单提前量） |
| GET/POST | `/api/vehicles` | 班次列表（含出港配载进度）/ 到车预报 |
| POST | `/api/vehicles/:id/action/:action` | 状态推进（depart 只锁本班配载单实际去向） |
| GET/POST | `/api/packages` | 包裹查询（含配载去向、进港来源）/ 到件登记 |
| POST | `/api/packages/:id/sort` `/intercept` `/release` | 分拣 / 拦截（自动撤配）/ 解除拦截 |
| GET/POST | `/api/load-plans` | 配载单列表 / 建单（auto_load 按目的地·截单·载重自动分配） |
| GET | `/api/load-plans/candidates/preview` | 候选件预览（可配 / 装不下留场） |
| GET | `/api/load-plans/:id` | 配载单明细（含每件进港来源） |
| POST/DELETE | `/api/load-plans/:id/items` | 追加补配 / 拆单撤配 |
| POST | `/api/load-plans/:id/reassign` | 改配到其它配载单 |
| POST | `/api/load-plans/:id/seal` `/unseal` `/cancel` | 封车 / 解封 / 撤单 |
| GET | `/api/stats/backlog` `/api/stats/abnormal` | 积压（按实际去向）/ 异常统计 |

## 目录结构

```
express-hub/
├── server/                 # Express 后端
│   └── src/
│       ├── index.js        # 入口
│       ├── db.js           # PGlite / PostgreSQL 适配层
│       ├── schema.sql      # 表结构
│       ├── seed.js         # 模拟数据
│       ├── helpers.js      # 超时预警计算、状态机、候选件筛选
│       ├── dispatch.js     # 出港配载领域服务（占用校验、事务化发车锁定）
│       └── routes/         # vehicles / packages / loadPlans / stats
└── client/React 前端
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 出港配载 / 包裹 / 统计
        └── components/     # 通用组件
```
