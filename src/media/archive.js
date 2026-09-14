// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { MAX_DOWNLOAD_BYTES, SUPPORTED_MEDIA, mediaTypeOf, safeFilename } from './formats.js';
import { readLimited } from './stream.js';

const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_ENTRIES = 256;
function fail() { throw new Error('Unsafe or unsupported ZIP archive.'); }
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function inspectZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22 || bytes.length > MAX_DOWNLOAD_BYTES) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== bytes.length)) end--;
  if (end < Math.max(0, bytes.length - 65557)) fail();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count > MAX_ENTRIES || start + size !== end) fail();
  let at = start, total = 0;
  const entries = [], seen = new Set(), ranges = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) fail();
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true), compressed = view.getUint32(at + 20, true), expanded = view.getUint32(at + 24, true);
    const nameSize = view.getUint16(at + 28, true), extraSize = view.getUint16(at + 30, true), commentSize = view.getUint16(at + 32, true);
    const mode = view.getUint32(at + 38, true) >>> 16, local = view.getUint32(at + 42, true);
    if (at + 46 + nameSize + extraSize + commentSize > end || view.getUint16(at + 34, true) !== 0 || (flags & ~0x808) || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000) fail();
    const rawName = bytes.subarray(at + 46, at + 46 + nameSize);
    const path = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    if (!path || /[\\:\u0000-\u001f]/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.') || seen.has(path.toLowerCase())) fail();
    seen.add(path.toLowerCase());
    total += expanded;
    if (total > MAX_EXPANDED || expanded > MAX_DOWNLOAD_BYTES || expanded > Math.max(1, compressed) * 100 || compressed === 0xffffffff || expanded === 0xffffffff) fail();
    if (local + 30 > start || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) fail();
    const localNameSize = view.getUint16(local + 26, true), dataAt = local + 30 + localNameSize + view.getUint16(local + 28, true);
    if (localNameSize !== nameSize || dataAt + compressed > start) fail();
    if (!rawName.every((v, j) => bytes[local + 30 + j] === v)) fail();
    if (!(flags & 8) && (view.getUint32(local + 14, true) !== crc || view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== expanded)) fail();
    if (ranges.some(([lo, hi]) => local < hi && dataAt + compressed > lo)) fail();
    ranges.push([local, dataAt + compressed]);
    if (method === 0 && compressed !== expanded) fail();
    const type = mediaTypeOf(path);
    if (!path.endsWith('/') && SUPPORTED_MEDIA.includes(type)) {
      entries.push({ name: safeFilename(path), path, mediaType: type, size: expanded,
        async extract(signal, onProgress) {
          signal?.throwIfAborted();
          const input = bytes.slice(dataAt, dataAt + compressed);
          let output = input;
          if (method === 8) {
            let stream;
            try { stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
            catch { throw new Error('This browser cannot unpack deflated ZIP files. Download an individual media file instead.'); }
            output = await readLimited(new Response(stream), Math.min(expanded, MAX_DOWNLOAD_BYTES), signal, { onProgress, expectedSize: expanded });
          }
          signal?.throwIfAborted();
          if (output.length !== expanded || crc32(output) !== crc) throw new Error('ZIP file failed its size or CRC check.');
          if (method === 0) onProgress?.({ loaded: output.length, total: expanded, done: true });
          return output;
        },
      });
    }
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end) fail();
  return entries;
}
