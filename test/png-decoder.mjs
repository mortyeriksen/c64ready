// Minimal PNG decoder supporting RGB/RGBA color types with all 5
// scanline filters (None/Sub/Up/Avg/Paeth). Returns
// { w, h, channels, pixels (Uint8Array of raw RGB/RGBA bytes) }.

import fs from 'fs';
import zlib from 'zlib';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  let p = 8;
  let w, h, bitDepth, colorType, channels;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); p += 4;
    const type = buf.toString('ascii', p, p + 4); p += 4;
    const data = buf.slice(p, p + len);
    p += len + 4;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      // colorType 2=RGB (3 channels), 6=RGBA (4 channels)
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`unsupported color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const pixels = new Uint8Array(w * h * channels);
  let rawOff = 0, pxOff = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rawOff++];
    const row = pixels.subarray(pxOff, pxOff + stride);
    const prev = y > 0 ? pixels.subarray(pxOff - stride, pxOff) : null;
    for (let i = 0; i < stride; i++) {
      const x = raw[rawOff + i];
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= channels) ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = (x + a) & 0xFF; break;
        case 2: v = (x + b) & 0xFF; break;
        case 3: v = (x + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: v = (x + paeth(a, b, c)) & 0xFF; break;
        default: throw new Error(`unknown filter ${filter} on row ${y}`);
      }
      row[i] = v;
    }
    rawOff += stride;
    pxOff += stride;
  }
  return { w, h, channels, pixels };
}

// Convert decoded PNG to Uint32Array fb32 (ABGR little-endian, matches
// our impl's vic2.fb32 format).
export function pngToFb32(png) {
  const { w, h, channels, pixels } = png;
  const fb = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * channels;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    fb[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return fb;
}
