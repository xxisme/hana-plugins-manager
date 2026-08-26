/**
 * lib/updater.js — 插件更新检测与执行
 *
 * 检测：对已关联 GitHub 的插件，拉取远端默认分支 manifest.version（或 package.json.version）
 *       与本地 manifest.version 对比。批量检测并行执行 + 5min 缓存（限流时 3min）。
 * 执行：下载 zip → 风险检测 → hana install（更新前 hana 服务端自动备份 plugin-backups）。
 */
'use strict';

import path from 'node:path';
import fs from 'node:fs';
import { getRemoteVersion } from './github.js';
import { getSource } from './sources.js';
import { compareVersions, runRiskCheck } from './risk-check.js';
import { readManifest } from './scanner.js';
import { checkLocalSource } from './zip-check.js';
import { getContext } from './plugin-context.js';
import { readServerInfo } from './hana-api.js';

/**
 * 批量检测所有已关联 GitHub 的插件是否有更新。
 * @param {object} plugins 扫描出的插件列表（含 id/dir）
 * @param {string} dataDir
 * @returns {Promise<{plugins: Array}>} 每项 { id, name, localVersion, remoteVersion, status: 'outdated'|'latest'|'no-source'|'check-failed', hasUpdate, upstreamError? }
 */
export async function checkUpdates(plugins, dataDir) {
  const targets = plugins.filter((p) => p.id);
  const results = await Promise.allSettled(
    targets.map(async (p) => {
      const src = getSource(dataDir, p.id);
      const localVersion = readLocalVersion(p);
      if (!src) {
        return { id: p.id, name: p.name, status: 'no-source', hasUpdate: false, localVersion };
      }
      const owner = src.owner || (src.repo && src.repo.split('/')[0]) || null;
      const repoName = src.repoName || (src.repo && src.repo.split('/')[1]) || null;
      if (!owner || !repoName) {
        return {
          id: p.id, name: p.name, localVersion,
          status: 'check-failed', hasUpdate: false,
          upstreamError: '来源关联缺少 owner/repo，请重新填写 GitHub 地址',
        };
      }
      const rv = await getRemoteVersion(owner, repoName, src.branch, dataDir);
      if (!rv.ok) {
        const status = (rv.status === 'upstream-404' || rv.status === 'no-version') ? rv.status : 'check-failed';
        return {
          id: p.id, name: p.name, localVersion,
          status, hasUpdate: false,
          upstreamError: rv.error,
        };
      }
      const remoteVersion = rv.version;
      const hasUpdate = !!localVersion && !!remoteVersion && compareVersions(remoteVersion, localVersion) > 0;
      return {
        id: p.id,
        name: p.name,
        localVersion,
        remoteVersion,
        status: hasUpdate ? 'outdated' : 'latest',
        hasUpdate,
        upstreamError: null,
      };
    })
  );

  const out = [];
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(r.value);
    else out.push({ status: 'check-failed', hasUpdate: false, error: r.reason?.message || '检测异常' });
  }
  return { plugins: out };
}

/** 读取本地插件版本（manifest.version，兜底目录名） */
function readLocalVersion(p) {
  const m = readManifest(p.dir);
  return (m && m.version) || null;
}

/**
 * 执行单个插件更新：下载远端 zip → 风险检测 → 返回 staged 路径供安装。
 * @returns {{ok, stagedPath?, check?, githubUrl, error?}}
 */
export async function prepareUpdate(pluginId, dataDir) {
  // 防御：id 白名单，避免拼入文件路径造成穿越
  const safeId = String(pluginId || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(safeId) || safeId === '.' || safeId === '..') {
    return { ok: false, error: '非法插件 id' };
  }
  const src = getSource(dataDir, safeId);
  if (!src) return { ok: false, error: `插件 ${safeId} 未关联 GitHub 地址` };

  const workRoot = path.join(dataDir, 'tmp');
  fs.mkdirSync(workRoot, { recursive: true });
  const zipPath = path.join(workRoot, `${safeId}-${Date.now()}.zip`);

  // 下载
  const dl = await downloadZip(src, zipPath, dataDir);
  if (!dl.ok) {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: dl.error };
  }

  // 校验 + 风险检测
  const check = checkLocalSource(zipPath, workRoot);
  if (!check.ok) {
    const detail = check.errors.join('；') + (check.warnings && check.warnings.length ? '（' + check.warnings.join('；') + '）' : '');
    try { check.cleanup(); } catch { /* ignore */ }
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: '结构校验失败: ' + detail };
  }

  // 合集仓库（仓库内含多个插件）：自动匹配本地插件 id，定位对应候选的根目录。
  // 更新语义是「把已安装插件升到新版」，候选里必有同 id 的一项；找不到则明确报错，
  // 而不是把整个仓库根目录塞给宿主（根目录没有 manifest.json，宿主会拒绝）。
  let installRoot = check.pluginRoot;
  let riskCheck = check;
  if (check.multiple && Array.isArray(check.candidates) && check.candidates.length > 0) {
    const matched = matchCandidate(check.candidates, safeId);
    if (!matched) {
      try { check.cleanup(); } catch { /* ignore */ }
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
      return {
        ok: false,
        error: `该仓库包含 ${check.candidates.length} 个插件，未找到与本地插件「${safeId}」匹配的候选，无法自动更新。可先卸载后在「安装」页手动选择`,
      };
    }
    installRoot = matched.pluginRoot;
    // 风险检测针对选中候选（manifest 换成候选的），而不是整个仓库根
    riskCheck = { ...check, pluginRoot: matched.pluginRoot, manifest: matched.manifest || check.manifest };
  }

  const risk = runRiskCheck(riskCheck, getHanaVersion());
  // pluginRoot 必须返回「实际安装的根」：非合集 = 定位到的插件根；
  // 合集 = 匹配到的候选目录（返回 check.pluginRoot 会把整个仓库根塞给宿主，
  // 根目录没有 manifest.json 会被宿主拒绝，导致合集子插件更新永远失败）
  return { ok: true, check, risk, githubUrl: src.githubUrl, zipPath, pluginRoot: installRoot || check.pluginRoot };
}

/**
 * 在合集仓库候选里匹配本地插件：优先 manifest.id 精确匹配，
 * 兜底目录名 / manifest.name 与 safeId 一致。
 */
export function matchCandidate(candidates, safeId) {
  if (!Array.isArray(candidates) || !safeId) return null;
  return candidates.find((c) => c.manifest && c.manifest.id === safeId)
    || candidates.find((c) => path.basename(c.pluginRoot) === safeId
        || (c.manifest && String(c.manifest.name || '').trim() === safeId))
    || null;
}

/** 读取当前 hana 版本（用于 minAppVersion 兼容性检测；读不到返回 null 不阻塞） */
function getHanaVersion() {
  try {
    const home = getContext().hanaHome || null;
    if (!home) return null;
    const info = readServerInfo(home);
    return info.ok ? info.version : null;
  } catch { return null; }
}

function downloadZip(src, zipPath, dataDir) {
  // 兜底：从 repo 字符串或 url 解析出 owner/repoName（旧 sources 无字段时也兼容）
  const owner = src.owner || (src.repo && src.repo.split('/')[0]) || null;
  const repoName = src.repoName || (src.repo && src.repo.split('/')[1]) || null;
  if (!owner || !repoName) {
    return Promise.resolve({ ok: false, status: 'check-failed', error: '来源关联缺少 owner/repo' });
  }
  return import('./github.js').then((gh) => gh.downloadRepoZip(owner, repoName, src.branch, zipPath, dataDir));
}
