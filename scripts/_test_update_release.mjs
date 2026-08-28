/**
 * 验证：prepareUpdate 的 downloadZip 对 dsh-hanako（源码项目 + Release 发布）应走 Release 包。
 * 直接模拟 updater 的下载+校验链路：dsh-hanako 源码仓库 entry 缺失会失败，Release 包应成功。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gh from '../lib/github.js';
import { checkLocalSource } from '../lib/zip-check.js';

const dataDir = path.join(os.tmpdir(), 'test-upd-data');
const workRoot = path.join(dataDir, 'tmp');
fs.mkdirSync(workRoot, { recursive: true });

const owner = 'Nyasers';
const repoName = 'dsh-hanako';

// 1) 先看仓库有没有可用的 release zip 资产
const rel = await gh.getLatestRelease(owner, repoName, dataDir);
console.log('release hasRelease:', rel.hasRelease, '| tag:', rel.tag);
if (rel.ok && rel.assets.length) {
  console.log('  资产:', rel.assets.map((a) => `${a.name} (${a.size} bytes)`).join(', '));
} else {
  console.log('  (无可用 release zip 资产，测试跳过 release 分支)');
}

// 2) 模拟 downloadZip 的 Release 优先逻辑
const zipPath = path.join(workRoot, `dsh-hanako-${Date.now()}.zip`);
let usedSource = 'none';
let check = null;
if (rel.ok && Array.isArray(rel.assets) && rel.assets.length) {
  const asset = gh.pickReleaseAsset(rel.assets, repoName);
  const dlRel = await gh.downloadReleaseAsset(asset, zipPath, dataDir);
  console.log('\ndownload release:', dlRel.ok, dlRel.error || `${dlRel.size} bytes`);
  if (dlRel.ok) {
    check = checkLocalSource(zipPath, workRoot);
    usedSource = 'release';
    console.log('checkLocalSource(release): ok =', check.ok, check.errors.join('；') || '(无错误)');
  }
}
if (!check || !check.ok) {
  // 回退源码（仅演示；真实环境 release 失败才走这里）
  const dlSrc = await gh.downloadRepoZip(owner, repoName, 'master', zipPath, dataDir);
  console.log('fallback download source:', dlSrc.ok, dlSrc.error || `${dlSrc.size} bytes`);
  if (dlSrc.ok) {
    check = checkLocalSource(zipPath, workRoot);
    usedSource = 'source';
    console.log('checkLocalSource(source): ok =', check.ok, '| errors:', check.errors.join('；') || '(无错误)');
  }
}

const pass = !!check && check.ok && usedSource === 'release';
console.log('\nPASS(更新走 Release 包且校验通过):', pass);
if (check && check.cleanup) { try { check.cleanup(); } catch { /* ignore */ } }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(pass ? 0 : 1);
