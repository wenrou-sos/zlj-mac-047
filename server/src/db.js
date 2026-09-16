// 数据库连接层
// 默认使用 PGlite（嵌入式 PostgreSQL，WASM 运行，无需安装）
// 设置环境变量 DATABASE_URL 可切换为真实 PostgreSQL 服务器（需 npm i pg）
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGDATA || path.join(__dirname, '..', 'data');

let db;

if (process.env.DATABASE_URL) {
  // 真实 PostgreSQL 服务器模式
  const { default: pg } = await import('pg').catch(() => {
    throw new Error('使用 DATABASE_URL 需要先安装 pg: npm i pg');
  });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  db = {
    async query(text, params = []) {
      const res = await pool.query(text, params);
      return res.rows;
    },
    async exec(text) {
      await pool.query(text);
    },
    // 真实 PostgreSQL：从连接池取一条连接执行 BEGIN/COMMIT，出错回滚
    async withTransaction(fn) {
      const client = await pool.connect();
      const q = (text, params = []) => client.query(text, params).then((r) => r.rows);
      try {
        await client.query('BEGIN');
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
  console.log('[db] 使用 PostgreSQL 服务器:', process.env.DATABASE_URL.replace(/\/\/.*@/, '//***@'));
} else {
  // PGlite 嵌入式模式（默认）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = {
    async query(text, params = []) {
      const res = await pglite.query(text, params);
      return res.rows;
    },
    async exec(text) {
      await pglite.exec(text);
    },
    // PGlite 单连接嵌入式事务，回调抛错自动 ROLLBACK
    async withTransaction(fn) {
      return pglite.transaction(async (tx) => {
        const q = (text, params = []) => tx.query(text, params).then((r) => r.rows);
        return fn(q);
      });
    },
  };
  console.log('[db] 使用嵌入式 PGlite，数据目录:', DATA_DIR);
}

export const query = (text, params) => db.query(text, params);
export const exec = (text) => db.exec(text);
// 在同一事务中执行：fn 接收事务内的 query 函数；抛错整体回滚
export const withTransaction = (fn) => db.withTransaction(fn);
export default db;
