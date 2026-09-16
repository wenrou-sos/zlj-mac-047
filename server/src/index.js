// 快递分拨管理系统 - 后端入口
import express from 'express';
import cors from 'cors';
import { initSchema } from './schema.js';
import { seedIfEmpty } from './seed.js';
import { reconcileAlerts, checkEscalations } from './alerts.js';
import vehiclesRouter from './routes/vehicles.js';
import packagesRouter from './routes/packages.js';
import alertsRouter from './routes/alerts.js';
import statsRouter from './routes/stats.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/vehicles', vehiclesRouter);
app.use('/api/packages', packagesRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api', statsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误: ' + err.message });
});

await initSchema();
await seedIfEmpty();

// 启动即对账：全部计时依据落库，重启后对历史事件继续计时，不丢事件、不重复生成
await reconcileAlerts();
await checkEscalations();

// 后台守护：无人访问页面也能自动对账与响应期升级
const RECONCILE_INTERVAL_MS = 30_000; // 30s：新超时自动成事件、恢复自动关事件
const ESCALATE_INTERVAL_MS = 15_000; // 15s：超过响应期限自动进主管待办
setInterval(() => { reconcileAlerts().catch((e) => console.error('[reconcile]', e)); }, RECONCILE_INTERVAL_MS).unref();
setInterval(() => { checkEscalations().catch((e) => console.error('[escalate]', e)); }, ESCALATE_INTERVAL_MS).unref();

app.listen(PORT, () => {
  console.log(`[server] 快递分拨管理系统 API 已启动: http://localhost:${PORT}`);
});
