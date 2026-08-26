/**
 * index.js — hana-plugins-manager 生命周期入口
 *
 * 职责：
 *  - onload: 探测 HANA_HOME，初始化数据目录与操作日志，注册 Agent 工具
 *  - onunload: 注销工具、清理临时目录
 *
 * 工具注册通过 ctx.registerTool() 手动注册（与 dsh-plugin-manager 一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setContext } from './lib/plugin-context.js';
import { getCurrentDshHome } from './lib/homes.js';
import { readSources, writeSources } from './lib/sources.js';
import { ensureLogFile } from './lib/operation-log.js';

const TMP_DIR = 'tmp';

// 插件 id 单一事实源：manifest.json（以免多处硬编码导致不一致）
let SELF_PLUGIN_ID = 'hana-plugins-manager';
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));
  if (m && typeof m.id === 'string' && m.id.trim()) SELF_PLUGIN_ID = m.id.trim();
} catch { /* 读不到则退到默认值，不阻断启动 */ }

// Agent 工具定义列表
const TOOL_DEFINITIONS = [
  './tool-modules/hana-list-plugins.js',
  './tool-modules/hana-install-plugin.js',
  './tool-modules/hana-uninstall-plugin.js',
  './tool-modules/hana-toggle-plugin.js',
  './tool-modules/hana-update-plugin.js',
];

/** 探测 hana 主目录：配置 hanaHome > env HANA_HOME > ~/.hanako */
function detectHanaHome(configValue, dataDir) {
  if (configValue && fs.existsSync(configValue)) return configValue;
  if (process.env.HANA_HOME && fs.existsSync(process.env.HANA_HOME)) return process.env.HANA_HOME;
  // 已持久化的选择（内部会做 ~/.hanako 探测兜底）
  const saved = getCurrentDshHome();
  if (saved) return saved;
  return null;
}

export default class HanaPluginsManager {
  constructor() {
    this._hanaHome = null;
    this._dataDir = null;
    this._log = console;
    this._toolDisposers = [];
    this._pluginId = SELF_PLUGIN_ID;
  }

  async onload(ctx) {
    this.ctx = ctx || {};
    const dataDir = this.ctx.dataDir
      || process.env.HANA_PLUGIN_DATA_DIR
      || (process.env.HANA_HOME
        ? path.join(process.env.HANA_HOME, 'plugin-data', 'hana-plugins-manager')
        : null);
    this._dataDir = dataDir;
    this._log = this.ctx.log || console;

    let configHanaHome = null;
    try { configHanaHome = this.ctx.config?.get?.('hanaHome') || null; } catch { /* ignore */ }

    this._hanaHome = detectHanaHome(configHanaHome, dataDir);
    if (this._hanaHome) {
      this._log.info(`[hana-plugins-manager] HANA_HOME = ${this._hanaHome}`);
    } else {
      this._log.warn('[hana-plugins-manager] 未检测到 Hana 主目录（~/.hanako 不存在）');
    }

    if (dataDir) {
      try {
        ensureLogFile(dataDir);
      } catch (e) {
        this._log.warn(`[hana-plugins-manager] dataDir init failed: ${e.message}`);
      }
    }

    setContext({
      hanaHome: this._hanaHome,
      dataDir: this._dataDir,
      log: this._log,
      pluginId: this._pluginId,
      configGet: (key) => {
        try { return this.ctx.config?.get?.(key); } catch { return undefined; }
      },
    });

    // 首次加载：自动写入本插件的 GitHub 关联，便于更新检测。
    // 手动覆盖场景：用户在详情抽屉改成别的仓库时仍可。
    if (dataDir) {
      try {
        const sources = readSources(dataDir);
        if (!sources[this._pluginId]) {
          sources[this._pluginId] = {
            githubUrl: 'https://github.com/xxisme/hana-plugins-manager',
            repo: 'xxisme/hana-plugins-manager',
            owner: 'xxisme',
            repoName: 'hana-plugins-manager',
            branch: 'master',
            updatedAt: new Date().toISOString(),
          };
          writeSources(dataDir, sources);
          this._log.info?.(`[hana-plugins-manager] 已自动写入 self source（用于版本检测）`);
        }
      } catch (e) {
        this._log.warn?.(`[hana-plugins-manager] 自动写入 self source 失败: ${e.message}`);
      }
    }

    await this._syncTools();
  }

  async _syncTools() {
    if (typeof this.ctx.registerTool !== 'function') {
      this._log.warn?.('[hana-plugins-manager] ctx.registerTool 不可用');
      return;
    }
    for (const p of TOOL_DEFINITIONS) {
      try {
        const tool = await import(p);
        const dispose = this.ctx.registerTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: (input = {}, runtimeCtx = {}) =>
            tool.execute(input, { ...this.ctx, ...(runtimeCtx || {}) }),
        });
        if (typeof dispose === 'function') this._toolDisposers.push(dispose);
        this._log.info?.(`[hana-plugins-manager] registered: ${tool.name}`);
      } catch (err) {
        this._log.warn?.(`[hana-plugins-manager] failed to load ${p}: ${err.message}`);
      }
    }
  }

  async onunload() {
    for (const d of this._toolDisposers.splice(0)) {
      try { d?.(); } catch { /* ignore */ }
    }
    if (this._dataDir) {
      const tmpDir = path.join(this._dataDir, TMP_DIR);
      if (fs.existsSync(tmpDir)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
}
