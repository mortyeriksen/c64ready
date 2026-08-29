// Invalid bitmap-mode ($70 / $F0) open-border idle: BLACK pixels, but the
// ghost-byte foreground / priority / collision bits MUST follow the real idle
// byte — not a forced 0.
//
// Bauer §3.7.3.7/8: the invalid modes 110 (ECM+BMM) and 111 (ECM+BMM+MCM)
// output BLACK pixels regardless of data, yet the sequencer still clocks the
// idle byte, so its foreground bits remain available to the sprite priority /
// collision multiplexer.
//
// The sequencer clocks the live idle g-access byte through the shifter for
// every BMM idle mode; the per-mode colour assignment decides the pixels but
// the foreground/priority/collision bits always follow the byte's bit
// pattern. nine.prg builds its top border in invalid mode $70 and its
// sprite-vs-background collision ($D01F) depends on those ghost-byte
// foreground bits.
//
// NOTE: the existing vic2-sprite-collision-spec-test.js covers the DIRECT
// `_renderOpenBorderIdleSpan` helper. This file pins the UPSTREAM caller path
// (`_renderCycleSegmentGraphics`), covering both the invalid ECM+BMM modes
// and the valid standard/MCM bitmap idle modes. Pure synthetic per-cycle
// state, no nine.prg load.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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

const PAL_RGBA = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const c = C64_PALETTE[i];
    out[i] = (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
  }
  return out;
})();
const BLACK = 0xFF000000;

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Render one open-top-border idle line (vBorder=0, sides closed, inner zone
// c15..54 open, no display columns) at a constant $D011 mode, with a uniform
// idle byte, through the REAL caller path (_renderCycleSegmentGraphics).
// canvasY=20 (a top-border row); returns { vic, ro }.
function renderIdleLine({ d011, d016, idleByte, displayActive }) {
  const vic = makeVic();
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x20] = 0x0E;     // border = light blue
  vic.regs[0x21] = 0x06;     // bg0 = blue
  vic._lineStartD011 = d011; // constant mode → no mid-line mode-flip latch
  vic._lineStartD021 = vic.regs[0x21];
  vic._prevLineStartD011 = d011;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 55) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleDisplayActive[c] = displayActive ? 1 : 0;
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleBanks[c] = 0x0000;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = idleByte;
  }
  vic.displayActive = !!displayActive;
  vic.lineDisplayActive = !!displayActive;
  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }
  return { vic, ro: canvasY * CANVAS_W };
}

// Inner-zone X span actually painted by the idle shifter (c15..54 → X 32..343).
const INNER = [];
for (let x = 32; x < 344; x++) INNER.push(x);

function countBuf(buf, ro, val) {
  let n = 0; for (const x of INNER) if (buf[ro + x] === val) n++; return n;
}

// ── 1: invalid $70 (ECM+BMM, MCM=0), idleByte=$FF, idle → BLACK + fg=1 ──
//
// The whole inner zone is BLACK pixels (invalid mode), but every fg/
// priority/collision bit is 1 (idle byte $FF = all foreground). Before the
// fix the clobber zeroed these to 0.
{
  const { vic, ro } = renderIdleLine({ d011: 0x7B, d016: 0x08, idleByte: 0xFF, displayActive: false });
  expect(countBuf(vic.fb32, ro, BLACK) === INNER.length,
    `$70 idle $FF: all ${INNER.length} inner px BLACK (got ${countBuf(vic.fb32, ro, BLACK)})`);
  expect(countBuf(vic.graphicsPriorityBuffer, 0, 1) === INNER.length,
    `$70 idle $FF: priority bits all 1 (got ${countBuf(vic.graphicsPriorityBuffer, 0, 1)}/${INNER.length}) — clobber would give 0`);
  expect(countBuf(vic.graphicsCollisionBuffer, 0, 1) === INNER.length,
    `$70 idle $FF: collision bits all 1 (got ${countBuf(vic.graphicsCollisionBuffer, 0, 1)}/${INNER.length}) — clobber would give 0`);
  ok('invalid $70 idle: BLACK pixels but fg/priority/collision follow ghost byte $FF');
}

// ── 2: invalid $70, idleByte=$00 → BLACK + fg=0 (control) ──────────────
{
  const { vic, ro } = renderIdleLine({ d011: 0x7B, d016: 0x08, idleByte: 0x00, displayActive: false });
  expect(countBuf(vic.fb32, ro, BLACK) === INNER.length, `$70 idle $00: all inner px BLACK`);
  expect(countBuf(vic.graphicsPriorityBuffer, 0, 0) === INNER.length, `$70 idle $00: priority bits all 0`);
  expect(countBuf(vic.graphicsCollisionBuffer, 0, 0) === INNER.length, `$70 idle $00: collision bits all 0`);
  ok('invalid $70 idle, ghost byte $00: BLACK + zero fg (control)');
}

// ── 3: invalid $70, idleByte=$AA → fg follows the bit pattern ──────────
//
// $AA = 1010_1010. With XSCROLL=0 the cycle's first pixel = bit7, so each
// 8-px cycle is fg = 1,0,1,0,1,0,1,0. Confirm the map FOLLOWS the byte (not
// uniformly 0 and not uniformly 1), and that within a cycle it alternates.
{
  const { vic, ro } = renderIdleLine({ d011: 0x7B, d016: 0x08, idleByte: 0xAA, displayActive: false });
  const ones = countBuf(vic.graphicsCollisionBuffer, 0, 1);
  expect(ones > 0 && ones < INNER.length,
    `$70 idle $AA: collision map mixed (got ${ones}/${INNER.length} ones) — follows the byte`);
  // cycle 20 → canvas X (20-12)*8+8 = 72; pattern 1,0,1,0,1,0,1,0
  const cb = vic.graphicsCollisionBuffer;
  let patternOk = true;
  for (let i = 0; i < 8; i++) if (cb[72 + i] !== ((i % 2 === 0) ? 1 : 0)) patternOk = false;   // line buffer (#1)
  expect(patternOk, `$70 idle $AA: cycle-20 collision pattern is 10101010 (bit7-first)`);
  ok('invalid $70 idle, ghost byte $AA: fg/collision map follows the actual bit pattern');
}

