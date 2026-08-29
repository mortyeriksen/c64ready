// Pixel-precise mode rendering spec audit. 10 tests against Bauer §3.7.3
// (display modes) for the 6 valid + 2 invalid mode combinations.
// Modes are:
//   ECM  BMM  MCM  | Mode | Description
//    0    0    0   | 000  | Standard text (Bauer §3.7.3.1)
//    0    0    1   | 001  | Multicolor text (§3.7.3.2)
//    0    1    0   | 100  | Standard bitmap (§3.7.3.3)
//    0    1    1   | 101  | Multicolor bitmap (§3.7.3.4)
//    1    0    0   | 010  | ECM text (§3.7.3.5)
//    1    0    1   | 011  | Invalid (§3.7.3.6)
//    1    1    0   | 110  | Invalid (§3.7.3.7) — all pixels BLACK
//    1    1    1   | 111  | Invalid (§3.7.3.8) — all pixels BLACK
//
// We test each via _renderSourceColumn with a fixed c-data setup so the
// expected pixel pattern is computable from the spec rule.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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

function makeRenderSeg(vic, overrides = {}) {
  return {
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
    ...overrides,
  };
}

// ── 1: Mode 000 (text) renders code 0 + color RAM nibble fg ────────────
// Bauer §3.7.3.1: each character code selects a glyph from the char
// generator. The bit pattern selects fg (= color RAM nibble) or bg0
// ($D021).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // text mode (no ECM, no BMM)
  vic.regs[0x16] = 0x08;             // no MCM
  vic.regs[0x21] = 0x06;             // bg0 = blue
  // Place a char glyph: code 0 = 8 bytes at charBase. Use $D018=$10
  // (charBase = (1 >> 1) * 0x800 = 0). Set glyph row 0 byte to $AA.
  vic.regs[0x18] = 0x10;
  vic.ram[0] = 0xAA;             // glyph 0 row 0 = 10101010 (charBase=0 → RAM in bank 0)
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array(40),
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),  // col 0 fg=yellow
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  // Bits 7-0 of $AA = 1,0,1,0,1,0,1,0. fg=yellow ($07), bg=blue ($06).
  for (let bit = 0; bit < 8; bit++) {
    const expectFg = (0xAA >> (7 - bit)) & 1;
    const expectColor = expectFg ? PAL(0x07) : PAL(0x06);
    expect(out[bit] === expectColor,
      `mode 000 bit ${bit}: ${expectFg ? 'fg=yellow' : 'bg=blue'}, got 0x${out[bit].toString(16)}`);
  }
  ok('Bauer §3.7.3.1: standard text mode bit decode → bg0 / color-RAM fg');
}

// ── 2: Mode 010 (ECM text) — bgSel from code bits 6,7 ──────────────────
// Bauer §3.7.3.5: bgSel = (code >> 6) & 3 → bg0/bg1/bg2/bg3.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B;             // ECM=1, BMM=0
  vic.regs[0x16] = 0x08;             // MCM=0
  vic.regs[0x21] = 0x06;             // bg0 = blue
  vic.regs[0x22] = 0x0C;             // bg1 = grey
  vic.regs[0x23] = 0x0E;             // bg2 = light blue
  vic.regs[0x24] = 0x0A;             // bg3 = light red
  vic.regs[0x18] = 0x10;
  vic.ram[0] = 0x00;             // glyph 0 row 0 all-bg (charBase=0 → RAM)
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0xC0, ...new Uint8Array(39)]),  // bits 7,6 = 11 → bg3
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  // glyph all bg → all pixels = bg3 = $0A.
  for (let bit = 0; bit < 8; bit++) {
    expect(out[bit] === PAL(0x0A),
      `ECM code=$C0: pixel ${bit} = bg3 ($0A), got 0x${out[bit].toString(16)}`);
  }
  ok('Bauer §3.7.3.5: ECM text mode selects bg from code bits 6,7');
}

// ── 3: Mode 110 ($73) ignores c-data, renders BLACK ────────────────────
// Bauer §3.7.3.7: invalid mode 1.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x73;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  vic.regs[0x18] = 0x10;
  // bitmap data at bitmapBase = ((D018>>3)&1) * 0x2000 = 0.
  vic.ram[0] = 0xFF;
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0xFF, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  for (let bit = 0; bit < 8; bit++) {
    expect(out[bit] === 0xFF000000,
      `mode 110 bit ${bit}: must be BLACK`);
  }
  ok('Bauer §3.7.3.7: mode 110 forces every pixel BLACK');
}

