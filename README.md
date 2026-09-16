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
- 按目的地、按车辆的积压分布
- 在场车辆积压明细表

### 5. 异常件处置工单
- 五种异常类型：外包装破损 / 错分线路 / 超重超限 / 疑似违禁品 / 地址信息异常
- **每次拦截生成一张独立处置工单**，同一包裹多次异常分别留档、互不影响
- 工单流转：`待认领 → 处理中 → 待复核 → 已结案`，支持**认领、转交、补充证据、提交处理结论、复核**
- 处理结论三选一：**修复放行 / 退回 / 继续隔离**；复核驳回后退回处理中继续处理
- **提交人与复核人不能是同一人**（后端强制校验）
- 包裹尚有未结工单时**禁止恢复装车**（装车与发车均强制校验）
- 结论为「退回」的包裹进入**独立退回去向**，状态为已退回，不再计入正常待发库存
- 全程流转记录留痕，工单页可查看同一包裹的历史异常工单

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
| GET/POST | `/api/packages` | 包裹查询 / 到件登记 |
| POST | `/api/packages/:id/sort` `/load` | 分拣 / 装车（有未结工单禁止装车） |
| POST | `/api/packages/:id/intercept` | 拦截并生成处置工单 |
| GET | `/api/work-orders` `/api/work-orders/:id` | 工单列表 / 详情（含流转留档） |
| POST | `/api/work-orders/:id/claim` `/transfer` `/evidence` | 认领 / 转交 / 补充证据 |
| POST | `/api/work-orders/:id/submit` `/review` | 提交处理结论 / 复核（通过或驳回） |
| GET | `/api/stats/backlog` `/api/stats/abnormal` | 积压 / 异常工单统计 |

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
│       └── routes/         # vehicles / packages / work-orders / stats
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 包裹 / 异常工单 / 统计
        └── components/     # 通用组件
```
