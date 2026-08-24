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

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT = 20000;

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
    if (!res.ok) return { ok: false, error: `GitHub 仓库信息获取失败: HTTP ${res.status}`, status: res.status };
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

/** 读取远端默认分支的 version（优先 manifest.version，其次 package.json.version） */
export async function getRemoteVersion(owner, repoName, branch, dataDir) {
  const r = await getRemoteManifest(owner, repoName, branch, dataDir);
  if (r.ok && r.manifest && r.manifest.version) return { ok: true, version: r.manifest.version };
  // 尝试 package.json（若 manifest 无 version 或 manifest 不存在）
  const p = await getRemoteFile(owner, repoName, branch, 'package.json', dataDir);
  if (p.ok) {
    try {
      const j = JSON.parse(p.content);
      if (j && j.version) return { ok: true, version: j.version, from: 'package.json' };
    } catch { /* ignore */ }
  }
  return { ok: false, error: '远端未找到 version（manifest/package.json 均缺失）' };
}

/** 获取最新 release tag */
export async function getLatestRelease(owner, repoName, dataDir) {
  const token = readGithubToken(dataDir);
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases/latest`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.status === 404) return { ok: false, hasRelease: false };
    if (!res.ok) return { ok: false, error: `releases 获取失败: HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, tag: j.tag_name || null, name: j.name || null, publishedAt: j.published_at || null, hasRelease: true };
  } catch (e) {
    return { ok: false, error: `releases 请求失败: ${e.message || e.name}` };
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
