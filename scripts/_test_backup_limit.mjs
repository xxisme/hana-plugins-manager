/**
 * 临时验证：cleanupOldBackups 上限 5，超出时删除时间最早的备份。
 * 模拟 7 份备份（目录名按时间递增），确认清理后保留最新 5 份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBackups, cleanupOldBackups, backupRoot } from '../lib/backup.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bk-'));
const root = backupRoot(dataDir);
fs.mkdirSync(root, { recursive: true });

// 生成 7 份备份目录（时间从旧到新），meta.json 带可读时间
const names = [
  '20260801-100000', '20260805-100000', '20260810-100000', '20260815-100000',
  '20260820-100000', '20260822-100000', '20260824-100000',
];
for (const n of names) {
  const d = path.join(root, n);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ timestamp: n }));
  fs.writeFileSync(path.join(d, 'dummy.txt'), n);
}

const before = listBackups(dataDir).map((b) => b.dir.split(path.sep).pop());
console.log('清理前(7 份):', before.join(' '));

const removed = cleanupOldBackups(dataDir, 5);
const after = listBackups(dataDir).map((b) => b.dir.split(path.sep).pop());
console.log('删除数:', removed);
console.log('清理后(应 5 份):', after.join(' '));

// 期望：保留最新的 5 份（20260810 之后的），删掉最早 2 份
// listBackups 返回新→旧；比较时按名称排序对齐
const expectAfter = names.slice(2).slice().sort(); // 后 5 个（旧→新）
const expectRemoved = names.slice(0, 2); // 前 2 个（最早）
const pass = removed === 2
  && after.slice().sort().join(',') === expectAfter.join(',')
  && expectRemoved.every((n) => !fs.existsSync(path.join(root, n)))
  && expectAfter.every((n) => fs.existsSync(path.join(root, n)));

console.log('\nPASS(删最早 2 份,保留最新 5 份):', pass);
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(pass ? 0 : 1);
