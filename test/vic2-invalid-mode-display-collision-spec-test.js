// Invalid DISPLAY-mode sprite-vs-graphics collision ($D01F), end to end.
//
// Bauer §3.7.3.6 (invalid text 101), §3.7.3.7 (invalid bitmap 1, 110) and
// §3.7.3.8 (invalid bitmap 2, 111): these three modes output BLACK for every
// pixel, BUT the "would-be foreground" pixels still drive the sprite priority
// and collision multiplexer. So a sprite drawn over an invalid-mode black
// foreground pixel MUST latch a sprite-graphics collision ($D01F), and (per
// §3.12) the first 0→non-zero transition raises the IMBC interrupt.
//
// The MC-pair rule (§3.7.3.2 / §3.7.3.4, inherited by the MC invalid modes
// 101 and 111) says pattern 00 and 01 are BACKGROUND; only 10 and 11 are
// foreground. So a sprite over a 01-pair invalid-mode pixel must NOT collide.
//
// COVERAGE NOTE: the IDLE-state version of this rule is proven end to end by
// vic2-invalid-mode-idle-collision-shinethrough-spec-test.js (and nine.prg's
// $70 top border). The DISPLAY-state path — a real character/bitmap column
// fetched into the sequencer, painted BLACK, with a sprite over it reading the
// actual $D01F register — had no test. This file fills that gap: it drives the
// real graphics render (_renderCycleSegmentGraphics → graphicsCollisionBuffer)
// AND a real opaque sprite (_renderSpriteSegmentForSprite → its own
// _processSpritePixelCollision → _applySpriteBgBits → $D01F + IMBC).

import { VIC2, CANVAS_W, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

const BLACK = 0xFF000000;
const RASTER = 0x40;          // in the $30-$f7 display band
const CANVAS_Y = RASTER - 15; // ours: canvas row 0 == raster 15

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Render one DISPLAY-state raster line in a fixed mode, with all 40 matrix
// columns fetched, screen code 1 / colour $0F in every cell, VC base 0, RC 0.
// The caller pre-seeds the g-data (charRom for text modes / ram for bitmap
// modes). Renders the real per-cycle graphics path into CANVAS_Y so
// graphicsCollisionBuffer / fb32 carry the true invalid-mode output.
function renderDisplayLine(vic, { d011, d016, d018 }) {
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;
  vic.regs[0x20] = 0x0E;        // border light blue (must differ from BLACK)
  vic.regs[0x21] = 0x06;        // bg0 blue (must differ from BLACK)
  vic._lineStartD011 = d011;    // constant mode → no mid-line mode-flip latch
  vic._lineStartD021 = vic.regs[0x21];
  vic._prevLineStartD011 = d011;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    const inner = (c >= 15 && c <= 54);
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleDisplayActive[c] = 1;
    vic.lineCycleDisplayPending[c] = 0;
    vic.lineCycleDisplayColumnActive[c] = inner ? 1 : 0;
    vic.lineCycleMatrixFetchActive[c] = 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = inner ? 0 : 1;
    vic.lineCycleHBorderBefore[c] = inner ? 0 : 1;
    vic.lineCycleHInner[c] = inner ? 1 : 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleBanks[c] = vic.currentVicBank;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleRowCodes[c].fill(1);     // code 1 → char data at +8
    vic.lineCycleRowColors[c].fill(0x0F); // MC pair interpretation where used
    vic.lineCycleIdleByte[c] = 0;
  }
  vic.rowFetchD011 = d011;
  vic.rowFetchD016 = d016;
  vic.rowFetchD018 = d018;
  vic.displayActive = true;
  vic.lineDisplayActive = true;
  vic._initRenderRasterLine(RASTER, CANVAS_Y);
  for (let cycle = 15; cycle <= 54; cycle++) {
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(cycle), CANVAS_Y);
  }
}

