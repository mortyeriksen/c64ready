// Reusable VICE-reference pixel comparison.
//
// Renders a .prg in our emulator and compares the framebuffer against a
// VICE reference PNG. We build this kind of check constantly (dentest,
// border, colorsplit, FLI, …) so it lives here as a shared tool rather
// than a throwaway investigation script.
//
// KEY GOTCHAS this tool handles for you:
//   1. PALETTE. VICE reference PNGs (the testprogs `references/` dirs)
//      are rendered with the *Pepto* PAL palette; we render with
//      *Colodore*. A raw RGB diff is therefore ~95% "different" even on a
//      pixel-perfect screen. So we quantize BOTH images to their own
//      16-colour palette and compare colour INDICES — palette-independent,
//      measures structure/timing only.
//   2. CROP / 1-LINE OFFSET. VICE PNG row 0 = raster 16, ours = raster 15
//      (and similar small shifts). We search dx,dy in [-2..2] and report
//      the best alignment. A residual of exactly CANVAS_W px (one row)
//      at dy=±1 means "pixel-perfect modulo the known 1-line crop".
//
// No external deps: uses the in-repo zero-dep PNG decoder.
//
// CLI:
//   node test/ref-compare.mjs <prg> <refPng> [boot=200] [run=80] [refPalette=pepto|colodore]
// Programmatic:
//   import { renderPrg, compareToReference } from './ref-compare.mjs';

import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { CANVAS_W, CANVAS_H, C64_PALETTE } from '../src/vic2.js';
import { decodePNG } from './png-decoder.mjs';

// VICE "Pepto" PAL palette — what the committed reference PNGs use.
export const PEPTO_PALETTE = [
  0x000000, 0xFFFFFF, 0x68372B, 0x70A4B2, 0x6F3D86, 0x588D43, 0x352879, 0xB8C76F,
  0x6F4F25, 0x433900, 0x9A6759, 0x444444, 0x6C6C6C, 0x9AD284, 0x6C5EB5, 0x959595,
];
const toRGB = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

const ROMS = {
  kernal: 'roms/kernal.bin', basic: 'roms/basic.bin', charRom: 'roms/chargen.bin',
};

// Boot the KERNAL, load+run a PRG, advance `run` frames; return the RGBA
// framebuffer (Uint8, CANVAS_W*CANVAS_H*4).
export function renderPrg(prgPath, { boot = 200, run = 80 } = {}) {
  const m = new C64Machine();
  m.loadROMs({
    kernal: fs.readFileSync(ROMS.kernal),
    basic: fs.readFileSync(ROMS.basic),
    charRom: fs.readFileSync(ROMS.charRom),
  });
  m.reset();
  for (let i = 0; i < boot; i++) m.runFrame();
  m.loadPRG(fs.readFileSync(prgPath));
  m.injectRun();
  for (let i = 0; i < run; i++) m.runFrame();
  return m.vic2.frameBuffer;
}

// Quantize an RGBA byte buffer to a Uint8 colour-index map using `palette`
// (array of 0xRRGGBB ints). Returns { idx, maxErr } where maxErr is the
// worst squared distance (a sanity check that the palette actually fits).
export function indexMap(rgba, palette = C64_PALETTE) {
  const pal = palette.map(toRGB);
  const idx = new Uint8Array(CANVAS_W * CANVAS_H);
  let maxErr = 0;
  for (let p = 0; p < idx.length; p++) {
    const r = rgba[p * 4], g = rgba[p * 4 + 1], b = rgba[p * 4 + 2];
    let bi = 0, bd = 1e9;
    for (let i = 0; i < 16; i++) {
      const q = pal[i];
      const dr = r - q[0], dg = g - q[1], db = b - q[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; bi = i; }
    }
    idx[p] = bi;
    if (bd > maxErr) maxErr = bd;
  }
  return { idx, maxErr };
}

function diffAt(a, b, dx, dy) {
  let n = 0;
  for (let y = 0; y < CANVAS_H; y++) {
    const sy = y + dy;
    if (sy < 0 || sy >= CANVAS_H) { n += CANVAS_W; continue; }
    for (let x = 0; x < CANVAS_W; x++) {
      const sx = x + dx;
      if (sx < 0 || sx >= CANVAS_W) { n++; continue; }
      if (a[sy * CANVAS_W + sx] !== b[y * CANVAS_W + x]) n++;
    }
  }
  return n;
}

// Compare a rendered framebuffer (RGBA) to a reference PNG path. Returns
// { diff, pct, dx, dy, total, refQuantErr } at the best small-offset
// alignment, in palette-independent colour-index space.
export function compareToReference(oursRgba, refPngPath, {
  refPalette = PEPTO_PALETTE, search = 2,
} = {}) {
  const png = decodePNG(fs.readFileSync(refPngPath));
  if (png.w !== CANVAS_W || png.h !== CANVAS_H) {
    throw new Error(`ref PNG ${png.w}x${png.h} != canvas ${CANVAS_W}x${CANVAS_H}`);
  }
  // decodePNG returns packed channels; expand to RGBA-stride for indexMap.
  const ch = png.channels, refRgba = new Uint8Array(CANVAS_W * CANVAS_H * 4);
  for (let p = 0; p < CANVAS_W * CANVAS_H; p++) {
    refRgba[p * 4] = png.pixels[p * ch];
    refRgba[p * 4 + 1] = png.pixels[p * ch + 1];
    refRgba[p * 4 + 2] = png.pixels[p * ch + 2];
  }
  const ours = indexMap(oursRgba, C64_PALETTE).idx;
  const ref = indexMap(refRgba, refPalette);
  let best = { diff: Infinity, dx: 0, dy: 0 };
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      const n = diffAt(ours, ref.idx, dx, dy);
      if (n < best.diff) best = { diff: n, dx, dy };
    }
  }
  const total = CANVAS_W * CANVAS_H;
  return { ...best, pct: 100 * best.diff / total, total, refQuantErr: Math.round(Math.sqrt(ref.maxErr)) };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [prg, ref, boot, run, refPal] = process.argv.slice(2);
  if (!prg || !ref) {
    console.error('usage: node test/ref-compare.mjs <prg> <refPng> [boot=200] [run=80] [refPalette=pepto|colodore]');
    process.exit(2);
  }
  const palette = refPal === 'colodore' ? C64_PALETTE : PEPTO_PALETTE;
  const fb = renderPrg(prg, { boot: boot ? +boot : 200, run: run ? +run : 80 });
  const r = compareToReference(fb, ref, { refPalette: palette });
  const oneRow = CANVAS_W;
  const verdict = r.diff === 0 ? 'EXACT'
    : (r.diff <= oneRow && Math.abs(r.dy) === 1) ? 'PERFECT (1-line crop offset)'
    : r.diff < 2000 ? 'CLOSE' : 'DIFF';
  console.log(`diff=${r.diff}px (${r.pct.toFixed(3)}%)  bestoff dx=${r.dx} dy=${r.dy}  refQuantErr=${r.refQuantErr}  → ${verdict}`);
  process.exit(r.diff <= oneRow ? 0 : 1);
}
