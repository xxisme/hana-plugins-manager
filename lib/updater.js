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
      const rv = await getRemoteVersion(src.owner, src.repoName, src.branch, dataDir);
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

  const risk = runRiskCheck(check, null);
  return { ok: true, check, risk, githubUrl: src.githubUrl, zipPath };
}

function downloadZip(src, zipPath, dataDir) {
  return import('./github.js').then((gh) => gh.downloadRepoZip(src.owner, src.repoName, src.branch, zipPath, dataDir));
}
