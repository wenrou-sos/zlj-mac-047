// 简易认证：用户表 + 服务端内存会话
// 说明：演示系统，密码用 sha256 加盐哈希存储（非明文），会话保存在内存中，
//       服务重启后会话失效需重新登录。身份以服务端会话为准，客户端不能自报操作人。
import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from './db.js';

// token -> { username, display_name }
const sessions = new Map();

const hashPassword = (pwd) =>
  crypto.createHash('sha256').update(`express-hub:${pwd}`).digest('hex');

// 初始用户（与种子工单中的处理人一致），默认密码 123456
const DEFAULT_USERS = [
  ['wangfang', '王芳'],
  ['liqiang', '李强'],
  ['zhaomin', '赵敏'],
  ['chenchen', '陈晨'],
  ['liujia', '刘佳'],
  ['zhoutao', '周涛'],
];

export async function ensureUsers() {
  for (const [username, name] of DEFAULT_USERS) {
    await query(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING`,
      [username, name, hashPassword('123456')]
    );
  }
}

// 鉴权中间件：从 Authorization: Bearer <token> 解析身份，未登录 401
export function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = token ? sessions.get(token) : null;
  if (!user) return res.status(401).json({ error: '请先登录后再操作' });
  req.user = user;
  next();
}

const router = Router();

// 登录：签发服务端会话 token
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const [user] = await query('SELECT * FROM users WHERE username = $1', [String(username).trim()]);
  if (!user || user.password_hash !== hashPassword(String(password))) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = crypto.randomUUID();
  const info = { username: user.username, display_name: user.display_name };
  sessions.set(token, info);
  res.json({ token, user: info });
});

// 注销
router.post('/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// 当前会话用户（前端启动时校验本地 token 是否仍有效）
router.get('/me', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = token ? sessions.get(token) : null;
  if (!user) return res.status(401).json({ error: '会话已失效，请重新登录' });
  res.json(user);
});

// 用户列表（转交工单时选择对象，无需登录）
router.get('/users', async (req, res) => {
  const rows = await query('SELECT username, display_name FROM users ORDER BY username');
  res.json(rows);
});

export default router;
