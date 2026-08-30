/**
 * lib/github.js — GitHub 封装
 *
 *  - 仓库信息（默认分支）
 *  - 读取默认分支的 manifest.json / version（对比更新用）
 *  - 最新 release tag
 *  - codeload zip 下载（限 50MB，可选 GITHUB_TOKEN）
 *
 * 鉴权 token 读取：process.env.GITHUB_TOKEN > <dataDir>/github-token（明文）。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { parseGithubUrl } from './sources.js';
import { compareVersions } from './risk-check.js';

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT = 20000;

// 进程内仓库信息缓存（批量更新去重，避免对同一 owner/repo 重复探测 defaultBranch）
const REPO_INFO_CACHE = new Map();
async function getRepoInfoCached(owner, repoName, dataDir) {
  const key = `${owner}/${repoName}`;
  if (REPO_INFO_CACHE.has(key)) return REPO_INFO_CACHE.get(key);
  const r = await getRepoInfo(`${owner}/${repoName}`, dataDir);
  // 只缓存成功结果：限流(403)/网络失败不缓存，否则失败状态会污染后续所有检测
  if (r.ok) REPO_INFO_CACHE.set(key, r);
  return r;
}

/** 读取 GitHub token（加速限流） */
export function readGithubToken(dataDir) {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) return process.env.GITHUB_TOKEN.trim();
  if (dataDir) {
    const p = path.join(dataDir, 'github-token');
    try {
      if (fs.existsSync(p)) {
        const t = fs.readFileSync(p, 'utf8').trim();
        if (t) return t;
      }
    } catch { /* ignore */ }
  }
  return null;
}

function ghHeaders(token) {
  const h = { 'user-agent': 'hana-plugins-manager', accept: 'application/vnd.github+json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** 获取仓库信息（默认分支等） */
export async function getRepoInfo(urlOrSpec, dataDir) {
  const parsed = parseGithubUrl(urlOrSpec);
  if (!parsed) return { ok: false, error: `无法解析的 GitHub 地址: ${urlOrSpec}` };
  const token = readGithubToken(dataDir);
  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.repo}`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) {
      // 403 通常是匿名 API 限流（60 次/小时），给出可执行提示而非含糊的 "HTTP 403"
      const friendly = res.status === 403
        ? 'GitHub API 限流（匿名 60 次/小时已用完），请稍后再试或配置 Token 提高配额'
        : `GitHub 仓库信息获取失败: HTTP ${res.status}`;
      return { ok: false, error: friendly, status: res.status };
    }
    const j = await res.json();
    return {
      ok: true,
      owner: parsed.owner,
      repoName: parsed.repoName,
      repo: parsed.repo,
      defaultBranch: j.default_branch || parsed.branch || 'master',
      description: j.description || '',
      stars: j.stargazers_count ?? null,
      homepage: j.homepage || null,
      url: j.html_url || parsed.url,
    };
  } catch (e) {
    return { ok: false, error: `GitHub 请求失败: ${e.message || e.name}` };
  }
}

/**
 * 用 api.github.com Contents API 读取远端文件内容（base64 解码）。
 * 注意：raw.githubusercontent.com 在某些网络不可达，改用 api.github.com（已验证可达）。
 */
async function getRemoteFile(owner, repoName, branch, filePath, dataDir) {
  const token = readGithubToken(dataDir);
  const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}?ref=${encodeURIComponent(branch || 'master')}`;
  try {
    const res = await fetch(url, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.status === 404) return { ok: false, status: 404, error: '文件不存在' };
    if (!res.ok) return { ok: false, status: res.status, error: `文件获取失败: HTTP ${res.status}` };
    const j = await res.json();
    if (j.type !== 'file' || !j.content) return { ok: false, error: '非文件类型' };
    const content = Buffer.from(j.content, 'base64').toString('utf-8');
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: `文件请求失败: ${e.message || e.name}` };
  }
}

