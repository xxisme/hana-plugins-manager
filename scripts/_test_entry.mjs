/**
 * 临时验证：manifest.entry 指向文件缺失时，checkLocalSource 应返回 ok:false + 明确错误。
 * 模拟 Nyasers/dsh-hanako 源码仓库场景：根目录有 manifest.json（entry=index.js）但无 index.js。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLocalSource } from '../lib/zip-check.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'test-entry-'));
const pluginRoot = path.join(base, 'dsh-hanako');
fs.mkdirSync(path.join(pluginRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(pluginRoot, 'src', 'index.js'), '// 源码,构建后才生成根 index.js\n');
fs.writeFileSync(path.join(pluginRoot, 'manifest.json'), JSON.stringify({
  manifestVersion: 1,
  id: 'dsh-hanako',
  name: 'DSHana',
  version: '0.17.1',
  entry: 'index.js',          // 指向构建产物,源码包内不存在
  trust: 'full-access',
}, null, 2));

const r = checkLocalSource(pluginRoot);
console.log('ok:', r.ok);
console.log('errors:', JSON.stringify(r.errors, null, 2));
console.log('pluginRoot:', r.pluginRoot);

// 对照组：entry 指向存在的文件 → 应放行
const okRoot = path.join(base, 'ok-plugin');
fs.mkdirSync(okRoot, { recursive: true });
fs.writeFileSync(path.join(okRoot, 'index.js'), '// ok\n');
fs.writeFileSync(path.join(okRoot, 'manifest.json'), JSON.stringify({ id: 'ok-plugin', name: 'ok', version: '1.0.0', entry: 'index.js' }, null, 2));
const r2 = checkLocalSource(okRoot);
console.log('\n[对照] ok:', r2.ok, 'errors:', r2.errors.length);

try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }

// 断言
const pass = r.ok === false && r.errors.some((e) => e.includes('entry 入口文件不存在')) && r2.ok === true;
console.log('\nPASS:', pass);
process.exit(pass ? 0 : 1);
