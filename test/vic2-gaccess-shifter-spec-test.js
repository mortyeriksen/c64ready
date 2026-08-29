// g-access shifter / ghost-byte / mode-decode spec audit. 10 tests
// derived from Bauer §3.7.3 (display-mode decode) and §3.7.5 (idle and
// ghost-byte handling), plus DEMO-NINE.md §7 + §8 (invalid modes).
//
// "Ghost byte" = the last g-byte the VIC fetched is held in the shifter
// and continues to clock out as graphics during idle/border periods. The
// demo exploits this for hyperscreen tricks; we verify the spec rules
// the demo's behavior depends on.

import { VIC2, CYCLES_PER_LINE, C64_PALETTE } from '../src/vic2.js';

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

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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

// ── 1: Idle byte from $3FFF in non-ECM mode ──────────────────────────────
// Bauer §3.7.5: VIC's idle g-access reads from address $3FFF (within the
// current 16K bank) when ECM=0.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x42;
  vic.ram[0x39FF] = 0x99;
  vic.regs[0x11] = 0x1B;     // ECM=0
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x42,
    `non-ECM idle reads $3FFF: expected 0x42, got 0x${vic._readIdleGByte(vic.regs, 0).toString(16)}`);
  ok('Bauer §3.7.5: idle g-access reads from $3FFF (non-ECM)');
}

// ── 2: Idle byte from $39FF in ECM mode ──────────────────────────────────
// Bauer §3.7.5: with ECM=1 the idle g-access shifts to $39FF (ECM masks
// the upper 2 character-code bits, which "leaks" into the address).
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x42;
  vic.ram[0x39FF] = 0x99;
  vic.regs[0x11] = 0x5B;     // ECM=1
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x99,
    `ECM idle reads $39FF: expected 0x99, got 0x${vic._readIdleGByte(vic.regs, 0).toString(16)}`);
  ok('Bauer §3.7.5: idle g-access reads from $39FF (ECM=1)');
}

// ── 3: Mode 110 (ECM=1, BMM=1, MCM=0) — every pixel BLACK ───────────────
// Bauer §3.7.3.7: invalid bitmap mode 1: every pixel rendered as BLACK,
// regardless of the bit-pattern of the fetched data. Foreground/priority
// map still tracks the bits.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x7B;     // ECM=1, BMM=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;
  const seg = makeRenderSeg(vic, {
    idleByte: 0xFF,
    displayColumnActive: false,
  });
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  expect(vic.fb32[35] === 0xFF000000,
    `mode 110: every pixel must render BLACK, got 0x${vic.fb32[35].toString(16)}`);
  ok('Bauer §3.7.3.7: invalid mode 110 renders every pixel BLACK');
}

// ── 4: Mode 111 (ECM=1, BMM=1, MCM=1) — every pixel BLACK ───────────────
// Bauer §3.7.3.8: invalid bitmap mode 2 (multicolor). Same as 110: every
// pixel BLACK regardless of pair value.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x7B;
  vic.regs[0x16] = 0x18;     // MCM=1, CSEL=1
  const seg = makeRenderSeg(vic, {
    idleByte: 0xFF,
    displayColumnActive: false,
  });
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  expect(vic.fb32[35] === 0xFF000000,
    `mode 111: every pixel must render BLACK`);
  ok('Bauer §3.7.3.8: invalid mode 111 renders every pixel BLACK');
}

// ── 5: Standard text mode (ECM=0, BMM=0, MCM=0) — bg0 / FG color ────────
// Bauer §3.7.3.1: standard text mode. bg pixel = $D021, fg pixel = char
// color RAM nibble. In our open-border idle path with idle byte $FF and
// non-ECM mode, every pixel is foreground BLACK (since the open-border
// renderer paints fg as BLACK regardless of color RAM, see vic2.js
// _renderOpenBorderIdleSpan branch for !bmm && !mcm && !ecm).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  const seg = makeRenderSeg(vic, {
    idleByte: 0xFF,
    displayColumnActive: false,
  });
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  // idle 0xFF, ECM=0 BMM=0 MCM=0 → fg=1 → BLACK per impl.
  expect(vic.fb32[35] === 0xFF000000,
    `text-mode idle with all-1 byte: fg pixel is BLACK in this branch`);
  ok('Bauer §3.7.3.1: standard text mode idle paints fg pixels BLACK');
}

// ── 6: Standard text mode with idle byte=0 → bg color ───────────────────
// idle byte = 0 means all pixels are bg. With $D021=$06 (blue), we should
// see blue pixels (regardless of border being "open").
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  const seg = makeRenderSeg(vic, {
    idleByte: 0x00,
    displayColumnActive: false,
  });
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  expect(vic.fb32[35] === PAL(0x06),
    `idle 0, $D021=blue: pixel must be blue (bg0), got 0x${vic.fb32[35].toString(16)}`);
  ok('Bauer §3.7.3.1: idle byte=0 yields bg0 ($D021) color');
}

