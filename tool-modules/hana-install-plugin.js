/**
 * tool-modules/hana-install-plugin.js — Agent 工具：安装插件（GitHub / 本地 zip / 目录）
 */
import path from 'node:path';
import fs from 'node:fs';
import { getContext, resolveDataDir } from '../lib/plugin-context.js';
import { getCurrentDshHome } from '../lib/homes.js';
import * as hanaApi from '../lib/hana-api.js';
import * as gh from '../lib/github.js';
import { checkLocalSource } from '../lib/zip-check.js';
import { runRiskCheck } from '../lib/risk-check.js';
import { setSource } from '../lib/sources.js';

export const name = 'hana_install_plugin';
export const description = '安装 Hana 插件：输入 GitHub 地址或本地 zip/目录路径，自动下载、风险检测后安装';
export const parameters = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'GitHub 地址（https://github.com/owner/repo）或本地路径（.zip 或目录）' },
    sourceType: { type: 'string', enum: ['github', 'local'], description: '来源类型，省略则自动识别' },
    confirm: { type: 'boolean', description: '是否跳过风险确认直接安装（默认 false，需确认）' },
  },
  required: ['source'],
};

export async function execute(input = {}) {
  const ctx = getContext();
  const dataDir = resolveDataDir();
  const home = ctx.hanaHome || getCurrentDshHome();
  if (!home) return { ok: false, error: '未检测到 Hana 主目录' };

  const source = String(input.source || '').trim();
  if (!source) return { ok: false, error: 'source 必填' };

  const isGitHub = /github\.com|git@github/.test(source) || input.sourceType === 'github';

  // 临时产物清理（仅限 dataDir/tmp 内，防越界删任意路径）
  let stagedCleanup = null;   // staging 解压目录清理函数（目录来源为 no-op）
  let zipPathToRemove = null; // 下载的 zip 文件路径
  const tmpRoot = path.join(dataDir, 'tmp');
  const safeCleanup = () => {
    try {
      if (stagedCleanup) stagedCleanup();
      if (zipPathToRemove) {
        const r = path.resolve(zipPathToRemove);
        if (r.startsWith(path.resolve(tmpRoot) + path.sep)) fs.rmSync(r, { force: true });
      }
    } catch { /* ignore */ }
  };

  try {
    let stagedRoot = null;
    let risk = null;

    if (isGitHub) {
      const info = await gh.getRepoInfo(source, dataDir);
      if (!info.ok) return { ok: false, error: info.error };
      const workRoot = path.join(dataDir, 'tmp');
      fs.mkdirSync(workRoot, { recursive: true });
      const zipPath = path.join(workRoot, `${info.repoName}-${Date.now()}.zip`);
      zipPathToRemove = zipPath;
      const dl = await gh.downloadRepoZip(info.owner, info.repoName, info.defaultBranch, zipPath, dataDir);
      if (!dl.ok) return { ok: false, error: dl.error };
      const check = checkLocalSource(zipPath, workRoot);
      if (!check.ok) return { ok: false, error: '结构校验失败: ' + check.errors.join('；') };
      stagedCleanup = check.cleanup;
      stagedRoot = check.pluginRoot;
      risk = runRiskCheck(check, readServerVersion(home));
    } else {
      if (!fs.existsSync(source)) return { ok: false, error: `路径不存在: ${source}` };
      const check = checkLocalSource(source, path.join(dataDir, 'tmp'));
      if (!check.ok) return { ok: false, error: '结构校验失败: ' + check.errors.join('；') };
      stagedCleanup = check.cleanup;
      stagedRoot = check.pluginRoot;
      risk = runRiskCheck(check, readServerVersion(home));
    }

    // 风险确认
    if (!input.confirm && risk.level === 'high') {
      safeCleanup();
      return {
        ok: false, needConfirm: true,
        error: `风险等级 ${risk.level}：${risk.findings.filter((f) => f.level === 'high').map((f) => f.detail).join('；')}`,
        risk,
        hint: '确认继续请传 confirm=true',
      };
    }

    const r = await hanaApi.installFromPath(home, stagedRoot, {});
    safeCleanup();
    if (!r.ok) return { ok: false, error: r.error, risk };

    // GitHub 安装路径：成功后自动关联 source（不覆盖已有设置）
    const warnings = [];
    if (isGitHub && r.data && r.data.id) {
      const safeId = hanaApi.safePathSegment(r.data.id);
      if (safeId) {
        try {
          const sr = setSource(dataDir, safeId, source, { overwrite: false });
          if (!sr.saved && sr.reason === 'already-set') {
            warnings.push(`已存在 GitHub 关联 ${sr.existing.githubUrl},未覆盖为 ${source}`);
          }
        } catch (e) {
          warnings.push(`自动关联 GitHub 失败: ${e.message}`);
        }
      } else {
        warnings.push(`插件 id "${r.data.id}" 不合法,跳过 GitHub 自动关联`);
      }
    }

    return {
      ok: true,
      installed: r.data,
      risk: { level: risk.level, findings: risk.findings.length },
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    safeCleanup();
    return { ok: false, error: e.message };
  }
}

function readServerVersion(home) {
  try {
    const info = hanaApi.readServerInfo(home);
    return info.ok ? info.version : null;
  } catch { return null; }
}
