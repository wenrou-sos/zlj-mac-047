// 认证路由：登录 / 退出 / 当前会话信息
import { Router } from 'express';
import { query } from '../db.js';
import { verifyPassword, createSession, authRequired } from '../auth.js';
import { permissionsOf } from '../permissions.js';
import { audit } from '../audit.js';

const router = Router();

// 登录（公开接口）
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  const [user] = await query('SELECT * FROM users WHERE username = $1', [String(username).trim()]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    await audit(req, 'auth.login_failed', { actor: { username: String(username) }, targetType: 'user', targetId: username });
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (user.status !== 'active') {
    await audit(req, 'auth.login_failed', {
      actor: { id: user.id, username: user.username, displayName: user.display_name },
      targetType: 'user', targetId: user.id, extra: { reason: '账号已停用' },
    });
    return res.status(403).json({ error: '账号已被停用，请联系管理员' });
  }

  const token = await createSession(user.id);
  const roles = (await query('SELECT role FROM user_roles WHERE user_id = $1', [user.id])).map((r) => r.role);
  await audit(req, 'auth.login', {
    actor: { id: user.id, username: user.username, displayName: user.display_name },
    targetType: 'user', targetId: user.id,
  });
  res.json({
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, roles, permissions: permissionsOf(roles) },
  });
});

// 退出登录（撤销当前会话）
router.post('/logout', authRequired, async (req, res) => {
  await query(`UPDATE sessions SET revoked_at = NOW(), revoke_reason = 'logout' WHERE id = $1`, [req.user.sessionId]);
  await audit(req, 'auth.logout', { targetType: 'user', targetId: req.user.id });
  res.json({ ok: true });
});

// 当前会话信息（前端据此渲染岗位与按钮权限）
router.get('/me', authRequired, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, display_name: u.displayName, roles: u.roles, permissions: u.permissions });
});

export default router;