// ── 7: ECM-only mode (010): idle byte non-zero → BLACK ──────────────────
// Bauer §3.7.3.5 ECM-text: bg pixel = $D021 (or D022/D023/D024 for chars
// with bits 6,7 set in screen RAM). fg pixel = BLACK (specifically, ECM
// fg is rendered as black per the `_renderOpenBorderIdleSpan` branch).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B;     // ECM=1, BMM=0, MCM=0
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  const seg = makeRenderSeg(vic, {
    idleByte: 0xFF,
    displayColumnActive: false,
  });
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  expect(vic.fb32[35] === 0xFF000000,
    `ECM mode + idle 0xFF: fg pixel must be BLACK`);
  ok('Bauer §3.7.3.5: ECM mode idle fg pixel is BLACK');
}

// ── 8: Ghost-byte rendering on side-border-open zone ────────────────────
// DEMO-NINE.md §8: the g-shifter holds the last fetched byte and shifts
// it across border cycles when the border-FF is open. _renderOpenBorder-
// IdleSpan uses seg.idleByte to seed; verify each bit of the byte
// produces the expected pixel value.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;     // bg0=blue
  const seg = makeRenderSeg(vic, {
    idleByte: 0xAA,            // 10101010 — alternating fg/bg
    displayColumnActive: false,
  });
  vic.fb32.fill(0xFFFFFFFF);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  // x=32 sees bit 7 of idleByte ($AA bit 7 = 1). x=33 sees bit 6 = 0. etc.
  // ECM=0, non-bmm/mcm → fg pixel BLACK, bg pixel = bg0 (blue).
  expect(vic.fb32[32] === 0xFF000000, `bit 7=1: fg=BLACK at canvas-X 32`);
  expect(vic.fb32[33] === PAL(0x06), `bit 6=0: bg0=blue at canvas-X 33`);
  expect(vic.fb32[34] === 0xFF000000, `bit 5=1: fg=BLACK at canvas-X 34`);
  expect(vic.fb32[35] === PAL(0x06), `bit 4=0: bg0=blue at canvas-X 35`);
  ok('DEMO-NINE §8: ghost-byte bits drive alternating fg/bg pixels');
}

// ── 9: Mid-line ECM toggle changes idle source on next read ─────────────
// Bauer §3.7.5: the idle g-access address depends on regs[0x11] ECM bit
// at the moment of the access. A CPU write to $D011 between cycles
// changes the idle-byte read for any subsequent cycle.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x42;
  vic.ram[0x39FF] = 0x99;
  vic.regs[0x11] = 0x1B;
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x42, `pre: ECM=0 idle = $42`);
  vic.write(0x11, 0x5B);     // ECM=1
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x99,
    `post-write ECM=1: idle byte source switches immediately to $39FF`);
  ok('Bauer §3.7.5: ECM toggle mid-line changes idle byte source on next access');
}

// ── 10: Idle byte respects current VIC bank ─────────────────────────────
// Bauer §3.4: the idle address is bank-relative ($3FFF | $39FF within the
// 16K window). Different banks return different values.
{
  const vic = makeVic();
  vic.ram[0x0000 + 0x3FFF] = 0x11;
  vic.ram[0x4000 + 0x3FFF] = 0x22;
  vic.ram[0x8000 + 0x3FFF] = 0x33;
  vic.ram[0xC000 + 0x3FFF] = 0x44;
  vic.regs[0x11] = 0x1B;
  for (const [bank, expected] of [[0x0000, 0x11], [0x4000, 0x22], [0x8000, 0x33], [0xC000, 0x44]]) {
    expect(vic._readIdleGByte(vic.regs, bank) === expected,
      `bank $${bank.toString(16)}: idle = $${expected.toString(16)}, got $${vic._readIdleGByte(vic.regs, bank).toString(16)}`);
  }
  ok('Bauer §3.4 + §3.7.5: idle g-access is bank-relative ($3FFF within 16K)');
}

