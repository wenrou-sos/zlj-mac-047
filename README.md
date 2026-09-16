# 快递分拨管理系统 (Express Hub)

记录分拨中心 **到车 → 卸车 → 分拣 → 发车** 全流程时间节点，提供 **超时预警、积压统计、异常件拦截** 能力。

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
- 达到时限 80% 触发黄色预警；规则可在「积压统计」页在线调整，实时生效

### 4. 积压统计
- 近 24 小时到件/分拣趋势图
- 按目的地、按车辆、按场区库位的积压分布
- 在场车辆积压明细表

### 5. 场区库位与滚动盘点
- 场区库位维护：到件暂存、分拣区、存储货架、拦截隔离区、车辆库位
- 到件自动进入 `RECV-01`；分拣后可自动/指定上架，支持人工移位，所有变更写入位置流水
- 每件包裹始终只有一个 `current_location_id`，车辆也是装车后的有效位置
- 按选定库位发起滚动盘点，先冻结**盘点时点账存快照**，但不封锁现场作业
- 盘点期间到件、上架、移位、装车继续执行；系统按 `snapshot_at ~ completed_at` 的位置流水区分：
  - 期间移入/新到件：不计盘盈
  - 期间移出：不计盘亏
  - 期间装车/发运：按流水核销，不能把刚发走的件判成丢失
- 记录盘盈、盘亏、错位；结束实盘后逐条复核，确认后才调整账面
  - 盘盈：补录包裹并落到实盘库位
  - 盘亏：状态置为 `lost`，位置移入 `LOST-01`
  - 错位：账面位置调整到实盘库位
- 拦截处置状态（未拦截/拦截中/已解除）与作业状态、物理位置分离；拦截件留在原位并禁止装车，解除拦截不改变位置

### 6. 异常件拦截
- 五种异常类型：外包装破损 / 错分线路 / 超重超限 / 疑似违禁品 / 地址信息异常
- 拦截后**禁止装车**（后端强制校验），处理完成后可解除拦截
- 异常类型分布统计与最近拦截记录

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

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览指标 |
| GET | `/api/alerts` | 超时预警列表 |
| GET/PUT | `/api/settings` | 超时规则 |
| GET/POST | `/api/vehicles` | 班次列表 / 到车预报 |
| POST | `/api/vehicles/:id/action/:action` | 状态推进（arrive / unload-start / unload-end / sort-start / sort-end / depart） |
| GET/POST | `/api/packages` | 包裹查询 / 到件登记（自动定位） |
| POST | `/api/packages/:id/sort` `/load` | 分拣上架 / 装车 |
| POST | `/api/packages/:id/intercept` `/release` | 拦截 / 解除拦截（不改位置） |
| GET/POST | `/api/locations` | 场区库位查询 / 新建 |
| POST | `/api/locations/move` | 包裹上架/移位 |
| GET/POST | `/api/stocktakes` | 盘点单列表 / 按库位发起滚动盘点 |
| POST | `/api/stocktakes/:id/scan` | 实盘扫描 |
| POST | `/api/stocktakes/:id/complete` | 结束实盘并核对期间流转 |
| PUT | `/api/stocktakes/:id/differences/:diffId/review` | 差异复核（确认/驳回） |
| POST | `/api/stocktakes/:id/adjust` | 复核后统一调整账面 |
| GET | `/api/stats/backlog` `/api/stats/abnormal` | 积压（含库位） / 异常统计 |

## 目录结构

```
express-hub/
├── server/                 # Express 后端
│   └── src/
│       ├── index.js        # 入口
│       ├── db.js           # PGlite / PostgreSQL 适配层
│       ├── schema.sql      # 表结构
│       ├── seed.js         # 模拟数据
│       ├── helpers.js      # 超时预警计算、状态机
│       ├── inventory.js    # 车辆库位、位置流水等共享逻辑
│       └── routes/         # vehicles / packages / locations / stocktakes / stats
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 包裹 / 库位盘点 / 统计
        └── components/     # 通用组件
```
