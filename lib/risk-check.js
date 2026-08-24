/**
 * lib/risk-check.js — 插件风险检测（格式 + 行为预检，非安全审计）
 *
 * 检测项：
 *  - manifest 信任等级（full-access 高，restricted 低）
 *  - capabilities / sensitiveCapabilities 敏感能力
 *  - minAppVersion 与当前 hana 版本兼容性
 *  - 递归扫描 js/ts 源码的可疑模式：child_process、eval(/Function(、硬编码网络地址、
 *    超长 base64、动态 require/import、fetch 到外部地址等
 *
 * 返回 { level: 'high'|'medium'|'low', findings: [{level,type,detail}] }。
 * 明确标注：仅供参考，插件可信度需自行判断。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const MAX_SCAN_BYTES = 4 * 1024 * 1024; // 单个文件最多扫描 4MB

// 可疑模式：{ regex, level, type, hint }
const PATTERNS = [
  { regex: /\bchild_process\b/g, level: 'high', type: 'child_process', hint: '调用子进程（可能执行外部命令）' },
  { regex: /\beval\s*\(/g, level: 'high', type: 'eval', hint: '使用 eval() 动态执行代码' },
  { regex: /\bnew\s+Function\s*\(/g, level: 'high', type: 'new-function', hint: '使用 Function 构造器动态执行代码' },
  { regex: /\bexec\s*\(/g, level: 'high', type: 'exec', hint: '调用 exec 类执行命令' },
  { regex: /\bspawn\s*\(/g, level: 'medium', type: 'spawn', hint: 'spawn 子进程' },
  { regex: /\bshell\s*[:=]/g, level: 'medium', type: 'shell', hint: '设置 shell 选项' },
  { regex: /\bprocess\.env\./g, level: 'medium', type: 'env', hint: '读取环境变量' },
  { regex: /\bfetch\s*\(\s*[\x22'](https?:\/\/[^)\x22']+)/g, level: 'medium', type: 'fetch-external', hint: '请求外部地址：$1' },
  { regex: /\brequire\s*\(\s*[\x22'](node:?(fs|child_process|net|http|https|os|path))[\x22']/g, level: 'low', type: 'require-node', hint: 'require Node 模块：$1' },
  { regex: /(?:[0-9]{1,3}\.){3}[0-9]{1,3}/g, level: 'low', type: 'hardcoded-ip', hint: '硬编码 IP 地址' },
  { regex: /[A-Za-z0-9+/]{200,}={0,2}/g, level: 'low', type: 'long-base64', hint: '超长疑似 base64 串（可能内嵌数据）' },
  { regex: /\bdeleteFile\b|\bunlink\b|\brmSync\b|\brm\s*\(/g, level: 'high', type: 'delete-file', hint: '删除文件操作' },
  { regex: /\bwriteFile\b|\bappendFile\b|\bcopyFile\b/g, level: 'medium', type: 'write-file', hint: '写文件操作' },
  { regex: /\brequire\s*\(\s*[\x22']https?:/g, level: 'high', type: 'require-remote', hint: '从远程 require 代码' },
  { regex: /\bimport\s*\(\s*[\x22']https?:/g, level: 'high', type: 'import-remote', hint: '动态 import 远程代码' },
];

/**
 * 执行风险检测。
 * @param {object} checkResult zip-check 的返回值（含 pluginRoot/manifest）
 * @param {string} [hanaVersion] 当前 hana 版本
 */
export function runRiskCheck(checkResult, hanaVersion) {
  const findings = [];
  const manifest = checkResult.manifest;

  // 1. manifest 信任等级
  if (manifest && manifest.trust === 'full-access') {
    findings.push({ level: 'medium', type: 'trust', detail: '声明 full-access：可访问文件系统与任意资源' });
  } else if (manifest && manifest.trust === 'restricted') {
    findings.push({ level: 'low', type: 'trust', detail: '声明 restricted：受限权限' });
  }

  // 2. 敏感能力
  if (manifest && Array.isArray(manifest.capabilities)) {
    for (const c of manifest.capabilities) {
      if (/write|exec|network|filesystem/i.test(c)) {
        findings.push({ level: 'medium', type: 'capability', detail: `声明能力：${c}` });
      }
    }
  }
  if (manifest && Array.isArray(manifest.sensitiveCapabilities)) {
    for (const c of manifest.sensitiveCapabilities) {
      findings.push({ level: 'high', type: 'sensitive-capability', detail: `声明敏感能力：${c}` });
    }
  }

  // 3. minAppVersion 兼容性
  if (manifest && manifest.minAppVersion && hanaVersion) {
    if (compareVersions(hanaVersion, manifest.minAppVersion) < 0) {
      findings.push({
        level: 'high',
        type: 'incompatible',
        detail: `需要 hana v${manifest.minAppVersion}+，当前 v${hanaVersion}，可能不兼容`,
      });
    } else {
      findings.push({ level: 'low', type: 'compatible', detail: `要求 hana v${manifest.minAppVersion}+，当前 v${hanaVersion}，兼容` });
    }
  }

  // 4. 扫描 js/ts 源码
  const sourceFindings = scanSource(checkResult.pluginRoot);
  findings.push(...sourceFindings);

  // 汇总等级
  let level = 'low';
  if (findings.some((f) => f.level === 'high')) level = 'high';
  else if (findings.some((f) => f.level === 'medium')) level = 'medium';

  return { level, findings, disclaimer: '仅供参考：这是格式与行为预检，非安全审计，插件可信度需自行判断。' };
}

/** 递归扫描 js/ts 文件 */
function scanSource(root) {
  const findings = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 跳过常见噪声目录
        if (['node_modules', '.git', 'dist', 'build', 'assets', '.cache'].includes(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(e.name)) {
        const rel = path.relative(root, full);
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_SCAN_BYTES) {
            findings.push({ level: 'low', type: 'large-file', detail: `${rel}: 文件过大，跳过内容扫描` });
            continue;
          }
          const text = fs.readFileSync(full, 'utf-8');
          for (const p of PATTERNS) {
            p.regex.lastIndex = 0;
            let m;
            let count = 0;
            while ((m = p.regex.exec(text)) && count < 3) {
              const detail = p.hint.replace('$1', m[1] || '');
              findings.push({ level: p.level, type: p.type, detail: `${rel}: ${detail}` });
              count += 1;
            }
          }
        } catch { /* 单个文件读取失败忽略 */ }
      }
    }
  };
  try { walk(root); } catch { /* ignore */ }
  return findings;
}

/** 精简 semver 比较：返回 <0 / 0 / >0 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 解析版本为数字数组，容忍 'v' 前缀与预发布/构建后缀（-webdav、+build） */
function parseVersion(v) {
  const core = String(v || '0.0.0').trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => {
    const x = parseInt(n, 10);
    return isNaN(x) ? 0 : x;
  });
}
