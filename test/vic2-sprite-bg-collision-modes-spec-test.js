// Sprite-vs-background collision foreground-mask spec audit. Per
// Bauer §3.7.3 + §3.11.2 + §3.8.2 (sprite priority + bg collision):
//
//   The `fgMap` produced by graphics rendering tags each pixel as
//   foreground (1) or background (0). A sprite pixel triggers a
//   $D01F latch only when the underlying graphics pixel is fg. The
//   priority bit ($D01B) similarly uses fg/bg to decide whether a
//   sprite renders behind or in front of graphics.
//
//   Mode-by-mode fg/bg rules:
//
//   Mode 000 (standard text):       fg = bit set in glyph
//   Mode 001 (multicolor text):     pair 00,01 = bg; 10,11 = fg
//                                   (§3.7.3.2: "pattern 00 or 01 is
//                                   background, pattern 10 or 11 is
//                                   foreground")
//   Mode 010 (ECM text):            fg = bit set in glyph
//   Mode 100 (standard bitmap):     fg = bit set
//   Mode 101 (multicolor bitmap):   pair 00,01 = bg; 10,11 = fg
//                                   (§3.7.3.4: "in multicolor bitmap
//                                   mode, pixels with pattern 00 and
//                                   01 count as background")
//
// The MCM-bitmap rule is the one Commando-class games depend on:
// the player sprite walking over a $D022-colored (pair 01) terrain
// pixel must NOT register as a collision, because pair 01 is
// background for collision purposes.

import { VIC2, C64_PALETTE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

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

// Build a one-column render seg for _renderSourceColumn. Returns the
// fgMap for the rendered byte.
function renderColumnFgMap(vic, opts) {
  const seg = {
    regs: vic.regs,
    bank: 0x0000,
    rowVcBase: 0,
    rowFetchedCols: new Uint8Array(40),
    rowCodes: new Uint8Array(40),
    rowColors: new Uint8Array(40),
    rowFetchD011: vic.regs[0x11],
    rowFetchD016: vic.regs[0x16],
    rowFetchD018: vic.regs[0x18],
    displayColumnActive: true,
    rc: 0,
    cycleStart: 32,
    idleByte: 0x00,
    ...opts.seg,
  };
  seg.rowFetchedCols[0] = 1;
  if (opts.code !== undefined) seg.rowCodes[0] = opts.code;
  if (opts.color !== undefined) seg.rowColors[0] = opts.color;
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  return fgMap;
}

// ── 1: Standard text mode — fg = bit set in glyph ─────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // text mode
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;             // charBase = 0
  vic.ram[0] = 0xAA;                 // glyph 0 row 0 = 10101010
  const fg = renderColumnFgMap(vic, { code: 0, color: 0x07 });
  for (let bit = 0; bit < 8; bit++) {
    const want = (0xAA >> (7 - bit)) & 1;
    expect(fg[bit] === want,
      `text mode bit ${bit}: fg=${want} expected, got ${fg[bit]}`);
  }
  ok('Bauer §3.7.3.1: standard text — fgMap = glyph bits');
}

// ── 2: MCM text — pairs 00/01 = bg, 10/11 = fg ───────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x18;             // MCM=1
  vic.regs[0x18] = 0x10;
  vic.ram[0] = 0b00011011;           // pairs: 00, 01, 10, 11
  // color bit 3 set → multicolor (pair-pixel mode)
  const fg = renderColumnFgMap(vic, { code: 0, color: 0x0F });
  expect(fg[0] === 0 && fg[1] === 0, `pair 00: bg`);
  expect(fg[2] === 0 && fg[3] === 0, `pair 01: bg (Bauer §3.7.3.2)`);
  expect(fg[4] === 1 && fg[5] === 1, `pair 10: fg`);
  expect(fg[6] === 1 && fg[7] === 1, `pair 11: fg`);
  ok('Bauer §3.7.3.2: MCM text — pair 01 is background');
}

// ── 3: Standard bitmap — fg = bit set ────────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x3B;             // BMM=1
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x08;             // bitmap base = $2000
  vic.ram[0x2000] = 0x55;            // 01010101
  const fg = renderColumnFgMap(vic, { code: 0xAB });
  for (let bit = 0; bit < 8; bit++) {
    const want = (0x55 >> (7 - bit)) & 1;
    expect(fg[bit] === want, `bitmap bit ${bit}: fg=${want}`);
  }
  ok('Bauer §3.7.3.3: standard bitmap — fgMap = pixel bits');
}

// ── 4: MCM BITMAP — pairs 00/01 = bg, 10/11 = fg (CRITICAL FOR COMMANDO)
// Per Bauer §3.7.3.4 + §3.11.2: in multicolor bitmap mode, pair 01
// (the high-nibble VM color) is BACKGROUND for sprite priority and
// collision purposes. A sprite over a pair-01 pixel must NOT trigger
// a sprite-bg collision.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x3B;             // BMM=1
  vic.regs[0x16] = 0x18;             // MCM=1
  vic.regs[0x18] = 0x08;             // bitmap base = $2000
  vic.ram[0x2000] = 0b00011011;      // pairs: 00, 01, 10, 11
  const fg = renderColumnFgMap(vic, { code: 0xAB });
  expect(fg[0] === 0 && fg[1] === 0, `pair 00: bg, got ${fg[0]}/${fg[1]}`);
  expect(fg[2] === 0 && fg[3] === 0,
    `pair 01: bg per Bauer §3.7.3.4, got ${fg[2]}/${fg[3]}`);
  expect(fg[4] === 1 && fg[5] === 1, `pair 10: fg, got ${fg[4]}/${fg[5]}`);
  expect(fg[6] === 1 && fg[7] === 1, `pair 11: fg, got ${fg[6]}/${fg[7]}`);
  ok('Bauer §3.7.3.4: MCM bitmap — pair 01 is BACKGROUND (Commando-relevant)');
}

// ── 5: ECM text — fg = bit set in glyph ──────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B;             // ECM=1
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.ram[0] = 0xCC;                 // glyph 0 row 0
  const fg = renderColumnFgMap(vic, { code: 0, color: 0x07 });
  for (let bit = 0; bit < 8; bit++) {
    const want = (0xCC >> (7 - bit)) & 1;
    expect(fg[bit] === want, `ECM bit ${bit}: fg=${want}, got ${fg[bit]}`);
  }
  ok('Bauer §3.7.3.5: ECM text — fgMap = glyph bits');
}

console.log(`\n${testNo} sprite-bg-collision-modes spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
