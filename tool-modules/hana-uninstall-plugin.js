/**
 * tool-modules/hana-uninstall-plugin.js — Agent 工具：卸载插件
 */
import fs from 'node:fs';
import path from 'node:path';
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
  // 白名单校验：插件 id 必须符合 SDK 规范 [a-zA-Z0-9._:-]*，防路径穿越删除任意目录
  const safeId = hanaApi.safePathSegment(id);
  if (!safeId) return { ok: false, error: '非法插件 id' };

  try {
    let backupDir = null;
    try { backupDir = backupPlugins(dataDir, home); } catch { /* ignore */ }
    const r = await hanaApi.uninstallPlugin(home, safeId);
    if (r.ok) {
      setSource(dataDir, safeId, '');
      appendLog(dataDir, { action: 'uninstall', pluginId: safeId, ok: true, backupDir, via: 'agent' });
      return { ok: true, pluginId: safeId, backupDir };
    }
    // 降级：直接删目录（safeId 已白名单化，仅限 plugins 内）
    const dir = path.join(home, 'plugins', safeId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      setSource(dataDir, safeId, '');
      return { ok: true, pluginId: safeId, backupDir, degraded: true, warning: '已直接删除，重启 Hana 后完全生效' };
    }
    return { ok: false, error: r.error || '插件不存在' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
