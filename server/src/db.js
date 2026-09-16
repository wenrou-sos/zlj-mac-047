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

// 构造一个事务执行器：fn(run) 内全部 run() 同一连接、同一事务
function makeTransaction(beginRunner) {
  return async (fn) => {
    const { run, commit, rollback, release } = await beginRunner();
    try {
      const result = await fn(run);
      await commit();
      return result;
    } catch (e) {
      await rollback();
      throw e;
    } finally {
      release?.();
    }
  };
}

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
    withTransaction: makeTransaction(async () => {
      const client = await pool.connect();
      return {
        run: (text, params = []) => client.query(text, params).then((r) => r.rows),
        commit: () => client.query('COMMIT'),
        rollback: () => client.query('ROLLBACK').catch(() => {}),
        release: () => client.release(),
      };
    }),
  };
  console.log('[db] 使用 PostgreSQL 服务器:', process.env.DATABASE_URL.replace(/\/\/.*@/, '//***@'));
} else {
  // PGlite 嵌入式模式（默认，单连接）
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
    withTransaction: makeTransaction(async () => ({
      run: (text, params = []) => pglite.query(text, params).then((r) => r.rows),
      commit: () => pglite.query('COMMIT'),
      rollback: () => pglite.query('ROLLBACK').catch(() => {}),
    })),
  };
  console.log('[db] 使用嵌入式 PGlite，数据目录:', DATA_DIR);
}

export const query = (text, params) => db.query(text, params);
export const exec = (text) => db.exec(text);
export const withTransaction = (fn) => db.withTransaction(fn);
export default db;
