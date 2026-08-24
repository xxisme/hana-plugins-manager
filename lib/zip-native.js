/**
 * lib/zip-native.js — 纯 Node 内置 zip 解压器
 *
 * 零依赖：只用 node:zlib。支持 STORED(0) 与 DEFLATE(8) 两种压缩方法；
 * 不支持加密/分卷/spanned。防 zip-slip（拒绝路径越界）。
 */
'use strict';

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const LOCAL_HEADER_SIG = 0x04034b50;

/**
 * 解压 zip 到目标目录。
 * @param {string} zipPath
 * @param {string} destDir
 */
export function extractZip(zipPath, destDir) {
  if (!fs.existsSync(zipPath)) throw new Error(`zip 不存在: ${zipPath}`);
  fs.mkdirSync(destDir, { recursive: true });

  const buf = fs.readFileSync(zipPath);
  const entries = parseZip(buf);
  const destNormalized = path.resolve(destDir);

  for (const entry of entries) {
    const outPath = resolveSafe(destNormalized, entry.name);
    if (entry.isDir) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (entry.method === 0) {
      fs.writeFileSync(outPath, entry.data);
    } else if (entry.method === 8) {
      fs.writeFileSync(outPath, zlib.inflateRawSync(entry.data));
    } else {
      throw new Error(`不支持的压缩方法: ${entry.method} (${entry.name})`);
    }
  }
}

/** 防 zip-slip：解析后必须仍在 destDir 内 */
function resolveSafe(destDir, name) {
  const outPath = path.resolve(destDir, name);
  const norm = outPath.replace(/\\/g, '/');
  const base = destDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (norm !== base && !norm.startsWith(base + '/')) {
    throw new Error(`拒绝越界路径: ${name}`);
  }
  return outPath;
}

function parseZip(buf) {
  const entries = [];
  let cursor = 0;
  while (cursor + 30 <= buf.length) {
    const sig = buf.readUInt32LE(cursor);
    if (sig !== LOCAL_HEADER_SIG) break; // 进入 central directory
    const method = buf.readUInt16LE(cursor + 8);
    const compressedSize = buf.readUInt32LE(cursor + 18);
    const nameLen = buf.readUInt16LE(cursor + 26);
    const extraLen = buf.readUInt16LE(cursor + 28);
    const name = buf.slice(cursor + 30, cursor + 30 + nameLen).toString('utf-8');
    const dataStart = cursor + 30 + nameLen + extraLen;
    if (dataStart + compressedSize > buf.length) break;
    const data = buf.slice(dataStart, dataStart + compressedSize);
    const isDir = name.endsWith('/');
    entries.push({ name, method, compressedSize, data, isDir });
    cursor = dataStart + compressedSize;
  }
  return entries;
}
