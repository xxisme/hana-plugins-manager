/**
 * scripts/smoke-test.mjs — 离线自测脚本
 *
 * 覆盖：模块可加载、GitHub URL 解析、semver 对比、zip-slip 防护、zip 解压、路径白名单。
 * 运行：node scripts/smoke-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push({ name, extra }); console.error(`✗ ${name}${extra ? ': ' + extra : ''}`); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// 1. 模块可加载
section('模块加载');
const mods = [
  '../lib/plugin-context.js',
  '../lib/homes.js',
  '../lib/operation-log.js',
  '../lib/hana-api.js',
  '../lib/scanner.js',
  '../lib/sources.js',
  '../lib/zip-native.js',
  '../lib/zip-check.js',
  '../lib/risk-check.js',
  '../lib/github.js',
  '../lib/updater.js',
  '../lib/backup.js',
  '../routes/api.js',
  '../index.js',
  '../tool-modules/hana-list-plugins.js',
  '../tool-modules/hana-install-plugin.js',
  '../tool-modules/hana-uninstall-plugin.js',
  '../tool-modules/hana-toggle-plugin.js',
  '../tool-modules/hana-update-plugin.js',
];
for (const m of mods) {
  try {
    await import(m);
    check(`import ${path.basename(m)}`, true);
  } catch (e) {
    check(`import ${path.basename(m)}`, false, e.message);
  }
}

// 2. GitHub URL 解析
section('GitHub URL 解析');
const { parseGithubUrl, detectSourceFromManifest } = await import('../lib/sources.js');
const urlCases = [
  ['https://github.com/foo/bar', { owner: 'foo', repoName: 'bar' }],
  ['https://github.com/foo/bar.git', { owner: 'foo', repoName: 'bar' }],
  ['git@github.com:foo/bar.git', { owner: 'foo', repoName: 'bar' }],
  ['foo/bar', { owner: 'foo', repoName: 'bar' }],
  ['https://github.com/foo/bar/tree/main', { owner: 'foo', repoName: 'bar', branch: 'main' }],
  ['https://github.com/foo/bar#dev', { owner: 'foo', repoName: 'bar', branch: 'dev' }],
];
for (const [input, expect] of urlCases) {
  const r = parseGithubUrl(input);
  check(`解析 ${input}`, !!r && r.owner === expect.owner && r.repoName === expect.repoName, JSON.stringify(r));
  if (expect.branch) check(`分支 ${input}`, r && r.branch === expect.branch, r && r.branch);
}
check('非法地址', parseGithubUrl('not-a-url') === null || parseGithubUrl('https://other.com/x/y') === null);
check('空地址', parseGithubUrl('') === null);

// manifest repository 识别
const manRepo = detectSourceFromManifest({ repository: { type: 'git', url: 'https://github.com/a/b' } });
check('manifest repository 对象', manRepo && manRepo.repo === 'a/b');
const manRepo2 = detectSourceFromManifest({ repository: 'https://github.com/c/d' });
check('manifest repository 字符串', manRepo2 && manRepo2.repo === 'c/d');

// 3. semver 对比
section('semver 对比');
const { compareVersions } = await import('../lib/risk-check.js');
check('1.0.0 < 1.1.0', compareVersions('1.0.0', '1.1.0') < 0);
check('1.1.0 > 1.0.0', compareVersions('1.1.0', '1.0.0') > 0);
check('1.0.0 == 1.0.0', compareVersions('1.0.0', '1.0.0') === 0);
check('v 前缀', compareVersions('v2.0.0', '1.9.0') > 0);
check('0.2.1 vs 0.10.0', compareVersions('0.10.0', '0.2.1') > 0);
check('0.5.4-webdav vs 0.5.4', compareVersions('0.5.4-webdav', '0.5.4') === 0);
check('缺少版本', compareVersions('', '1.0.0') < 0);

// 4. zip-slip 防护 + zip 解压
section('zip 解压与安全');
const { extractZip } = await import('../lib/zip-native.js');

// 构造一个含 zip-slip 路径的 zip（用纯 Buffer 手写）
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8');
    const dataBuf = e.data || Buffer.alloc(0);
    const method = e.method || 0;
    // local header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, dataBuf);
    // central header
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b01, 0);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(dataBuf.length, 20);
    cen.writeUInt32LE(dataBuf.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += 30 + nameBuf.length + dataBuf.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-smoke-'));
try {
  // 正常 zip
  const goodZip = path.join(tmp, 'good.zip');
  fs.writeFileSync(goodZip, makeZip([
    { name: 'plugin/manifest.json', data: Buffer.from('{"id":"p","name":"P","version":"1.0.0"}') },
    { name: 'plugin/index.js', data: Buffer.from('export const x=1;') },
  ]));
  const out1 = path.join(tmp, 'out1');
  extractZip(goodZip, out1);
  check('正常解压', fs.existsSync(path.join(out1, 'plugin', 'manifest.json')));

  // zip-slip
  const evilZip = path.join(tmp, 'evil.zip');
  fs.writeFileSync(evilZip, makeZip([{ name: '../escape.txt', data: Buffer.from('evil') }]));
  const out2 = path.join(tmp, 'out2');
  let slipped = false;
  try { extractZip(evilZip, out2); } catch { slipped = true; }
  check('zip-slip 被拦截', slipped, '应抛出错误');
  check('未越界写入', !fs.existsSync(path.join(tmp, 'escape.txt')));

  // zip-check 校验
  const { checkLocalSource } = await import('../lib/zip-check.js');
  const c1 = checkLocalSource(goodZip, tmp);
  check('zip-check 有效插件', c1.ok === true);
  const c2 = checkLocalSource(path.join(tmp, 'nonexist.zip'), tmp);
  check('zip-check 不存在路径', c2.ok === false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 5. 路径白名单
section('路径白名单');
const { safePathSegment } = await import('../lib/hana-api.js');
check('合法 id', safePathSegment('my-plugin') === 'my-plugin');
check('拒绝 @scope（hana id 应为简单名）', safePathSegment('@scope') === null);
check('拒绝 ..', safePathSegment('..') === null);
check('拒绝 斜杠', safePathSegment('../x') === null);
check('拒绝 空', safePathSegment('') === null);

// 6. homes 探测（不落地）
section('homes 探测');
const { listCandidates, getCurrentDshHome } = await import('../lib/homes.js');
const home = os.homedir();
check('候选包含 ~/.hanako', listCandidates().some((c) => c.endsWith(path.join('.hanako'))));
check('getCurrentDshHome 返回 null 或路径', getCurrentDshHome() === null || typeof getCurrentDshHome() === 'string');
check('候选无重复', new Set(listCandidates()).size === listCandidates().length);

// 7. 操作日志
section('操作日志');
const { appendLog, readRecentLogs } = await import('../lib/operation-log.js');
const logTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-log-'));
try {
  appendLog(logTmp, { action: 'test', ok: true, token: 'secret' });
  appendLog(logTmp, { action: 'test2', ok: false, error: 'boom' });
  const logs = readRecentLogs(logTmp, 10);
  check('日志写入 2 条', logs.length === 2);
  check('日志不落 token', !JSON.stringify(logs).includes('secret'));
  check('日志顺序（新在前）', logs[0].action === 'test2');
} finally {
  fs.rmSync(logTmp, { recursive: true, force: true });
}

// 8. risk-check
section('风险检测');
const { runRiskCheck } = await import('../lib/risk-check.js');
const riskTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-risk-'));
try {
  const pdir = path.join(riskTmp, 'p');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({ id: 'p', name: 'P', version: '1.0.0', trust: 'full-access', minAppVersion: '1.0.0' }));
  fs.writeFileSync(path.join(pdir, 'index.js'), 'const { exec } = require("child_process"); exec("rm -rf /"); eval(x); fetch("http://1.2.3.4/api");');
  const risk = runRiskCheck({ pluginRoot: pdir, manifest: JSON.parse(fs.readFileSync(path.join(pdir, 'manifest.json'), 'utf-8')) }, '2.0.0');
  check('风险检测等级为 high', risk.level === 'high');
  check('发现 child_process', risk.findings.some((f) => f.type === 'child_process'));
  check('发现 eval', risk.findings.some((f) => f.type === 'eval'));
  check('发现硬编码 IP', risk.findings.some((f) => f.type === 'hardcoded-ip'));
} finally {
  fs.rmSync(riskTmp, { recursive: true, force: true });
}

// 9. backup 列表（空目录）
section('备份模块');
const { listBackups } = await import('../lib/backup.js');
const bakTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-bak-'));
try {
  check('空备份列表', Array.isArray(listBackups(bakTmp)) && listBackups(bakTmp).length === 0);
} finally {
  fs.rmSync(bakTmp, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.error('\n失败明细：');
  for (const f of failures) console.error(`  - ${f.name}${f.extra ? ' => ' + f.extra : ''}`);
  process.exit(1);
}
console.log('全部通过 ✓');