/** 读取远端仓库默认分支（或指定分支）的 manifest.json */
export async function getRemoteManifest(owner, repoName, branch, dataDir) {
  const r = await getRemoteFile(owner, repoName, branch, 'manifest.json', dataDir);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  try {
    return { ok: true, manifest: JSON.parse(r.content) };
  } catch (e) {
    return { ok: false, error: `远端 manifest 不是有效 JSON: ${e.message}` };
  }
}

/** 从指定目录读取 version（优先 manifest.json，其次 package.json）。dir 为空表示根目录 */
async function readVersionFrom(owner, repoName, branch, dir, dataDir) {
  const prefix = dir ? String(dir).replace(/[\\/]+$/, '') + '/' : '';
  const m = await getRemoteFile(owner, repoName, branch, prefix + 'manifest.json', dataDir);
  if (m.ok) {
    try {
      const j = JSON.parse(m.content);
      if (j && j.version) return { ok: true, version: j.version, from: 'manifest' };
    } catch { /* ignore */ }
  }
  const p = await getRemoteFile(owner, repoName, branch, prefix + 'package.json', dataDir);
  if (p.ok) {
    try {
      const j = JSON.parse(p.content);
      if (j && j.version) return { ok: true, version: j.version, from: 'package.json' };
    } catch { /* ignore */ }
  }
  return { ok: false, noVersion: true, error: '该目录下未找到 manifest/package.json 的 version 字段' };
}

// 常见的"插件位于子目录"命名，命中后可下探该目录（优先）
const NESTED_CANDIDATES = ['plugins', 'plugin', 'packages', 'src', 'apps', 'tools', 'services', 'extensions'];
// 明确"非插件"子目录，扫描时跳过
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'docs', 'images', 'assets', 'dist', 'build', 'examples', 'test', 'tests', '__tests__', 'fixtures', 'scripts', 'bin', '.vscode', '.idea', 'wiki', 'public', 'static', 'docs-cn', 'website', 'site', 'benchmark', 'benchmarks', 'mocks']);

/**
 * 在嵌套目录中探测 version。
 * 关键语义：
 *  - **只有「列目录 API 失败(404)」才判定为仓库 404**（仓库不存在、链接错误或私有仓库无权限）
 *  - 单个文件 404（manifest.json/package.json 不存在）只是「该目录下无 version」，不等于仓库 404
 *  - 候选目录优先 NESTED_CANDIDATES 命中；其余顶层"看起来可包含插件"的子目录也会被逐一尝试
 */
