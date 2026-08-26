/**
 * lib/scanner.js — 插件扫描与状态合并
 *
 * fs 扫描 ${HANA_HOME}/plugins/ 目录，解析各插件 manifest.json；
 * 合并 preferences.json 的 disabled_plugins（启用状态）与 plugin-installs.json（安装记录）。
 *
 * 返回的每个插件条目结构：
 * { id, dir, name, version, description, trust, minAppVersion, author,
 *   enabled, status, source, installedAt, updatedAt, hasManifest, error }
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

/** 插件目录 */
export function pluginsDir(hanaHome) {
  return path.join(hanaHome, 'plugins');
}

/** 读取 preferences.json 中用户手动禁用的插件 id 列表 */
export function readDisabledPlugins(hanaHome) {
  const p = path.join(hanaHome, 'preferences.json');
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // 兼容两种宿主格式：数组 [id] 或对象 { [id]: true }
    if (Array.isArray(j.disabled_plugins)) return j.disabled_plugins;
    if (j.disabled_plugins && typeof j.disabled_plugins === 'object') {
      return Object.keys(j.disabled_plugins).filter((k) => !!j.disabled_plugins[k]);
    }
    return [];
  } catch {
    return [];
  }
}

/** 读取 plugin-installs.json 安装记录 */
export function readInstallRecords(hanaHome) {
  const p = path.join(hanaHome, 'plugin-installs.json');
  if (!fs.existsSync(p)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j && typeof j.plugins === 'object' ? j.plugins : {};
  } catch {
    return {};
  }
}

/** 解析单个插件的 manifest.json */
export function readManifest(pluginDir) {
  const p = path.join(pluginDir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/** 扫描插件目录，返回插件条目列表（排序稳定） */
export function scanPlugins(hanaHome) {
  const dir = pluginsDir(hanaHome);
  if (!fs.existsSync(dir)) return { ok: true, plugins: [] };

  const disabled = new Set(readDisabledPlugins(hanaHome));
  const records = readInstallRecords(hanaHome);

  const plugins = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    return { ok: false, error: `无法读取插件目录: ${e.message}` };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pdir = path.join(dir, ent.name);
    const manifest = readManifest(pdir);
    const id = (manifest && manifest.id) || ent.name;
    const rec = records[id];

    // 有效插件判定：有 manifest.json，或包含 index.js/index.ts，或包含贡献目录
    const hasIndex = fs.existsSync(path.join(pdir, 'index.js')) || fs.existsSync(path.join(pdir, 'index.ts'));
    const hasContrib = ['tools', 'routes', 'skills', 'agents', 'commands', 'providers', 'extensions', 'widgets', 'pages']
      .some((c) => fs.existsSync(path.join(pdir, c)));
    const valid = !!(manifest || hasIndex || hasContrib);

    plugins.push({
      id,
      dir: pdir,
      name: (manifest && (manifest.name || manifest.id)) || ent.name,
      version: (manifest && manifest.version) || null,
      description: (manifest && manifest.description) || '',
      trust: (manifest && manifest.trust) || 'restricted',
      minAppVersion: (manifest && manifest.minAppVersion) || null,
      author: (manifest && manifest.author) || null,
      enabled: !disabled.has(id),
      status: valid ? (rec ? (rec.installedVersion ? 'installed' : 'unknown') : 'installed') : 'invalid',
      source: rec ? rec.source || 'local' : 'local',
      installedAt: rec ? rec.installedAt || null : null,
      updatedAt: rec ? rec.updatedAt || null : null,
      hasManifest: !!manifest,
      valid,
      error: valid ? null : '缺少 manifest.json / index / 贡献目录',
    });
  }

  // 按名称排序
  plugins.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { ok: true, plugins };
}