// Drive a real opaque hi-res sprite 0 across canvas [sx, sx+24). Collision is
// committed to $D01F immediately (no 2-cycle pipeline) so the register can be
// read straight after. Returns nothing — read vic.regs[0x1F] / vic.irqStatus.
function overlayOpaqueSprite(vic, sx) {
  const s = 0;
  vic._deferCollisionCommit = false;
  const regs = new Uint8Array(0x40);
  const rawX = sx - 8;                 // sequencer adds +8 back
  regs[s * 2] = rawX & 0xFF;
  if (rawX > 255) regs[0x10] = 1 << s;
  regs[0x27 + s] = 0x01;               // sprite colour white
  const seg = {
    regs,
    spriteDisplayOn: new Uint8Array(8),
    spriteDataRow: new Int8Array(8).fill(-1),
    spriteShiftReg: new Uint32Array(8),
    spriteRowByteMask: new Uint8Array(8),
    start: sx,
    end: Math.min(sx + 24, CANVAS_W),
  };
  seg.spriteDisplayOn[s] = 1;          // display FF on → render this line
  seg.spriteDataRow[s] = 0;            // valid data row
  seg.spriteShiftReg[s] = 0xFFFFFF;    // 24 opaque pixels
  seg.spriteRowByteMask[s] = 0x07;
  vic._renderSpriteSegmentForSprite(seg, s, CANVAS_Y);
}

function ro() { return CANVAS_Y * CANVAS_W; }
function allEqual(buf, base, start, end, val) {
  for (let x = start; x < end; x++) if (buf[base + x] !== val) return false;
  return true;
}

// ── 1: invalid TEXT mode 101 ($D011=$40 ECM, $D016=$10 MCM), all-fg byte $FF
//      → BLACK pixels, foreground collision bits set, sprite latches $D01F +
//      IMBC IRQ. (Bauer §3.7.3.6 + §3.12) ───────────────────────────────────
{
  const vic = makeVic();
  vic.charRom[8] = 0xFF;             // glyph 1 row 0: pairs 11,11,11,11 → all fg
  renderDisplayLine(vic, { d011: 0x40, d016: 0x10, d018: 0x14 });
  const base = ro();
  expect(allEqual(vic.fb32, base, 48, 320, BLACK),
    'invalid text 101: every display pixel is BLACK (§3.7.3.6)');
  expect(allEqual(vic.graphicsCollisionBuffer, 0, 48, 320, 1),
    'invalid text 101 byte $FF: would-be-foreground collision bits all 1');
  vic.irqMask = 0x02;                // enable IMBC
  vic.irqHandler = () => {};
  overlayOpaqueSprite(vic, 64);      // sprite over the black foreground
  expect((vic.regs[0x1F] & 0x01) !== 0,
    'sprite over invalid-mode black foreground latches $D01F bit0 (§3.8.2)');
  expect((vic.irqStatus & 0x02) !== 0,
    'IMBC ($D019 bit1) fires on the 0→non-zero $D01F transition (§3.12)');
  expect((vic.irqStatus & 0x80) !== 0,
    '$D019 bit7 (IRQ-asserted) set when IMBC enabled + fires (§3.12)');
  ok('Bauer §3.7.3.6: invalid text mode — black foreground still collides → $D01F + IMBC');
}

// ── 2: invalid TEXT mode 101, byte $55 (pairs 01,01,01,01) → BACKGROUND.
//      No collision bits, sprite does NOT latch $D01F. (Bauer §3.7.3.2 rule
//      inherited: pattern 01 is background.) ──────────────────────────────
{
  const vic = makeVic();
  vic.charRom[8] = 0x55;             // pairs 01,01,01,01 → all background
  renderDisplayLine(vic, { d011: 0x40, d016: 0x10, d018: 0x14 });
  const base = ro();
  expect(allEqual(vic.fb32, base, 48, 320, BLACK),
    'invalid text 101: still BLACK pixels regardless of fg/bg classification');
  expect(allEqual(vic.graphicsCollisionBuffer, 0, 48, 320, 0),
    'invalid text 101 byte $55: pair 01 classified as background → collision bits 0');
  vic.irqMask = 0x02;
  vic.irqHandler = () => {};
  overlayOpaqueSprite(vic, 64);
  expect((vic.regs[0x1F] & 0x01) === 0,
    'sprite over a 01-pair (background) invalid-mode pixel does NOT latch $D01F');
  expect((vic.irqStatus & 0x02) === 0,
    'no IMBC IRQ when no collision occurs');
  ok('Bauer §3.7.3.6/§3.7.3.2: invalid text 01-pair is background → no sprite-gfx collision');
}