async function findNestedVersion(owner, repoName, branch, dataDir) {
  const token = readGithubToken(dataDir);
  const listDir = async (p) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/contents/${p ? encodeURIComponent(p) + '/' : ''}?ref=${encodeURIComponent(branch || 'master')}`,
        { headers: ghHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) }
      );
      if (res.status === 404) return { _notFound: true };
      if (!res.ok) return { _err: `HTTP ${res.status}` };
      const j = await res.json();
      return Array.isArray(j) ? j : { _err: '列表返回非数组' };
    } catch (e) {
      return { _err: e.message || e.name };
    }
  };
  const isUsableDir = (i) => i.type === 'dir' && !SKIP_DIRS.has(i.name.toLowerCase());

  const root = await listDir('');
  if (root && root._notFound) return { ok: false, status: 'upstream-404', noVersion: true, error: 'GitHub 仓库或目录返回 404（仓库不存在、链接错误或私有仓库无权限）' };
  if (!root || root._err) return { ok: false, status: 'check-failed', noVersion: true, error: `列表根目录失败: ${root && root._err}` };
  const dirs = root.filter(isUsableDir);

  // 候选目录：NESTED_CANDIDATES 优先，再补其他"看起来可包含插件"的子目录（限 8 个）
  const candidateSet = new Set();
  if (dirs.length === 1) candidateSet.add(dirs[0].name); // repo-main 之类单包裹
  for (const d of NESTED_CANDIDATES) {
    if (dirs.find((x) => x.name === d)) candidateSet.add(d);
  }
  for (const d of dirs) {
    if (candidateSet.size >= 8) break;
    if (!candidateSet.has(d.name)) candidateSet.add(d.name);
  }
  const candidates = Array.from(candidateSet);

  let tried = 0;
  for (const cand of candidates) {
    tried += 1;
    const v0 = await readVersionFrom(owner, repoName, branch, cand, dataDir);
    if (v0.ok) return v0;
    const sub = await listDir(cand);
    if (!sub || sub._notFound || sub._err) continue;
    const subDirs = sub.filter(isUsableDir);
    // 子目录可能是单包裹（repo-main）或多插件合集（plugins/ 下多个插件目录）：
    // 逐个探测（限量 5 个防 API 滥用），任一命中即返回——
    // 修复合集仓库多子插件场景下更新检测失效（此前仅 subDirs.length===1 才下探）
    for (const sd of subDirs.slice(0, 5)) {
      const v1 = await readVersionFrom(owner, repoName, branch, `${cand}/${sd.name}`, dataDir);
      if (v1.ok) return v1;
    }
  }
  return { ok: false, status: 'no-version', noVersion: true, error: `已尝试 ${tried} 个嵌套目录，均未找到 version` };
}

/**
 * 读取远端默认分支的 version（用于更新对比）。
 * 探测顺序：根目录 manifest/package.json → 嵌套目录（monorepo/包裹）→ release tag 兜底。
 * 失败状态细分：
 *  - 'upstream-404'  列目录 API 404 = 仓库不存在、链接错误或私有仓库无权限
 *  - 'no-version'    仓库可达但未声明 version 字段
 *  - 'check-failed'  网络/限流等其他失败
 */
export async function getRemoteVersion(owner, repoName, branch, dataDir) {
  // 1) 探测仓库真实默认分支(缓存避免重复 API)
  const info = await getRepoInfoCached(owner, repoName, dataDir);
  if (!info.ok) {
    // 只有 HTTP 404 才是「仓库不存在」；限流(403)/网络错误应归为 check-failed，
    // 否则全部误报成"仓库 404"，误导用户去查链接/配 token
    const status = info.status === 404 ? 'upstream-404' : 'check-failed';
    return { ok: false, status, error: info.error || 'GitHub 仓库信息获取失败' };
  }
  // 候选分支顺序：默认分支 > 用户配置分支 > main > master
  const branches = Array.from(new Set([info.defaultBranch, branch, 'main', 'master'].filter(Boolean)));
  for (const br of branches) {
    const root = await readVersionFrom(owner, repoName, br, '', dataDir);
    if (root.ok) return root;
    const nested = await findNestedVersion(owner, repoName, br, dataDir);
    if (nested.ok) return nested;
    if (nested.status === 'upstream-404') continue; // 试下一个分支
    if (nested.status === 'check-failed') {
      return { ok: false, status: 'check-failed', error: nested.error || '检测失败' };
    }
    // 该分支无 version：试下一个分支
  }
  // 2) 所有分支都没找到 version：尝试 release tag 兜底
  const rel = await getLatestRelease(owner, repoName, dataDir);
  if (rel.ok && rel.tag) {
    const v = String(rel.tag).replace(/^v/i, '');
    if (/^\d/.test(v)) return { ok: true, version: v, from: 'release-tag' };
  }
  return { ok: false, status: 'no-version', error: '远端仓库无 version 字段（manifest/package.json/release tag 均无 version）' };
}

/**
 * 获取版本号最高的 release（含 pre-release），返回其 tag 与作者上传的 zip 资产。
 *
 * 背景：此前只查 /releases/latest（GitHub 仅返回正式版），而版本检测（getRemoteVersion）
 * 读的是源码 manifest——作者发 pre-release 前常先把源码 bump 到新版本号，于是出现
 * 「检测显示可更新 X，下载却永远装成正式版 Y」的不同步（如 dsh-hanako 0.20.1 pre vs 0.20.0）。
 * 现在统一按「版本号最高」取（含 pre-release），检测与下载使用同一语义，消除误解。
 */
export async function getLatestRelease(owner, repoName, dataDir) {
  const token = readGithubToken(dataDir);
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases?per_page=30`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.status === 404) return { ok: false, hasRelease: false };
    if (!res.ok) return { ok: false, error: `releases 获取失败: HTTP ${res.status}` };
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return { ok: false, hasRelease: false };
    // 挑版本号最高的一项（含 pre-release；draft 排除）。compareVersions 比较数字部分，
    // 同版本号时保留先出现的（releases 接口按发布时间倒序，通常正式版在前）。
    let best = null;
    for (const r of list) {
      if (!r || r.draft || !r.tag_name) continue;
      if (!best) { best = r; continue; }
      if (compareVersions(r.tag_name, best.tag_name) > 0) best = r;
    }
    if (!best) return { ok: false, hasRelease: false };
    // 只保留作者上传的 zip 资产：排除 GitHub 自动生成的 Source code (zip/tar.gz)
    // （自动资产 = 源码包本身，装它等于装源码，无 Release 优先意义）
    const assets = Array.isArray(best.assets)
      ? best.assets.filter((a) => {
          const name = String(a.name || '');
          const isAutoSource = /^source\s+code/i.test(name) || /source-code/i.test(name) || name.endsWith('.tar.gz') || name.endsWith('.tar.gz.sig');
          return name.toLowerCase().endsWith('.zip') && !isAutoSource;
        })
      : [];
    return { ok: true, tag: best.tag_name || null, name: best.name || null, publishedAt: best.published_at || null, hasRelease: true, assets };
  } catch (e) {
    return { ok: false, error: `releases 请求失败: ${e.message || e.name}` };
  }
}

