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

### 6. 分拣规则与格口
- **格口维护**：新增格口、启用/停用；停用时可将引用规则一键**改道**到其他格口，未改道的规则扫描时自动落空
- **规则版本化**：按「目的地 + 重量区间 + 优先级」配置规则，调整走 **草稿 → 试算 → 发布** 流程，同一时间仅一个发布版生效
- **试算影响**：发布前用当前全部待分拣包裹模拟，输出自动路由覆盖率、规则冲突数、无匹配数、各格口预计负荷与规则命中排行
- **扫描分拣**：扫描运单即返回**目标格口 + 命中原因 + 规则版本**；规则冲突（同级多规则命中）或无匹配时进入**待判区**，人工指定格口后出库
- **版本留痕**：已分拣包裹保留当时的规则版本与命中原因快照，新版本发布不影响历史记录
- **错分回流**：错分件（错分线路）复核后回流待分拣重新扫描；`sorted_at` 只记首分时间，**重分不重复增加完成量**；拦截件禁止分拣，重分不绕过异常拦截

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

注意：PGlite 为单进程写库，请先停止后端服务再执行重置，完成后再启动。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览指标 |
| GET | `/api/alerts` | 超时预警列表 |
| GET/PUT | `/api/settings` | 超时规则 |
| GET/POST | `/api/vehicles` | 班次列表 / 到车预报 |
| POST | `/api/vehicles/:id/action/:action` | 状态推进（arrive / unload-start / unload-end / sort-start / sort-end / depart） |
| GET/POST | `/api/packages` | 包裹查询 / 到件登记 |
| POST | `/api/packages/scan` | 扫描分拣决策（目标格口 + 命中原因，不改状态） |
| POST | `/api/packages/:id/sort` `/load` | 分拣（自动路由 / 传 chute_id 人工指定）/ 装车 |
| POST | `/api/packages/:id/intercept` `/release` | 拦截 / 解除（错分件复核后回流重分） |
| GET/POST | `/api/chutes` | 格口列表 / 新增 |
| POST | `/api/chutes/:id/disable` `/enable` | 停用（可带 reroute_chute_id 改道）/ 启用 |
| GET | `/api/sort-rules` | 当前发布版 + 草稿 |
| POST/DELETE | `/api/sort-rules/draft` | 新建 / 放弃草稿 |
| POST/PUT/DELETE | `/api/sort-rules/draft/rules[/:id]` | 草稿规则增改删 |
| POST | `/api/sort-rules/draft/simulate` `/publish` | 试算影响 / 发布新版本 |
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
│       ├── sorting.js      # 分拣规则匹配引擎
│       └── routes/         # vehicles / packages / stats / sorting（格口与规则）
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 包裹 / 分拣规则 / 统计
        └── components/     # 通用组件
```