// ── 4: invalid $F0 (ECM+BMM+MCM=1), idleByte=$FF → BLACK + fg=1 ────────
//
// Mode 111: multicolor pair interpretation; $FF = all "11" pairs → fg=1.
{
  const { vic, ro } = renderIdleLine({ d011: 0x7B, d016: 0x18, idleByte: 0xFF, displayActive: false });
  expect(countBuf(vic.fb32, ro, BLACK) === INNER.length, `$F0 idle $FF: all inner px BLACK`);
  expect(countBuf(vic.graphicsCollisionBuffer, 0, 1) === INNER.length,
    `$F0 idle $FF: collision bits all 1 (got ${countBuf(vic.graphicsCollisionBuffer, 0, 1)}/${INNER.length})`);
  ok('invalid $F0 (mode 111) idle: BLACK pixels but collision follows ghost byte');
}

// ── 5: standard bitmap (BMM=1, MCM=0, ECM=0), idleByte=$FF → BLACK + fg=1
//
// Bauer §3.7.3.3: in standard (hi-res) bitmap both the "0" and "1" colours
// come from the c-data nibbles (low/high) — never $D021. In idle the c-data
// is 0 (§3.7.3), so the whole span is BLACK regardless of the byte. But the
// sequencer still clocks the real idle byte, so the fg/priority/collision
// bits follow its "1" bits — same modeCode path as the invalid $70 above.
{
  const { vic, ro } = renderIdleLine({ d011: 0x3B, d016: 0x08, idleByte: 0xFF, displayActive: false });
  expect(countBuf(vic.fb32, ro, BLACK) === INNER.length,
    `std bitmap idle $FF: all inner px = BLACK (got ${countBuf(vic.fb32, ro, BLACK)}/${INNER.length})`);
  expect(countBuf(vic.graphicsPriorityBuffer, 0, 1) === INNER.length,
    `std bitmap idle $FF: priority bits all 1 (got ${countBuf(vic.graphicsPriorityBuffer, 0, 1)}/${INNER.length}) — follows byte`);
  expect(countBuf(vic.graphicsCollisionBuffer, 0, 1) === INNER.length,
    `std bitmap idle $FF: collision bits all 1 (got ${countBuf(vic.graphicsCollisionBuffer, 0, 1)}/${INNER.length}) — follows byte`);
  ok('Bauer §3.7.3.3: standard bitmap idle → BLACK pixels, fg/collision follow ghost byte');
}

// ── 6: MCM bitmap (BMM=1, MCM=1, ECM=0) idle → idle-byte pattern ───────
//
// Bauer §3.7.3.4: MCM bitmap pair 00 → $D021; pairs 01/10/11 → c-data /
// colour-RAM nibbles = 0 = BLACK; fg/collision set for pairs 10/11. The idle
// byte clocks through unchanged, so it shows as a PATTERN, not a solid $D021
// bar. (VICE colorsplit reference: idle byte $F0 = dots.)
{
  // $FF = all "11" pairs → all BLACK pixels, all fg=1.
  {
    const { vic, ro } = renderIdleLine({ d011: 0x3B, d016: 0x18, idleByte: 0xFF, displayActive: false });
    expect(countBuf(vic.fb32, ro, BLACK) === INNER.length,
      `MCM idle $FF: all inner px BLACK (got ${countBuf(vic.fb32, ro, BLACK)}/${INNER.length})`);
    expect(countBuf(vic.graphicsCollisionBuffer, 0, 1) === INNER.length,
      `MCM idle $FF: collision all 1 (pairs 11 are fg)`);
  }
  // $00 = all "00" pairs → all $D021, fg=0.
  {
    const { vic, ro } = renderIdleLine({ d011: 0x3B, d016: 0x18, idleByte: 0x00, displayActive: false });
    expect(countBuf(vic.fb32, ro, PAL_RGBA[0x06]) === INNER.length,
      `MCM idle $00: all inner px $D021 (got ${countBuf(vic.fb32, ro, PAL_RGBA[0x06])}/${INNER.length})`);
    expect(countBuf(vic.graphicsCollisionBuffer, 0, 0) === INNER.length, `MCM idle $00: collision all 0`);
  }
  // $F0 = pairs 11,11,00,00 → mixed BLACK + $D021 (the pattern), fg mixed.
  {
    const { vic, ro } = renderIdleLine({ d011: 0x3B, d016: 0x18, idleByte: 0xF0, displayActive: false });
    const blk = countBuf(vic.fb32, ro, BLACK), bg = countBuf(vic.fb32, ro, PAL_RGBA[0x06]);
    expect(blk > 0 && bg > 0 && blk + bg === INNER.length,
      `MCM idle $F0: pattern of BLACK + $D021 (got ${blk} black, ${bg} bg0 of ${INNER.length})`);
    const ones = countBuf(vic.graphicsCollisionBuffer, 0, 1);
    expect(ones > 0 && ones < INNER.length, `MCM idle $F0: collision map mixed (got ${ones}/${INNER.length})`);
  }
  ok('Bauer §3.7.3.4: MCM bitmap idle → idle-byte pattern (00=$D021, else BLACK), not solid');
}

console.log(`\n${testNo} invalid-mode idle collision-shine-through spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
