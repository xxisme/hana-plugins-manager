/**
 * hana-plugins-manager / app/manager.js
 *
 * 前端（vanilla JS，零依赖）：
 *  - 顶栏状态条 + Tab 导航（插件管理/安装/更新/备份还原/操作日志）
 *  - 插件卡片列表 + 详情抽屉（GitHub 关联）
 *  - 安装向导（GitHub 地址 / 本地 zip 目录）
 *  - 批量更新检测与勾选更新
 *  - 备份还原 + 操作日志
 */

(function () {
  'use strict';

  const API = window.HANA_PLUGIN_BASE || '/api/plugins/hana-plugins-manager';
  const TOKEN = window.HANA_PLUGIN_TOKEN || '';

  // GitHub 图标（内联 SVG，用于绿色关联标签）
  const GH_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
  // 勾选图标（更新表格选择）
  const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M3 8.6l3.1 3L13 5.4"/></svg>';

  const STATE = {
    status: null,
    plugins: [],
    activeView: 'manage',
    currentPlugin: null,
    risk: null,           // 当前安装风险报告
    pendingInstall: null, // { type:'github'|'local', sourcePath|stagingPath }
    updates: [],          // 更新检测结果
    updateSel: new Set(),
    backups: [],
    logs: [],
    browse: null,
  };

  // ── helpers ────────────────────────────────
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, type) {
    type = type || 'success';
    let wrap = $('toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toast-wrap';
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type + ' show';
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => { el.classList.remove('show'); }, 3500);
    setTimeout(() => el.remove(), 3900);
  }
  async function api(method, path, body, opts = {}) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (TOKEN) opt.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const timeoutMs = opts.timeoutMs || 15000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    opt.signal = ctrl.signal;
    try {
      const r = await fetch(API + path, opt);
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { ok: false, error: text || ('HTTP ' + r.status) }; }
    } finally { clearTimeout(timer); }
  }
  function showLoading(msg) {
    const el = document.createElement('div');
    el.className = 'loading-overlay';
    el.id = 'loading';
    el.innerHTML = '<div style="text-align:center"><div class="spinner"></div><div class="loading-text">' + esc(msg || '处理中…') + '</div></div>';
    document.body.appendChild(el);
  }
  function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.remove();
  }
  /** 单输入框模态(用于 GitHub Token 等) */
  function promptModal(title, label, placeholder = '', defaultValue = '') {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `
        <div class="modal">
          <h3>${esc(title)}</h3>
          <div class="field" style="margin:14px 0">
            <label>${esc(label)}</label>
            <input class="input" id="prompt-modal-input" type="password" placeholder="${esc(placeholder)}" value="${esc(defaultValue)}">
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">取消</button>
            <button class="btn btn-primary" data-act="ok">保存</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      requestAnimationFrame(() => { back.classList.add('show'); back.querySelector('#prompt-modal-input').focus(); });
      const input = back.querySelector('#prompt-modal-input');
      const close = (val) => {
        back.classList.remove('show');
        setTimeout(() => back.remove(), 200);
        resolve(val);
      };
      back.addEventListener('click', (e) => {
        if (e.target === back || e.target.dataset.act === 'cancel') close(null);
        else if (e.target.dataset.act === 'ok') close(input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        else if (e.key === 'Escape') close(null);
      });
    });
  }

  /** 配置 GitHub Personal Access Token(用于访问私有仓库与避免限流) */
  async function openGithubTokenModal() {
    const r0 = await api('GET', '/api/github-token/status');
    const masked = r0 && r0.ok ? r0.masked : null;
    const fromEnv = r0 && r0.ok && r0.fromEnv;
    const hint = fromEnv
      ? '当前：来自环境变量 GITHUB_TOKEN（前端无法修改）'
      : (masked ? `当前：${masked}（留空不修改）` : '当前：未配置');
    const token = await promptModal('配置 GitHub Token', `Personal Access Token（需 repo 权限）· ${hint}`, 'ghp_xxxxxxxxxxxxxxxxxxxx', '');
    if (token === null) return;
    if (!token.trim()) { toast('已取消', 'info'); return; }
    const r = await api('POST', '/api/github-token', { token: token.trim() });
    if (r && r.ok) {
      toast('已保存 GitHub Token，正在重新检测', 'success');
      loadStatus();
      loadUpdates(true);
    } else toast((r && r.error) || '保存失败', 'error');
  }

  function modal(title, msg, { danger, confirmText } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `
        <div class="modal">
          <h3>${esc(title)}</h3>
          <p>${esc(msg)}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-act="cancel">取消</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText || '确认')}</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      requestAnimationFrame(() => back.classList.add('show'));
      back.addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act === 'ok' || act === 'cancel' || e.target === back) {
          back.classList.remove('show');
          setTimeout(() => back.remove(), 200);
          resolve(act === 'ok');
        }
      });
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ── 路由与状态加载 ───────────────────────
  async function loadStatus() {
    const r = await api('GET', '/api/status');
    if (r && r.ok) {
      STATE.status = r;
      renderTopbar();
    }
  }
  async function loadPlugins() {
    const r = await api('GET', '/api/plugins');
    if (r && r.ok) { STATE.plugins = r.plugins || []; STATE.mode = r.mode || 'api'; }
    else toast((r && r.error) || '加载插件失败', 'error');
    renderManage();
  }

  /** 就地更新 STATE.plugins 中某项，返回是否命中 */
  function patchPlugin(id, patch) {
    const p = STATE.plugins.find((x) => x.id === id);
    if (!p) return false;
    Object.assign(p, patch);
    return true;
  }

  /** 同步顶栏插件计数与 Tab 徽标 */
  function syncCounts() {
    const n = STATE.plugins.length;
    const hud = $('hud-count');
    if (hud) hud.textContent = n + ' 个插件';
    const tab = $('tab-count');
    if (tab) tab.textContent = n || '';
  }
  async function loadBackups() {
    const r = await api('GET', '/api/backups');
    if (r && r.ok) STATE.backups = r.backups || [];
    renderBackup();
  }
  async function loadLogs() {
    const r = await api('GET', '/api/logs');
    if (r && r.ok) STATE.logs = r.logs || [];
    renderLogs();
  }

  // ── 顶栏 ─────────────────────────────────
  function renderTopbar() {
    const s = STATE.status;
    const home = s && s.hanaHome ? s.hanaHome : '';
    let serverText, serverPulseCls;
    if (!s) {
      serverText = '加载中';
      serverPulseCls = 'off';
    } else if (!s.server || !s.server.ok) {
      serverText = '未配置';
      serverPulseCls = 'off';
    } else if (s.api) {
      serverText = `已连接 · 端口 ${s.server.port}`;
      serverPulseCls = '';
    } else {
      serverText = `未连接 · 端口 ${s.server.port}`;
      serverPulseCls = 'warn';
    }
    const count = (s && s.pluginCount != null) ? s.pluginCount : STATE.plugins.length;
    const homeEl = $('hud-home');
    if (homeEl) { homeEl.textContent = home; homeEl.title = home; }
    const serverEl = $('hud-server');
    if (serverEl) serverEl.textContent = serverText;
    const countEl = $('hud-count');
    if (countEl) countEl.textContent = count + ' 个插件';
    const pulseServer = $('pulse-server');
    if (pulseServer) pulseServer.className = 'pulse ' + serverPulseCls;
    const pulseApi = $('pulse-api');
    if (pulseApi) pulseApi.className = 'pulse ' + ((s && s.api) ? '' : (s && s.api === false ? 'warn' : 'off'));
    updateOpenHomeBtn();
  }

  // ── Tab 切换 ─────────────────────────────
  function switchView(name) {
    STATE.activeView = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'install') {
      // 重置安装向导
      STATE.risk = null;
      STATE.pendingInstall = null;
      renderRisk();
      setInstallStatus('idle');
    } else if (name === 'update') {
      loadUpdates();
    } else if (name === 'backup') {
      loadBackups();
    } else if (name === 'logs') {
      loadLogs();
    } else {
      loadPlugins();
    }
  }

  // ── 插件管理页 ───────────────────────────
  function trustTag(trust) {
    if (!trust) return '<span class="tag">权限未知</span>';
    const cls = trust === 'full-access' ? 'trust-high' : 'trust-low';
    const label = trust === 'full-access' ? '完全访问' : '受限';
    return `<span class="tag ${cls}">${esc(label)}</span>`;
  }
  function renderManage() {
    const wrap = $('plugin-list');
    if (!STATE.plugins.length) {
      wrap.innerHTML = `<div class="empty"><h3>暂无插件</h3><p>去「安装」页添加插件，或确认 Hana 主目录路径正确</p></div>`;
      return;
    }
    const degraded = STATE.mode === 'fs' ? '<span class="tag warn">本地模式（服务未连接）</span>' : '';
    wrap.innerHTML = STATE.plugins.map((p, i) => {
      const ghUrl = p.github ? (p.github.url || ('https://github.com/' + p.github.repo)) : '';
      const gh = p.github ? `<a class="tag github-tag" href="${esc(ghUrl)}" target="_blank" rel="noopener" title="已关联 GitHub：${esc(p.github.repo || '')}">${GH_ICON}<span>${esc(p.github.repo || 'GitHub')}</span></a>` : '';
      const srcHint = p.fromApi === false ? '<span class="tag">本地</span>' : '';
      const invalidTag = p.error && !p.fromApi ? '<span class="tag warn">异常</span>' : '';
      const version = p.version ? `<span class="tag">v${esc(p.version)}</span>` : '';
      return `
      <div class="plugin-card ${p.fromApi === false ? 'degraded' : ''} ${p.error ? 'invalid' : ''}" style="animation-delay:${i * 30}ms">
        <div class="card-top">
          <div class="plugin-icon">${esc((p.name || '?').charAt(0).toUpperCase())}</div>
          <div class="card-info">
            <div class="name">${esc(p.name || p.id)} ${invalidTag} ${srcHint}</div>
            <div class="desc">${esc(p.description || '(无描述)')}</div>
            <div class="tags">${version}${trustTag(p.trust)}${gh}</div>
          </div>
        </div>
        <div class="card-actions">
          <label class="switch" title="${p.enabled ? '点击停用' : '点击启用'}">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} data-toggle="${esc(p.id)}">
            <span class="track"></span>
          </label>
          <button class="btn btn-detail" data-detail="${esc(p.id)}">详情</button>
          <button class="btn btn-secondary" data-update="${esc(p.id)}" ${p.github ? '' : 'disabled title="未关联 GitHub"'} >更新</button>
          <button class="btn btn-danger" data-uninstall="${esc(p.id)}">卸载</button>
        </div>
      </div>`;
    }).join('') + (degraded ? `<div style="margin-top:12px" class="tag warn">${esc(degraded)}：改动会直接写入文件，重启 Hana 后完全生效</div>` : '');
    syncCounts();
    bindManageActions();
  }

  function bindManageActions() {
    // 启用开关
    document.querySelectorAll('[data-toggle]').forEach((el) => {
      el.onchange = async () => {
        const id = el.dataset.toggle;
        const enabled = el.checked;
        const r = await api('POST', '/api/toggle', { id, enabled });
        if (r && r.ok) {
          patchPlugin(id, { enabled });
          toast(enabled ? '已启用' : '已停用', 'success');
          if (r.degraded) toast('已写入本地配置，重启 Hana 后完全生效', 'warning');
        } else {
          toast((r && r.error) || '操作失败', 'error');
          el.checked = !enabled;
        }
      };
    });
    // 详情
    document.querySelectorAll('[data-detail]').forEach((el) => {
      el.onclick = () => openDetail(el.dataset.detail);
    });
    // 更新
    document.querySelectorAll('[data-update]').forEach((el) => {
      el.onclick = () => {
        if (!el.dataset.update) return;
        const id = el.dataset.update;
        const p = STATE.plugins.find((x) => x.id === id);
        if (!p || !p.github) { toast('该插件未关联仓库地址', 'warning'); return; }
        switchView('update');
      };
    });
    // 卸载
    document.querySelectorAll('[data-uninstall]').forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.uninstall;
        const p = STATE.plugins.find((x) => x.id === id);
        const ok = await modal('卸载插件', `确定卸载「${p ? p.name : id}」？卸载前会自动备份，可随时还原。`, { danger: true, confirmText: '卸载' });
        if (!ok) return;
        const r = await api('POST', '/api/uninstall', { id });
        if (r && r.ok) {
          STATE.plugins = STATE.plugins.filter((x) => x.id !== id);
          toast('已卸载', 'success');
          if (r.degraded) toast('已直接删除，重启 Hana 后完全生效', 'warning');
          renderManage();
        } else toast((r && r.error) || '卸载失败', 'error');
      };
    });
  }

  // ── 详情抽屉 ─────────────────────────────
  async function openDetail(id) {
    const r = await api('GET', '/api/plugins/' + encodeURIComponent(id));
    if (!r || !r.ok) { toast((r && r.error) || '加载详情失败', 'error'); return; }
    const m = r.manifest || {};
    const gh = r.github || null;
    const trustLabel = { 'full-access': '完全访问', 'restricted': '受限' }[m.trust] || '未知';
    const html = `
      <div class="drawer-head">
        <h3>${esc(m.name || id)}</h3>
        <button class="drawer-close" data-close>×</button>
      </div>
      <div class="drawer-body">
        <div class="info-row"><span class="k">ID</span><span class="v">${esc(id)}</span></div>
        <div class="info-row"><span class="k">版本</span><span class="v">${esc(m.version || '—')}</span></div>
        <div class="info-row"><span class="k">信任</span><span class="v">${esc(trustLabel)}</span></div>
        <div class="info-row"><span class="k">描述</span><span class="v">${esc(m.description || '—')}</span></div>
        <div class="info-row"><span class="k">作者</span><span class="v">${esc(m.author || '—')}</span></div>
        <div class="info-row"><span class="k">要求版本</span><span class="v">${esc(m.minAppVersion ? 'v' + m.minAppVersion : '—')}</span></div>
        <div style="margin-top:20px">
          <div class="field">
            <label>GitHub 仓库地址</label>
            <input class="input" id="detail-gh-url" placeholder="https://github.com/owner/repo" value="${esc(gh ? gh.url : '')}">
          </div>
          <button class="btn btn-primary" id="save-gh" style="width:100%">保存关联</button>
          ${gh ? '<button class="btn btn-ghost" id="clear-gh" style="width:100%;margin-top:8px">清除关联</button>' : ''}
        </div>
      </div>`;
    const back = document.createElement('div');
    back.className = 'drawer-backdrop';
    back.id = 'drawer-backdrop';
    const drawer = document.createElement('div');
    drawer.className = 'drawer';
    drawer.id = 'drawer';
    drawer.innerHTML = html;
    document.body.appendChild(back);
    document.body.appendChild(drawer);
    requestAnimationFrame(() => { back.classList.add('show'); drawer.classList.add('show'); });
    const close = () => {
      back.classList.remove('show'); drawer.classList.remove('show');
      setTimeout(() => { back.remove(); drawer.remove(); }, 240);
    };
    back.onclick = close;
    drawer.querySelector('[data-close]').onclick = close;
    const applyLocalSource = (url, savedSource) => {
      if (url) {
        const s = savedSource || {};
        patchPlugin(id, { github: s.repo ? { repo: s.repo, branch: s.branch, url: s.githubUrl } : { repo: url, url } });
      } else {
        patchPlugin(id, { github: null });
      }
      renderManage();
      // 若当前在更新 Tab，立即强制重检关联状态
      if (STATE.activeView === 'update') loadUpdates(true);
    };
    drawer.querySelector('#save-gh').onclick = async () => {
      const url = drawer.querySelector('#detail-gh-url').value.trim();
      const rr = await api('POST', '/api/plugins/' + encodeURIComponent(id) + '/source', { githubUrl: url });
      if (rr && rr.ok) {
        toast(url ? '已关联 GitHub' : '已清除关联', 'success');
        applyLocalSource(url, rr.source);
        close();
      } else toast((rr && rr.error) || '保存失败', 'error');
    };
    const clearBtn = drawer.querySelector('#clear-gh');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        const rr = await api('DELETE', '/api/plugins/' + encodeURIComponent(id) + '/source');
        if (rr && rr.ok) {
          toast('已清除关联', 'success');
          applyLocalSource('', null);
          close();
        } else toast((rr && rr.error) || '清除失败', 'error');
      };
    }
  }

  // ── 安装页 ───────────────────────────────
  function setupInstallTabs() {
    document.querySelectorAll('.sub-tab').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.sub-tab').forEach((x) => x.classList.toggle('active', x === t));
        const panel = t.dataset.panel;
        $('gh-panel').style.display = panel === 'gh' ? '' : 'none';
        $('local-panel').style.display = panel === 'local' ? '' : 'none';
        STATE.risk = null;
        STATE.pendingInstall = null;
        resetInstallPanel();
        setInstallStatus('idle');
      };
    });
  }

  function bindGithubActions() {
    $('gh-analyze').onclick = async () => {
      const url = $('gh-url').value.trim();
      if (!url) { toast('请输入 GitHub 地址', 'warning'); return; }
      setInstallStatus('parsing');
      const r = await api('POST', '/api/install/github-analyze', { url }, { timeoutMs: 25000 });
      if (!r || !r.ok) {
        setInstallStatus('failed', (r && r.error) || '解析失败');
        toast((r && r.error) || '解析失败', 'error');
        return;
      }
      $('gh-repo-info').innerHTML = `
        <div class="info-row"><span class="k">仓库</span><span class="v">${esc(r.repo)}</span></div>
        <div class="info-row"><span class="k">分支</span><span class="v">${esc(r.defaultBranch)}</span></div>
        ${r.description ? `<div class="info-row"><span class="k">描述</span><span class="v">${esc(r.description)}</span></div>` : ''}
        ${r.remoteManifestError ? `<div class="tag warn" style="margin-top:8px">远端 manifest：${esc(r.remoteManifestError)}</div>` : ''}`;
      STATE.pendingInstall = { type: 'github', url };
      setInstallStatus('downloading');
      const rr = await api('POST', '/api/install/github-apply', { url }, { timeoutMs: 90000 });
      if (!rr || !rr.ok) {
        setInstallStatus('failed', (rr && rr.error) || '下载/检测失败');
        toast((rr && rr.error) || '下载/检测失败', 'error');
        return;
      }
      // 插件合集仓库：列出候选，等待用户选择后继续
      if (rr.multiple && Array.isArray(rr.candidates)) {
        STATE.pendingInstall = { type: 'github', url };
        renderCandidates(rr.candidates, 'github');
        setInstallStatus('warning', `检测到 ${rr.candidates.length} 个插件，请选择要安装的一项`);
        return;
      }
      STATE.pendingInstall = { type: 'github', stagingPath: rr.pluginRoot, sourcePath: rr.stagedZip, url };
      STATE.risk = rr.risk;
      $('gh-proceed').style.display = '';
      renderRisk();
      setInstallStatus('ready', `检测通过（${rr.risk.level === 'high' ? '高风险，请谨慎' : '低/中风险'}）`);
    };
    $('gh-proceed').onclick = () => confirmInstall();
  }

  function bindLocalActions() {
    $('local-browse').onclick = () => openBrowse((p) => { $('local-path').value = p; });
    $('local-analyze').onclick = async () => {
      const path = $('local-path').value.trim();
      if (!path) { toast('请输入或选择本地路径', 'warning'); return; }
      setInstallStatus('analyzing');
      const r = await api('POST', '/api/install/local', { sourcePath: path }, { timeoutMs: 30000 });
      if (!r || !r.ok) {
        setInstallStatus('failed', (r && r.error) || '校验失败');
        toast((r && r.error) || '校验失败', 'error');
        return;
      }
      // 插件合集 zip/目录：列出候选，等待用户选择后继续
      if (r.multiple && Array.isArray(r.candidates)) {
        STATE.pendingInstall = { type: 'local' };
        renderCandidates(r.candidates, 'local');
        setInstallStatus('warning', `检测到 ${r.candidates.length} 个插件，请选择要安装的一项`);
        return;
      }
      STATE.pendingInstall = { type: 'local', sourcePath: path };
      STATE.risk = r.risk;
      $('local-proceed').style.display = '';
      renderRisk();
      setInstallStatus('ready', `检测通过（${r.risk.level === 'high' ? '高风险，请谨慎' : '低/中风险'}）`);
    };
    $('local-proceed').onclick = () => confirmInstall();
  }

  /** 插件合集候选选择（github/local 通用） */
  function renderCandidates(candidates, type) {
    const wrap = $('cand-area');
    if (!wrap || !Array.isArray(candidates) || !candidates.length) return;
    const items = candidates.map((c, i) => {
      const trustLabel = c.trust === 'full-access' ? '完全访问' : '受限';
      const riskLabel = { high: '高风险', medium: '中风险', low: '低风险' }[c.risk && c.risk.level] || '未知';
      return `
      <div class="cand-item" data-i="${i}">
        <div class="cand-name">${esc(c.pluginName || c.pluginId || '未命名')}
          ${c.version ? `<span class="tag">v${esc(c.version)}</span>` : ''}
          <span class="tag ${c.trust === 'full-access' ? 'trust-high' : 'trust-low'}">${esc(trustLabel)}</span>
        </div>
        <div class="cand-meta">${esc(c.pluginId || '')} · 风险：${esc(riskLabel)}</div>
      </div>`;
    }).join('');
    wrap.innerHTML = `<div class="cand-hint">该来源包含 ${candidates.length} 个插件，请选择要安装的一项：</div><div class="cand-list">${items}</div>`;
    wrap.style.display = '';
    wrap.querySelectorAll('.cand-item').forEach((el) => {
      el.onclick = () => {
        wrap.querySelectorAll('.cand-item').forEach((x) => x.classList.remove('selected'));
        el.classList.add('selected');
        const c = candidates[+el.dataset.i];
        STATE.pendingInstall = {
          type,
          sourcePath: c.pluginRoot,
          url: type === 'github' ? (STATE.pendingInstall && STATE.pendingInstall.url) : undefined,
        };
        STATE.risk = c.risk || null;
        renderRisk();
        const proceed = type === 'github' ? $('gh-proceed') : $('local-proceed');
        if (proceed) proceed.style.display = '';
        setInstallStatus('ready', `已选择「${c.pluginName || c.pluginId}」，可继续安装`);
      };
    });
  }

  /** 重置安装面板（成功/切换来源时清理候选与状态区） */
  function resetInstallPanel() {
    const ghProceed = $('gh-proceed'); if (ghProceed) ghProceed.style.display = 'none';
    const localProceed = $('local-proceed'); if (localProceed) localProceed.style.display = 'none';
    const ghInfo = $('gh-repo-info'); if (ghInfo) ghInfo.innerHTML = '';
    const cand = $('cand-area'); if (cand) { cand.style.display = 'none'; cand.innerHTML = ''; }
    renderRisk();
  }

  function renderRisk() {
    const wrap = $('risk-area');
    if (!STATE.risk) { wrap.innerHTML = ''; return; }
    const r = STATE.risk;
    const high = r.findings.filter((f) => f.level === 'high');
    const med = r.findings.filter((f) => f.level === 'medium');
    const low = r.findings.filter((f) => f.level === 'low');
    const lvlLabel = { high: '高风险', medium: '中风险', low: '低风险' }[r.level];
    wrap.innerHTML = `
      <div class="risk-banner ${r.level}">风险等级：${esc(lvlLabel)}（${r.findings.length} 项）</div>
      <ul class="finding-list">
        ${r.findings.map((f) => `<li><span class="lvl lvl-${esc(f.level)}">${esc(f.level)}</span><span>${esc(f.detail)}</span></li>`).join('') || '<li>未发现可疑模式</li>'}
      </ul>
      <div class="disclaimer">${esc(r.disclaimer)}</div>`;
  }

  // 内联状态更新区（不虚化背景；安装/更新共用）
  // 图标全部使用纯文本符号，避免彩色 emoji 破坏整体低饱和色调
  const STAGE_META = {
    idle: { icon: '○', cls: '' },
    parsing: { icon: '⟳', cls: 'busy', text: '解析仓库…' },
    downloading: { icon: '↓', cls: 'busy', text: '下载源码…' },
    analyzing: { icon: '⟳', cls: 'busy', text: '风险检测中…' },
    checking: { icon: '⟳', cls: 'busy', text: '检测更新中…' },
    ready: { icon: '✓', cls: 'ok', text: '检测通过，等待确认安装' },
    installing: { icon: '⟳', cls: 'busy', text: '安装中…' },
    success: { icon: '✔', cls: 'ok', text: '完成' },
    failed: { icon: '✖', cls: 'err', text: '失败' },
    warning: { icon: '△', cls: 'warn', text: '警告' },
  };
  function setInstallStatus(stage, msg, containerId) {
    const el = $(containerId || 'install-status');
    if (!el) return;
    const meta = STAGE_META[stage] || STAGE_META.idle;
    const busy = meta.cls === 'busy';
    const spinner = busy ? '<span class="spinner-inline"></span>' : '';
    el.innerHTML = `<div class="install-status-row ${meta.cls}">${spinner}<span class="is-icon">${meta.icon}</span><span>${esc(msg || meta.text || '')}</span></div>`;
    el.style.display = stage === 'idle' && !msg ? 'none' : '';
  }

  async function confirmInstall() {
    const p = STATE.pendingInstall;
    if (!p) return;
    if (p.type === 'github') {
      if (STATE.risk && STATE.risk.level === 'high') {
        const ok = await modal('确认安装', '该插件存在高风险项，仍要安装吗？', { danger: true, confirmText: '仍要安装' });
        if (!ok) return;
      }
      setInstallStatus('installing');
      const r = await api('POST', '/api/install/confirm', { sourcePath: p.sourcePath }, { timeoutMs: 60000 });
      if (r && r.ok) {
        setInstallStatus('success');
        toast('安装成功', 'success');
        if (r.installed && r.installed.id) {
          // 自动关联 GitHub
          await api('POST', '/api/plugins/' + encodeURIComponent(r.installed.id) + '/source', { githubUrl: p.url });
        }
        STATE.risk = null; STATE.pendingInstall = null;
        resetInstallPanel();
      } else {
        setInstallStatus('failed', (r && r.error) || '安装失败');
        toast((r && r.error) || '安装失败', 'error');
      }
    } else {
      if (STATE.risk && STATE.risk.level === 'high') {
        const ok = await modal('确认安装', '该插件存在高风险项，仍要安装吗？', { danger: true, confirmText: '仍要安装' });
        if (!ok) return;
      }
      setInstallStatus('installing');
      const r = await api('POST', '/api/install/confirm', { sourcePath: p.sourcePath }, { timeoutMs: 60000 });
      if (r && r.ok) {
        setInstallStatus('success');
        toast('安装成功', 'success');
        STATE.risk = null; STATE.pendingInstall = null;
        resetInstallPanel();
      } else {
        setInstallStatus('failed', (r && r.error) || '安装失败');
        toast((r && r.error) || '安装失败', 'error');
      }
    }
    if (STATE.activeView === 'install') switchView('manage');
  }

  // ── 文件浏览器 ───────────────────────────
  async function openBrowse(onPick) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.id = 'browse-backdrop';
    back.innerHTML = `
      <div class="modal" style="max-width:520px">
        <h3>选择文件/文件夹</h3>
        <div class="breadcrumb" id="browse-crumb">…</div>
        <div class="browse-list" id="browse-list">加载中…</div>
        <div class="modal-actions" style="margin-top:14px">
          <button class="btn btn-secondary" data-act="close">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add('show'));
    const close = () => { back.classList.remove('show'); setTimeout(() => back.remove(), 200); };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.dataset.act === 'close') close(); });

    // 单色文件浏览图标（跟随 currentColor，与整体冷色调一致）
    const BI = {
      up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>',
      folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1H3a1.5 1.5 0 0 1-1.5-1.5v-8.5z"/></svg>',
      zip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="4" width="11" height="9" rx="1.5"/><path d="M6 4V2h4v2"/></svg>',
      file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.5L9 1.5z"/><path d="M9 1.5V5h4"/></svg>',
    };
    let cur = '';
    async function loadDir(path) {
      const r = await api('GET', '/api/browse?path=' + encodeURIComponent(path), undefined, { timeoutMs: 10000 });
      const crumb = $('browse-crumb'); const list = $('browse-list');
      if (!r || !r.ok) { list.innerHTML = '<div class="empty">' + esc((r && r.error) || '读取失败') + '</div>'; return; }
      cur = r.path;
      crumb.textContent = r.path;
      let html = `<div class="browse-item dir" data-path="${esc(r.parent || r.path)}">${BI.up} 上一级</div>`;
      for (const e of r.entries) {
        const isZip = e.isFile && /\.zip$/i.test(e.name);
        const sz = e.isFile && e.size ? fmtSize(e.size) : '';
        if (e.isDir) html += `<div class="browse-item dir" data-path="${esc(r.path + '\\' + e.name)}">${BI.folder} ${esc(e.name)}</div>`;
        else if (isZip) html += `<div class="browse-item file" data-pick="${esc(r.path + '\\' + e.name)}">${BI.zip} ${esc(e.name)} <span class="sz">${sz}</span></div>`;
        else if (e.isFile) html += `<div class="browse-item file" data-path="${esc(r.path + '\\' + e.name)}">${BI.file} ${esc(e.name)}</div>`;
      }
      list.innerHTML = html;
      list.querySelectorAll('.browse-item[data-path]').forEach((el) => {
        el.onclick = () => loadDir(el.dataset.path);
      });
      list.querySelectorAll('.browse-item[data-pick]').forEach((el) => {
        el.onclick = () => { if (onPick) onPick(el.dataset.pick); close(); };
      });
    }
    loadDir(STATE.browse || '');
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ── 更新页 ───────────────────────────────
  async function loadUpdates(force) {
    setInstallStatus('checking', '', 'update-status');
    const q = force ? '?force=1' : '';
    const r = await api('GET', '/api/updates/check' + q, undefined, { timeoutMs: 30000 });
    if (!r || !r.ok) {
      setInstallStatus('failed', (r && r.error) || '检测失败', 'update-status');
      $('update-body').innerHTML = `<div class="empty">${esc((r && r.error) || '检测失败')}</div>`;
      return;
    }
    STATE.updates = r.plugins || [];
    STATE.updateSel = new Set(STATE.updates.filter((p) => p.hasUpdate).map((p) => p.id));
    renderUpdates();
    const updatable = STATE.updates.filter((p) => p.hasUpdate).length;
    const failed = STATE.updates.filter((p) => p.status === 'check-failed').length;
    const badge = $('tab-update');
    if (badge) badge.textContent = updatable ? String(updatable) : '';
    if (updatable) setInstallStatus('success', `检测完成：${updatable} 个插件可更新${failed ? `，${failed} 个检测失败` : ''}`, 'update-status');
    else if (failed) setInstallStatus('warning', `检测完成：${failed} 个插件检测失败`, 'update-status');
    else setInstallStatus('success', '检测完成：所有插件均已最新或未关联更新源', 'update-status');
  }

  /** 更新页：已选/可更新计数 + 「更新选中」按钮可用态 */
  function updateSelectSummary() {
    const total = STATE.updates.filter((p) => p.hasUpdate).length;
    const sel = STATE.updateSel.size;
    $('update-summary').textContent = `${sel} / ${total} 已选`;
    const btn = $('btn-apply-update');
    if (btn) btn.disabled = sel === 0;
  }

  /** 顶栏「打开 Hana 插件文件夹」按钮的可用态 */
  function updateOpenHomeBtn() {
    const btn = $('btn-open-home');
    if (!btn) return;
    const home = (STATE.status && STATE.status.hanaHome) || null;
    btn.disabled = !home;
    btn.title = home ? `打开 Hana 插件文件夹：${home}` : '未配置 Hana 插件文件夹';
  }

  function renderUpdates() {
    const body = $('update-body');
    updateSelectSummary();
    if (!STATE.updates.length) { body.innerHTML = '<div class="empty"><h3>暂无已关联 GitHub 的插件</h3><p>在插件详情里关联仓库地址后即可检测更新</p></div>'; return; }
    const STATUS_META = {
      'outdated':      { chipCls: 'outdated',      label: '可更新' },
      'latest':        { chipCls: 'latest',        label: '已最新' },
      'no-source':     { chipCls: 'no-source',     label: '未关联' },
      'check-failed':  { chipCls: 'failed',        label: '检测失败' },
      'upstream-404':  { chipCls: 'upstream-404',  label: '仓库 404' },
      'no-version':    { chipCls: 'no-version',    label: '无 version' },
    };
    const rows = STATE.updates.map((p) => {
      const meta = STATUS_META[p.status] || { chipCls: '', label: p.status };
      const errStatus = p.status === 'check-failed' || p.status === 'upstream-404' || p.status === 'no-version';
      const ghLink = p.github && p.github.url
        ? `<a class="upd-gh" href="${esc(p.github.url)}" target="_blank" rel="noopener" title="${esc(p.github.url)}">打开仓库</a>`
        : '';
      const hasToken = !!(STATE.status && STATE.status.githubToken && STATE.status.githubToken.hasToken);
      const tokenBtn = !hasToken
        ? `<button class="upd-gh" data-cfg-token title="为私有仓库或限流场景配置 GitHub Token">配置 Token</button>`
        : '';
      const versionCell = p.hasUpdate
        ? `<span class="version-compare">${esc(p.localVersion || '?')} <span class="arrow">→</span> ${esc(p.remoteVersion || '?')}</span>`
        : (errStatus
          ? `<div class="upd-err">${esc(p.upstreamError || p.error || '检测失败')} ${ghLink} ${tokenBtn}</div>`
          : '<span class="version-compare">—</span>');
      const hasSource = p.status !== 'no-source';
      const selected = STATE.updateSel.has(p.id);
      const cb = hasSource
        ? `<span class="cb${selected ? ' on' : ''}" data-uid="${esc(p.id)}" title="点击选择/重试">${selected ? CHECK_ICON : ''}</span>`
        : '';
      return `
      <tr data-uid="${esc(p.id)}" class="upd-row${hasSource ? ' selectable' : ''}${selected ? ' selected' : ''}">
        <td>${cb}</td>
        <td>${esc(p.name || p.id)}</td>
        <td>${versionCell}</td>
        <td><span class="status-chip ${meta.chipCls}">${esc(meta.label)}</span></td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <table class="update-table">
        <thead><tr><th style="width:34px"></th><th>插件</th><th>版本</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    // 仓库链接点击不触发行切换
    body.querySelectorAll('.upd-gh').forEach((a) => {
      a.addEventListener('click', (e) => e.stopPropagation());
    });
    // 「配置 Token」按钮：打开输入模态
    body.querySelectorAll('[data-cfg-token]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); openGithubTokenModal(); });
    });
    // 点击行（含勾选方块）切换选择
    body.querySelectorAll('.upd-row.selectable').forEach((row) => {
      row.onclick = () => {
        const uid = row.dataset.uid;
        if (STATE.updateSel.has(uid)) STATE.updateSel.delete(uid);
        else STATE.updateSel.add(uid);
        renderUpdates();
      };
    });
  }

  async function applyUpdates() {
    const ids = Array.from(STATE.updateSel);
    if (!ids.length) { toast('请先勾选要更新的插件', 'warning'); return; }
    const ok = await modal('批量更新', `将对 ${ids.length} 个插件执行更新，更新前会自动备份旧版本。继续？`, { confirmText: '开始更新' });
    if (!ok) return;
    let done = 0, success = 0;
    for (const id of ids) {
      done += 1;
      setInstallStatus('checking', `正在更新 ${done}/${ids.length}：${id}…`, 'update-status');
      const r = await api('POST', '/api/updates/apply', { id }, { timeoutMs: 120000 });
      if (r && r.ok) {
        success += 1;
        setInstallStatus('success', `(${done}/${ids.length}) ${id} 更新成功`, 'update-status');
      } else {
        setInstallStatus('warning', `(${done}/${ids.length}) ${id} 更新失败：${(r && r.error) || '未知错误'}`, 'update-status');
      }
    }
    setInstallStatus(success === ids.length ? 'success' : (success ? 'warning' : 'failed'),
      `更新完成：${success}/${ids.length} 成功`, 'update-status');
    toast(`更新完成：${success}/${ids.length} 成功`, success === ids.length ? 'success' : (success ? 'warning' : 'error'));
    loadUpdates();
  }

  // ── 备份页 ───────────────────────────────
  function renderBackup() {
    const list = $('backup-list');
    $('backup-count').textContent = STATE.backups.length + ' 份备份';
    if (!STATE.backups.length) { list.innerHTML = '<div class="empty"><h3>暂无备份</h3><p>点击右上角「全量备份」保护你的插件</p></div>'; return; }
    list.innerHTML = STATE.backups.map((b, i) => {
      const m = b.meta || {};
      const note = m.note ? `<small>备注：${esc(m.note)}</small>` : '';
      return `
      <div class="backup-item" style="animation:cardIn 300ms ${i * 30}ms backwards">
        <div class="meta">
          <b>${esc(b.name)}</b>
          <small>${esc(fmtDate(m.timestamp))} · ${m.pluginCount || 0} 插件 · ${m.fileCount || 0} 文件</small>
          ${note}
        </div>
        <button class="btn btn-ghost" data-restore-one="${esc(b.dir)}">还原</button>
        <button class="btn btn-ghost" data-note="${esc(b.dir)}">备注</button>
        <button class="btn btn-danger" data-del="${esc(b.dir)}">删除</button>
      </div>`;
    }).join('');
    document.querySelectorAll('[data-restore-one]').forEach((el) => {
      el.onclick = async () => {
        const dir = el.dataset.restoreOne;
        const ok = await modal('全量还原', '将用该备份整体替换当前插件目录（当前状态会先自动备份）。继续？', { danger: true, confirmText: '全量还原' });
        if (!ok) return;
        showLoading('还原中…');
        const r = await api('POST', '/api/restore', { backupDir: dir }, { timeoutMs: 60000 });
        hideLoading();
        if (r && r.ok) { toast('还原成功', 'success'); loadBackups(); }
        else toast((r && r.error) || '还原失败', 'error');
      };
    });
    document.querySelectorAll('[data-note]').forEach((el) => {
      el.onclick = async () => {
        const dir = el.dataset.note;
        const note = prompt('备注：', '');
        if (note === null) return;
        const r = await api('POST', '/api/backup/note', { backupDir: dir, note });
        if (r && r.ok) { toast('已更新备注', 'success'); loadBackups(); }
        else toast((r && r.error) || '更新失败', 'error');
      };
    });
    document.querySelectorAll('[data-del]').forEach((el) => {
      el.onclick = async () => {
        const ok = await modal('删除备份', '删除后不可恢复，确定？', { danger: true, confirmText: '删除' });
        if (!ok) return;
        const r = await api('POST', '/api/backup/delete', { backupDir: el.dataset.del });
        if (r && r.ok) { toast('已删除', 'success'); loadBackups(); }
        else toast((r && r.error) || '删除失败', 'error');
      };
    });
  }

  // ── 日志页 ───────────────────────────────
  function renderLogs() {
    const list = $('log-list');
    if (!STATE.logs.length) { list.innerHTML = '<div class="empty">暂无操作记录</div>'; return; }
    const actions = { install: '安装', uninstall: '卸载', enable: '启用', disable: '停用', update: '更新', backup: '备份', restore: '还原', source: '关联', 'source.set': '关联', 'source.remove': '解除' };
    list.innerHTML = STATE.logs.map((l) => {
      const act = actions[l.action] || l.action || '';
      const isErr = !l.ok || !!l.error;
      const msg = [l.pluginId || l.pluginName || '', l.error || ''].filter(Boolean).join(' · ') || 'ok';
      return `<div class="log-entry ${isErr ? 'err' : 'ok'}">
        <span class="ts">${esc(fmtDate(l.ts))}</span>
        <span class="st">${isErr ? '✕' : '✓'}</span>
        <span class="act">${esc(act)}</span>
        <span class="msg">${esc(msg)}</span>
      </div>`;
    }).join('');
  }

  // ── 初始化 ───────────────────────────────
  function init() {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="hdr">
        <div class="brand">
          <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6m0 0l-3-3m3 3l3-3"/><path d="M5 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/><path d="M8 12h8"/></svg></div>
          <div><h1>小花插件管理</h1></div>
        </div>
        <div class="rt">
          <span class="hud-item"><span class="pulse off" id="pulse-server"></span> <b id="hud-server">加载中</b></span>
          <span class="hud-item"><span class="pulse" id="pulse-api"></span> <b id="hud-count">—</b></span>
        </div>
      </div>
      <div class="path-bar glass">
        <div class="path-info">
          <span class="path-label">Hana 插件文件夹</span>
          <span class="path-value" id="hud-home" title=""></span>
          <button class="btn-open-home" id="btn-open-home" title="打开 Hana 主目录" aria-label="打开 Hana 主目录">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2l1 1.5h6A1.5 1.5 0 0 1 14 6v6.5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8z"/>
            </svg>
          </button>
        </div>
        <div class="tabs">
          <button class="tab active" data-view="manage">插件管理<span class="badge" id="tab-count"></span></button>
          <button class="tab" data-view="install">安装</button>
          <button class="tab" data-view="update">更新<span class="badge" id="tab-update"></span></button>
          <button class="tab" data-view="backup">备份还原</button>
          <button class="tab" data-view="logs">操作日志</button>
        </div>
      </div>
      <div class="main">
        <div class="view active" id="view-manage">
          <div class="page-head">
            <div><h2>已安装插件</h2><p>管理本机 Hana 的插件：安装、更新、卸载、启停与备份还原</p></div>
            <div class="actions">
              <button class="btn btn-secondary" id="btn-refresh">刷新</button>
              <button class="btn btn-primary" data-go-install>安装插件</button>
            </div>
          </div>
          <div id="plugin-list" class="card-grid"></div>
        </div>

        <div class="view" id="view-install">
          <div class="page-head"><div><h2>安装插件</h2><p>支持 GitHub 源码或本地 zip / 文件夹导入</p></div></div>
          <div class="sub-tabs">
            <button class="sub-tab active" data-panel="gh">GitHub 地址</button>
            <button class="sub-tab" data-panel="local">本地 zip / 目录</button>
          </div>
          <div class="panel" id="gh-panel">
            <h3>从 GitHub 安装</h3>
            <div class="field">
              <label>GitHub 仓库地址</label>
              <div class="file-picker">
                <input class="input" id="gh-url" placeholder="https://github.com/owner/repo">
                <button class="btn btn-primary" id="gh-analyze">解析并下载</button>
              </div>
            </div>
            <div id="gh-repo-info" style="margin-bottom:10px"></div>
            <button class="btn btn-success" id="gh-proceed" style="display:none;width:100%">检测通过，继续安装</button>
          </div>
          <div class="panel" id="local-panel" style="display:none">
            <h3>从本地安装</h3>
            <div class="field">
              <label>本地路径（.zip 或文件夹）</label>
              <div class="file-picker">
                <input class="input" id="local-path" placeholder="C:\\下载\\my-plugin.zip 或 目录">
                <button class="btn btn-secondary" id="local-browse">浏览…</button>
                <button class="btn btn-primary" id="local-analyze">校验并检测</button>
              </div>
            </div>
            <button class="btn btn-success" id="local-proceed" style="display:none;width:100%">检测通过，继续安装</button>
          </div>
          <div id="cand-area" style="display:none"></div>
          <div id="risk-area"></div>
          <div id="install-status" class="install-status"></div>
        </div>

        <div class="view" id="view-update">
          <div class="page-head">
            <div><h2>插件更新</h2><p id="update-summary">检测中…</p></div>
            <div class="actions">
              <button class="btn btn-ghost" id="btn-select-all">全选</button>
              <button class="btn btn-ghost" id="btn-select-none">清空</button>
              <button class="btn btn-secondary" id="btn-recheck">重新检测</button>
              <button class="btn btn-primary" id="btn-apply-update" disabled>更新选中</button>
            </div>
          </div>
          <div id="update-status" class="install-status"></div>
          <div id="update-body" style="margin-top:12px"></div>
        </div>

        <div class="view" id="view-backup">
          <div class="page-head">
            <div><h2>备份与还原</h2><p id="backup-count">…</p></div>
            <div class="actions">
              <button class="btn btn-secondary" id="btn-restore-open">查看备份位置</button>
              <button class="btn btn-primary" id="btn-backup">全量备份</button>
            </div>
          </div>
          <div id="backup-list" class="backup-list"></div>
        </div>

        <div class="view" id="view-logs">
          <div class="page-head">
            <div><h2>操作日志</h2><p>最近操作记录</p></div>
          </div>
          <div id="log-list" class="log-list"></div>
        </div>
      </div>`;

    // Tab 切换
    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => switchView(t.dataset.view);
    });
    setupInstallTabs();

    // 管理页按钮
    $('btn-refresh').onclick = () => loadPlugins();
    document.querySelector('[data-go-install]').onclick = () => switchView('install');
    // 更新页按钮
    $('btn-recheck').onclick = () => loadUpdates();
    $('btn-select-all').onclick = () => {
      STATE.updateSel = new Set(STATE.updates.filter((p) => p.hasUpdate).map((p) => p.id));
      renderUpdates();
    };
    $('btn-select-none').onclick = () => {
      STATE.updateSel = new Set();
      renderUpdates();
    };
    $('btn-apply-update').onclick = () => applyUpdates();
    // 备份页按钮
    $('btn-backup').onclick = async () => {
      showLoading('备份中…');
      const r = await api('POST', '/api/backup', {}, { timeoutMs: 60000 });
      hideLoading();
      if (r && r.ok) { toast('备份成功', 'success'); loadBackups(); }
      else toast((r && r.error) || '备份失败', 'error');
    };
    $('btn-restore-open').onclick = async () => {
      // 优先用第一份备份的 dir 推导 backups 父目录(避开硬编码 plugin id)
      let target = null;
      if (STATE.backups && STATE.backups.length > 0 && STATE.backups[0].dir) {
        // dir 形如 <HANA_HOME>/plugin-data/<pluginId>/backups/plugins/<ts>
        // 想要 <HANA_HOME>/plugin-data/<pluginId>/backups
        target = STATE.backups[0].dir.replace(/[/\\][^/\\]+[/\\][^/\\]+$/, '');
      }
      if (!target && STATE.status && STATE.status.hanaHome) {
        target = STATE.status.hanaHome + '/plugin-data/hana-plugins-manager/backups';
      }
      if (!target) { toast('无法确定备份目录：未配置 Hana 主目录', 'error'); return; }
      const r = await api('POST', '/api/open-path', { path: target });
      if (r && r.ok) toast('已尝试打开备份目录', 'success');
      else toast((r && r.error) || '打开失败', 'error');
    };

    // 绑定安装向导动作
    bindGithubActions();
    bindLocalActions();

    // 顶栏「打开 Hana 插件文件夹」按钮
    const btnOpenHome = $('btn-open-home');
    if (btnOpenHome) {
      btnOpenHome.onclick = async () => {
        const home = (STATE.status && STATE.status.hanaHome) || null;
        const r = await api('POST', '/api/open-path', { path: home });
        if (r && r.ok) toast('已尝试打开 Hana 插件文件夹', 'success');
        else toast((r && r.error) || '打开失败', 'error');
      };
    }

    // 初始加载
    loadStatus();
    loadPlugins();
    // 日志轮询
    setInterval(() => { if (STATE.activeView === 'logs') loadLogs(); }, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
