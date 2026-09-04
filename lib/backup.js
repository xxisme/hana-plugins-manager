/**
 * lib/backup.js — 插件目录备份与还原
 *
 * 备份：全量复制 ${HANA_HOME}/plugins/ → <dataDir>/backups/plugins/<YYYYMMDD-HHmmss>/ 并写 meta.json。
 * 还原：单插件还原（先备份当前版本 → 覆盖目标目录）；全量还原（先备份当前 → 清空 plugins/ → 整体拷回）。
 * 保留最近 keepLimit 条（默认 5）。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

/** 备份根目录 */
export function backupRoot(dataDir) {
  return path.join(dataDir, 'backups', 'plugins');
}

/**
 * lib 层纵深防御：校验 backupDir 必须在备份根目录内。
 * routes 层已做 assertBackupDir，这里独立再守一道——函数被其他调用方直接复用时同样安全。
 * @returns {string|null} 规范化后的安全路径，非法返回 null
 */
function assertInsideBackupRoot(dataDir, backupDir) {
  if (!backupDir || typeof backupDir !== 'string') return null;
  const root = path.resolve(backupRoot(dataDir));
  const target = path.resolve(backupDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(target)) return null;
  return target;
}

/** cpSync filter：跳过符号链接（防备份/还原把链接原样拷回，宿主跟随读扩大攻击面） */
function noSymlink(src) {
  try { return !fs.lstatSync(src).isSymbolicLink(); } catch { return false; }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function uniqueDir(dir) {
  const base = timestamp();
  if (!fs.existsSync(path.join(dir, base))) return base;
  const ms = String(Date.now() % 1000).padStart(3, '0');
  const c = `${base}-${ms}`;
  if (!fs.existsSync(path.join(dir, c))) return c;
  for (let i = 2; i < 100; i++) {
    const cc = `${base}-${ms}-${i}`;
    if (!fs.existsSync(path.join(dir, cc))) return cc;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 全量备份 plugins 目录。
 * @returns {string} 备份目录绝对路径
 */
export function backupPlugins(dataDir, hanaHome) {
  const src = path.join(hanaHome, 'plugins');
  if (!fs.existsSync(src)) throw new Error('plugins 目录不存在');
  const root = backupRoot(dataDir);
  const dir = path.join(root, uniqueDir(root));
  fs.mkdirSync(dir, { recursive: true });

  // 复制所有顶层条目
  const entries = fs.readdirSync(src, { withFileTypes: true });
  let pluginCount = 0;
  let fileCount = 0;
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dir, e.name);
    if (e.isDirectory()) {
      fs.cpSync(sp, dp, { recursive: true, filter: noSymlink });
      pluginCount += 1;
    } else if (e.isFile()) {
      fs.copyFileSync(sp, dp);
      fileCount += 1;
    }
    // 符号链接条目：既不目录也非文件，直接跳过（不拷链接本身，防还原后宿主跟随读）
  }

  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      type: 'plugins',
      timestamp: new Date().toISOString(),
      pluginCount,
      fileCount,
      source: src,
    }, null, 2),
    'utf-8'
  );
  return dir;
}

/** 列出所有备份（新的在前） */
export function listBackups(dataDir) {
  const root = backupRoot(dataDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let meta = null;
    const mp = path.join(dir, 'meta.json');
    if (fs.existsSync(mp)) {
      try { meta = JSON.parse(fs.readFileSync(mp, 'utf-8')); } catch { /* ignore */ }
    }
    out.push({ name: ent.name, dir, meta });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** 更新备份备注 */
export function updateBackupNote(dataDir, backupDir, note) {
  const safe = assertInsideBackupRoot(dataDir, backupDir);
  if (!safe) return false;
  const mp = path.join(safe, 'meta.json');
  let meta = {};
  if (fs.existsSync(mp)) {
    try { meta = JSON.parse(fs.readFileSync(mp, 'utf-8')); } catch { /* ignore */ }
  }
  meta.note = String(note == null ? '' : note);
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2), 'utf-8');
  return true;
}

/** 删除备份 */
export function deleteBackup(dataDir, backupDir) {
  const safe = assertInsideBackupRoot(dataDir, backupDir);
  if (!safe) return false;
  try { fs.rmSync(safe, { recursive: true, force: true }); return true; } catch { return false; }
}

/** 清理超出 keepLimit 的旧备份，返回删除数 */
export function cleanupOldBackups(dataDir, keepLimit = 5) {
  const list = listBackups(dataDir);
  let removed = 0;
  for (const b of list.slice(keepLimit)) {
    if (deleteBackup(dataDir, b.dir)) removed += 1;
  }
  return removed;
}

/** 从备份还原单个插件。返回 { ok, restoredPath, backupOfCurrent } */
export function restorePlugin(dataDir, backupDir, hanaHome, pluginId) {
  const safeBackup = assertInsideBackupRoot(dataDir, backupDir);
  if (!safeBackup) return { ok: false, error: '备份目录不存在或不在备份根目录内' };
  const safe = String(pluginId || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(safe) || safe === '.' || safe === '..') {
    return { ok: false, error: '非法插件 id' };
  }
  const srcPluginDir = path.join(safeBackup, safe);
  if (!fs.existsSync(srcPluginDir)) {
    return { ok: false, error: `备份中不存在插件: ${safe}` };
  }
  const targetDir = path.join(hanaHome, 'plugins', safe);

  // 还原前自动备份当前版本
  let backupOfCurrent = null;
  if (fs.existsSync(targetDir)) {
    backupOfCurrent = backupPlugins(dataDir, hanaHome);
  }

  // 覆盖（filter 跳过符号链接，防链接被原样还原供宿主跟随读）
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(srcPluginDir, targetDir, { recursive: true, filter: noSymlink });
  return { ok: true, restoredPath: targetDir, backupOfCurrent };
}

/** 全量还原：先备份当前 → 清空 plugins/ → 整体拷回。返回 { ok, restored[], backupOfCurrent } */
export function restorePlugins(dataDir, backupDir, hanaHome) {
  const safeBackup = assertInsideBackupRoot(dataDir, backupDir);
  if (!safeBackup) return { ok: false, error: '备份目录不存在或不在备份根目录内' };
  const pluginsSrc = path.join(hanaHome, 'plugins');

  // 先备份当前
  const backupOfCurrent = fs.existsSync(pluginsSrc)
    ? backupPlugins(dataDir, hanaHome)
    : null;

  // 清空现有插件目录
  if (fs.existsSync(pluginsSrc)) {
    fs.rmSync(pluginsSrc, { recursive: true, force: true });
  }
  fs.mkdirSync(pluginsSrc, { recursive: true });

  // 从备份拷贝（跳过 meta.json 与符号链接）
  const restored = [];
  const entries = fs.readdirSync(safeBackup, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'meta.json') continue;
    if (e.isSymbolicLink()) continue; // 顶层符号链接不还原
    const sp = path.join(safeBackup, e.name);
    const dp = path.join(pluginsSrc, e.name);
    if (e.isDirectory()) {
      fs.cpSync(sp, dp, { recursive: true, filter: noSymlink });
      restored.push(e.name);
    } else if (e.isFile()) {
      fs.copyFileSync(sp, dp);
      restored.push(e.name);
    }
  }
  return { ok: true, restored, backupOfCurrent };
}