// ── 3: invalid BITMAP mode 1 (110, $D011=$60 ECM+BMM, $D016=$00) 1-bit fg,
//      column-0 byte $FF → BLACK + collide → $D01F. (Bauer §3.7.3.7) ────────
{
  const vic = makeVic();
  // §3.7.3.7 address: bitmapBase + (VC & $33F)*8 + RC. VC base 0, col 0, RC 0
  // → bitmapBase $2000 (D018=$18). Bank 0.
  vic.ram[0x2000] = 0xFF;            // col 0 g-byte: all 1 → all foreground
  renderDisplayLine(vic, { d011: 0x60, d016: 0x00, d018: 0x18 });
  const base = ro();
  expect(allEqual(vic.fb32, base, 32, 40, BLACK),
    'invalid bitmap 1 (110): column-0 pixels are BLACK (§3.7.3.7)');
  expect(allEqual(vic.graphicsCollisionBuffer, 0, 32, 40, 1),
    'invalid bitmap 1 byte $FF: 1-bit foreground bits all 1 in column 0');
  overlayOpaqueSprite(vic, 32);      // sprite over column 0 (canvas 32..39)
  expect((vic.regs[0x1F] & 0x01) !== 0,
    'sprite over invalid bitmap-1 black foreground latches $D01F (§3.8.2)');
  ok('Bauer §3.7.3.7: invalid bitmap mode 1 — 1-bit black foreground collides → $D01F');
}

// ── 4: invalid BITMAP mode 2 (111, ECM+BMM+MCM), column-0 byte $55 (pairs
//      01) → BACKGROUND → no $D01F. (Bauer §3.7.3.8 + §3.7.3.4 rule) ────────
{
  const vic = makeVic();
  vic.ram[0x2000] = 0x55;            // col 0: pairs 01,01,01,01 → background
  renderDisplayLine(vic, { d011: 0x60, d016: 0x10, d018: 0x18 });
  const base = ro();
  expect(allEqual(vic.graphicsCollisionBuffer, 0, 32, 40, 0),
    'invalid bitmap 2 byte $55: pair 01 is background → collision bits 0');
  overlayOpaqueSprite(vic, 32);
  expect((vic.regs[0x1F] & 0x01) === 0,
    'sprite over a 01-pair invalid bitmap-2 pixel does NOT latch $D01F');
  ok('Bauer §3.7.3.8/§3.7.3.4: invalid bitmap 2 01-pair is background → no collision');
}

// ── 5: invalid BITMAP mode 2 (111), column-0 byte $FF (pairs 11) →
//      FOREGROUND → BLACK + $D01F. (Bauer §3.7.3.8) ───────────────────────
{
  const vic = makeVic();
  vic.ram[0x2000] = 0xFF;            // col 0: pairs 11,11,11,11 → foreground
  renderDisplayLine(vic, { d011: 0x60, d016: 0x10, d018: 0x18 });
  const base = ro();
  expect(allEqual(vic.fb32, base, 32, 40, BLACK),
    'invalid bitmap 2 (111): column-0 pixels are BLACK (§3.7.3.8)');
  expect(allEqual(vic.graphicsCollisionBuffer, 0, 32, 40, 1),
    'invalid bitmap 2 byte $FF: pair 11 is foreground → collision bits 1');
  overlayOpaqueSprite(vic, 32);
  expect((vic.regs[0x1F] & 0x01) !== 0,
    'sprite over invalid bitmap-2 black foreground latches $D01F (§3.8.2)');
  ok('Bauer §3.7.3.8: invalid bitmap mode 2 — 11-pair black foreground collides → $D01F');
}

console.log(`\n${testNo} invalid-mode display-state collision spec tests; ${testsFailing} fail`);
if (testsFailing) { console.log('All invalid-mode display collision tests FAILED.'); process.exit(1); }
console.log('All invalid-mode display-state sprite-graphics collision tests passed.');
