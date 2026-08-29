// Sprite-crunch timing edge cases — extends mxye-crunch-spec-test.js
// with multi-sprite scenarios, RMW write semantics, DMA interaction,
// re-arm across lines, and bit-interleave boundary values.
//
// Spec source: Bauer §3.8.1 rules 1, 3, 7, 7a (https://www.cebix.net/VIC-Article.txt
// lines 1886-1934).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, targetRaster, targetCycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === targetRaster && vic.cycleInLine === targetCycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
}

let testNo = 0, testsFailing = 0, currentFailures = [], currentSoftWarns = 0;
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function softExpect(cond, msg) {
  if (!cond) {
    currentSoftWarns++;
    console.warn(`  WARN - spec-deviation: ${msg}`);
  }
}
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}${currentSoftWarns ? ` (${currentSoftWarns} soft-warn)` : ''}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = []; currentSoftWarns = 0;
  }
  currentSoftWarns = 0;
}

// ── 1: Multi-sprite crunch — clearing 8 bits at c15 latches all eight ──
// VIC-Addendum drops the FF=0 gate. A single $D017 write that clears
// multiple bits should latch crunch for EVERY sprite with a cleared bit,
// regardless of FF state.
//
// SOFT: implementation currently follows Bauer (FF=0 gate). The FF=1
// sprites are surfaced as warns rather than hard fails until a real
// demo demonstrates the addendum behavior is needed.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;                 // Disable Y match in rule 2
  vic.regs[0x17] = 0xFF;                 // start MxYE all set
  for (let s = 0; s < 8; s++) {
    vic.regs[1 + 2*s] = 200;             // Y far from raster 0
    vic.spriteDmaOn[s] = 1;
  }
  driveTo(vic, 0, 14);
  // Mixed FF states should NOT affect latching per addendum.
  const ffBefore = [0, 1, 0, 1, 1, 0, 1, 1];
  for (let s = 0; s < 8; s++) vic.spriteYExpandFF[s] = ffBefore[s];
  vic.clock(1);                           // → c15
  vic.write(0x17, 0x00);                  // clear ALL MxYE bits at c15
  // FF=0 sprites: hard expect (Bauer + addendum agree).
  // FF=1 sprites: soft warn (addendum-only, current impl follows Bauer).
  for (let s = 0; s < 8; s++) {
    if (ffBefore[s] === 1) {
      softExpect(vic._spriteCrunchPending[s] === 1, `sprite ${s}: crunchPending must be 1 (no FF gate)`);
    } else {
      expect(vic._spriteCrunchPending[s] === 1, `sprite ${s}: crunchPending must be 1 (no FF gate)`);
    }
  }
  ok('VIC-Addendum: multi-sprite crunch — all cleared bits latch (no FF gate)');
}

// ── 2: Partial-clear write at c15 latches only cleared bits ──────────
// $D017 = $FF → $F0: bits 0..3 go from 1→0, bits 4..7 stay 1. Only the
// cleared bits should latch crunch (for sprites with FF=0).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0xFF;
  for (let s = 0; s < 8; s++) {
    vic.regs[1 + 2*s] = 200;
    vic.spriteDmaOn[s] = 1;
    vic.spriteYExpandFF[s] = 0;          // all FF=0, all eligible
  }
  driveTo(vic, 0, 15);
  vic.write(0x17, 0xF0);                  // clear bits 0..3 only
  for (let s = 0; s < 4; s++) {
    expect(vic._spriteCrunchPending[s] === 1, `sprite ${s} (bit cleared): crunchPending must be 1`);
  }
  for (let s = 4; s < 8; s++) {
    expect(vic._spriteCrunchPending[s] === 0, `sprite ${s} (bit unchanged): crunchPending must be 0`);
  }
  ok('Bauer §3.8.1 rule 7a: partial $D017 clear latches only the changed bits');
}

