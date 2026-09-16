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
- 在场车辆、待分拣、已装车、拦截件、**未恢复预警事件** 实时指标卡
- 超时预警事件列表（红色=已超时，黄色=即将超时），显示处理状态、跟进人、首次触发时间
- 包裹状态分布饼图，每 15 秒自动刷新

### 2. 预警待办（事件中心）
- 每一次超时都是一个**可认领、可追溯的事件**（同一车辆同一环节同时只有一起未结束事件）
- 事件全程留痕：**首次触发、认领确认（处理人+时间）、每条处理记录、自动升级主管、处理完成、车辆恢复** 的全部时间与操作人；创建时采用的阈值以规则快照冻结
- 视图：全部待办 / 待认领 / 我的跟进 / 主管待办 / 历史事件；点击事件查看完整处理台账
- 操作：认领（他人不可抢单、本人重复认领幂等）、追加处理记录、标记处理完成、主管改派
- **响应期限**（默认触发后 15 分钟）内无人确认 → 自动升级主管待办；已认领但红色超时持续超过宽限期仍未恢复 → 主管督办
- **已确认或已处理但车辆未恢复的事件不会从待办消失**；车辆环节实际完成才恢复关闭，再次超时自动另起一起新事件
- 状态与计时依据全部落库：刷新不重复生成事件，**重启服务后照常继续计时与升级**
- 首次使用在「预警待办」页设置操作人姓名（存于浏览器本地），认领/处理/改规则会带上该身份（请求头 `X-User-Name`）

### 3. 车辆班次（时间记录）
- 班次状态机：`待到车 → 已到车 → 卸车中 → 待分拣 → 分拣中 → 待发车 → 已发车`
- 每个环节一键打卡，自动记录时间戳，四阶段时间线可视化
- 完成分拣时车上待分拣包裹自动转为已分拣；发车时自动装车，**拦截件留置不发**
- 行内显示未恢复预警事件，可直接认领或跳转事件中心；打卡使环节完成后对应事件自动恢复关闭
- 支持到车预报登记与删除

### 4. 超时规则
- **卸车超时**：到车后超过 N 分钟未完成卸车（默认 30）
- **分拣超时**：卸车完成后超过 N 分钟未完成分拣（默认 60）
- **发车超时**：超过计划发车时间未发车（计划时刻一到即为超时）
- 达到时限 80% 触发黄色预警；可配置**响应期限**与**升级宽限**
- 每次调整写入规则调整台账（规则项 / 旧值 / 新值 / 操作人 / 时间）
- 规则调整**只对之后新触发的事件生效**，进行中的事件按创建时的快照执行——当时采用了哪版规则始终可追溯

### 5. 积压统计
- 近 24 小时到件/分拣趋势图
- 按目的地、按车辆的积压分布
- 在场车辆积压明细表
- 超时规则在线配置 + 规则调整台账

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
| GET | `/api/overview` | 总览指标（预警口径来自事件表） |
| GET | `/api/alerts?scope=active\|unassigned\|mine\|escalated\|resolved\|history\|all` | 预警事件列表 |
| GET | `/api/alerts/todo-summary` | 待办计数（徽标/指标卡） |
| GET | `/api/alerts/:id` | 事件详情（含处理记录台账、规则快照） |
| POST | `/api/alerts/:id/claim` `/notes` `/resolve` `/reassign` | 认领 / 追加处理记录 / 标记处理 / 改派 |
| GET/PUT | `/api/settings` | 超时规则（读取 / 修改，修改自动留痕） |
| GET | `/api/settings/history` | 规则调整台账 |
| GET/POST | `/api/vehicles` | 班次列表 / 到车预报 |
| POST | `/api/vehicles/:id/action/:action` | 状态推进（arrive / unload-start / unload-end / sort-start / sort-end / depart） |
| GET/POST | `/api/packages` | 包裹查询 / 到件登记 |
| POST | `/api/packages/:id/sort` `/load` | 分拣 / 装车 |
| POST | `/api/packages/:id/intercept` `/release` | 拦截 / 解除拦截 |
| GET | `/api/stats/backlog` `/api/stats/abnormal` | 积压 / 异常统计 |

> 写操作可通过 `X-User-Name` 请求头携带操作人姓名（支持百分号编码）。

## 目录结构

```
express-hub/
├── server/                 # Express 后端
│   └── src/
│       ├── index.js        # 入口（启动对账 + 后台定时对账/升级扫描）
│       ├── db.js           # PGlite / PostgreSQL 适配层（含事务）
│       ├── alerts.js       # 预警事件引擎（幂等对账、自动升级）
│       ├── schema.sql      # 表结构（vehicles/packages/alert_events/alert_event_logs/settings…）
│       ├── seed.js         # 模拟数据
│       ├── helpers.js      # 规则读取、状态机
│       └── routes/         # alerts / vehicles / packages / stats
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 预警待办 / 车辆 / 包裹 / 统计
        └── components/     # 通用组件
```
