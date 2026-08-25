/**
 * tool-modules/hana-list-plugins.js — Agent 工具：列出已安装插件
 */
import { getContext, resolveDataDir } from '../lib/plugin-context.js';
import { getCurrentDshHome } from '../lib/homes.js';
import { scanPlugins } from '../lib/scanner.js';
import { getSource } from '../lib/sources.js';
import * as hanaApi from '../lib/hana-api.js';

export const name = 'hana_list_plugins';
export const description = '列出本机 Hana 已安装的插件（含名称/版本/启用状态/GitHub 关联）';
export const parameters = {
  type: 'object',
  properties: {},
};

export async function execute() {
  const ctx = getContext();
  const dataDir = resolveDataDir();
  const home = ctx.hanaHome || getCurrentDshHome();
  if (!home) return { ok: false, error: '未检测到 Hana 主目录' };

  const apiR = await hanaApi.listPlugins(home);
  const fsPlugins = scanPlugins(home).plugins || [];
  const sources = {};

  if (apiR.ok) {
    const byId = new Map(fsPlugins.map((p) => [p.id, p]));
    const list = apiR.plugins.map((p) => {
      const f = byId.get(p.id) || {};
      const src = getSource(dataDir, p.id);
      return {
        id: p.id, name: p.name || f.name || p.id, version: p.version || f.version || null,
        enabled: p.status !== 'disabled' && p.status !== 'failed',
        trust: p.trust || f.trust || 'restricted',
        github: src ? src.githubUrl : null,
      };
    });
    return { ok: true, count: list.length, plugins: list };
  }

  const list = fsPlugins.map((p) => {
    const src = getSource(dataDir, p.id);
    return {
      id: p.id, name: p.name, version: p.version, enabled: p.enabled,
      trust: p.trust, github: src ? src.githubUrl : null,
    };
  });
  return { ok: true, count: list.length, plugins: list, degraded: true };
}