// ── 11: Mid-line $D018 CB change splits glyph rendering at cycle boundary ──
//
// Bauer §3.7.3 + §3.6.3: char data is fetched at the g-access cycle that
// owns the column. CB (bits 1-3 of $D018) is sampled live at fetch time.
// A CPU write to $D018 at PHI2 of cycle N takes effect at cycle N+1's
// access (per VIC-first ordering — VIC reads at PHI1/PHI2, CPU writes
// land in time for the NEXT VIC cycle). The visible result: cols
// rendered by cycles ≤N use the OLD CB; cols rendered by cycles ≥N+1
// use the NEW CB. The transition is exactly at the cycle boundary.
//
// Synthetic setup: all matrix codes = $01, screen at $0400 in bank 0;
// CB candidates have distinct row-0 patterns:
//   CB=$0000 char $01 row 0 = $AA = 10101010
//   CB=$0800 char $01 row 0 = $55 = 01010101
// Drive a normal bad-line. Mid-line write $D018 = $12 (CB bits 001 →
// CB=$0800) at PHI2 of cycle 20. Verify the transition at the
// canvas-X corresponding to cycle 21's segment start (= col 6, X=80).
{
  const vic = makeVic();
  // Char $01 row 0 lives at CB + 1*8 + 0 = CB + 8.
  vic.ram[0x0008] = 0xAA;                 // CB=$0000 → char $01 row 0
  vic.ram[0x0808] = 0x55;                 // CB=$0800 → char $01 row 0
  // chargen mirror is at $1000-$1FFF in bank 0; we want CB=$0000 to
  // read RAM (not chargen), so use bank 0 normally — $0000 is RAM. CB
  // = $0800 also RAM. Good.
  // Plant char $01 across the full 1KB screen window — by L$38 the
  // c-access reads from screen[vcBase + col], with vcBase at 40 after
  // the L$30..L$37 row finishes. Cover the whole range so cols 0-39
  // see code $01 regardless of vcBase.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x01;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;   // fg=yellow
  vic.regs[0x11] = 0x1B;                   // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;                   // CSEL=1
  vic.regs[0x18] = 0x10;                   // VM=$0400, CB=$0000
  vic.regs[0x21] = 0x06;                   // bg0=blue
  vic.displayEnabled = true;
  // Set raster IRQ outside our test line so it doesn't fire.
  // Drive to L$30 = 48 to latch displayEnabled, but use YSCROLL=0
  // so badline triggers at 48&7=0=YSCROLL. Update: $1B → YSCROLL=3,
  // 48&7=0 mismatch. Use YSCROLL=0:
  vic.regs[0x11] = 0x18;                   // DEN=1, RSEL=1, YSCROLL=0
  // Drive past L$30 (latches displayEnabled), then to L$38 = 56,
  // the first display-window bad-line with YSCROLL=0 (56 & 7 = 0).
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  // Drive to c20 of L$38.
  while (!(vic.raster === 0x38 && vic.cycleInLine === 20)) vic.clock(1);
  // CPU writes $D018 at PHI2 of cycle 20. In our model, CPU write
  // executes after vic.clock(20), and the NEXT vic.clock(21) will
  // capture the new value into lineCycleRegs[21].
  vic.write(0x18, 0x12);                   // CB=$0800
  // Drive to end of line so render completes for L$38.
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  // Per Bauer §3.7.4: g-access for col K at cy 16+K phi1. A CPU write at
  // cy 20 phi2 is visible from cy 21 phi1 (Bauer §3.6.3), so the first
  // g-access to read the NEW CB is the one at cy 21 → col 5 (since
  // 16+K=21 ⇒ K=5). Col 4's g-access is at cy 20 phi1, BEFORE the cy 20
  // phi2 write, so col 4 still uses OLD CB.
  //
  // Col 4 canvas X: 64-71 (OLD CB, char $01 row 0 = $AA = 10101010).
  // Col 5 canvas X: 72-79 (NEW CB, char $01 row 0 = $55 = 01010101).
  const cy = 0x38 - 15;
  const ro = cy * 384;
  // Identify fg/bg from col 4 (uses OLD CB = $AA).
  //   Col 4 X=64: bit 7 of $AA = 1 → fg.  Col 4 X=65: bit 6 = 0 → bg.
  const fg = vic.fb32[ro + 64];
  const bg = vic.fb32[ro + 65];
  expect(fg !== bg, `fg/bg distinguishable: fg=0x${fg.toString(16)} bg=0x${bg.toString(16)}`);

  // Col 4 (canvas X 64-71) uses OLD CB ($AA = 10101010): F B F B F B F B
  for (let i = 0; i < 8; i++) {
    const want = (i % 2 === 0) ? fg : bg;
    const got = vic.fb32[ro + 64 + i];
    expect(got === want,
      `col 4 X=${64 + i}: $AA bit ${7 - i}=${(0xAA >> (7-i)) & 1} → ${want === fg ? 'fg' : 'bg'}, got 0x${got.toString(16)}`);
  }
  // Col 5 (canvas X 72-79) uses NEW CB ($55 = 01010101): B F B F B F B F
  for (let i = 0; i < 8; i++) {
    const want = (i % 2 === 0) ? bg : fg;
    const got = vic.fb32[ro + 72 + i];
    expect(got === want,
      `col 5 X=${72 + i}: $55 bit ${7 - i}=${(0x55 >> (7-i)) & 1} → ${want === fg ? 'fg' : 'bg'}, got 0x${got.toString(16)}`);
  }
  ok('Bauer §3.7.4 + §3.6.3: mid-line $D018 CB change splits glyph at g-access cycle (col 5 = first NEW-CB after cy-20 phi2 write)');
}

console.log(`\n${testNo} g-access / shifter / ghost-byte spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