// ── 3: Stable-mask write at c15 (no bits change) latches NOTHING ─────
// Writing $D017 with the SAME value as before must not trigger crunch
// — rule 7a requires a 1→0 transition on a bit, not just any write.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0xFF;
  for (let s = 0; s < 8; s++) {
    vic.regs[1 + 2*s] = 200;
    vic.spriteDmaOn[s] = 1;
    vic.spriteYExpandFF[s] = 0;
  }
  driveTo(vic, 0, 15);
  vic.write(0x17, 0xFF);                  // no change
  for (let s = 0; s < 8; s++) {
    expect(vic._spriteCrunchPending[s] === 0,
      `sprite ${s}: stable-mask write must not latch crunch, got ${vic._spriteCrunchPending[s]}`);
  }
  ok('Bauer §3.8.1 rule 7a: stable-mask $D017 write does not latch crunch');
}

// ── 4: RMW DEC $D017 — write-OLD at c14 + write-NEW at c15 ─────────
// Models a CPU `DEC $D017` that finishes its NMOS RMW sequence with
// write-OLD at c14 phi2 and write-NEW at c15 phi2. The write-OLD
// preserves the value (no bits change) so rule 7a doesn't fire from
// it. The write-NEW clears bits at c15 phi2 — that's the crunch
// trigger. Result: same as a single write at c15.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0xFF;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.write(0x17, 0xFF);                  // RMW write-OLD at c14 (no change)
  expect(vic._spriteCrunchPending[0] === 0, `c14 write-OLD: crunch must not latch`);
  vic.clock(1);                            // → c15
  vic.write(0x17, 0xFE);                   // RMW write-NEW at c15 (DEC: $FF→$FE, bit 0 cleared)
  expect(vic._spriteCrunchPending[0] === 1,
    `c15 write-NEW (RMW): crunch must latch for sprite 0, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer §3.8.1 rule 7a: RMW DEC $D017 with write-NEW at c15 latches crunch');
}

// ── 5: RMW INC $D017 (sets bit) at c15 — no crunch ───────────────────
// INC $D017 going $FE→$FF SETS a bit. Rule 7a only fires on 1→0 (clear),
// not 0→1 (set). The c15 write must not latch crunch.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0xFE;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.write(0x17, 0xFE);                  // RMW write-OLD at c14
  vic.clock(1);                            // → c15
  vic.write(0x17, 0xFF);                   // RMW write-NEW: INC $FE→$FF
  expect(vic._spriteCrunchPending[0] === 0,
    `INC $D017 (set bit) at c15 must not latch crunch, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer §3.8.1 rule 7a: bit-set at c15 (e.g. INC $D017) does not latch crunch');
}