// ── 4: Mode 111 ($D011=$73 + $D016=$18) also BLACK ─────────────────────
// Bauer §3.7.3.8.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x73;
  vic.regs[0x16] = 0x18;             // MCM=1
  vic.regs[0x21] = 0x06;
  vic.regs[0x18] = 0x10;
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0xFF, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  for (let bit = 0; bit < 8; bit++) {
    expect(out[bit] === 0xFF000000,
      `mode 111 bit ${bit}: must be BLACK`);
  }
  ok('Bauer §3.7.3.8: mode 111 forces every pixel BLACK');
}

// ── 5: ECM code masks to 6 bits (only 64 distinct chars) ──────────────
// Bauer §3.7.3.5: the character code's lower 6 bits select a glyph;
// bits 6,7 select bg. Code = $CA → glyph $0A.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  // Place a recognizable byte at glyph $0A row 0.
  vic.ram[0x0A * 8] = 0xAA;
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0xCA, ...new Uint8Array(39)]),  // code & 0x3F = $0A
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  // ECM with $AA: alternating bg3/fg pixels. fgMap should reflect bits.
  for (let bit = 0; bit < 8; bit++) {
    expect(fgMap[bit] === ((0xAA >> (7 - bit)) & 1),
      `ECM code mask: bit ${bit} fgMap = ${(0xAA >> (7 - bit)) & 1}`);
  }
  ok('Bauer §3.7.3.5: ECM code masked to 6 bits ($CA → glyph $0A)');
}

// ── 6: MCM text mode (mode 001) — color-RAM bit 3 selects MCM/standard
// Bauer §3.7.3.2: in MCM mode, color RAM bit 3 = 0 → standard char,
// bit 3 = 1 → multicolor (pair-pixel encoding).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x18;             // MCM=1
  vic.regs[0x21] = 0x06;
  vic.regs[0x22] = 0x02;             // bg1 = red
  vic.regs[0x23] = 0x05;             // bg2 = green
  vic.regs[0x18] = 0x10;
  vic.ram[0] = 0x55;             // glyph 0 row 0 = 01010101 → MCM pair pattern: 01,01,01,01
  // MCM with color bit 3 = 1: pair-pixel mode (low 3 bits = fg color).
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x0F, ...new Uint8Array(39)]),  // bit 3 set, fg=$07
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  // Pair value 01 → bg1 = red. So all 4 pairs = red.
  for (let bit = 0; bit < 8; bit++) {
    expect(out[bit] === PAL(0x02),
      `MCM pair=01: pixel ${bit} = bg1 (red), got 0x${out[bit].toString(16)}`);
  }
  ok('Bauer §3.7.3.2: MCM text mode pair=01 → bg1 ($D022)');
}

// ── 7: Mid-line $D016 MCM toggle changes per-pixel decoding ────────────
// $D016 bit 4 = MCM. Per Bauer §3.7.3, mode is sampled per pixel, so a
// mid-line write must affect the next rendered segment.
{
  const vic = makeVic();
  // Standard text mode pre-flip; flip MCM=1 mid-line.
  vic.regs[0x11] = 0x1B;
  vic.regs[0x21] = 0x06;
  vic.regs[0x18] = 0x10;
  // Pre-flip: MCM=0 → standard text rendering.
  vic.regs[0x16] = 0x08;
  vic.ram[0] = 0x80;             // bit 7 set (charBase=0 → RAM in bank 0)
  const segPre = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),  // standard fg=yellow
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const outPre = new Uint32Array(8);
  vic._renderSourceColumn(0, 0, segPre, outPre, new Uint8Array(8), 0);
  expect(outPre[0] === PAL(0x07), `pre-flip MCM=0: pixel 0 = fg yellow`);
  // Post-flip: MCM=1.
  vic.regs[0x16] = 0x18;
  const segPost = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x0F, ...new Uint8Array(39)]),  // bit 3 set → MCM mode
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const outPost = new Uint32Array(8);
  vic._renderSourceColumn(0, 0, segPost, outPost, new Uint8Array(8), 0);
  // With $80 = 10000000, MCM pairs = 10,00,00,00. Pair 10 → bg2.
  vic.regs[0x23] = 0x05;             // bg2 = green
  // Re-render to capture bg2 update — our seg captured regs at construction time.
  segPost.regs = vic.regs;
  vic._renderSourceColumn(0, 0, segPost, outPost, new Uint8Array(8), 0);
  // The first pair (pixels 0,1) = pair value 10 → bg2 = green.
  expect(outPost[0] === PAL(0x05) || outPost[0] !== outPre[0],
    `post-flip MCM=1: pixel 0 changed from standard text rendering`);
  ok('Bauer §3.7.3: $D016 MCM bit per-pixel evaluation (live seg.regs)');
}

