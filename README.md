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

### 6. 手持扫描工作台（断网可作业）
- **断网照常扫描**：到件 / 分拣 / 装车三类扫描在断网期间保存在手持机本地（IndexedDB），刷新页面、关闭浏览器均不丢失
- **按批次作业**：每个作业类型自动延续当前批次，可手动开新批次、切回未完成批次继续；批次存在未补传或未处理完的扫描时不能关闭
- **逐条补传与结果**：网络恢复后自动（或手动）补传，每条扫描独立返回「已记账 / 冲突暂停 / 失败」，未确认的扫描绝不计为成功作业
- **幂等不重复记账**：每条扫描带设备生成的唯一 `scan_id`、设备号、扫描实际发生时间；服务端以台账去重，刷新或重复补传只回放首次结果，成功的扫描按**实际扫描时间**（非补传时间）记账
- **冲突人工处理**：离线期间若包裹已被拦截、班次已发车、状态已被推进或装车班次不一致，冲突项暂停并展示服务器当前状态，提供「放弃（以服务器为准）/ 暂留 / 调整后重扫」选择，**不会覆盖服务器新状态**
- **服务器扫描台账**：所有补传结果按设备、运单号可追溯（`scan_ledger` 表），含扫描时间、记账时间、冲突原因与处理结论

> 设备号首次打开手持台时自动生成并长期保存在本机，可在页面顶部修改设备名称。

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
| POST | `/api/scan/sync` | 手持扫描批量补传（幂等：scan_id 去重，逐条返回记账/冲突结果；可附带冲突处理结论） |
| GET | `/api/scan/ledger` | 扫描补传台账（设备 / 状态 / 运单号筛选） |
| POST | `/api/scan/devices/heartbeat` | 手持设备报到 |
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
│       └── routes/         # vehicles / packages / scan(手持补传) / stats
└── client/                 # React 前端
    └── src/
        ├── pages/          # 总览 / 车辆 / 包裹 / 统计
        ├── handheld/       # 手持扫描工作台（离线队列、补传引擎、冲突处理、台账）
        └── components/     # 通用组件
```
