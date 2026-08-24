/**
 * scripts/net-check.mjs — GitHub 连通性与安装链路自测
 * 测试：GitHub API 可达性、Contents API 读版本、codeload 下载、getRepoInfo/getRemoteVersion/downloadRepoZip 全链路。
 * 运行：node scripts/net-check.mjs（默认仓库可用 NET_REPO=owner/repo 覆盖）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRepoInfo, getRemoteVersion, getRemoteManifest, downloadRepoZip } from '../lib/github.js';
import { parseGithubUrl } from '../lib/sources.js';
import { checkLocalSource } from '../lib/zip-check.js';
import { runRiskCheck } from '../lib/risk-check.js';

const dataDir = os.tmpdir();
// 用参考项目仓库（单插件结构，含 manifest.json），验证完整安装链路
const repo = process.env.NET_REPO || 'omdsh-dev/DSH-better-sidebar';
const parsed = parseGithubUrl(repo);
const OWNER = parsed.owner;
const NAME = parsed.repoName;
const BRANCH = 'main';

function log(name, ok, extra) {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  => ' + extra : ''}`);
}

// 1. GitHub API
console.log('--- GitHub API / repos ---');
try {
  const info = await getRepoInfo(repo, dataDir);
  log('getRepoInfo', info.ok, info.ok ? `defaultBranch=${info.defaultBranch} stars=${info.stars}` : info.error);
} catch (e) {
  log('getRepoInfo', false, e.message);
}

// 2. api.github.com Contents API（替代 raw）
console.log('--- api.github.com Contents API ---');
try {
  const rv = await getRemoteVersion(OWNER, NAME, BRANCH, dataDir);
  log('getRemoteVersion', rv.ok, rv.ok ? `version=${rv.version}${rv.from ? ' from=' + rv.from : ''}` : rv.error);
} catch (e) {
  log('getRemoteVersion', false, e.message);
}
try {
  const rm = await getRemoteManifest(OWNER, NAME, BRANCH, dataDir);
  log('getRemoteManifest', rm.ok, rm.ok ? `manifest keys=${rm.manifest ? Object.keys(rm.manifest).join(',') : 'null'}` : rm.error);
} catch (e) {
  log('getRemoteManifest', false, e.message);
}

// 3. codeload zip 下载 + 解压 + 风险检测全链路
console.log('--- codeload + zip + risk ---');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-net-'));
try {
  const zipPath = path.join(tmp, 'repo.zip');
  const dl = await downloadRepoZip(OWNER, NAME, BRANCH, zipPath, dataDir);
  log('downloadRepoZip', dl.ok, dl.ok ? `size=${dl.size}` : dl.error);
  if (dl.ok) {
    const check = checkLocalSource(zipPath, tmp);
    log('checkLocalSource', check.ok, check.ok ? `pluginRoot=${path.basename(check.pluginRoot)} manifest=${!!check.manifest}` : check.errors.join(';'));
    if (check.ok) {
      const risk = runRiskCheck(check, '0.82.0');
      log('runRiskCheck', true, `level=${risk.level} findings=${risk.findings.length}`);
    }
    try { check.cleanup(); } catch { /* ignore */ }
  }
} catch (e) {
  log('download chain', false, e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n完成。若出现大量 ✗ 且带 timeout/network/fetch failed，说明是网络问题而非代码问题。');
