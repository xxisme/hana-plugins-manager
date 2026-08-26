/**
 * routes/api.js — Hana 插件管理 HTTP 路由
 *
 * 端点：
 *   GET  /manager, /page            iframe shell HTML（CSS/JS 内联 + 注入 token）
 *   GET  /api/status                 Hana 主目录 / 服务状态 / 插件总数
 *   GET  /api/homes                  候选 home + 当前选择
 *   POST /api/current-home           切换当前 home
 *   GET  /api/plugins                插件列表（API 优先，降级 fs）
 *   GET  /api/plugins/:id            单个插件详情
 *   GET/POST/DELETE /api/plugins/:id/source   GitHub 关联读写/删除
 *   POST /api/install/github-analyze 解析 GitHub 地址 + 分析（风险预检）
 *   POST /api/install/github-apply   下载 + 风险检测 + 安装
 *   POST /api/install/local          本地 zip/目录导入 + 风险检测 + 安装
 *   POST /api/uninstall              卸载
 *   POST /api/toggle                 启用/停用
 *   GET  /api/updates/check          批量检测更新
 *   POST /api/updates/apply          执行单个插件更新
 *   GET  /api/backups                备份列表
 *   POST /api/backup                 全量备份
 *   POST /api/backup/note            更新备注
 *   POST /api/backup/delete          删除备份
 *   POST /api/restore                全量还原
 *   POST /api/restore/plugin         单插件还原
 *   GET  /api/logs                   操作日志
 *   GET  /api/browse                 文件浏览器
 *   GET/POST/DELETE /api/github-token GitHub token 配置
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getContext, resolveDataDir, currentHanaHome } from '../lib/plugin-context.js';
import {
  listCandidates, getCurrentDshHome, setCurrentDshHome,
} from '../lib/homes.js';
import { scanPlugins, readManifest, pluginsDir } from '../lib/scanner.js';
import { readSources, getSource, setSource, detectSourceFromManifest, parseGithubUrl } from '../lib/sources.js';
import * as hanaApi from '../lib/hana-api.js';
import * as gh from '../lib/github.js';
import { checkLocalSource } from '../lib/zip-check.js';
import { runRiskCheck, compareVersions } from '../lib/risk-check.js';
import { checkUpdates, prepareUpdate } from '../lib/updater.js';
import {
  backupPlugins, listBackups, updateBackupNote, deleteBackup,
  cleanupOldBackups, restorePlugin, restorePlugins,
} from '../lib/backup.js';
import { appendLog, readRecentLogs } from '../lib/operation-log.js';
import { readServerInfo } from '../lib/hana-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(__dirname);
const APP_DIR = path.join(ROOT_DIR, 'app');

const UPDATE_CHECK_CACHE = new Map(); // key: home -> { at, result, likelyRateLimited }

export default function (app, ctx) {
  const dataDir = resolveDataDir();

  // ── helpers ─────────────────────────────
  function currentHome() {
    return getCurrentDshHome() || currentHanaHome();
  }
  function pluginsDirPath() {
    const home = currentHome();
    return home ? pluginsDir(home) : null;
  }

  // 状态缓存（60s）
  let statusCache = { at: 0, data: null };
  async function getStatus() {
    const now = Date.now();
    if (statusCache.data && now - statusCache.at < 60000) {
      return { ...statusCache.data, _cache: { hit: true, age: Math.floor((now - statusCache.at) / 1000) } };
    }
    const home = currentHome();
    const homeExists = home ? fs.existsSync(home) : false;
    const info = home ? readServerInfo(home) : { ok: false, error: '未配置 Hana 主目录' };
    const pluginsPath = pluginsDirPath();
    let pluginCount = 0;
    if (pluginsPath && fs.existsSync(pluginsPath)) {
      try { pluginCount = fs.readdirSync(pluginsPath).filter((n) => fs.statSync(path.join(pluginsPath, n)).isDirectory()).length; } catch { /* ignore */ }
    }
    const settings = info.ok ? await hanaApi.getPluginSettings(home) : { ok: false };
    statusCache = {
      at: now,
      data: {
        hanaHome: home,
        hanaHomeExists: homeExists,
        server: info.ok ? { ok: true, port: info.port, version: info.version } : { ok: false, error: info.error },
        api: settings.ok,
        settings: settings.ok ? settings.settings : null,
        pluginsDir: pluginsPath,
        pluginCount,
        platform: process.platform,
        githubToken: { hasToken: !!gh.readGithubToken(dataDir), fromEnv: !!process.env.GITHUB_TOKEN },
      },
    };
    return { ...statusCache.data, _cache: { hit: false, age: 0 } };
  }

  // iframe shell
  function renderShell(c) {
    const pluginId = ctx.pluginId || 'hana-plugins-manager';
    const hanaCss = c.req.query('hana-css') || '';
    const theme = c.req.query('hana-theme') || 'warm-paper';
    const base = `/api/plugins/${pluginId}`;

    let pluginToken = '';
    const home = currentHome();
    if (home) {
      const info = readServerInfo(home);
      if (info.ok && info.token) pluginToken = info.token;
    }

    let cssInline = '';
    let jsInline = '';
    try {
      const cssPath = path.join(APP_DIR, 'manager.css');
      if (fs.existsSync(cssPath)) cssInline = fs.readFileSync(cssPath, 'utf-8');
    } catch { /* ignore */ }
    try {
      const jsPath = path.join(APP_DIR, 'manager.js');
      if (fs.existsSync(jsPath)) {
        jsInline = fs.readFileSync(jsPath, 'utf-8').replace(/<\/script>/gi, '<\\/script>');
      }
    } catch { /* ignore */ }

    return c.html(`<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>小花插件管理</title>
  ${hanaCss ? `<link rel="stylesheet" href="${hanaCss.replace(/"/g, '&quot;')}">` : ''}
  <style>${cssInline}</style>