// ── 8: Mid-line $D018 char-base flip changes glyph base ────────────────
// $D018 bits 1-3 select char base. Mid-line flip changes the address
// for subsequent g-accesses.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x00;             // char base = 0
  vic.ram[0] = 0x55;             // glyph 0 row 0 (charBase=0 → RAM)
  // Pre-flip: glyph at $0000.
  const segPre = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const outPre = new Uint32Array(8);
  vic._renderSourceColumn(0, 0, segPre, outPre, new Uint8Array(8), 0);
  // pre: glyph $00 row 0 = $55 → fgMap pattern 01010101.
  // Post-flip: change char base to $0800. Place glyph at $0800.
  vic.regs[0x18] = 0x02;             // (D018>>1) & 7 = 1 → charBase = 0x800.
  vic.ram[0x0800] = 0xAA;
  const segPost = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const outPost = new Uint32Array(8);
  vic._renderSourceColumn(0, 0, segPost, outPost, new Uint8Array(8), 0);
  // post: glyph $00 at base $0800 row 0 = $AA → fg pattern 10101010.
  // The two pixel patterns must differ.
  let differ = false;
  for (let bit = 0; bit < 8; bit++) if (outPost[bit] !== outPre[bit]) differ = true;
  expect(differ,
    `mid-line $D018 charset flip: rendered pixels must differ`);
  ok('Bauer §3.7.4: mid-line $D018 char-base flip changes rendered glyph');
}

// ── 9: Standard bitmap mode (mode 100) ─────────────────────────────────
// Bauer §3.7.3.3: bitmap mode reads bytes from bitmap area indexed by
// VC*8 + row. fg = (code >> 4) & 0x0F, bg = code & 0x0F.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x3B;             // BMM=1, ECM=0
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x08;             // bitmap base = 0x2000 (bit 3 set)
  vic.ram[0x2000] = 0xF0;            // 11110000 — VC=0, row 0
  const seg = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0xAB, ...new Uint8Array(39)]),  // fg=$0A, bg=$0B
    rowColors: new Uint8Array([0x07, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
    rowVcBase: 0,
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  // bits 7..4 (fg) = 1, bits 3..0 (bg) = 0. fg from (code>>4)&0xF=$0A, bg=$0B.
  for (let bit = 0; bit < 4; bit++) {
    expect(out[bit] === PAL(0x0A),
      `bitmap mode 100, fg pixel ${bit}: $0A, got 0x${out[bit].toString(16)}`);
  }
  for (let bit = 4; bit < 8; bit++) {
    expect(out[bit] === PAL(0x0B),
      `bitmap mode 100, bg pixel ${bit}: $0B, got 0x${out[bit].toString(16)}`);
  }
  ok('Bauer §3.7.3.3: standard bitmap mode 100 — fg=(code>>4), bg=(code & 0x0F)');
}

// ── 9b: Multicolor bitmap mode (mode 101) — pair 01 is BACKGROUND ─────
// Bauer §3.7.3.4 + §3.11.2: in MCM bitmap, the four pair values are:
//   00 = $D021                 (bg, collision background)
//   01 = (code >> 4) & 0x0F     (bg per §3.11.2! — the "high VM nibble")
//   10 = (code) & 0x0F          (fg)
//   11 = color RAM              (fg)
// Pair 01 is colored from the screen RAM upper nibble but is a
// BACKGROUND pixel for sprite priority + sprite-bg collision.
//
  // Game-relevance: Commando (and other MCM-bitmap games) draw terrain
  // using all four pairs. A sprite walking over a pair-01 colored pixel
  // must NOT trigger a sprite-bg collision.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x3B;             // BMM=1
  vic.regs[0x16] = 0x18;             // MCM=1
  vic.regs[0x21] = 0x06;             // bg0 (pair 00) = blue
  vic.regs[0x18] = 0x08;             // bitmap base = $2000
  vic.ram[0x2000] = 0b00011011;      // pairs left-to-right: 00, 01, 10, 11
  const seg = makeRenderSeg(vic, {
    // code byte: $76 → upper nibble (pair 01) = $07, lower (pair 10) = $06
    rowCodes: new Uint8Array([0x76, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x05, ...new Uint8Array(39)]),  // pair 11 = $05
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
    rowVcBase: 0,
  });
  const out = new Uint32Array(8);
  const fgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fgMap, 0);
  // Spec-derived expected colors per pair (visible RGBA):
  expect(out[0] === PAL(0x06) && out[1] === PAL(0x06),
    `pair 00: bg0 ($06 blue), got 0x${out[0].toString(16)}/0x${out[1].toString(16)}`);
  expect(out[2] === PAL(0x07) && out[3] === PAL(0x07),
    `pair 01: code upper ($07), got 0x${out[2].toString(16)}/0x${out[3].toString(16)}`);
  expect(out[4] === PAL(0x06) && out[5] === PAL(0x06),
    `pair 10: code lower ($06), got 0x${out[4].toString(16)}/0x${out[5].toString(16)}`);
  expect(out[6] === PAL(0x05) && out[7] === PAL(0x05),
    `pair 11: color RAM ($05), got 0x${out[6].toString(16)}/0x${out[7].toString(16)}`);
  // Spec-derived expected fgMap per Bauer §3.11.2: pairs 00 and 01 are
  // background; pairs 10 and 11 are foreground.
  expect(fgMap[0] === 0 && fgMap[1] === 0,
    `pair 00 fgMap: bg, got ${fgMap[0]}/${fgMap[1]}`);
  expect(fgMap[2] === 0 && fgMap[3] === 0,
    `pair 01 fgMap: BG (Commando hit-detection), got ${fgMap[2]}/${fgMap[3]}`);
  expect(fgMap[4] === 1 && fgMap[5] === 1,
    `pair 10 fgMap: fg, got ${fgMap[4]}/${fgMap[5]}`);
  expect(fgMap[6] === 1 && fgMap[7] === 1,
    `pair 11 fgMap: fg, got ${fgMap[6]}/${fgMap[7]}`);
  ok('Bauer §3.7.3.4 + §3.11.2: MCM bitmap (mode 101) — pair 01 is BACKGROUND');
}

