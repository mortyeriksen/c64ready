// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/collage.mjs — one sheet from a whole `run --all`: every program's shot in
// a grid, captioned from the C64's own character ROM. A still run tiles the
// final screens into a PNG; an --anim run tiles the films into one animated PNG,
// each cell playing its own and held on its last frame once it ends.
//
// It composes on the framebuffer, never by reading a PNG back, so it needs no
// image library — the same reason png.mjs writes its own.

import zlib from 'node:zlib';
import { writePng, Apng } from './png.mjs';

const COLS = 4;                                  // tiles per row
const PAD = 6;                                   // gap around each tile
const LABEL_H = 10;                              // room under a tile for its name
const rgb = (r, g, b) => (r | (g << 8) | (b << 16)) >>> 0;   // the framebuffer's own layout
const INK = rgb(0x9d, 0x93, 0xe4);
const PAPER = rgb(0x2b, 0x2b, 0x2b);

/** Copy a w×h tile framebuffer into the sheet at (x0, y0). */
function blit(sheet, sheetW, tile, w, h, x0, y0) {
  for (let y = 0; y < h; y++) {
    sheet.set(tile.subarray(y * w, y * w + w), (y0 + y) * sheetW + x0);
  }
}

/** A program's name under its tile, in the char ROM's own glyphs. */
function caption(sheet, sheetW, chargen, text, x0, y0) {
  const code = (ch) => {
    const c = ch.toUpperCase();
    if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 64;
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48 + 48;
    return { ' ': 32, '.': 46, '-': 45, '/': 47, '+': 43, '(': 40, ')': 41 }[c] ?? 42;
  };
  for (let i = 0; i < text.length; i++) {
    const glyph = code(text[i]) * 8;
    for (let row = 0; row < 8; row++) {
      const bits = chargen[glyph + row];
      for (let col = 0; col < 8; col++) {
        if (!(bits & (0x80 >> col))) continue;
        sheet[(y0 + row) * sheetW + x0 + i * 8 + col] = INK;
      }
    }
  }
}

/**
 * A film's frames reconstructed into full screens one tick at a time, so tiling
 * several films costs one screen buffer apiece rather than every frame of every
 * film at once. The Apng stores each frame as the rectangle that changed; this
 * lays those back down onto a running screen.
 */
class Cursor {
  constructor(film, w, h) {
    this.frames = film.frames;                   // { x, y, w, h, holds, data }
    this.w = w;
    this.buf = new Uint32Array(w * h);
    this.i = -1;
    this.hold = 0;
  }
  ticks() { return this.frames.reduce((n, f) => n + f.holds, 0); }
  step() {
    if (this.hold <= 0) {
      this.i++;
      if (this.i < this.frames.length) {
        this._apply(this.frames[this.i]);
        this.hold = this.frames[this.i].holds;
      } else {
        this.hold = Infinity;                    // past the end: hold the last screen
      }
    }
    this.hold--;
    return this.buf;
  }
  _apply(fr) {
    const raw = zlib.inflateSync(fr.data);       // rows of [filter 0][R G B]×w
    let ri = 0;
    for (let row = 0; row < fr.h; row++) {
      ri++;                                      // the per-row filter byte, always 0
      let at = (fr.y + row) * this.w + fr.x;
      for (let col = 0; col < fr.w; col++) {
        this.buf[at++] = (raw[ri] | (raw[ri + 1] << 8) | (raw[ri + 2] << 16)) >>> 0;
        ri += 3;
      }
    }
  }
}

const nameFor = s => (String(s).trim() || 'PROGRAM').toUpperCase();

function layout(n, tileW, tileH) {
  const cols = Math.min(COLS, n);
  const rows = Math.ceil(n / cols);
  const W = cols * (tileW + PAD) + PAD;
  const H = rows * (tileH + LABEL_H + PAD) + PAD;
  const at = i => ({
    x: PAD + (i % cols) * (tileW + PAD),
    y: PAD + Math.floor(i / cols) * (tileH + LABEL_H + PAD),
  });
  return { W, H, at };
}

/**
 * The sheet, written to `out`.
 * @param {string} out
 * @param {Array<{name: string, film?: object, fb?: Uint32Array}>} tiles  a
 *   film per tile for an --anim run, a final framebuffer otherwise
 * @param {object} o  { tileW, tileH, chargen, anim, fps }
 */
export function writeCollage(out, tiles, { tileW, tileH, chargen, anim, fps }) {
  const { W, H, at } = layout(tiles.length, tileW, tileH);
  const label = (sheet, i) => caption(sheet, W, chargen,
    nameFor(tiles[i].name).slice(0, Math.floor(tileW / 8)), at(i).x + 2, at(i).y + tileH + 1);

  if (!anim) {
    const sheet = new Uint32Array(W * H).fill(PAPER);
    tiles.forEach((t, i) => {
      const { x, y } = at(i);
      blit(sheet, W, t.fb, tileW, tileH, x, y);
      label(sheet, i);
    });
    writePng(out, sheet, W, H);
    return;
  }

  const cursors = tiles.map(t => new Cursor(t.film, tileW, tileH));
  const maxTicks = Math.max(1, ...cursors.map(c => c.ticks()));
  const sheet = new Uint32Array(W * H).fill(PAPER);
  const film = new Apng(W, H, fps);
  for (let tick = 0; tick < maxTicks; tick++) {
    tiles.forEach((t, i) => {
      const { x, y } = at(i);
      blit(sheet, W, cursors[i].step(), tileW, tileH, x, y);
      // Captions do not move, so they are drawn once and left standing under the
      // tiles the later ticks keep repainting.
      if (tick === 0) label(sheet, i);
    });
    film.add(sheet);
  }
  film.write(out);
}
