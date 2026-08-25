/**
 * tool-modules/hana-update-plugin.js — Agent 工具：检查/执行插件更新
 */
import fs from 'node:fs';
import { getContext, resolveDataDir } from '../lib/plugin-context.js';
import { getCurrentDshHome } from '../lib/homes.js';
import * as hanaApi from '../lib/hana-api.js';
import { checkUpdates, prepareUpdate } from '../lib/updater.js';
import { scanPlugins } from '../lib/scanner.js';
import { appendLog } from '../lib/operation-log.js';

export const name = 'hana_update_plugin';
export const description = '检查 Hana 插件是否有更新，并可执行更新到最新版本';
export const parameters = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '插件 id。留空则检查所有已关联 GitHub 的插件' },
    apply: { type: 'boolean', description: '是否执行更新（true 则更新指定插件，默认 false 仅检查）' },
  },
};

export async function execute(input = {}) {
  const ctx = getContext();
  const dataDir = resolveDataDir();
  const home = ctx.hanaHome || getCurrentDshHome();
  if (!home) return { ok: false, error: '未检测到 Hana 主目录' };

  const id = String(input.id || '').trim();
  try {
    if (id && input.apply) {
      const prep = await prepareUpdate(id, dataDir);
      if (!prep.ok) return { ok: false, error: prep.error };
      const installed = await hanaApi.installFromPath(home, prep.pluginRoot, {});
      try { prep.check.cleanup(); } catch { /* ignore */ }
      try { fs.rmSync(prep.zipPath, { force: true }); } catch { /* ignore */ }
      appendLog(dataDir, { action: 'update', pluginId: id, ok: installed.ok, via: 'agent', riskLevel: prep.risk.level });
      return { ok: installed.ok, pluginId: id, installed: installed.ok, riskLevel: prep.risk.level, error: installed.ok ? undefined : installed.error };
    }

    // 仅检查
    const fsPlugins = scanPlugins(home).plugins || [];
    if (id) {
      const one = fsPlugins.filter((p) => p.id === id);
      const r = await checkUpdates(one, dataDir);
      return { ok: true, result: r.plugins[0] };
    }
    const r = await checkUpdates(fsPlugins, dataDir);
    return {
      ok: true,
      summary: `${r.plugins.filter((p) => p.hasUpdate).length} 个插件有更新`,
      plugins: r.plugins.map((p) => ({
        id: p.id, name: p.name, status: p.status,
        localVersion: p.localVersion, remoteVersion: p.remoteVersion,
        hasUpdate: p.hasUpdate, error: p.upstreamError || p.error || null,
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
