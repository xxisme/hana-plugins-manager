/**
 * lib/zip-native.js — 纯 Node 内置 zip 解压器
 *
 * 零依赖：只用 node:zlib。支持 STORED(0) 与 DEFLATE(8) 两种压缩方法；
 * 不支持加密/分卷/spanned。防 zip-slip（拒绝路径越界）。
 *
 * 解析策略：优先从 central directory（CD）读取条目——这是唯一可靠的来源。
 * 流式写入的 zip（QQ/微信/浏览器下载常见）在 local header 里 compressedSize=0，
 * 靠 data descriptor 记录真实大小；只有 CD 里才写真实值。仅当文件完全没有
 * CD（极简 zip）时兜底遍历 local headers。
 */
'use strict';

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

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
    // 真损坏/截断的 zip：明确报错，不静默写出空文件
    if (entry.truncated) {
      throw new Error(`zip 数据不完整（文件可能损坏或下载未完成）: ${entry.name}`);
    }
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
  // 1) 优先 central directory：能拿到每个条目的真实大小与 local header 偏移
  const eocd = findEOCD(buf);
  if (eocd !== -1) {
    const entryCount = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    // 0xffff 是 zip64 标记（本实现不支持 zip64，回退 local 遍历；normal zip 不会触发）
    if (entryCount > 0 && entryCount < 0xffff
      && cdOffset + 46 <= buf.length
      && buf.readUInt32LE(cdOffset) === CENTRAL_HEADER_SIG) {
      return parseCentralDirectory(buf, cdOffset, entryCount);
    }
  }
  // 2) 兜底：遍历 local headers（无 CD 的极简 zip）
  return parseLocalHeaders(buf);
}

/** 从文件尾部找 EOCD 记录（zip 注释最长 65535，向前扫描即可） */
function findEOCD(buf) {
  const minLen = 22;
  if (buf.length < minLen) return -1;
  const maxScan = Math.min(buf.length, minLen + 65535);
  for (let i = buf.length - minLen; i >= buf.length - maxScan; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 从 central directory 解析全部条目。
 * 每个 CD entry 头部 46 bytes，其后跟 name/extra/comment；字段布局见 zip 规范。
 */
function parseCentralDirectory(buf, cdOffset, count) {
  const entries = [];
  let cursor = cdOffset;
  for (let i = 0; i < count && cursor + 46 <= buf.length; i++) {
    const sig = buf.readUInt32LE(cursor);
    if (sig !== CENTRAL_HEADER_SIG) break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf-8');

    // 按 CD 里的真实大小，去 local header 处取压缩数据（local 的 size 可能是 0）
    const data = readLocalData(buf, localOffset, compressedSize);
    entries.push({
      name,
      method,
      compressedSize,
      data: data || Buffer.alloc(0),
      isDir: name.endsWith('/'),
      truncated: data === null,
    });

    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 定位 local header 后的数据区（local header 的 nameLen/extraLen 决定偏移） */
function readLocalData(buf, localOffset, compressedSize) {
  if (localOffset + 30 > buf.length) return null;
  if (buf.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) return null;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  if (dataStart + compressedSize > buf.length) return null;
  return buf.slice(dataStart, dataStart + compressedSize);
}

/** 兜底：无 CD 的极简 zip，遍历 local headers（遇到 CD 或数据越界即停） */
function parseLocalHeaders(buf) {
  const entries = [];
  let cursor = 0;
  while (cursor + 30 <= buf.length) {
    const sig = buf.readUInt32LE(cursor);
    if (sig !== LOCAL_HEADER_SIG) break;
    const method = buf.readUInt16LE(cursor + 8);
    const compressedSize = buf.readUInt32LE(cursor + 18);
    const nameLen = buf.readUInt16LE(cursor + 26);
    const extraLen = buf.readUInt16LE(cursor + 28);
    const name = buf.slice(cursor + 30, cursor + 30 + nameLen).toString('utf-8');
    const dataStart = cursor + 30 + nameLen + extraLen;
    if (dataStart + compressedSize > buf.length) break;
    const data = buf.slice(dataStart, dataStart + compressedSize);
    entries.push({ name, method, compressedSize, data, isDir: name.endsWith('/'), truncated: false });
    cursor = dataStart + compressedSize;
  }
  return entries;
}
