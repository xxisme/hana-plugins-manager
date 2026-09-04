/**
 * lib/zip-check.js — zip/目录 结构校验
 *
 * 对照 hana 插件 SDK 的目录契约（docs/PLUGINS.md「目录结构」）：
 *  - manifest.json 可选；没有 manifest 时 id 取自目录名，权限默认 restricted
 *  - 有效插件 = 存在 index.js/index.ts 或任一贡献目录
 *    （tools/skills/commands/agents/assets/routes/providers/extensions，及 legacy widgets/pages）
 *  - 自动定位插件根目录：兼容多层嵌套包裹（repo-main/、plugins/my-plugin/ 等），最多下探 4 层
 *  - 插件合集仓库（同一仓库/压缩包内含多个插件）返回 multiple + candidates，
 *    由上层（安装向导）提示用户选择安装其中一项
 *  - 结构类瑕疵只记录 warnings（如 manifest 缺 id/name/version），不再拒绝安装；
 *    最终结构判定交给 hana 宿主安装 API（POST /api/plugins/install）
 *
 * 返回 { ok, multiple?, candidates?, pluginRoot, manifest, hasIndex, contribCount, errors, warnings, cleanup }。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractZip } from './zip-native.js';

// SDK 目录契约 + legacy 目录（widgets/pages 为存量 page/widget UI）
const CONTRIB_DIRS = ['tools', 'skills', 'commands', 'agents', 'assets', 'routes', 'providers', 'extensions', 'widgets', 'pages'];
const MAX_NEST_DEPTH = 4; // 包裹/嵌套定位最多下探的层数
const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.cache', 'docs'];

/** 一个目录是否"看起来像"插件根（含 manifest 或入口或贡献目录或单文件 skill） */
function looksLikePluginDir(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return true;
  if (fs.existsSync(path.join(dir, 'index.js')) || fs.existsSync(path.join(dir, 'index.ts'))) return true;
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return true; // 根目录单文件 skill 写法（合集提示用）
  return CONTRIB_DIRS.some((c) => fs.existsSync(path.join(dir, c)));
}

function readManifestAt(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return m && typeof m === 'object' ? m : null;
  } catch { return null; }
}

/**
 * 收集仓库/压缩包内所有"看起来像插件"的目录。
 * - 根目录本身就是插件 → 返回单个
 * - 否则 BFS 下探最多 MAX_NEST_DEPTH 层
 * - 排序：含 manifest 的优先，再按深度
 */
function collectCandidates(realRoot) {
  if (looksLikePluginDir(realRoot)) return [{ dir: realRoot, depth: 0, hasManifest: fs.existsSync(path.join(realRoot, 'manifest.json')) }];
  const queue = [{ dir: realRoot, depth: 0 }];
  const out = [];
  let visited = 0;
  const MAX_VISITED = 300; // 防超大 zip 的目录海量展开把同步 BFS 卡在 UI 线程（readdirSync 是同步的）
  while (queue.length) {
    if (visited++ >= MAX_VISITED) break;
    const { dir, depth } = queue.shift();
    if (depth >= MAX_NEST_DEPTH) continue;
    let subs = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => !IGNORE_DIRS.includes(e.name));
    } catch { continue; }
    for (const s of subs) {
      const child = path.join(dir, s.name);
      if (looksLikePluginDir(child)) {
        out.push({ dir: child, depth: depth + 1, hasManifest: fs.existsSync(path.join(child, 'manifest.json')) });
      } else if (depth + 1 < MAX_NEST_DEPTH) {
        queue.push({ dir: child, depth: depth + 1 });
      }
    }
  }
  return out.sort((a, b) => Number(b.hasManifest) - Number(a.hasManifest) || a.depth - b.depth);
}

function makeCleanup(cleanupDir) {
  return cleanupDir
    ? () => { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    : () => {};
}

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
    return inspectDir(sourcePath, null);
  }
  if (sourcePath.toLowerCase().endsWith('.zip')) {
    // mkdtempSync 要求父目录已存在;workRoot 可能尚未创建（如重启后 tmp 被清理）,
    // 这里统一补齐,所有调用方（local/github/tool）都无需自己记着建目录
    const base = workRoot || os.tmpdir();
    try { fs.mkdirSync(base, { recursive: true }); } catch { /* 下面 mkdtemp 会再报 */ }
    const staging = fs.mkdtempSync(path.join(base, 'hana-install-'));
    try {
      extractZip(sourcePath, staging);
      return inspectDir(staging, staging);
    } catch (e) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, errors: [`预检解压失败（zip 可能损坏或下载未完成）: ${e.message}`] };
    }
  }
  return { ok: false, errors: ['仅支持 .zip 文件或目录'] };
}