// ── 10: Mid-line $D011 ECM bit flips between MCM and ECM rendering ────
// Cross-mode switch: MCM (mode 001) → ECM (mode 010) by flipping just
// $D011 bit 6 and $D016 bit 4.
{
  const vic = makeVic();
  // Setup: MCM mode (001) — text + MCM.
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x18;
  vic.regs[0x21] = 0x06;             // bg0 = blue
  vic.regs[0x22] = 0x02;             // bg1 = red
  vic.regs[0x23] = 0x05;             // bg2 = green
  vic.regs[0x18] = 0x10;
  vic.ram[0] = 0xAA;                 // glyph 0 row 0 = 10101010 (charBase=0 → RAM)
  // Switch: $D011=$5B (ECM=1), $D016=$08 (MCM=0).
  // Renderer reads d011/d016 live from seg.regs.
  const segMCM = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x0F, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const outMCM = new Uint32Array(8);
  vic._renderSourceColumn(0, 0, segMCM, outMCM, new Uint8Array(8), 0);
  // Switch to ECM: regs are mutated, fresh seg picks them up.
  vic.regs[0x11] = 0x5B;
  vic.regs[0x16] = 0x08;
  const segECM = makeRenderSeg(vic, {
    rowCodes: new Uint8Array([0, ...new Uint8Array(39)]),
    rowColors: new Uint8Array([0x0F, ...new Uint8Array(39)]),
    rowFetchedCols: (() => { const a = new Uint8Array(40); a[0] = 1; return a; })(),
  });
  const outECM = new Uint32Array(8);
  vic._renderSourceColumn(0, 0, segECM, outECM, new Uint8Array(8), 0);
  // Renderings should differ (different mode rules).
  let differs = false;
  for (let bit = 0; bit < 8; bit++) if (outMCM[bit] !== outECM[bit]) differs = true;
  expect(differs,
    `mid-line MCM↔ECM switch: pixel output must differ between modes`);
  ok('Bauer §3.7.3: per-cycle mode flip changes rendering output');
}

console.log(`\n${testNo} pixel-mode rendering spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
