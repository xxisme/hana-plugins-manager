/**
 * tool-modules/hana-uninstall-plugin.js — Agent 工具：卸载插件
 */
import fs from 'node:fs';
import { getContext, resolveDataDir } from '../lib/plugin-context.js';
import { getCurrentDshHome } from '../lib/homes.js';
import * as hanaApi from '../lib/hana-api.js';
import { setSource } from '../lib/sources.js';
import { backupPlugins } from '../lib/backup.js';
import { appendLog } from '../lib/operation-log.js';

export const name = 'hana_uninstall_plugin';
export const description = '卸载指定的 Hana 插件';
export const parameters = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '插件 id（在插件列表里查看）' },
  },
  required: ['id'],
};

export async function execute(input = {}) {
  const ctx = getContext();
  const dataDir = resolveDataDir();
  const home = ctx.hanaHome || getCurrentDshHome();
  if (!home) return { ok: false, error: '未检测到 Hana 主目录' };
  const id = String(input.id || '').trim();
  if (!id) return { ok: false, error: 'id 必填' };

  try {
    let backupDir = null;
    try { backupDir = backupPlugins(dataDir, home); } catch { /* ignore */ }
    const r = await hanaApi.uninstallPlugin(home, id);
    if (r.ok) {
      setSource(dataDir, id, '');
      appendLog(dataDir, { action: 'uninstall', pluginId: id, ok: true, backupDir, via: 'agent' });
      return { ok: true, pluginId: id, backupDir };
    }
    // 降级：直接删目录
    const dir = `${home}/plugins/${id}`;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      setSource(dataDir, id, '');
      return { ok: true, pluginId: id, backupDir, degraded: true, warning: '已直接删除，重启 Hana 后完全生效' };
    }
    return { ok: false, error: r.error || '插件不存在' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
