/**
 * lib/homes.js — Hana 主目录探测与持久化
 *
 * 探测顺序（第一个存在的作为当前 home）：
 *   1. 已持久化的用户选择（current-home.json）
 *   2. 环境变量 HANA_HOME（非空且存在）
 *   3. 插件配置 hanaHome（非空且存在）
 *   4. ~/.hanako（默认候选）
 *
 * 用户选择持久化到 <dataDir>/current-home.json。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveDataDir, getContext } from './plugin-context.js';

const CURRENT_HOME_FILE = 'current-home.json';

/** 读取持久化的选择（私有 helper，不触发探测） */
function readSaved(dataDir) {
  const dir = resolveDataDir();
  if (!dir) return null;
  try {
    const f = path.join(dir, CURRENT_HOME_FILE);
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (j && j.hanaHome && fs.existsSync(j.hanaHome)) return path.resolve(j.hanaHome);
    }
  } catch { /* ignore */ }
  return null;
}

/** 探测所有候选 home（含持久化选择、环境变量、配置、默认候选），去重保留顺序 */
export function listCandidates() {
  const candidates = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || typeof p !== 'string' || !p.trim()) return;
    const norm = path.resolve(p.trim());
    if (seen.has(norm)) return;
    seen.add(norm);
    candidates.push(norm);
  };

  add(readSaved());
  if (process.env.HANA_HOME) add(process.env.HANA_HOME);

  const ctx = getContext();
  if (typeof ctx.configGet === 'function') {
    try {
      const cfg = ctx.configGet('hanaHome');
      if (cfg) add(cfg);
    } catch { /* ignore */ }
  }

  add(path.join(os.homedir(), '.hanako'));
  return candidates;
}

/** 读取当前选定的 home（持久化 + 探测兜底） */
export function getCurrentDshHome() {
  // 1. 持久化选择
  const saved = readSaved();
  if (saved) return saved;
  // 2. 探测兜底：第一个存在的候选
  for (const c of listCandidates()) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 持久化用户选择的 home */
export function setCurrentDshHome(hanaHome) {
  const dir = resolveDataDir();
  if (!dir) throw new Error('dataDir 未配置');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, CURRENT_HOME_FILE),
    JSON.stringify({ hanaHome: path.resolve(hanaHome), updatedAt: new Date().toISOString() }, null, 2),
    'utf-8'
  );
}

/** 添加自定义 home 路径（返回规范化路径；仅校验合法性，不要求存在） */
export function addCustomDshHome(input) {
  if (!input || typeof input !== 'string' || !input.trim()) {
    throw new Error('路径不能为空');
  }
  return path.resolve(input.trim());
}
