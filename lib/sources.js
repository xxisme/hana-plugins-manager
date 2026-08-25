/**
 * lib/sources.js — GitHub 来源关联存储
 *
 * 保存每个插件的 GitHub 地址（pluginId → { githubUrl, repo, branch, updatedAt }）。
 * 数据落 <dataDir>/plugin-sources.json；并支持从已安装插件的 manifest.repository 自动识别。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const SOURCES_FILE = 'plugin-sources.json';

function sourcesPath(dataDir) {
  return path.join(dataDir, SOURCES_FILE);
}

/** 读取全部来源关联 */
export function readSources(dataDir) {
  if (!dataDir) return {};
  const p = sourcesPath(dataDir);
  if (!fs.existsSync(p)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 保存全部来源关联 */
export function writeSources(dataDir, sources) {
  if (!dataDir) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sourcesPath(dataDir), JSON.stringify(sources, null, 2), 'utf-8');
}

/** 获取单个插件的来源关联 */
export function getSource(dataDir, pluginId) {
  return readSources(dataDir)[pluginId] || null;
}

/**
 * 保存/更新某个插件的 GitHub 地址。
 * 自动解析 owner/repo 与默认分支（默认 master/main）。
 */
export function setSource(dataDir, pluginId, githubUrl) {
  const sources = readSources(dataDir);
  const url = String(githubUrl || '').trim();
  if (!url) {
    delete sources[pluginId];
    writeSources(dataDir, sources);
    return { saved: false, removed: true };
  }
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new Error(`无法解析的 GitHub 地址: ${url}`);
  sources[pluginId] = {
    githubUrl: parsed.url,
    repo: parsed.repo,
    owner: parsed.owner,
    repoName: parsed.repoName,
    branch: parsed.branch,
    updatedAt: new Date().toISOString(),
  };
  writeSources(dataDir, sources);
  return { saved: true, source: sources[pluginId] };
}

/**
 * 从插件 manifest 的 repository 字段自动识别 GitHub 地址。
 * 支持 { type, url } 或字符串。
 */
export function detectSourceFromManifest(manifest) {
  if (!manifest || !manifest.repository) return null;
  let repoStr = null;
  if (typeof manifest.repository === 'string') repoStr = manifest.repository;
  else if (manifest.repository && typeof manifest.repository === 'object') {
    repoStr = manifest.repository.url || manifest.repository.repository || null;
  }
  if (!repoStr) return null;
  // 形如 user/repo 的短格式补全
  if (/^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(repoStr) && !repoStr.includes('/')) {
    repoStr = `https://github.com/${repoStr}`;
  }
  return parseGithubUrl(repoStr);
}

/**
 * 解析 GitHub 地址 → { url, repo: 'owner/repo', owner, repoName, branch }。
 * 支持：https://github.com/owner/repo、git@github.com:owner/repo.git、owner/repo 短格式。
 */
export function parseGithubUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;

  let owner = null;
  let repoName = null;

  // git@github.com:owner/repo.git
  let m = s.match(/^git@[^:]+:([^/]+)\/([^/#]+?)(?:\.git)?$/);
  if (m) { owner = m[1]; repoName = m[2].replace(/\.git$/, ''); }
  else {
    // https://github.com/owner/repo[可选 /tree|/blob/.. 或 #分支]
    // 允许仓库名后跟 /tree、/blob、/issues、/releases 等路径片段
    m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/);
    if (m) { owner = m[1]; repoName = m[2].replace(/\.git$/, ''); }
    else {
      // owner/repo 短格式（去 .git，允许 #分支）
      m = s.match(/^([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?(?:#.*)?$/);
      if (m) { owner = m[1]; repoName = m[2].replace(/\.git$/, ''); }
    }
  }

  if (!owner || !repoName) return null;
  // 从完整 URL 提取 branch（#branch 或 /tree/branch）
  let branch = 'master';
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) {
    const frag = s.slice(hashIdx + 1);
    if (frag) branch = frag.replace(/\.git$/, '');
  }
  const treeIdx = s.indexOf('/tree/');
  if (treeIdx !== -1) {
    const t = s.slice(treeIdx + 6).split(/[/?#]/)[0];
    if (t) branch = t;
  }
  const blobIdx = s.indexOf('/blob/');
  if (blobIdx !== -1) {
    const t = s.slice(blobIdx + 6).split(/[/?#]/)[0];
    if (t) branch = t;
  }

  const repo = `${owner}/${repoName}`;
  return {
    url: `https://github.com/${owner}/${repoName}`,
    repo,
    owner,
    repoName,
    branch,
  };
}