</head>
<body data-hana-theme="${theme.replace(/"/g, '&quot;')}">
  <div id="root"></div>
  <script>window.HANA_PLUGIN_BASE=${JSON.stringify(base)};</script>
  <script>window.HANA_PLUGIN_TOKEN=${JSON.stringify(pluginToken)};</script>
  <script>${jsInline}</script>
</body>
</html>`);
  }

  // ── 页面 ─────────────────────────────
  app.get('/manager', (c) => renderShell(c));
  app.get('/page', (c) => renderShell(c));

  // ── homes ─────────────────────────────
  app.get('/api/homes', (c) => {
    const candidates = listCandidates();
    return c.json({ ok: true, current: currentHome(), candidates });
  });

  app.post('/api/current-home', async (c) => {
    const { hanaHome } = await c.req.json();
    try {
      setCurrentDshHome(hanaHome);
      statusCache = { at: 0, data: null };
      return c.json({ ok: true, hanaHome });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  // ── status ─────────────────────────────
  app.get('/api/status', async (c) => c.json({ ok: true, ...(await getStatus()) }));

  // 安全打开本地目录（仅 HANA_HOME 及其子目录）
  app.post('/api/open-path', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    const target = body && body.path ? String(body.path) : home;
    const resolved = path.resolve(target);
    if (resolved !== home && !resolved.startsWith(home + path.sep)) {
      return c.json({ ok: false, error: '只能打开 Hana 主目录及其子目录' }, 400);
    }
    if (!fs.existsSync(resolved)) {
      return c.json({ ok: false, error: '目录不存在' }, 400);
    }
    try {
      let cmd, args;
      if (process.platform === 'win32') { cmd = 'explorer'; args = [resolved]; }
      else if (process.platform === 'darwin') { cmd = 'open'; args = [resolved]; }
      else { cmd = 'xdg-open'; args = [resolved]; }
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => { /* ignore */ });
      child.unref();
      return c.json({ ok: true });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 插件列表 ───────────────────────────
  app.get('/api/plugins', async (c) => {
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);

    const sources = readSources(dataDir);
    const fsPlugins = scanPlugins(home).plugins || [];

    // 优先调用 hana API 获取实时状态
    const apiR = await hanaApi.listPlugins(home);
    if (apiR.ok && Array.isArray(apiR.plugins)) {
      const byId = new Map(fsPlugins.map((p) => [p.id, p]));
      const merged = apiR.plugins.map((p) => {
        const f = byId.get(p.id) || {};
        const src = sources[p.id] || detectSourceFromManifest(f.manifest) || null;
        return {
          id: p.id,
          name: p.name || f.name || p.id,
          version: p.version || f.version || null,
          description: p.description || f.description || '',
          trust: p.trust || f.trust || 'restricted',
          minAppVersion: f.minAppVersion || null,
          author: f.author || null,
          enabled: p.status !== 'disabled' && p.status !== 'failed',
          status: p.status || 'unknown',
          source: p.source || 'community',
          activationState: p.activationState || null,
          activationError: p.activationError || null,
          error: p.error || null,
          github: src ? { repo: src.repo, branch: src.branch, url: src.githubUrl } : null,
          fromApi: true,
        };
      });
      // 补上 API 没返回但 fs 有 manifest 的插件（确保列表完整）
      const apiIds = new Set(merged.map((p) => p.id));
      for (const fp of fsPlugins) {
        if (!apiIds.has(fp.id)) {
          const src = sources[fp.id] || detectSourceFromManifest(fp.manifest) || null;
          merged.push({
            id: fp.id, name: fp.name, version: fp.version,
            description: fp.description, trust: fp.trust, minAppVersion: fp.minAppVersion,
            author: fp.author, enabled: fp.enabled, status: fp.status, source: fp.source,
            github: src ? { repo: src.repo, branch: src.branch, url: src.githubUrl } : null,
            fromApi: false, error: fp.error,
          });
        }
      }
      merged.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return c.json({ ok: true, plugins: merged, mode: 'api' });
    }

    // 降级：纯 fs
    const list = fsPlugins.map((p) => ({
      id: p.id, name: p.name, version: p.version, description: p.description,
      trust: p.trust, minAppVersion: p.minAppVersion, author: p.author,
      enabled: p.enabled, status: p.status, source: p.source, error: p.error,
      github: (sources[p.id] || detectSourceFromManifest(p.manifest)) ? {
        repo: (sources[p.id] || detectSourceFromManifest(p.manifest)).repo,
        branch: (sources[p.id] || detectSourceFromManifest(p.manifest)).branch,
      } : null,
      fromApi: false,
    }));
    return c.json({ ok: true, plugins: list, mode: 'fs', degraded: true });
  });

  // ── 插件详情 ───────────────────────────
  app.get('/api/plugins/:id', (c) => {
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    const id = hanaApi.safePathSegment(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '非法插件 id' }, 400);
    const dir = path.join(pluginsDirPath(), id);
    if (!fs.existsSync(dir)) return c.json({ ok: false, error: '插件不存在' }, 404);
    const manifest = readManifest(dir);
    const src = getSource(dataDir, id) || detectSourceFromManifest(manifest);
    return c.json({
      ok: true,
      id,
      dir,
      manifest,
      github: src ? { repo: src.repo, branch: src.branch, url: src.githubUrl } : null,
    });
  });

  // ── GitHub 关联读写 ────────────────────
  app.get('/api/plugins/:id/source', (c) => {
    const src = getSource(dataDir, c.req.param('id'));
    return c.json({ ok: true, source: src });
  });

  app.post('/api/plugins/:id/source', async (c) => {
    const { githubUrl } = await c.req.json();
    const id = hanaApi.safePathSegment(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '非法插件 id' }, 400);
    try {
      // 手动关联场景：用户主动改，明确传 overwrite=true 允许覆盖
      const r = setSource(dataDir, id, githubUrl, { overwrite: true });
      UPDATE_CHECK_CACHE.clear(); // 关联变化后立即让更新检测失效
      appendLog(dataDir, { action: 'source.set', pluginId: id, ok: true, githubUrl });
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  app.delete('/api/plugins/:id/source', (c) => {
    const id = hanaApi.safePathSegment(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '非法插件 id' }, 400);
    setSource(dataDir, id, '');
    UPDATE_CHECK_CACHE.clear(); // 关联变化后立即让更新检测失效
    appendLog(dataDir, { action: 'source.remove', pluginId: id, ok: true });
    return c.json({ ok: true });
  });

  // ── 可安装插件发现 ──────────────────────
  // 固定清单地址（xxisme/hana-plugins-manager 仓库的 hanaagent-plugins.json）。
  // 注意：github blob 页 URL 需转成 raw 才能读 JSON；raw 域名不受 api.github.com 限流影响。
  const DISCOVER_URL = 'https://raw.githubusercontent.com/xxisme/hana-plugins-manager/master/hanaagent-plugins.json';
  const DISCOVER_TTL = 10 * 60 * 1000; // 10 分钟缓存
  let discoverCache = { at: 0, data: null };

  /** 收集本机已安装插件的 GitHub 仓库集合（owner/repo 小写），用于清单排除 */
  function collectInstalledRepos(home, dataDir) {
    const set = new Set();
    const plugins = scanPlugins(home).plugins || [];
    const sources = readSources(dataDir);
    for (const p of plugins) {
      const src = sources[p.id] || detectSourceFromManifest(readManifest(p.dir));
      if (src && src.repo) set.add(String(src.repo).toLowerCase());
      else if (src && src.githubUrl) {
        const parsed = parseGithubUrl(src.githubUrl);
        if (parsed) set.add(parsed.repo.toLowerCase());
      }
    }
    return set;
  }

  app.get('/api/install/discover', async (c) => {
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    try {
      if (discoverCache.data && Date.now() - discoverCache.at < DISCOVER_TTL) {
        return c.json({ ok: true, ...discoverCache.data, _cache: true });
      }

      // 双通道拉取清单：优先 raw（不受 api.github.com 限流）；失败 fallback Contents API（支持 Token）
      const raw = await fetchDiscoverText(DISCOVER_URL, null, dataDir);
      let text = null;
      let fetchNote = 'raw';
      if (raw.ok) {
        text = raw.text;
      } else {
        const apiUrl = 'https://api.github.com/repos/xxisme/hana-plugins-manager/contents/hanaagent-plugins.json?ref=master';
        const via = await fetchDiscoverText(apiUrl, gh.readGithubToken(dataDir), dataDir);
        if (via.ok) {
          text = via.text;
          fetchNote = 'api';
        } else {
          return c.json({
            ok: false,
            error: `插件清单拉取失败: ${via.error}${String(via.error).includes('403') ? '（GitHub API 限流，请配置 Token 或稍后再试）' : ''}`,
          }, 502);
        }
      }

      let j = null;
      try { j = JSON.parse(text); } catch { /* 下面统一报格式错 */ }
      const projects = j && Array.isArray(j.projects) ? j.projects : [];
      if (!projects.length) return c.json({ ok: false, error: '插件清单为空或格式不符' }, 502);

      const installed = collectInstalledRepos(home, dataDir);
      const plugins = [];
      for (const it of projects) {
        const gh0 = String(it.github || '').trim();
        if (!gh0) continue;
        const parsed = parseGithubUrl(gh0);
        if (!parsed) continue;
        // 排除本机已装（无论是否最新）：按 owner/repo 归一比对，合集仓库子插件也能命中
        if (installed.has(parsed.repo.toLowerCase())) continue;
        // stars 缺字段/非数字归 0；前端只在 >0 时渲染，0 不显式画"0 ★"
        const starsRaw = Number(it.stars);
        const stars = Number.isFinite(starsRaw) && starsRaw >= 0 ? Math.floor(starsRaw) : 0;
        plugins.push({
          github: gh0,   // 保留原始地址（可能含 /tree/... 子路径，合集子插件可辨）
          repo: parsed.repo,
          owner: parsed.owner,
          repoName: parsed.repoName,
          description: String(it.description || '').trim(),
          stars,
        });
      }
      discoverCache = { at: Date.now(), data: { plugins, lastUpdated: j.lastUpdated || null } };
      return c.json({ ok: true, plugins, lastUpdated: j.lastUpdated || null, fetchedAt: new Date().toISOString(), via: fetchNote });
    } catch (e) {
      return c.json({ ok: false, error: e.message || '插件清单拉取失败' }, 502);
    }
  });

  /**
   * 拉取远程文本：raw 直取；Contents API 时 base64 解码。
   * @param {string} url 目标 URL
   * @param {string|null} token 可选的 GitHub Token（Contents API 鉴权/提配额）
   * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
   */
  async function fetchDiscoverText(url, token, dataDir) {
    const headers = { 'user-agent': 'hana-plugins-manager' };
    if (url.includes('api.github.com')) {
      headers.accept = 'application/vnd.github+json';
      if (token) headers.authorization = `Bearer ${token}`;
    }
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const text = await res.text();
      // Contents API 返回 JSON 包装（base64 content），raw 返回裸 JSON
      if (url.includes('api.github.com')) {
        try {
          const j = JSON.parse(text);
          if (j && j.content) return { ok: true, text: Buffer.from(j.content, 'base64').toString('utf-8') };
          return { ok: false, error: 'Contents API 返回格式不符' };
        } catch { return { ok: false, error: 'Contents API 响应解析失败' }; }
      }
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e.message || e.name };
    }
  }

  // ── 安装：GitHub 分析 ──────────────────
  app.post('/api/install/github-analyze', async (c) => {
    const { url } = await c.req.json();
    if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'url 必填' }, 400);
    try {
      const info = await gh.getRepoInfo(url, dataDir);
      if (!info.ok) {
        appendLog(dataDir, { action: 'install.github.analyze', url, ok: false, error: info.error });
        return c.json({ ok: false, error: info.error }, 400);
      }
      // 远端 manifest 预检
      const remote = await gh.getRemoteManifest(info.owner, info.repoName, info.defaultBranch, dataDir);
      appendLog(dataDir, { action: 'install.github.analyze', url, ok: true, repo: info.repo });
      return c.json({
        ok: true,
        repo: info.repo,
        owner: info.owner,
        repoName: info.repoName,
        defaultBranch: info.defaultBranch,
        description: info.description,
        stars: info.stars,
        remoteManifest: remote.ok ? remote.manifest : null,
        remoteManifestError: remote.ok ? null : remote.error,
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 安装：GitHub 应用（下载+风险检测）──
  // 返回 staged 信息 + 风险报告；前端确认后调用 /api/install/confirm 实际安装
  app.post('/api/install/github-apply', async (c) => {
    const { url } = await c.req.json();
    if (!url) return c.json({ ok: false, error: 'url 必填' }, 400);
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    try {
      const info = await gh.getRepoInfo(url, dataDir);
      if (!info.ok) return c.json({ ok: false, error: info.error }, 400);

      const workRoot = path.join(dataDir, 'tmp');
      fs.mkdirSync(workRoot, { recursive: true });
      const zipPath = path.join(workRoot, `${info.repoName}-${Date.now()}.zip`);
      const dl = await gh.downloadRepoZip(info.owner, info.repoName, info.defaultBranch, zipPath, dataDir);
      if (!dl.ok) return c.json({ ok: false, error: dl.error }, 400);

      const check = checkLocalSource(zipPath, workRoot);
      if (!check.ok) {
        try { check.cleanup(); } catch { /* ignore */ }
        try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
        return c.json({ ok: false, error: '结构校验失败: ' + check.errors.join('；'), errors: check.errors }, 400);
      }
      const hanaVersion = readServerInfo(home).version || null;

      // 插件合集仓库：识别全部候选，返回给前端选择安装哪一项
      if (check.multiple && Array.isArray(check.candidates)) {
        const candidates = check.candidates.map((c) => {
          const r = runRiskCheck(c, hanaVersion);
          return {
            pluginRoot: c.pluginRoot,
            pluginId: (c.manifest && c.manifest.id) || path.basename(c.pluginRoot),
            pluginName: (c.manifest && (c.manifest.name || c.manifest.id)) || path.basename(c.pluginRoot),
            version: (c.manifest && c.manifest.version) || null,
            trust: (c.manifest && c.manifest.trust) || 'restricted',
            risk: r,
          };
        });
        appendLog(dataDir, { action: 'install.github.multi', url, ok: true, repo: info.repo, count: candidates.length });
        return c.json({ ok: true, multiple: true, repo: info.repo, candidates });
      }

      const risk = runRiskCheck(check, hanaVersion);
      appendLog(dataDir, { action: 'install.github.apply', url, ok: true, repo: info.repo, riskLevel: risk.level });

      return c.json({
        ok: true,
        repo: info.repo,
        pluginName: check.manifest?.name || check.manifest?.id || info.repoName,
        pluginId: check.manifest?.id || null,
        version: check.manifest?.version || null,
        trust: check.manifest?.trust || null,
        stagedZip: zipPath,
        pluginRoot: check.pluginRoot,
        cleanupKey: null, // 实际安装走 confirm 时重新校验并安装
        risk,
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 安装：确认并安装 staged（github 或 local 通用）──
  // 可选 githubUrl：传了则在安装成功后自动关联该 GitHub 地址（已有不同 source 时不覆盖，
  // 结果通过 warnings 字段返回给前端 toast 提示）
  app.post('/api/install/confirm', async (c) => {
    const { sourcePath, allowDowngrade = false, githubUrl } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return c.json({ ok: false, error: `路径不存在: ${sourcePath}` }, 400);
    }
    try {
      const r = await hanaApi.installFromPath(home, sourcePath, { allowDowngrade });
      appendLog(dataDir, {
        action: 'install.confirm', sourcePath, ok: r.ok, allowDowngrade,
        error: r.ok ? undefined : r.error,
        status: r.status,
      });
      if (!r.ok) return c.json({ ok: false, error: r.error, status: r.status }, r.status || 500);

      // 自动关联 GitHub（幂等,不覆盖已有设置）
      const warnings = [];
      if (githubUrl && r.data && r.data.id) {
        const safeId = hanaApi.safePathSegment(r.data.id);
        if (!safeId) {
          warnings.push(`插件 id "${r.data.id}" 不合法,跳过 GitHub 自动关联`);
        } else {
          try {
            const sr = setSource(dataDir, safeId, githubUrl, { overwrite: false });
            if (sr.saved) {
              UPDATE_CHECK_CACHE.clear();
              appendLog(dataDir, { action: 'source.set.auto', pluginId: safeId, ok: true, githubUrl });
            } else if (sr.reason === 'already-set') {
              warnings.push(`已存在 GitHub 关联 ${sr.existing.githubUrl},未覆盖为 ${githubUrl}`);
              appendLog(dataDir, { action: 'source.set.auto', pluginId: safeId, ok: false, reason: 'already-set', existingUrl: sr.existing.githubUrl, githubUrl });
            }
          } catch (e) {
            warnings.push(`自动关联 GitHub 失败: ${e.message}`);
            appendLog(dataDir, { action: 'source.set.auto', pluginId: safeId, ok: false, error: e.message, githubUrl });
          }
        }
      }
      return c.json({ ok: true, installed: r.data, warnings });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 安装：本地 zip/目录 ─────────────────
  app.post('/api/install/local', async (c) => {
    const { sourcePath } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return c.json({ ok: false, error: '路径不存在' }, 400);
    }
    try {
      const check = checkLocalSource(sourcePath, path.join(dataDir, 'tmp'));
      if (!check.ok) {
        return c.json({ ok: false, error: '结构校验失败: ' + check.errors.join('；'), errors: check.errors }, 400);
      }
      const hanaVersion = readServerInfo(home).version || null;

      // 插件合集 zip/目录：识别全部候选，返回给前端选择安装哪一项
      if (check.multiple && Array.isArray(check.candidates)) {
        const candidates = check.candidates.map((c) => {
          const r = runRiskCheck(c, hanaVersion);
          return {
            pluginRoot: c.pluginRoot,
            pluginId: (c.manifest && c.manifest.id) || path.basename(c.pluginRoot),
            pluginName: (c.manifest && (c.manifest.name || c.manifest.id)) || path.basename(c.pluginRoot),
            version: (c.manifest && c.manifest.version) || null,
            trust: (c.manifest && c.manifest.trust) || 'restricted',
            risk: r,
          };
        });
        appendLog(dataDir, { action: 'install.local.multi', sourcePath, ok: true, count: candidates.length });
        return c.json({ ok: true, multiple: true, candidates });
      }

      const risk = runRiskCheck(check, hanaVersion);
      appendLog(dataDir, { action: 'install.local', sourcePath, ok: true, riskLevel: risk.level });
      return c.json({
        ok: true,
        pluginName: check.manifest?.name || check.manifest?.id || path.basename(sourcePath, '.zip'),
        pluginId: check.manifest?.id || null,
        version: check.manifest?.version || null,
        trust: check.manifest?.trust || null,
        sourcePath,
        risk,
        cleanupKey: null,
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 卸载 ───────────────────────────────
  app.post('/api/uninstall', async (c) => {
    const { id } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!id) return c.json({ ok: false, error: 'id 必填' }, 400);
    const safeId = hanaApi.safePathSegment(id);
    if (!safeId) return c.json({ ok: false, error: '非法插件 id' }, 400);
    try {
      // 先备份当前（安全网）
      let backupDir = null;
      try { backupDir = backupPlugins(dataDir, home); } catch { /* ignore */ }

      const r = await hanaApi.uninstallPlugin(home, safeId);
      if (r.ok) {
        // 清理 GitHub 关联
        setSource(dataDir, id, '');
        appendLog(dataDir, { action: 'uninstall', pluginId: id, ok: true, backupDir });
        return c.json({ ok: true, backupDir });
      }
      // API 失败降级：直接删目录 + 清 disabled
      const dir = path.join(pluginsDirPath(), safeId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        setSource(dataDir, safeId, '');
        appendLog(dataDir, { action: 'uninstall.fallback', pluginId: safeId, ok: true, backupDir, degraded: true });
        return c.json({ ok: true, backupDir, degraded: true, warning: '已直接删除，重启 Hana 后完全生效' });
      }
      return c.json({ ok: false, error: r.error || '插件不存在' }, 404);
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 启用/停用 ──────────────────────────
  app.post('/api/toggle', async (c) => {
    const { id, enabled } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!id) return c.json({ ok: false, error: 'id 必填' }, 400);
    if (typeof enabled !== 'boolean') return c.json({ ok: false, error: 'enabled 必须是 boolean' }, 400);
    try {
      const r = await hanaApi.setPluginEnabled(home, id, enabled);
      if (r.ok) {
        appendLog(dataDir, { action: enabled ? 'enable' : 'disable', pluginId: id, ok: true });
        return c.json({ ok: true, id, enabled });
      }
      // 降级：编辑 preferences.json 的 disabled_plugins
      const prefsPath = path.join(home, 'preferences.json');
      let prefs = {};
      if (fs.existsSync(prefsPath)) {
        try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8')); } catch { /* ignore */ }
      }
      let disabled = Array.isArray(prefs.disabled_plugins) ? prefs.disabled_plugins : [];
      const idx = disabled.indexOf(id);
      if (enabled) {
        if (idx !== -1) disabled.splice(idx, 1);
      } else {
        if (idx === -1) disabled.push(id);
      }
      prefs.disabled_plugins = disabled;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
      appendLog(dataDir, { action: enabled ? 'enable' : 'disable', pluginId: id, ok: true, degraded: true });
      return c.json({ ok: true, id, enabled, degraded: true, warning: '已写入本地配置，重启 Hana 后完全生效' });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 更新检测 ───────────────────────────
  app.get('/api/updates/check', async (c) => {
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
    const cacheKey = home;
    if (!force) {
      const hit = UPDATE_CHECK_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < (hit.likelyRateLimited ? 3 * 60 * 1000 : 5 * 60 * 1000)) {
        return c.json({ ok: true, ...hit.result, _cache: { hit: true, age: Math.floor((Date.now() - hit.at) / 1000) } });
      }
    }
    try {
      const fsPlugins = scanPlugins(home).plugins || [];
      const r = await checkUpdates(fsPlugins, dataDir);
      // 合并 sources:前端需要 github.url 渲染「打开仓库」按钮
      const sources = readSources(dataDir);
      const hasToken = !!gh.readGithubToken(dataDir);
      const fromEnv = !!process.env.GITHUB_TOKEN;
      for (const p of r.plugins) {
        const src = sources[p.id];
        if (src) p.github = { repo: src.repo, branch: src.branch, url: src.githubUrl };
        // 友好化 404 错误信息：分三类给出可执行建议
        if (p.status === 'upstream-404') {
          if (hasToken) {
            p.upstreamError = 'GitHub 返回 404：仓库不存在、已改名或权限不足。点击「打开仓库」在浏览器确认';
          } else {
            p.upstreamError = 'GitHub 返回 404：常见为私有仓库匿名不可见。点击「打开仓库」确认可访问后，配置 Token 重试';
          }
        }
      }
      const likelyRateLimited = r.plugins.length > 0
        && r.plugins.every((p) => p.status === 'check-failed' && (p.upstreamError || '').includes('限流'));
      UPDATE_CHECK_CACHE.set(cacheKey, { at: Date.now(), result: r, likelyRateLimited });
      // 嵌入最新 githubToken 状态，前端据此渲染「配置 Token」按钮，避免 UI 滞后
      return c.json({ ok: true, ...r, githubToken: { hasToken, fromEnv } });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 执行更新（单个插件）───────────────
  app.post('/api/updates/apply', async (c) => {
    const { id, allowDowngrade = false } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!id) return c.json({ ok: false, error: 'id 必填' }, 400);
    try {
      const prep = await prepareUpdate(id, dataDir);
      if (!prep.ok) return c.json({ ok: false, error: prep.error }, 400);
      // 定位实际安装根：prep.pluginRoot（prepareUpdate 显式返回）兜底 prep.check.pluginRoot
      const installTarget = prep.pluginRoot || (prep.check && prep.check.pluginRoot);
      if (!installTarget) return c.json({ ok: false, error: '未定位到插件根目录' }, 400);
      const installed = await hanaApi.installFromPath(home, installTarget, { allowDowngrade });
      // 清理 staging
      try { prep.check.cleanup(); } catch { /* ignore */ }
      try { fs.rmSync(prep.zipPath, { force: true }); } catch { /* ignore */ }

      appendLog(dataDir, {
        action: 'update', pluginId: id, ok: installed.ok, allowDowngrade,
        riskLevel: prep.risk.level,
        error: installed.ok ? undefined : installed.error,
      });
      if (!installed.ok) return c.json({ ok: false, error: installed.error, status: installed.status }, installed.status || 500);
      // 更新成功清缓存
      UPDATE_CHECK_CACHE.delete(home);
      return c.json({ ok: true, installed: installed.data, risk: prep.risk });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 备份与还原 ─────────────────────────
  app.get('/api/backups', (c) => {
    return c.json({ ok: true, backups: listBackups(dataDir) });
  });

  app.post('/api/backup', (c) => {
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    try {
      const dir = backupPlugins(dataDir, home);
      const removed = cleanupOldBackups(dataDir, 10);
      appendLog(dataDir, { action: 'backup', ok: true, backupDir: dir, removed });
      return c.json({ ok: true, backupDir: dir, removed });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post('/api/backup/note', async (c) => {
    const { backupDir, note } = await c.req.json();
    if (!backupDir) return c.json({ ok: false, error: 'backupDir 缺失' }, 400);
    const ok = updateBackupNote(backupDir, note);
    if (!ok) return c.json({ ok: false, error: '备份目录不存在' }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/backup/delete', async (c) => {
    const { backupDir } = await c.req.json();
    if (!backupDir) return c.json({ ok: false, error: 'backupDir 缺失' }, 400);
    const ok = deleteBackup(backupDir);
    if (!ok) return c.json({ ok: false, error: '删除失败' }, 400);
    appendLog(dataDir, { action: 'backup.delete', backupDir, ok: true });
    return c.json({ ok: true });
  });

  // 全量还原
  app.post('/api/restore', async (c) => {
    const { backupDir } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!backupDir) return c.json({ ok: false, error: 'backupDir 缺失' }, 400);
    try {
      const r = restorePlugins(dataDir, backupDir, home);
      if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
      appendLog(dataDir, { action: 'restore.all', backupDir, ok: true, restored: r.restored.length, backupOfCurrent: r.backupOfCurrent });
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 单插件还原
  app.post('/api/restore/plugin', async (c) => {
    const { backupDir, id } = await c.req.json();
    const home = currentHome();
    if (!home) return c.json({ ok: false, error: '未配置 Hana 主目录' }, 400);
    if (!backupDir || !id) return c.json({ ok: false, error: 'backupDir/id 缺失' }, 400);
    try {
      const r = restorePlugin(dataDir, backupDir, home, id);
      if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
      appendLog(dataDir, { action: 'restore.plugin', backupDir, pluginId: id, ok: true, backupOfCurrent: r.backupOfCurrent });
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 操作日志 ───────────────────────────
  app.get('/api/logs', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    return c.json({ ok: true, logs: readRecentLogs(dataDir, limit) });
  });

  // ── 文件浏览器 ─────────────────────────
  // 我的电脑（盘符列表）视图 token：path 为该值时返回所有存在的盘符
  const DRIVES_TOKEN = '__drives__';
  /** Windows 盘符根（如 C:\） */
  function isDriveRoot(p) {
    return /^[a-zA-Z]:[\\/]$/.test(p);
  }
  /** 枚举本机存在的盘符（A: ~ Z:） */
  function listDrives() {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const root = String.fromCharCode(i) + ':\\';
      try { if (fs.existsSync(root)) drives.push({ name: root, isDir: true, isFile: false }); } catch { /* ignore */ }
    }
    return drives;
  }

  app.get('/api/browse', (c) => {
    const raw = c.req.query('path') || '';
    // 我的电脑视图：默认起点 + 盘符根向上的终点
    if (!raw || raw === DRIVES_TOKEN) {
      return c.json({ ok: true, path: DRIVES_TOKEN, parent: null, entries: listDrives() });
    }
    const start = path.resolve(String(raw));
    if (!fs.existsSync(start)) return c.json({ ok: false, error: '路径不存在' }, 400);
    try {
      const stat = fs.statSync(start);
      if (!stat.isDirectory()) return c.json({ ok: false, error: '不是目录' }, 400);
      const entries = fs.readdirSync(start, { withFileTypes: true })
        .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      // 上一级：普通目录 → dirname；Windows 盘符根 → 我的电脑（跨盘符）
      const parent = isDriveRoot(start) ? DRIVES_TOKEN : path.dirname(start);
      return c.json({ ok: true, path: start, parent, entries });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── GitHub token 配置 ──────────────────
  app.get('/api/github-token/status', (c) => {
    const t = gh.readGithubToken(dataDir);
    const masked = t ? (t.length > 8 ? t.slice(0, 4) + '…' + t.slice(-4) : '•••') : null;
    return c.json({ ok: true, hasToken: !!t, masked, fromEnv: !!process.env.GITHUB_TOKEN });
  });

  app.post('/api/github-token', async (c) => {
    const { token } = await c.req.json();
    if (!token || typeof token !== 'string' || token.length < 10) {
      return c.json({ ok: false, error: 'token 无效（至少 10 字符）' }, 400);
    }
    try {
      fs.writeFileSync(path.join(dataDir, 'github-token'), token.trim(), { mode: 0o600 });
      UPDATE_CHECK_CACHE.clear();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.delete('/api/github-token', (c) => {
    const p = path.join(dataDir, 'github-token');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    UPDATE_CHECK_CACHE.clear();
    return c.json({ ok: true });
  });
}
