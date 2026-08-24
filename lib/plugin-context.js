/**
 * lib/plugin-context.js — 全局单例上下文
 *
 * 供 routes/api.js 与 tool-modules/*.js 共享 hanaHome / dataDir / log / configGet。
 * onload 时通过 setContext() 写入，其余模块 import 后调用 getContext() 读取。
 */
'use strict';

let _ctx = null;

export function setContext(ctx) {
  _ctx = ctx || {};
}

export function getContext() {
  if (!_ctx) _ctx = {};
  return _ctx;
}

/** 获取插件数据目录（ctx.dataDir 或推导），目录不存在时返回 null（不自动创建） */
export function resolveDataDir() {
  const ctx = getContext();
  if (ctx.dataDir && typeof ctx.dataDir === 'string' && ctx.dataDir.length) return ctx.dataDir;
  const hanaHome = ctx.hanaHome || process.env.HANA_HOME || null;
  if (hanaHome) return `${hanaHome}/plugin-data/hana-plugins-manager`;
  return null;
}

/** 获取当前选定的 hana home（含持久化选择） */
export function currentHanaHome() {
  const ctx = getContext();
  return ctx.hanaHome || null;
}
