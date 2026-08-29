// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vic2-tables.js – VIC-II shared constants and lookup tables: the colour
// palettes (+ the live PALETTE_RGBA table), canvas/display geometry, PAL
// timing, and the precomputed sprite p/s-access cycle maps. Leaf module
// (no imports) shared by the vic2 chip files; vic2.js re-exports the
// public names so importers of vic2.js are unchanged.


// Authentic C64 color palettes. The renderer reads from PALETTE_RGBA (below);
// setVicPalette(name) swaps the active palette at runtime by recomputing that
// table in place, so a switch takes full effect within one rendered frame.
//
//   colodore — Colodore (the modern VICE default; sharper, more saturated)
//   pepto    — Pepto "PAL" (the classic 2001 measurement-based palette)
//
// Default is Colodore to preserve the established look (the reference demos are
// byte-identical against it).
export const PALETTES = Object.freeze({
  colodore: [
    0x000000, // 0  Black
    0xFFFFFF, // 1  White
    0x813338, // 2  Red
    0x75CEC8, // 3  Cyan
    0x8E3C97, // 4  Purple
    0x56AC4D, // 5  Green
    0x2E2C9B, // 6  Blue
    0xEDF171, // 7  Yellow
    0x8E5029, // 8  Orange
    0x553800, // 9  Brown
    0xC46C71, // 10 Light Red
    0x4A4A4A, // 11 Dark Gray
    0x7B7B7B, // 12 Medium Gray
    0xA9FF9F, // 13 Light Green
    0x706DEB, // 14 Light Blue
    0xB2B2B2, // 15 Light Gray
  ],
  pepto: [
    0x000000, // 0  Black
    0xFFFFFF, // 1  White
    0x68372B, // 2  Red
    0x70A4B2, // 3  Cyan
    0x6F3D86, // 4  Purple
    0x588D43, // 5  Green
    0x352879, // 6  Blue
    0xB8C76F, // 7  Yellow
    0x6F4F25, // 8  Orange
    0x433900, // 9  Brown
    0x9A6759, // 10 Light Red
    0x444444, // 11 Dark Gray
    0x6C6C6C, // 12 Medium Gray
    0x9AD284, // 13 Light Green
    0x6C5EB5, // 14 Light Blue
    0x959595, // 15 Light Gray
  ],
});

// Ordered name list for the UI toggle button (single source of truth).
export const PALETTE_NAMES = Object.freeze(['colodore', 'pepto']);

// The active palette. `let` (not const) so setVicPalette can repoint it; the
// ES-module live binding means importers always see the current palette.
export let C64_PALETTE = PALETTES.colodore;
let activePaletteName = 'colodore';

// Canvas dimensions
export const CANVAS_W = 384;
export const CANVAS_H = 272;

// VIC-II variants — single source of truth. main.js imports these for the UI
// toggle + localStorage so the model strings never drift from the chip model
// the setter compares against.
export const VIC_VARIANT = Object.freeze({
  V6569:   '6569',     // original PAL NMOS (breadbin C64)
  V8565:   '8565',     // late PAL HMOS (C64C/C128) — 1-cycle register-pipeline delay
});
// Cycle order for the UI toggle button.
export const VIC_VARIANTS = Object.freeze([
  VIC_VARIANT.V6569, VIC_VARIANT.V8565,
]);
// Active display area within canvas
export const DISPLAY_X = 32;
export const DISPLAY_Y = 36;
export const DISPLAY_W = 320;
export const DISPLAY_H = 200;
// Horizontal graphics window. The display occupies canvas X 32..351 (320 px
// wide). _getHorizontalGraphicsWindow used to return a fresh {start,end}
// object per call — these constants replace it for hot-path readers.
export const GRAPHICS_WINDOW_START = 32;
export const GRAPHICS_WINDOW_END = 352;

// PAL timing
export const CYCLES_PER_LINE = 63;
export const LINES_PER_FRAME = 312;
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES_PER_FRAME; // 19656

// Static cycle→sprite-index maps. Both are pure functions of the in-line
// cycle (the sprite p- and s-access slots are fixed by the chip schedule),
// so precompute them once instead of re-deriving the branch/switch on every
// call — these are hit many times per cycle from the BA / sprite dispatch
// (_spriteBaLow alone does 4 lookahead lookups). Index 0 and any non-access
// cycle map to -1, matching the original functions' default return.
export const SPRITE_PTR_ACCESS = new Int8Array(CYCLES_PER_LINE + 1).fill(-1);
export const SPRITE_ROW_ACCESS = new Int8Array(CYCLES_PER_LINE + 1).fill(-1);
for (let c = 1; c <= 9; c += 2) SPRITE_PTR_ACCESS[c] = 3 + ((c - 1) >> 1);
SPRITE_PTR_ACCESS[58] = 0; SPRITE_PTR_ACCESS[60] = 1; SPRITE_PTR_ACCESS[62] = 2;
for (let c = 2; c <= 10; c += 2) SPRITE_ROW_ACCESS[c] = 2 + (c >> 1);
SPRITE_ROW_ACCESS[59] = 0; SPRITE_ROW_ACCESS[61] = 1; SPRITE_ROW_ACCESS[63] = 2;

