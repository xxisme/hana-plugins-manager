/**
 * lib/hana-api.js — 调用 hana 服务端 HTTP 管理 API
 *
 * 从 ${HANA_HOME}/server-info.json 读取 port + token，封装对 /api/plugins/* 的调用。
 * 任一环节不可用（未运行/文件缺失/鉴权失败）返回 { ok:false, error }，调用方降级为 fs 操作。
 *
 * 注意：本模块不做硬编码端口；全部从 server-info.json 动态读取。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const REQUEST_TIMEOUT = 15000;

/** 读取 server-info.json（探测 hana 服务端口与 Bearer token） */
export function readServerInfo(hanaHome) {
  if (!hanaHome) return { ok: false, error: 'HANA_HOME 未配置' };
  const p = path.join(hanaHome, 'server-info.json');
  if (!fs.existsSync(p)) return { ok: false, error: 'server-info.json 不存在' };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const port = j.port || j.configuredPort || null;
    const token = j.token || '';
    const host = j.host || j.configuredHost || '127.0.0.1';
    if (!port) return { ok: false, error: 'server-info.json 缺少 port' };
    return { ok: true, port, token, host, version: j.version || null };
  } catch (e) {
    return { ok: false, error: `server-info.json 解析失败: ${e.message}` };
  }
}

/** 构造 hana 服务基础地址 */
export function baseUrl(hanaHome) {
  const info = readServerInfo(hanaHome);
  if (!info.ok) return null;
  const host = info.host && info.host !== '0.0.0.0' ? info.host : '127.0.0.1';
  return `http://${host}:${info.port}`;
}

/**
 * 对 hana /api 发起请求。
 * @param {string} hanaHome
 * @param {string} apiPath 形如 /api/plugins
 * @param {{method?:string, body?:object}} [opts]
 */
export async function request(hanaHome, apiPath, opts = {}) {
  const info = readServerInfo(hanaHome);
  if (!info.ok) return { ok: false, error: info.error };
  const base = baseUrl(hanaHome);
  const host = info.host && info.host !== '0.0.0.0' ? info.host : '127.0.0.1';
  const url = `http://${host}:${info.port}${apiPath}`;
  const method = opts.method || 'GET';
  const headers = { 'content-type': 'application/json' };
  if (info.token) headers.authorization = `Bearer ${info.token}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeout || REQUEST_TIMEOUT),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: msg, data };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: `hana 服务不可达: ${e.message || e.name}`, unreachable: true };
  }
}

/** 列出社区插件（实时数据，含启用状态） */
export async function listPlugins(hanaHome) {
  const r = await request(hanaHome, '/api/plugins?source=community');
  return r.ok ? { ok: true, plugins: Array.isArray(r.data) ? r.data : [] } : r;
}

/** 安装本地路径（zip 或目录）。hana 服务端完成 staging/校验/热加载/回滚。 */
export async function installFromPath(hanaHome, sourcePath, { allowDowngrade = false } = {}) {
  return request(hanaHome, '/api/plugins/install', {
    method: 'POST',
    body: { path: sourcePath, allowDowngrade },
  });
}

/** 卸载插件 */
export async function uninstallPlugin(hanaHome, id) {
  const safe = safePathSegment(id);
  if (!safe) return { ok: false, error: '非法插件 id' };
  return request(hanaHome, `/api/plugins/${encodeURIComponent(safe)}`, { method: 'DELETE' });
}

/** 启用/停用插件 */
export async function setPluginEnabled(hanaHome, id, enabled) {
  const safe = safePathSegment(id);
  if (!safe) return { ok: false, error: '非法插件 id' };
  return request(hanaHome, `/api/plugins/${encodeURIComponent(safe)}/enabled`, {
    method: 'PUT',
    body: { enabled: !!enabled },
  });
}

/** 获取插件全局设置（含真实 plugins 目录） */
export async function getPluginSettings(hanaHome) {
  const r = await request(hanaHome, '/api/plugins/settings');
  return r.ok ? { ok: true, settings: r.data || {} } : r;
}

/** 插件 id 白名单：仅 [a-zA-Z0-9._-]，防路径穿越 */
export function safePathSegment(id) {
  if (!id || typeof id !== 'string') return null;
  const t = id.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(t)) return null;
  if (t === '.' || t === '..') return null;
  return t;
}
