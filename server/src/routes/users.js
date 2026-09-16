// 账号与岗位管理（仅管理员）：建号、调岗、停用/启用、重置密码、会话撤销
import { Router } from 'express';
import { query } from '../db.js';
import { hashPassword, requirePerm, revokeUserSessions } from '../auth.js';
import { ROLES } from '../permissions.js';
import { audit } from '../audit.js';

const router = Router();
// 整个账号管理模块仅管理员可用 —— 普通岗位无法为自己或他人授予权限
router.use(requirePerm('user:manage'));

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

async function getUserWithRoles(id) {
  const [u] = await query(
    'SELECT id, username, display_name, status, created_at FROM users WHERE id = $1',
    [id]
  );
  if (!u) return null;
  const roles = (await query('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [id])).map((r) => r.role);
  return { ...u, roles };
}

// 除指定账号外，仍处于启用状态的管理员数量（用于保护最后一个可用管理员）
async function otherActiveAdminCount(excludeUserId) {
  const [{ c }] = await query(
    `SELECT COUNT(*)::int AS c
     FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin'
     WHERE u.status = 'active' AND u.id <> $1`,
    [excludeUserId]
  );
  return c;
}

// 账号列表（含岗位与活跃会话数）
router.get('/', async (req, res) => {
  const users = await query(
    `SELECT u.id, u.username, u.display_name, u.status, u.created_at,
       (SELECT COUNT(*)::int FROM sessions s
         WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS active_sessions
     FROM users u ORDER BY u.id`
  );
  const roleRows = await query('SELECT user_id, role FROM user_roles');
  const byUser = {};
  for (const r of roleRows) (byUser[r.user_id] ||= []).push(r.role);
  res.json(users.map((u) => ({ ...u, roles: byUser[u.id] || [] })));
});

// 新建账号
router.post('/', async (req, res) => {
  const { username, display_name, password, roles = [] } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: '账号需为 3-20 位字母、数字或下划线' });
  }
  if (!display_name || !display_name.trim()) return res.status(400).json({ error: '请填写姓名' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const validRoles = [...new Set((Array.isArray(roles) ? roles : []).filter((r) => ROLES.includes(r)))];

  try {
    const [u] = await query(
      'INSERT INTO users (username, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id, username, display_name, status, created_at',
      [username, display_name.trim(), hashPassword(String(password))]
    );
    for (const r of validRoles) {
      await query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [u.id, r]);
    }
    await audit(req, 'user.create', {
      targetType: 'user', targetId: u.id,
      after: { username, display_name: display_name.trim(), roles: validRoles },
    });
    res.status(201).json({ ...u, roles: validRoles });
  } catch (e) {
    if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
      return res.status(409).json({ error: '账号已存在' });
    }
    throw e;
  }
});

// 调整岗位（支持兼岗；权限变更对旧会话即时生效）
router.put('/:id/roles', async (req, res) => {
  const target = await getUserWithRoles(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const roles = [...new Set((Array.isArray(req.body?.roles) ? req.body.roles : []).filter((r) => ROLES.includes(r)))];

  // 保护最后一个可用管理员：不允许移除其管理员岗位
  if (target.status === 'active' && target.roles.includes('admin') && !roles.includes('admin')) {
    if ((await otherActiveAdminCount(target.id)) === 0) {
      return res.status(409).json({ error: '不能移除最后一个可用管理员的岗位' });
    }
  }

  await query('DELETE FROM user_roles WHERE user_id = $1', [target.id]);
  for (const r of roles) {
    await query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [target.id, r]);
  }
  await audit(req, 'user.roles', {
    targetType: 'user', targetId: target.id,
    before: { roles: target.roles },
    after: { roles },
    extra: { username: target.username },
  });
  res.json({ ...target, roles });
});

// 停用 / 启用账号（停用即撤销其全部会话）
router.put('/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: '非法状态' });
  const target = await getUserWithRoles(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });

  // 保护最后一个可用管理员：不允许停用
  if (status === 'disabled' && target.status === 'active' && target.roles.includes('admin')) {
    if ((await otherActiveAdminCount(target.id)) === 0) {
      return res.status(409).json({ error: '不能停用最后一个可用管理员' });
    }
  }

  await query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, target.id]);
  if (status === 'disabled') await revokeUserSessions(target.id, 'account_disabled');
  await audit(req, 'user.status', {
    targetType: 'user', targetId: target.id,
    before: { status: target.status },
    after: { status },
    extra: { username: target.username },
  });
  res.json({ ...target, status });
});

// 重置密码（重置后撤销该账号全部会话，需重新登录）
router.put('/:id/password', async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const target = await getUserWithRoles(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });

  await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hashPassword(String(password)), target.id]);
  await revokeUserSessions(target.id, 'password_reset');
  await audit(req, 'user.password', {
    targetType: 'user', targetId: target.id,
    extra: { username: target.username, note: '密码已重置，该账号全部会话已撤销' },
  });
  res.json({ ok: true });
});

// 某账号的会话列表
router.get('/:id/sessions', async (req, res) => {
  const target = await getUserWithRoles(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const sessions = await query(
    `SELECT id, created_at, expires_at, revoked_at, revoke_reason,
            (revoked_at IS NULL AND expires_at > NOW()) AS active
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [target.id]
  );
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.user.sessionId })));
});

// 撤销指定会话
router.delete('/:id/sessions/:sid', async (req, res) => {
  const target = await getUserWithRoles(req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  const rows = await query(
    `UPDATE sessions SET revoked_at = NOW(), revoke_reason = 'revoked_by_admin'
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [req.params.sid, target.id]
  );
  if (!rows.length) return res.status(404).json({ error: '会话不存在或已撤销' });
  await audit(req, 'session.revoke', {
    targetType: 'user', targetId: target.id,
    extra: { username: target.username, session: `${req.params.sid.slice(0, 8)}…` },
  });
  res.json({ ok: true });
});

export default router;