// Reverse map sprite index -> its p-access (pointer fetch) cycle. Used to
// detect the "late DMA start" open-bus first byte (testprogs/VICII/
// spriteenable core2): byte 0's data fetch sits one half-cycle after the
// p-access, so a sprite whose DMA starts fewer than 3 cycles before its
// p-access never gets BA/AEC low in time for that first byte.
export const SPRITE_PTR_CYCLE = new Int8Array(8).fill(-1);
for (let c = 1; c <= CYCLES_PER_LINE; c++) {
  if (SPRITE_PTR_ACCESS[c] >= 0) SPRITE_PTR_CYCLE[SPRITE_PTR_ACCESS[c]] = c;
}

// Per-base-cycle BA-low candidate sprites. _spriteBaLow scans a 4-cycle
// lookahead window (cycle..cycle+3, wrapped) for ANY enabled sprite's p- or
// s-access. The SET of sprites with an access in that window is a pure function
// of the base cycle, so precompute it once — at runtime _spriteBaLow only walks
// the (usually empty) candidate list against the live spriteDmaOn[], with no
// per-call wrap arithmetic or access-table lookups. Indexed by
// `cycle + SPRITE_BA_BASE` to cover the negative cycles that reach _spriteBaLow
// via _isBaLowCycle(cycle - 3) (min cycle = -2). Built with the EXACT same
// _wrapLineCycle + access-table logic it replaces, so it is behaviour-identical
// across the whole call domain (out-of-range → empty list → false, as before).
export const SPRITE_BA_BASE = 3;
export const SPRITE_BA_CANDIDATES = [];
{
  const wrap = (c) => (c < 1) ? c + CYCLES_PER_LINE : (c > CYCLES_PER_LINE ? c - CYCLES_PER_LINE : c);
  const access = (tab, c) => (c >= 0 && c <= CYCLES_PER_LINE) ? tab[c] : -1;
  for (let i = 0; i < CYCLES_PER_LINE + SPRITE_BA_BASE + 4; i++) {
    const base = i - SPRITE_BA_BASE;
    let mask = 0;
    for (let la = 0; la <= 3; la++) {
      const wc = wrap(base + la);
      const sRow = access(SPRITE_ROW_ACCESS, wc); if (sRow >= 0) mask |= (1 << sRow);
      const sPtr = access(SPRITE_PTR_ACCESS, wc); if (sPtr >= 0) mask |= (1 << sPtr);
    }
    const list = [];
    for (let s = 0; s < 8; s++) if (mask & (1 << s)) list.push(s);
    SPRITE_BA_CANDIDATES[i] = new Int8Array(list);
  }
}

// Pre-compute RGBA palette for fast fill. Recomputed in place by
// setVicPalette() so every PALETTE_RGBA reader picks up a runtime swap.
// Int32Array (signed), NOT Uint32Array: the ARGB entries have bit 31 set
// (0xFF000000 alpha), so a Uint32Array read yields a value > 2^31 that V8
// boxes as a HeapNumber. As signed int32 every read is a Smi, so the hot
// per-pixel comparisons (pxVal === segBg0) and assignments stay unboxed.
// Bits are identical when written into the Uint32 fb32 canvas view (the
// `0xFF000000 | …` store already produces a signed int32).
export const PALETTE_RGBA = new Int32Array(16);
function _recomputePaletteRgba() {
  for (let i = 0; i < 16; i++) {
    const c = C64_PALETTE[i];
    // RGBA in little-endian: ABGR
    PALETTE_RGBA[i] = 0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
  }
}
_recomputePaletteRgba();

// Switch the active C64 palette at runtime. Returns true if `name` is a known
// palette (see PALETTE_NAMES). PALETTE_RGBA is rewritten in place, so the swap
// is visible on the next rendered frame without re-creating the machine. The
// choice is module-level state, so it also survives RESET / POWER cycling.
export function setVicPalette(name) {
  if (!PALETTES[name]) return false;
  activePaletteName = name;
  C64_PALETTE = PALETTES[name];
  _recomputePaletteRgba();
  return true;
}
export function getVicPalette() { return activePaletteName; }

export const ACCESS_IDLE = 0;
export const ACCESS_REFRESH = 1;
export const ACCESS_C = 2;
export const ACCESS_G = 3;
