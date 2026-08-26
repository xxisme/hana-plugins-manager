/**
 * tool-modules/hana-toggle-plugin.js — Agent 工具：启用/停用插件
 */
import fs from 'node:fs';
import path from 'node:path';
import { getContext, resolveDataDir } from '../lib/plugin-context.js';
import { getCurrentDshHome } from '../lib/homes.js';
import * as hanaApi from '../lib/hana-api.js';
import { appendLog } from '../lib/operation-log.js';

export const name = 'hana_toggle_plugin';
export const description = '启用或停用指定的 Hana 插件';
export const parameters = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '插件 id' },
    enabled: { type: 'boolean', description: 'true 启用，false 停用' },
  },
  required: ['id', 'enabled'],
};

export async function execute(input = {}) {
  const ctx = getContext();
  const dataDir = resolveDataDir();
  const home = ctx.hanaHome || getCurrentDshHome();
  if (!home) return { ok: false, error: '未检测到 Hana 主目录' };
  const id = String(input.id || '').trim();
  const enabled = !!input.enabled;
  if (!id) return { ok: false, error: 'id 必填' };
  // 白名单校验：非法 id 拒绝，防止降级写 preferences.json 时注入脏数据
  const safeId = hanaApi.safePathSegment(id);
  if (!safeId) return { ok: false, error: '非法插件 id' };

  try {
    const r = await hanaApi.setPluginEnabled(home, safeId, enabled);
    if (r.ok) {
      appendLog(dataDir, { action: enabled ? 'enable' : 'disable', pluginId: safeId, ok: true, via: 'agent' });
      return { ok: true, id: safeId, enabled };
    }
    // 降级：编辑 preferences.json
    const prefsPath = path.join(home, 'preferences.json');
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
      try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8')); } catch { /* ignore */ }
    }
    let disabled = Array.isArray(prefs.disabled_plugins) ? prefs.disabled_plugins : [];
    const idx = disabled.indexOf(safeId);
    if (enabled) { if (idx !== -1) disabled.splice(idx, 1); }
    else if (idx === -1) disabled.push(safeId);
    prefs.disabled_plugins = disabled;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
    appendLog(dataDir, { action: enabled ? 'enable' : 'disable', pluginId: safeId, ok: true, degraded: true });
    return { ok: true, id: safeId, enabled, degraded: true, warning: '已写入本地配置，重启 Hana 后完全生效' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
