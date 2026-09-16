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

### 2. 月台调度（预约 + 现场叫号）
- **预约不等于占用**：预约只是排班（`booked`），车辆签到才进入候叫队列（`checked`），**叫号成功才实际占用月台**
- 按**车型适配**（小/中/大/特大）+ 预约时段 + 到场顺序派泊位；月台卡片实时显示空闲/靠台/卸车中/停用
- 迟到车辆（超过预约时段结束才到场）自动标记并**重新排队**；叫号后召回的车辆排在队尾
- 支持**有理由的插队**、**改约**（记录次数与原因）、取消预约、叫号后**召回重排**、**临时停用/恢复月台**（占用中不可停用）
- **泊位只在卸车结束时释放**；未叫号靠台不允许开始卸车
- 并发叫号由数据库部分唯一索引 + 原子 `INSERT…SELECT` 保证，**同一月台绝不会同时派给两辆车**
- 排队等待、靠台待卸、实际卸车**三段时间分开显示**

### 3. 车辆班次（时间记录）
- 班次状态机：`待到车 → 已到车 → 卸车中 → 待分拣 → 分拣中 → 待发车 → 已发车`
- 每个环节一键打卡，自动记录时间戳，四阶段时间线可视化
- 完成分拣时车上待分拣包裹自动转为已分拣；发车时自动装车，**拦截件留置不发**
- 支持到车预报（可同时登记车型与预约时段）与删除；无预约车辆到场按临时车辆入队

### 4. 超时预警
- **卸车超时**：到车后超过 N 分钟未完成卸车（默认 30）
- **分拣超时**：卸车完成后超过 N 分钟未完成分拣（默认 60）
- **发车超时**：超过计划发车时间未发车
- 达到时限 80% 触发黄色预警；规则可在「积压统计」页在线调整，实时生效

### 5. 积压统计
- 近 24 小时到件/分拣趋势图
- 按目的地、按车辆的积压分布
- 在场车辆积压明细表

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
| GET/POST | `/api/vehicles` | 班次列表 / 到车预报（可带车型与预约时段） |
| POST | `/api/vehicles/:id/action/:action` | 状态推进（arrive / unload-start / unload-end / sort-start / sort-end / depart） |
| GET/POST | `/api/docks` | 月台列表 / 新增月台 |
| PUT | `/api/docks/:id` | 修改月台名称/适配车型 |
| POST | `/api/docks/:id/disable` `/enable` | 临时停用（需原因）/ 恢复 |
| POST | `/api/docks/:id/call-next` | 月台叫下一位（车型适配+排队规则） |
| GET | `/api/appointments` `/board` | 预约列表 / 调度看板（候叫队列+靠台车辆） |
| POST | `/api/appointments` | 登记预约（不占用月台） |
| POST | `/api/appointments/:id/check-in` `/call` | 签到排队 / 叫号（dock_id 可空=自动选位） |
| POST | `/api/appointments/:id/priority` `/reschedule` `/cancel` `/recall` | 有理由插队 / 改约 / 取消 / 召回重排 |
| GET/POST | `/api/packages` | 包裹查询 / 到件登记 |
| POST | `/api/packages/:id/sort` `/load` | 分拣 / 装车 |
| POST | `/api/packages/:id/intercept` `/release` | 拦截 / 解除拦截 |
| GET | `/api/stats/backlog` `/api/stats/abnormal` | 积压 / 异常统计 |

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
│       └── routes/         # vehicles / packages / stats
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 包裹 / 统计
        └── components/     # 通用组件
```
