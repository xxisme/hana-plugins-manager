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
import { setContext } from './lib/plugin-context.js';
import { getCurrentDshHome } from './lib/homes.js';
import { ensureLogFile } from './lib/operation-log.js';

const TMP_DIR = 'tmp';

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
      this._log.warn('[hana-plugins-manager] 未检测到 HANA_HOME（~/.hanako 不存在）');
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
      configGet: (key) => {
        try { return this.ctx.config?.get?.(key); } catch { return undefined; }
      },
    });

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
