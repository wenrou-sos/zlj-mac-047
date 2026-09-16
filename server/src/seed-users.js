// 初始化演示账号（仅当 users 表为空时执行，覆盖各岗位，含兼岗示例）
import { query } from './db.js';
import { hashPassword } from './auth.js';

const DEMO_USERS = [
  { username: 'admin',      display_name: '系统管理员', password: 'admin123',     roles: ['admin'] },
  { username: 'dispatcher', display_name: '调度员',     password: 'dispatch123',  roles: ['dispatcher'] },
  { username: 'sorter',     display_name: '分拣员',     password: 'sort123',      roles: ['sorter'] },
  { username: 'exception',  display_name: '异常处理员', password: 'exception123', roles: ['exception'] },
  { username: 'ops',        display_name: '综合操作员', password: 'ops123',       roles: ['dispatcher', 'sorter'] }, // 兼岗示例
];

export async function seedUsersIfEmpty() {
  const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM users');
  if (count > 0) return false;
  for (const u of DEMO_USERS) {
    const [row] = await query(
      'INSERT INTO users (username, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [u.username, u.display_name, hashPassword(u.password)]
    );
    for (const r of u.roles) {
      await query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [row.id, r]);
    }
  }
  console.log('[seed] 已创建演示账号：admin / dispatcher / sorter / exception / ops（兼岗）');
  return true;
}
