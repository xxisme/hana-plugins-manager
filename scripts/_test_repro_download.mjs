/**
 * 复现：download-progress（JohnGalt0802/HanaAgent-Plugins，合集仓库，插件在 plugins/ 子目录）
 * 检测远端 version 的结果。分支参数分别模拟 src.branch='master' 和默认分支。
 */
import os from 'node:os';
import path from 'node:path';
import { getRemoteVersion } from '../lib/github.js';

const dataDir = path.join(os.tmpdir(), 'test-grv-data');

// 模拟 updater：传 src.branch（plugin-sources.json 里存的 'master'）
const r1 = await getRemoteVersion('JohnGalt0802', 'HanaAgent-Plugins', 'master', dataDir);
console.log('[传 master] ok:', r1.ok, '| status:', r1.status, '| version:', r1.version, '| error:', r1.error || '');

// 对比：只传 owner/repo，branch 留空（走默认分支探测）
const r2 = await getRemoteVersion('JohnGalt0802', 'HanaAgent-Plugins', null, dataDir);
console.log('[传 null ] ok:', r2.ok, '| status:', r2.status, '| version:', r2.version, '| error:', r2.error || '');
