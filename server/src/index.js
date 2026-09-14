// 快递分拨管理系统 - 后端入口
import express from 'express';
import cors from 'cors';
import { initSchema } from './schema.js';
import { seedIfEmpty } from './seed.js';
import vehiclesRouter from './routes/vehicles.js';
import packagesRouter from './routes/packages.js';
import statsRouter from './routes/stats.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/vehicles', vehiclesRouter);
app.use('/api/packages', packagesRouter);
app.use('/api', statsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误: ' + err.message });
});

await initSchema();
await seedIfEmpty();

app.listen(PORT, () => {
  console.log(`[server] 快递分拨管理系统 API 已启动: http://localhost:${PORT}`);
});
