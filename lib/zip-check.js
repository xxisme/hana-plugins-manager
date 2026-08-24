/**
 * lib/zip-check.js — zip/目录 结构校验
 *
 * 把 zip 解压到临时目录（或直接使用本地目录），校验插件结构：
 *  - manifest.json 必需字段（id/name/version）
 *  - 存在 index.js/index.ts 或至少一个贡献目录（tools/routes/skills/agents/commands/providers）
 *  - trust / capabilities / minAppVersion 提取
 *
 * 返回 { ok, pluginRoot, manifest, errors, warnings, cleanup }。
 * cleanup() 用于清理临时解压目录（zip 来源时才需要）。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractZip } from './zip-native.js';

const CONTRIB_DIRS = ['tools', 'routes', 'skills', 'agents', 'commands', 'providers', 'widgets', 'pages'];

/**
 * 校验一个本地路径（zip 或目录）。
 * @param {string} sourcePath
 * @param {string} [workRoot] 临时工作根目录（默认系统 tmp）
 */
export function checkLocalSource(sourcePath, workRoot) {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, errors: [`路径不存在: ${sourcePath}`] };
  }
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return inspectDir(sourcePath, sourcePath, null);
  }
  if (sourcePath.toLowerCase().endsWith('.zip')) {
    const staging = fs.mkdtempSync(path.join(workRoot || os.tmpdir(), 'hana-install-'));
    try {
      extractZip(sourcePath, staging);
      return inspectDir(staging, staging, staging);
    } catch (e) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, errors: [`解压失败: ${e.message}`] };
    }
  }
  return { ok: false, errors: ['仅支持 .zip 文件或目录'] };
}

/**
 * 检查已解压的插件根目录（自动定位单层包裹目录）。
 * @param {string} root
 * @param {string} cleanupDir 需要清理的临时目录（目录来源传 null）
 */
function inspectDir(root, realRoot, cleanupDir) {
  // 若根下只有单个目录且是插件结构，则视为包裹目录
  let pluginRoot = realRoot;
  const manifestAtRoot = fs.existsSync(path.join(realRoot, 'manifest.json'));
  if (!manifestAtRoot) {
    try {
      const subDirs = fs.readdirSync(realRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      if (subDirs.length === 1) {
        const cand = path.join(realRoot, subDirs[0].name);
        if (fs.existsSync(path.join(cand, 'manifest.json')) || fs.existsSync(path.join(cand, 'index.js')) || fs.existsSync(path.join(cand, 'index.ts'))) {
          pluginRoot = cand;
        }
      }
    } catch { /* ignore */ }
  }

  const errors = [];
  const warnings = [];

  const manifestPath = path.join(pluginRoot, 'manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (manifest && typeof manifest !== 'object') { manifest = null; errors.push('manifest.json 不是有效对象'); }
    } catch (e) {
      errors.push(`manifest.json 解析失败: ${e.message}`);
    }
  }

  if (manifest) {
    for (const field of ['id', 'name', 'version']) {
      if (!manifest[field] || typeof manifest[field] !== 'string' || !manifest[field].trim()) {
        errors.push(`manifest.json 缺少必需字段: ${field}`);
      }
    }
    // id 白名单
    if (manifest.id && !/^[a-zA-Z0-9._-]+$/.test(manifest.id)) {
      errors.push(`manifest.id 含非法字符: ${manifest.id}`);
    }
    if (!manifest.trust) warnings.push('manifest 未声明 trust（默认 restricted）');
    if (!manifest.description) warnings.push('manifest 未声明 description');
  }

  const hasIndex = fs.existsSync(path.join(pluginRoot, 'index.js')) || fs.existsSync(path.join(pluginRoot, 'index.ts'));
  const contribCount = CONTRIB_DIRS.filter((c) => fs.existsSync(path.join(pluginRoot, c))).length;
  if (!manifest && !hasIndex && contribCount === 0) {
    errors.push('不是有效插件目录（缺少 manifest.json / index.js / 贡献目录）');
  }

  const valid = errors.length === 0;
  return {
    ok: valid,
    pluginRoot,
    manifest,
    hasIndex,
    contribCount,
    errors,
    warnings,
    cleanup: cleanupDir ? () => { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } } : () => {},
  };
}
