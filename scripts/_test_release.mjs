/**
 * 临时验证：getLatestRelease 资产过滤 + downloadReleaseAsset 下载。
 * 用 mock 全局 fetch 模拟 GitHub API 返回，验证：
 *  - 自动生成的 "Source code (zip)" / .tar.gz 被排除
 *  - 作者上传的 zip 保留
 *  - downloadReleaseAsset 走 browser_download_url 并写文件
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLatestRelease, downloadReleaseAsset } from '../lib/github.js';

const realFetch = globalThis.fetch;

// ── mock 1：releases 列表返回模拟资产（含 prerelease）──
let mode = 'release';
globalThis.fetch = async (url, opts) => {
  if (mode === 'release') {
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          tag_name: 'v0.17.1',
          name: 'v0.17.1',
          published_at: '2026-08-01T00:00:00Z',
          draft: false,
          assets: [
            { name: 'Source code (zip)', browser_download_url: 'https://github.com/Nyasers/dsh-hanako/archive/refs/tags/v0.17.1.zip' },
            { name: 'Source code (tar.gz)', browser_download_url: 'https://github.com/Nyasers/dsh-hanako/archive/refs/tags/v0.17.1.tar.gz' },
            { name: 'dsh-hanako-v0.17.1.zip', browser_download_url: 'https://github.com/Nyasers/dsh-hanako/releases/download/v0.17.1/dsh-hanako-v0.17.1.zip', size: 1234 },
            { name: 'dsh-hanako-v0.17.1.tar.gz', browser_download_url: 'https://github.com/Nyasers/dsh-hanako/releases/download/v0.17.1/dsh-hanako-v0.17.1.tar.gz' },
          ],
        },
      ],
    };
  }
  if (mode === 'release-multi') {
    // 正式版 0.17.1 + prerelease 0.17.2：必须选版本号更高的 0.17.2
    return {
      ok: true,
      status: 200,
      json: async () => [
        { tag_name: 'v0.17.1', draft: false, published_at: '2026-08-01T00:00:00Z', assets: [{ name: 'dsh-hanako-v0.17.1.zip', browser_download_url: 'https://x/v0.17.1.zip' }] },
        { tag_name: 'v0.17.2', draft: false, published_at: '2026-08-02T00:00:00Z', assets: [{ name: 'dsh-hanako-v0.17.2.zip', browser_download_url: 'https://x/v0.17.2.zip' }] },
        { tag_name: 'v0.17.0', draft: true, published_at: '2026-07-30T00:00:00Z', assets: [{ name: 'dsh-hanako-v0.17.0.zip', browser_download_url: 'https://x/v0.17.0.zip' }] },
      ],
    };
  }
  if (mode === 'download') {
    return {
      ok: true,
      status: 200,
      headers: { get: () => '512' },
      arrayBuffer: async () => Buffer.from('RELEASE_ZIP_CONTENT'),
    };
  }
  throw new Error('unexpected mock mode');
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-rel-'));

// ── 1) 资产过滤 ──
const r = await getLatestRelease('Nyasers', 'dsh-hanako', null);
console.log('hasRelease:', r.hasRelease, 'tag:', r.tag);
console.log('assets:', r.assets.map((a) => a.name).join(', '));

const names = r.assets.map((a) => a.name);
const pass1 = r.ok && names.length === 1 && names[0] === 'dsh-hanako-v0.17.1.zip';
console.log('PASS 过滤(仅作者 zip):', pass1);

// ── 2) 下载资产 ──
mode = 'download';
const dest = path.join(tmp, 'rel.zip');
const dl = await downloadReleaseAsset(r.assets[0], dest, null);
const content = fs.readFileSync(dest, 'utf8');
console.log('download ok:', dl.ok, 'size:', dl.size);
const pass2 = dl.ok && content === 'RELEASE_ZIP_CONTENT';
console.log('PASS 下载写文件:', pass2);

// ── 3) prerelease 场景：版本号更高的 prerelease 应胜出（修复的核心）──
mode = 'release-multi';
const r3 = await getLatestRelease('Nyasers', 'dsh-hanako', null);
console.log('\n[prerelease 场景] tag:', r3.tag, '| 资产:', r3.assets.map((a) => a.name).join(', '));
const pass4 = r3.ok && r3.tag === 'v0.17.2' && r3.assets.length === 1 && r3.assets[0].name === 'dsh-hanako-v0.17.2.zip';
console.log('PASS prerelease 最高版本胜出:', pass4);

// ── 4) 无资产兜底：404 → hasRelease:false ──
mode = 'release';
globalThis.fetch = async () => ({ ok: false, status: 404 });
const r2 = await getLatestRelease('xxisme', 'no-release-repo', null);
console.log('no-release 404 → hasRelease:', r2.hasRelease);
const pass3 = r2.ok === false && r2.hasRelease === false;
console.log('PASS 无 Release 返回空:', pass3);

globalThis.fetch = realFetch;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

const allPass = pass1 && pass2 && pass3 && pass4;
console.log('\nALL PASS:', allPass);
process.exit(allPass ? 0 : 1);
