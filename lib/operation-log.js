/**
 * lib/operation-log.js — 操作日志
 *
 * 追加/读取最近 N 条操作记录，存 <dataDir>/operations.log（每行一条 JSON）。
 * 日志不记录 token / PII；长字段（stdout/stderr）截断到尾部 500 字符。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = 'operations.log';
const TAIL_LEN = 500;

function logPath(dataDir) {
  return path.join(dataDir, LOG_FILE);
}

/** 追加一条操作日志（对象） */
export function appendLog(dataDir, entry = {}) {
  if (!dataDir) return;
  try {
    const sanitized = { ...entry };
    if (typeof sanitized.stdoutTail === 'string' && sanitized.stdoutTail.length > TAIL_LEN) {
      sanitized.stdoutTail = sanitized.stdoutTail.slice(-TAIL_LEN);
    }
    if (typeof sanitized.stderrTail === 'string' && sanitized.stderrTail.length > TAIL_LEN) {
      sanitized.stderrTail = sanitized.stderrTail.slice(-TAIL_LEN);
    }
    // 不落 token 类字段
    delete sanitized.token;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...sanitized,
    }) + '\n';
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logPath(dataDir), line, 'utf-8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 读取最近 N 条操作日志（新的在前） */
export function readRecentLogs(dataDir, limit = 50) {
  if (!dataDir) return [];
  const p = logPath(dataDir);
  if (!fs.existsSync(p)) return [];
  try {
    const text = fs.readFileSync(p, 'utf-8');
    const lines = text.split('\n').filter((l) => l.trim());
    const out = [];
    for (const l of lines.slice(-Math.max(limit, 1))) {
      try {
        out.push(JSON.parse(l));
      } catch { /* 跳过损坏行 */ }
    }
    return out.reverse(); // 新的在前
  } catch {
    return [];
  }
}

/** 初始化日志文件（不存在则创建空文件） */
export function ensureLogFile(dataDir) {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const p = logPath(dataDir);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8');
  } catch { /* ignore */ }
}
