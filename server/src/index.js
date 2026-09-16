// 快递分拨管理系统 - 后端入口
import express from 'express';
import cors from 'cors';
import { initSchema } from './schema.js';
import { seedIfEmpty } from './seed.js';
import { seedUsersIfEmpty } from './seed-users.js';
import { authRequired } from './auth.js';
import { query } from './db.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import auditRouter from './routes/audit.js';
import vehiclesRouter from './routes/vehicles.js';
import packagesRouter from './routes/packages.js';
import statsRouter from './routes/stats.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// 登录/退出/会话信息（login 公开，其余在路由内鉴权）
app.use('/api/auth', authRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 以下接口一律要求登录，具体操作权限在各路由内按岗位校验
app.use('/api/users', authRequired, usersRouter);
app.use('/api/audit-logs', authRequired, auditRouter);
app.use('/api/vehicles', authRequired, vehiclesRouter);
app.use('/api/packages', authRequired, packagesRouter);
app.use('/api', authRequired, statsRouter);

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误: ' + err.message });
});

await initSchema();
await seedUsersIfEmpty();
await seedIfEmpty();

// 清理 7 天前的历史会话（已过期或已撤销）
await query(
  `DELETE FROM sessions
   WHERE expires_at < NOW() - INTERVAL '7 days'
      OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')`
).catch(() => {});

app.listen(PORT, () => {
  console.log(`[server] 快递分拨管理系统 API 已启动: http://localhost:${PORT}`);
});
