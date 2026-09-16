// 认证与授权：scrypt 密码散列、服务端会话、按请求实时鉴权
import crypto from 'node:crypto';
import { query } from './db.js';
import { permissionsOf } from './permissions.js';

// 会话有效期（小时），可用环境变量覆盖
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, NOW() + $3 * INTERVAL '1 hour')`,
    [token, userId, SESSION_TTL_HOURS]
  );
  return token;
}

// 撤销某账号的全部有效会话（停用账号 / 重置密码时调用）
export async function revokeUserSessions(userId, reason) {
  await query(
    `UPDATE sessions SET revoked_at = NOW(), revoke_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason]
  );
}

/**
 * 鉴权中间件：校验 Bearer 会话，并实时从数据库读取账号状态与岗位。
 * 不缓存权限 —— 岗位调整、账号停用、会话撤销后，旧会话下一次请求即按新授权执行。
 */
export async function authRequired(req, res, next) {
  try {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: '未登录，请先登录' });

    const [row] = await query(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              u.id AS user_id, u.username, u.display_name, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [m[1]]
    );
    if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: '会话已失效，请重新登录' });
    }
    if (row.status !== 'active') {
      return res.status(401).json({ error: '账号已被停用，请联系管理员' });
    }

    const roles = (await query('SELECT role FROM user_roles WHERE user_id = $1', [row.user_id])).map((r) => r.role);
    req.user = {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      roles,
      permissions: permissionsOf(roles),
      sessionId: row.session_id,
    };
    next();
  } catch (e) {
    next(e);
  }
}

// 授权中间件：要求具备任一指定权限点（直接调用接口同样生效）
export const requirePerm = (...perms) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: '未登录，请先登录' });
  if (perms.some((p) => req.user.permissions.includes(p))) return next();
  return res.status(403).json({ error: '当前岗位无权执行该操作' });
};
