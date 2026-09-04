/**
 * 验证 expectId 防串版：
 * 1) download-progress（已改名为 hana-downloader）→ 应报「未找到匹配目录」，不再误报 2.0.1
 * 2) hana-downloader（正确 id）→ 应能检测到版本
 * 3) dsh-hanako（单插件仓库）→ 正常检测不受影响
 */
import os from 'node:os';
import path from 'node:path';
import { getRemoteVersion } from '../lib/github.js';

// 用真实插件数据目录（内含 github-token，避免匿名限流影响验证）
const dataDir = 'C:/Users/Administrator/.hanako/plugin-data/hana-plugins-manager';

// 1) 旧 id download-progress → 应拦截（改名场景）
const r1 = await getRemoteVersion('JohnGalt0802', 'HanaAgent-Plugins', 'main', dataDir, 'download-progress');
console.log('[download-progress 旧id] ok:', r1.ok, '| status:', r1.status, '| error:', (r1.error || '').slice(0, 80));

// 2) 新 id hana-downloader → 应命中
const r2 = await getRemoteVersion('JohnGalt0802', 'HanaAgent-Plugins', 'main', dataDir, 'hana-downloader');
console.log('[hana-downloader 新id ] ok:', r2.ok, '| version:', r2.version, '| error:', r2.error || '');

// 3) 单插件仓库 dsh-hanako（无 expectId 兼容 + 有 expectId 都应正常）
const r3 = await getRemoteVersion('Nyasers', 'dsh-hanako', 'master', dataDir);
const r4 = await getRemoteVersion('Nyasers', 'dsh-hanako', 'master', dataDir, 'dsh-hanako');
console.log('[dsh-hanako 无expectId ] ok:', r3.ok, '| version:', r3.version);
console.log('[dsh-hanako 有expectId ] ok:', r4.ok, '| version:', r4.version);

const pass = !r1.ok && (r1.status === 'no-version')
  && r2.ok && r2.version && String(r2.version) !== '2.0.1'  // 不再串到其他插件的 2.0.1
  && r3.ok && r4.ok && String(r3.version) === String(r4.version);
console.log('\nPASS:', pass);
process.exit(pass ? 0 : 1);
