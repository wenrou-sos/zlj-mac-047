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

### 5. 异常件拦截
- 五种异常类型：外包装破损 / 错分线路 / 超重超限 / 疑似违禁品 / 地址信息异常
- 拦截后**禁止装车**（后端强制校验），处理完成后可解除拦截
- 异常类型分布统计与最近拦截记录

### 6. 班次交接
- 按作业班次（白班/中班/夜班，支持跨午夜）生成交接单，**自动汇集**未发车车辆、待处理包裹、拦截件、超时事项并拍成快照
- 交班人可补充总体说明与逐条备注，也可在交接进行中**追加现场新出现的事项**或口头补充
- 接班人**逐项接收或退回**（退回必须填写原因）；交接期间作业正常继续：
  - 期间完成的事项（发车、装车、解除拦截、超时消除）**自动确认并提示变化，不重复移交**
  - **未接收/退回事项责任仍归交出班次**，自动带入该班次下一张交接单
- 全部处理完方可**签收**；签收后单据与逐项结果**立即冻结为历史快照，任何修改接口拒绝写入**（刷新不能改写历史）
- 已签收单据保留「后续处理去向」（已发车/已装车/恢复作业）与**再次转交链**，跨午夜班次凭交接单号全程可追溯

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
| POST | `/api/packages/:id/sort` `/load` | 分拣 / 装车 |
| POST | `/api/packages/:id/intercept` `/release` | 拦截 / 解除拦截 |
| GET/POST | `/api/shifts` | 班次列表 / 新建班次（夜班可跨午夜） |
| GET/POST | `/api/handovers` | 交接单台账 / 生成交接单（自动汇集快照） |
| GET | `/api/handovers/:id` | 交接单详情（未签收含实时变化，已签收含后续去向） |
| PUT | `/api/handovers/:id/summary` | 交班总体说明（仅草稿） |
| POST | `/api/handovers/:id/submit` `/sign` `/cancel` | 提交签收 / 签收冻结 / 作废 |
| POST | `/api/handovers/:id/items` | 交接进行中追加事项 |
| PUT | `/api/handovers/items/:id/note` | 交班人逐条补充说明 |
| PUT | `/api/handovers/items/:id/decision` | 接班人逐项接收 / 退回 / 撤回 |
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
│       ├── helpers.js      # 超时预警计算、状态机、交接常量
│       ├── handover.js     # 交接快照汇集 / 变化检测 / 去向追溯
│       └── routes/         # vehicles / packages / stats / shifts / handovers
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 包裹 / 统计
        └── components/     # 通用组件
```