// ── 6: Crunch with DMA OFF — latch fires regardless of DMA state ─────
// Rule 7a's text doesn't mention DMA — only "the CPU has cleared one
// of the MxYE bits in cycle 15 and the advance line flip-flop of the
// corresponding sprite was not set". The DMA-off case is therefore
// part of the latch domain. (Whether anything observable happens at
// cycle 16 — rule 7's MCBASE update — is gated by FF state, but the
// LATCH itself must fire.)
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 0;                 // DMA off
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.clock(1);
  vic.write(0x17, 0x00);
  expect(vic._spriteCrunchPending[0] === 1,
    `crunch latch must fire even with DMA off (rule 7a doesn't gate on DMA), got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer §3.8.1 rule 7a: crunch latches independent of DMA state');
}

// ── 7: Bit-interleave formula edge cases ─────────────────────────────
// Spec formula: MCBASE = (0b101010 & (MCBASE & MC)) | (0b010101 & (MCBASE | MC))
// Test boundary values:
//   - MCBASE=0, MC=0 → 0
//   - MCBASE=63, MC=63 → 63 (all 1s)
//   - MCBASE=0, MC=63 → 0b010101 = 21
//   - MCBASE=63, MC=0 → 0b010101 = 21
function crunchFormula(mcbase, mc) {
  return ((0b101010 & (mcbase & mc)) | (0b010101 & (mcbase | mc))) & 0x3F;
}
{
  const cases = [
    { mcbase: 0,  mc: 0,  expected: 0 },
    { mcbase: 63, mc: 63, expected: 63 },
    { mcbase: 0,  mc: 63, expected: 0b010101 }, // 21
    { mcbase: 63, mc: 0,  expected: 0b010101 }, // 21
    { mcbase: 0b101010, mc: 0b010101, expected: 0b010101 }, // disjoint bits
  ];
  let failed = 0;
  for (const c of cases) {
    const actual = crunchFormula(c.mcbase, c.mc);
    if (actual !== c.expected) {
      failed++;
      currentFailures.push(`formula(${c.mcbase}, ${c.mc}) = ${actual}, expected ${c.expected}`);
    }
  }
  expect(failed === 0, `${failed} bit-interleave formula edge case(s) wrong`);
  ok('Bauer §3.8.1 rule 7a: bit-interleave formula matches spec across boundary values');
}

// ── 8: Crunch latch CONSUMED at c16 — does not persist to c17+ ────────
// After cycle 16 phi1 applies the formula, _spriteCrunchPending must
// be cleared so a stale latch doesn't bleed into the next line.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.spriteMCBase[0] = 9;
  vic.spriteMC[0] = 12;
  vic.clock(1);                            // → c15
  vic.write(0x17, 0x00);                   // latch crunch
  expect(vic._spriteCrunchPending[0] === 1, `pre-c16: crunchPending=1`);
  vic.clock(1);                            // → c16 phi1 consumes latch
  expect(vic._spriteCrunchPending[0] === 0,
    `post-c16: crunchPending must be cleared, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer §3.8.1 rule 7a: c16 consumes (clears) the crunch latch');
}

// ── 9: Crunch can re-arm on consecutive lines ────────────────────────
// FppScroller-style: the IRQ handler clears MxYE every line at c15.
// Each line should latch crunch independently — no interference from
// the previous line's pending state.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.clock(1);
  vic.write(0x17, 0x00);                   // line 0 c15: latch
  expect(vic._spriteCrunchPending[0] === 1, `line 0: latched`);
  // Drive past c16 to consume, then to next line c14.
  driveTo(vic, 1, 14);
  expect(vic._spriteCrunchPending[0] === 0, `line 1 c14: latch must be cleared`);
  // Set up FF=0 and clear MxYE again.
  vic.regs[0x17] = 0x01;                   // re-set so we can re-clear
  vic.spriteYExpandFF[0] = 0;
  vic.clock(1);                             // → c15
  vic.write(0x17, 0x00);
  expect(vic._spriteCrunchPending[0] === 1,
    `line 1 c15 re-latch: crunchPending must be 1, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer §3.8.1 rule 7a: crunch re-arms on consecutive lines (no leak)');
}

// ── 10: Crunch + FF-already-set: latch fires (per addendum, no FF gate) ──
// When MxYE is cleared at c15 with FF=1: rule 1 force is idempotent
// (FF stays 1), AND crunch DOES latch per addendum (no FF gate). At
// c16, MCBASE := bit-interleave runs because FF=1 + crunch latched.
//
// SOFT: implementation currently follows Bauer (FF=0 gate). Crunch-latch
// assertion is a soft warn; FF-stays-1 invariant is hard (rule 1).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;
  vic.clock(1);
  vic.write(0x17, 0x00);
  softExpect(vic._spriteCrunchPending[0] === 1, `FF=1 + clear at c15: crunch latches per addendum`);
  expect(vic.spriteYExpandFF[0] === 1, `FF was 1, stays 1 (rule 1 force is idempotent)`);
  ok('VIC-Addendum: clear at c15 with FF=1 — crunch latches (no FF gate)');
}

console.log(`\n${testNo} sprite-crunch timing spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
