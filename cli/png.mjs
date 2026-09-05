// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/png.mjs — the machine's framebuffer written out as a PNG, with nothing
// but zlib and a CRC. The same encoder the repo's screenshot harnesses use, so
// `run` and the reference harness produce byte-identical files.
//
// Apng films a run rather than photographing it: each captured screen becomes
// an animation frame, carrying only the rectangle that changed. An APNG is a
// PNG, so the file keeps its name and its extension, and the still inside it —
// the one a viewer that knows nothing of APNG shows — is the final screen,
// exactly the image a still run would have written.

import fs from 'node:fs';
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function ihdrChunk(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                      // 8-bit RGB
  return chunk('IHDR', ihdr);
}

/** Unfiltered RGB scanlines for one rectangle of an ABGR framebuffer. */
function scanlines(fb32, stride, { x, y, w, h }) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let ri = 0;
  for (let row = y; row < y + h; row++) {
    raw[ri++] = 0;                               // filter: none
    for (let col = x; col < x + w; col++) {
      const px = fb32[row * stride + col] >>> 0;
      raw[ri++] = px & 0xFF;
      raw[ri++] = (px >> 8) & 0xFF;
      raw[ri++] = (px >> 16) & 0xFF;
    }
  }
  return raw;
}

/** The box around every pixel that differs, or null when nothing moved. */
function changedRect(before, after, stride) {
  const h = before.length / stride;
  let x0 = stride, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      if (before[row + x] === after[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * @param {string} name  output path
 * @param {Uint32Array} fb32  ABGR pixels, as vic2 keeps them
 * @param {number} w @param {number} h
 */
export function writePng(name, fb32, w, h) {
  fs.writeFileSync(name, Buffer.concat([
    SIGNATURE,
    ihdrChunk(w, h),
    chunk('IDAT', zlib.deflateSync(scanlines(fb32, w, { x: 0, y: 0, w, h }))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

const DELAY_DEN = 1000;                          // delays are counted in milliseconds
const MAX_DELAY = 0xFFFF;                        // …and the field holding them is 16 bits

/** An animated PNG, gathered frame by frame while the machine runs. */
export class Apng {
  /** @param {number} w @param {number} h @param {number} fps  playback rate */
  constructor(w, h, fps) {
    this.w = w;
    this.h = h;
    this.delay = Math.max(1, Math.round(DELAY_DEN / fps));
    this.frames = [];                            // { x, y, w, h, holds, data }
    this.screen = null;                          // the last screen added, as it stands
    this.captured = 0;
  }

  /** One screen. The buffer is copied — the machine goes on drawing into it. */
  add(fb32) {
    this.captured++;
    const whole = { x: 0, y: 0, w: this.w, h: this.h };
    const rect = this.screen ? changedRect(this.screen, fb32, this.w) : whole;
    // A screen the machine left alone holds the frame before it rather than
    // repeating it — until the delay field runs out of room, and then a single
    // pixel carries the rest of the wait.
    if (!rect) {
      const held = this.frames[this.frames.length - 1];
      if (held && (held.holds + 1) * this.delay <= MAX_DELAY) { held.holds++; return; }
    }
    const box = rect ?? { x: 0, y: 0, w: 1, h: 1 };
    this.frames.push({ ...box, holds: 1, data: zlib.deflateSync(scanlines(fb32, this.w, box)) });
    this.screen = fb32.slice();
  }

  write(name) {
    if (!this.frames.length) throw new Error('the film is empty — nothing was captured');
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(this.frames.length, 0);   // num_frames
    actl.writeUInt32BE(0, 4);                    // num_plays: forever
    const parts = [
      SIGNATURE,
      ihdrChunk(this.w, this.h),
      chunk('acTL', actl),
      // The default image stands outside the animation, so it can be the final
      // screen rather than the first: what a still run would have written.
      chunk('IDAT', zlib.deflateSync(scanlines(this.screen, this.w, { x: 0, y: 0, w: this.w, h: this.h }))),
    ];
    let seq = 0;
    for (const f of this.frames) {
      const fctl = Buffer.alloc(26);
      fctl.writeUInt32BE(seq++, 0);              // sequence_number
      fctl.writeUInt32BE(f.w, 4);
      fctl.writeUInt32BE(f.h, 8);
      fctl.writeUInt32BE(f.x, 12);
      fctl.writeUInt32BE(f.y, 16);
      fctl.writeUInt16BE(f.holds * this.delay, 20);   // delay_num
      fctl.writeUInt16BE(DELAY_DEN, 22);              // delay_den
      fctl[24] = 0;                                   // dispose: leave the frame standing
      fctl[25] = 0;                                   // blend: the rectangle is replaced
      const fdat = Buffer.alloc(4 + f.data.length);
      fdat.writeUInt32BE(seq++, 0);
      f.data.copy(fdat, 4);
      parts.push(chunk('fcTL', fctl), chunk('fdAT', fdat));
    }
    parts.push(chunk('IEND', Buffer.alloc(0)));
    fs.writeFileSync(name, Buffer.concat(parts));
  }
}