/**
 * 检查插件根目录（自动定位单层/多层包裹目录，识别插件合集）。
 * @param {string} realRoot 实际要定位的根
 * @param {string|null} cleanupDir 需要清理的临时目录（目录来源传 null）
 */
function inspectDir(realRoot, cleanupDir) {
  const errors = [];
  const warnings = [];
  const candidates = collectCandidates(realRoot);

  // ── 插件合集：返回候选列表，由上层提示用户选择安装其中一项 ──
  if (candidates.length > 1) {
    const list = candidates.map((c) => {
      const m = readManifestAt(c.dir);
      const entry = m && m.entry ? String(m.entry).replace(/^\.\//, '') : null;
      return {
        pluginRoot: c.dir,
        manifest: m,
        hasIndex: fs.existsSync(path.join(c.dir, 'index.js')) || fs.existsSync(path.join(c.dir, 'index.ts')),
        contribCount: CONTRIB_DIRS.filter((d) => fs.existsSync(path.join(c.dir, d))).length,
        // 入口缺失标记：manifest 显式声明 entry 但源码包内不存在（源码项目病），前端可提示
        entryMissing: !!(entry && !fs.existsSync(path.join(c.dir, entry))),
      };
    });
    warnings.push(`检测到 ${candidates.length} 个候选插件，请选择要安装的一项`);
    return {
      ok: true,
      multiple: true,
      candidates: list,
      pluginRoot: realRoot,
      manifest: null,
      hasIndex: false,
      contribCount: 0,
      errors,
      warnings,
      cleanup: makeCleanup(cleanupDir),
      stagingRoot: cleanupDir || null, // zip 来源=解压临时目录；目录来源=null（不可删）
    };
  }

  // ── 单插件（或零候选）：原判定逻辑 ──
  const single = candidates[0] || null;
  const pluginRoot = single ? single.dir : realRoot;
  const locatedExplicit = single !== null;
  if (!locatedExplicit) {
    warnings.push('未在目录内定位到 manifest.json / index / 贡献目录，将由 Hana 安装器最终判定');
  }

  const manifest = readManifestAt(pluginRoot);
  if (manifest) {
    if (manifest.id && !/^[a-zA-Z0-9._:-]+$/.test(String(manifest.id))) {
      errors.push(`manifest.id 含非法字符: ${manifest.id}`);
    } else if (!manifest.id || !String(manifest.id).trim()) {
      warnings.push('manifest 未声明 id，将使用目录名作为插件 id');
    }
    if (!manifest.name) warnings.push('manifest 未声明 name');
    if (!manifest.version) warnings.push('manifest 未声明 version（更新对比将不可用）');
    if (!manifest.trust) warnings.push('manifest 未声明 trust（默认 restricted）');
    if (!manifest.description) warnings.push('manifest 未声明 description');
    // 入口文件存在性：manifest 显式声明 entry 时，指向的文件必须真实存在。
    // 源码项目常见病：entry 指向构建产物（如 dist/index.js），源码包内不存在——
    // 装上后宿主加载不到入口，表现为“安装成功但插件打不开”。
    if (manifest.entry) {
      const entryRel = String(manifest.entry).replace(/^\.\//, '');
      if (!fs.existsSync(path.join(pluginRoot, entryRel))) {
        errors.push(`manifest.entry 入口文件不存在: ${manifest.entry}（可能是源码项目，构建产物在 GitHub Releases，建议下载发布包 zip 安装）`);
      }
    }
  } else {
    const hasAnyStructure = fs.existsSync(path.join(pluginRoot, 'index.js'))
      || fs.existsSync(path.join(pluginRoot, 'index.ts'))
      || fs.existsSync(path.join(pluginRoot, 'SKILL.md'))
      || CONTRIB_DIRS.some((c) => fs.existsSync(path.join(pluginRoot, c)));
    if (!hasAnyStructure) {
      errors.push('不是有效插件目录（缺少 manifest.json / index.js / 贡献目录 / SKILL.md）');
    }
  }

  const hasIndex = fs.existsSync(path.join(pluginRoot, 'index.js')) || fs.existsSync(path.join(pluginRoot, 'index.ts'));
  const contribCount = CONTRIB_DIRS.filter((c) => fs.existsSync(path.join(pluginRoot, c))).length;

  return {
    ok: errors.length === 0,
    multiple: false,
    pluginRoot,
    manifest,
    hasIndex,
    contribCount,
    errors,
    warnings,
    cleanup: makeCleanup(cleanupDir),
    stagingRoot: cleanupDir || null, // zip 来源=解压临时目录；目录来源=null（不可删）
  };
}
