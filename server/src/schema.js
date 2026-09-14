// 初始化数据库结构
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await exec(sql);
  console.log('[db] 表结构已就绪');
}
