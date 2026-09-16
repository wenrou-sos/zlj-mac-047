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

// 构造事务执行器：beginRunner 必须真正开启事务（BEGIN），
// fn(run) 内全部 run() 同一事务，出错 ROLLBACK，成功 COMMIT。
// serialize：可选的串行包装器（PGlite 单连接需要，pg.Pool 每事务独占连接则不需要）
function makeTransaction(beginRunner, serialize = (fn) => fn()) {
  const execOne = async (fn) => {
    const { run, commit, rollback, release } = await beginRunner();
    try {
      const result = await fn(run);
      await commit();
      return result;
    } catch (e) {
      // 出错必须能整体回滚（改配先撤源单再校验等场景依赖这一点）
      await rollback();
      throw e;
    } finally {
      release?.();
    }
  };
  return (fn) => serialize(() => execOne(fn));
}

// 简单互斥锁：PGlite 是单连接，多个事务必须串行，否则 BEGIN/COMMIT 会交错
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn());
    tail = run.then(() => {}, () => {});
    return run;
  };
}

if (process.env.DATABASE_URL) {
  // 真实 PostgreSQL 服务器模式（pg.Pool 每个事务独占一个 client）
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
      try {
        await client.query('BEGIN');
      } catch (e) {
        client.release();
        throw e;
      }
      return {
        run: (text, params = []) => client.query(text, params).then((r) => r.rows),
        commit: () => client.query('COMMIT'),
        rollback: () => client.query('ROLLBACK').catch(() => {}),
        release: () => client.release(),
      };
    }), // pg.Pool 每个事务独占连接，无需串行
  };
  console.log('[db] 使用 PostgreSQL 服务器:', process.env.DATABASE_URL.replace(/\/\/.*@/, '//***@'));
} else {
  // PGlite 嵌入式模式（默认，单连接）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  const txMutex = makeMutex();
  db = {
    async query(text, params = []) {
      const res = await pglite.query(text, params);
      return res.rows;
    },
    async exec(text) {
      await pglite.exec(text);
    },
    // 单连接：事务串行执行，事务体内不允许穿插其它事务
    withTransaction: makeTransaction(async () => {
      await pglite.query('BEGIN');
      return {
        run: (text, params = []) => pglite.query(text, params).then((r) => r.rows),
        commit: () => pglite.query('COMMIT'),
        rollback: () => pglite.query('ROLLBACK').catch(() => {}),
      };
    }, txMutex),
  };
  console.log('[db] 使用嵌入式 PGlite，数据目录:', DATA_DIR);
}

export const query = (text, params) => db.query(text, params);
export const exec = (text) => db.exec(text);
export const withTransaction = (fn) => db.withTransaction(fn);
export default db;
