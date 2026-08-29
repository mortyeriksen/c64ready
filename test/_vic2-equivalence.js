// Shared harness for the render-equivalence spec tests: a VIC with non-trivial
// screen/character memory, one full PAL frame driven cycle by cycle with a
// per-cycle write schedule, and a byte-for-byte framebuffer compare.
import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

/** A 6569 with RAM, colour RAM, character ROM and the standard register set. */
export function newVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  for (let i = 0; i < 0x0400; i++) { vic.ram[0x0400 + i] = (i * 7) & 0xFF; vic.colorRam[i] = (i * 3) & 0x0F; }
  for (let i = 0; i < 0x1000; i++) vic.charRom[i] = (i * 13 + 1) & 0xFF;
  vic.regs[0x11] = 0x1B;     // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;     // CSEL=1
  vic.regs[0x18] = 0x14;     // screen $0400, char $1000
  vic.regs[0x20] = 0x00; vic.regs[0x21] = 0x06; vic.regs[0x22] = 0x09;
  vic.regs[0x23] = 0x0A; vic.regs[0x24] = 0x0B;
  vic.displayEnabled = true;
  return vic;
}

/** Eight sprites with dense data, spread in Y, at the given X positions. */
export function placeSprites(vic, xs) {
  for (let s = 0; s < 8; s++) {
    vic.ram[0x07F8 + s] = 0x20 + s;                       // pointer → block (0x20+s)*64
    const base = (0x20 + s) * 64;
    for (let b = 0; b < 63; b++) vic.ram[base + b] = (s * 37 + b * 11) & 0xFF;
    vic.regs[0x00 + s * 2] = xs[s] & 0xFF;
    vic.regs[0x27 + s] = (s + 1) & 0x0F;
  }
  let msb = 0;
  for (let s = 0; s < 8; s++) if (xs[s] > 255) msb |= 1 << s;
  vic.regs[0x10] = msb;
  vic.regs[0x15] = 0xFF;     // all enabled
  vic.regs[0x25] = 0x07; vic.regs[0x26] = 0x0D;           // sprite multicolour regs
}

/**
 * Drive one full frame. `onCycle(vic, raster, cycle)` runs before each clock so a
 * test can issue phi2 writes at (raster, cycle). Returns a copy of the framebuffer.
 */
export function runFrame(vic, onCycle) {
  const maxSteps = 314 * CYCLES_PER_LINE;
  for (let step = 0; step < maxSteps; step++) {
    const r = vic.raster, c = vic.cycleInLine;
    onCycle(vic, r, c);
    vic.clock(1);
    if (r === 311 && vic.raster === 0) break;
  }
  return Uint32Array.from(vic.fb32);
}

/** The mid-line write schedule every equivalence test uses on rasters 50..250. */
export function standardWrites(vic, r, c) {
  if (r < 50 || r > 250) return;
  if (c === 12 + (r % 46)) vic.write(0x21, (r * 7) & 0x0F);   // bg0 swept across cy 12..57
  if (c === 50 && (r % 4) === 0) vic.write(0x22, r & 0x0F);   // bg1
  if (c === 18 && (r % 3) === 0) vic.write(0x11, vic.regs[0x11] ^ 0x20); // toggle BMM
  if (c === 44 && (r % 5) === 0) vic.write(0x16, vic.regs[0x16] ^ 0x10); // toggle MCM
}

/** Pushes one failure message onto `fails` unless the two frames are identical. */
export function compareFrames(expect, label, a, b) {
  if (a.length !== b.length) { expect(false, `${label}: length ${a.length} vs ${b.length}`); return; }
  let diffs = 0, fX = -1, fY = -1, av = 0, bv = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { if (diffs === 0) { fX = i % CANVAS_W; fY = (i / CANVAS_W) | 0; av = a[i]; bv = b[i]; } diffs++; }
  }
  expect(diffs === 0,
    `${label}: ${diffs} px differ; first x=${fX} y=${fY}: off=0x${(av >>> 0).toString(16)} on=0x${(bv >>> 0).toString(16)}`);
}

/** How many distinct colours a frame holds, capped at 9 (a vacuity guard). */
export function distinctColors(fb) {
  const s = new Set();
  for (let i = 0; i < fb.length; i++) { s.add(fb[i]); if (s.size > 8) break; }
  return s.size;
}