/** 从 release 资产里挑选最合适的 zip：优先文件名含 repoName，其次第一个 */
export function pickReleaseAsset(assets, repoName) {
  const n = String(repoName || '').toLowerCase();
  return assets.find((a) => String(a.name || '').toLowerCase().includes(n)) || assets[0] || null;
}

/**
 * 下载 release 资产到本地文件。
 * 走 browser_download_url（release-assets.githubusercontent.com，cdn 直连），不走 api.github.com 限流。
 */
export async function downloadReleaseAsset(asset, destPath, dataDir) {
  const url = asset && (asset.browser_download_url || asset.url);
  if (!url) return { ok: false, error: 'release 资产缺少下载地址' };
  const token = readGithubToken(dataDir);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'hana-plugins-manager', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: `下载失败: HTTP ${res.status}` };
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_DOWNLOAD_BYTES) return { ok: false, error: '文件体积超过 50MB 限制' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, error: '文件体积超过 50MB 限制' };
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return { ok: true, path: destPath, size: buf.length };
  } catch (e) {
    return { ok: false, error: `下载失败: ${e.message || e.name}` };
  }
}

/** 下载 codeload 分支 zip 到本地文件，返回路径 */
export async function downloadRepoZip(owner, repoName, branch, destPath, dataDir) {
  const token = readGithubToken(dataDir);
  const url = `https://codeload.github.com/${owner}/${repoName}/zip/refs/heads/${encodeURIComponent(branch || 'master')}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'hana-plugins-manager', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, error: `下载失败: HTTP ${res.status}` };
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_DOWNLOAD_BYTES) return { ok: false, error: '仓库体积超过 50MB 限制' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, error: '仓库体积超过 50MB 限制' };
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return { ok: true, path: destPath, size: buf.length };
  } catch (e) {
    return { ok: false, error: `下载失败: ${e.message || e.name}` };
  }
}
