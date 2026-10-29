// 一次性维护脚本：为历史提交补齐内容指纹（fingerprint）。
// 指纹用于「重复提交」检测；补齐全量后可识别旧提交的完全重复内容。
// 用法：node tools\backfill-fingerprints.js [--dry]

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { fingerprintText } = require('../backend/src/util');

const DB_PATH = process.env.EA_DB_PATH || path.resolve(__dirname, '..', 'data', 'platform.db');
const dry = process.argv.includes('--dry');

const db = new DatabaseSync(DB_PATH);
const rows = db
  .prepare("SELECT id, content FROM submissions WHERE fingerprint IS NULL OR fingerprint = ''")
  .all();

console.log(`待补齐指纹的提交：${rows.length} 条${dry ? '（dry run，不写入）' : ''}`);

if (!dry && rows.length) {
  const update = db.prepare('UPDATE submissions SET fingerprint = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) update.run(fingerprintText(row.content), row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`已写入 ${rows.length} 条指纹。`);
}

const missing = db
  .prepare("SELECT COUNT(*) AS n FROM submissions WHERE fingerprint IS NULL OR fingerprint = ''")
  .get();
console.log(`剩余缺少指纹：${missing.n} 条`);
db.close();
