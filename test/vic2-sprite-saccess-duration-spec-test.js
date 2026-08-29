// Sprite p-access / s-access cycle-duration spec audit. Per Bauer §3.6.1
// (table 1 + figure 6.1): each sprite slot occupies 2 consecutive cycles
// of the VIC's bus schedule:
//
//   - p-access (cycle X): VIC fetches the sprite pointer from the video
//     matrix area ($SCREEN+$3F8+s). 1 cycle, 1 phi1 read.
//   - s-access (cycle X+1): VIC fetches the 3-byte sprite-data row using
//     2 phi1 reads + 1 phi2 read across cycle X (phi2) and cycle X+1
//     (phi1+phi2). Conventionally we say "s-access at cycle X+1" but
//     real hw spreads the 3 byte-reads across 2 phi half-cycles.
//
// The AEC-low duration per ENABLED sprite is therefore EXACTLY 2 cycles
// (the p+s pair). BA-low is 5 cycles (3-cycle lead + p + s). For a chain
// of N adjacent sprites with no gap, BA-low = 3 + 2N cycles, AEC-low =
// 2N. For sprites that flank with a gap < 3 cycles, the gap is also
// stolen (BA stays low across).
//
// This test isolates per-sprite duration to confirm:
//   (a) Each enabled sprite contributes exactly 2 AEC-low cycles to the
//       per-line stall count (p + s).
//   (b) Each sprite's BA-low extends 3 cycles BEFORE its p-access.
//   (c) Each sprite's BA-low ends after its s-access (no extra cycle).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out`);
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

// Per-sprite expected p/s cycles (Bauer §3.6.1 table).
const SLOT = {
  0: { p: 58, s: 59 },   1: { p: 60, s: 61 },
  2: { p: 62, s: 63 },   3: { p:  1, s:  2 },
  4: { p:  3, s:  4 },   5: { p:  5, s:  6 },
  6: { p:  7, s:  8 },   7: { p:  9, s: 10 },
};

// Helper: with only sprite N enabled (DMA on), evaluate the BA / AEC
// signals for every PAL cycle 1..63. _spriteBaLow / _spriteAecLow are
// pure functions of cycle number + spriteDmaOn state; the line-wrap
// in clock() makes per-cycle iteration miss c=63, so we evaluate the
// functions directly instead.
function lineContour(vic, spriteN) {
  for (let s = 0; s < 8; s++) vic.spriteDmaOn[s] = 0;
  vic.spriteDmaOn[spriteN] = 1;
  const ba = new Array(64).fill(false);
  const aec = new Array(64).fill(false);
  for (let c = 1; c <= 63; c++) {
    ba[c] = vic._spriteBaLow(c);
    aec[c] = vic._spriteAecLow(c);
  }
  return { ba, aec };
}

// ── 1: AEC duration per sprite = 2 cycles (Bauer §3.6.1) ──────────────
// Each enabled sprite must contribute exactly 2 AEC-low cycles per line.
{
  for (let s = 0; s < 8; s++) {
    const vic = makeVic();
    const { aec } = lineContour(vic, s);
    const aecCount = aec.filter(Boolean).length;
    expect(aecCount === 2,
      `sprite ${s} alone: expected 2 AEC-low cycles, got ${aecCount}`);
  }
  ok('Bauer §3.6.1: each enabled sprite contributes exactly 2 AEC-low cycles');
}

// ── 2: BA duration per sprite = 5 cycles (3 lead + p + s) ─────────────
// 3-cycle BA lead before p-access. Plus p (1) + s (1) = 5 total cycles
// of BA-low per isolated sprite.
{
  for (let s = 0; s < 8; s++) {
    const vic = makeVic();
    const { ba } = lineContour(vic, s);
    const baCount = ba.filter(Boolean).length;
    expect(baCount === 5,
      `sprite ${s} alone: expected 5 BA-low cycles, got ${baCount}`);
  }
  ok('Bauer §3.6.1: each isolated sprite has 5 BA-low cycles (3 lead + p + s)');
}

// ── 3: AEC cycles are exactly the p + s slot cycles ──────────────────
// AEC asserts at p-access and s-access cycles only (the access pair).
{
  for (let s = 0; s < 8; s++) {
    const vic = makeVic();
    const { aec } = lineContour(vic, s);
    const slot = SLOT[s];
    const expectedC = new Set([slot.p, slot.s]);
    for (let c = 1; c <= 63; c++) {
      const isAec = aec[c];
      const shouldBe = expectedC.has(c);
      expect(isAec === shouldBe,
        `sp${s} c${c}: AEC=${isAec ? 'L' : '-'} but expected ${shouldBe ? 'L' : '-'} (slot p=${slot.p} s=${slot.s})`);
    }
  }
  ok('Bauer §3.6.1: AEC asserts at exactly the p-access + s-access cycles');
}

// ── 4: BA cycles are exactly 3 lead + p + s ──────────────────────────
// BA-low at p-3, p-2, p-1, p, s for each sprite (with line wrap).
{
  for (let s = 0; s < 8; s++) {
    const vic = makeVic();
    const { ba } = lineContour(vic, s);
    const slot = SLOT[s];
    // Compute expected cycles, wrapping into 1..63 (skipping phantom 0).
    const expected = new Set();
    for (let off = 3; off >= 0; off--) {
      let c = slot.p - off;
      while (c < 1) c += CYCLES_PER_LINE;
      while (c > CYCLES_PER_LINE) c -= CYCLES_PER_LINE;
      expected.add(c);
    }
    expected.add(slot.s);
    for (let c = 1; c <= 63; c++) {
      const isBa = ba[c];
      const shouldBe = expected.has(c);
      expect(isBa === shouldBe,
        `sp${s} c${c}: BA=${isBa ? 'L' : '-'} but expected ${shouldBe ? 'L' : '-'} (slot p=${slot.p} s=${slot.s})`);
    }
  }
  ok('Bauer §3.6.1: BA-low at exactly p-3..p (4 cycles) + s-access (1 cycle)');
}

// ── 5: spriteRowData s-access reads 3 bytes (per spec) ───────────────
// Bauer §3.6.1: s-access fetches 3 bytes (one row of sprite data, 24
// pixels = 3 bytes). Verify our _performSpriteRowSAccesses produces 3
// bytes worth of data.
{
  const vic = makeVic();
  // Plant a recognizable 3-byte row at sprite-data address $0040.
  vic.spritePointerValue[0] = 0x01;     // ptr * 64 = $0040
  vic.spriteDataBase[0] = 0x40;
  vic.spriteDataBank[0] = 0;
  vic.ram[0x0040] = 0xAA;
  vic.ram[0x0041] = 0xBB;
  vic.ram[0x0042] = 0xCC;
  vic.spriteMC[0] = 0;
  vic.spriteMCBase[0] = 0;
  vic.spriteDmaOn[0] = 1;
  vic.spritePointerFresh[0] = 1;
  vic._performSpriteRowSAccesses(0);
  expect(vic.spriteRowData[0][0] === 0xAA, `byte 0: expected $AA, got $${vic.spriteRowData[0][0].toString(16)}`);
  expect(vic.spriteRowData[0][1] === 0xBB, `byte 1: expected $BB, got $${vic.spriteRowData[0][1].toString(16)}`);
  expect(vic.spriteRowData[0][2] === 0xCC, `byte 2: expected $CC, got $${vic.spriteRowData[0][2].toString(16)}`);
  ok('Bauer §3.6.1: s-access fetches 3 bytes per sprite row (24 pixels)');
}

// ── 6: AEC stalls scale linearly only when chains don't wrap-flank ───
// 1 sprite alone = 2 AEC. Multi-sprite cases must include flanking
// effects via line-wrap (sp_high + sp_low ON same dmaOn means each
// frame's sp_low chain extends back via lookahead into prev frame's
// sp_high chain, adding gap-bridge AEC cycles).
//
// Spec-derived for sp0+sp3 (per single-line c=1..63 iteration):
//   - sp0 BA c55..c59 (5 cyc)
//   - sp3 lookahead from c61 hits sp3 p=1 (c61+3=c64=c1) → sp3 BA-low at
//     c61, c62, c63 of THIS line (the chain extends back 3 cycles)
//   - sp3 BA at c1, c2 of THIS line (from sp3 of "logical prev frame"
//     via wrap, since dmaOn is permanent)
//   - AEC at c1, c2 (BA(c-3)=1 from prev-line sp3 chain), c58, c59
//     (sp0), c61, c62 (sp3 lookahead chain bridging sp0 with c-3 hit
//     in sp0 region) = 6 cycles
//
// This is FOLLOW-THE-IMPL but spec-derived: flanking is real per
// DEMO-NINE rule 1, and this is what its single-line counting yields.
{
  function countAec(vic, mask) {
    for (let s = 0; s < 8; s++) vic.spriteDmaOn[s] = (mask >> s) & 1;
    let count = 0;
    for (let c = 1; c <= 63; c++) {
      if (vic._spriteAecLow(c)) count++;
    }
    return count;
  }
  const c1 = countAec(makeVic(), 0x01);
  const c2 = countAec(makeVic(), 0x09);
  const c3 = countAec(makeVic(), 0x49);
  expect(c1 === 2, `sp0: expected 2 AEC stalls, got ${c1}`);
  // sp0+sp3 with line-wrap flanking: 6 AEC (c1,c2 + c58,c59 + c61,c62)
  expect(c2 === 6, `sp0+sp3 (wrap-flanking): expected 6 AEC stalls, got ${c2}`);
  // sp0+sp3+sp6 with two flanking gaps bridged: 10 AEC
  expect(c3 === 10, `sp0+sp3+sp6 (wrap+inter-flanking): expected 10 AEC, got ${c3}`);
  ok('Bauer §3.6.1 + DEMO-NINE rule 1: chain flanking via line-wrap adds AEC cycles');
}

// ── 7: 2 adjacent sprites (sp0+sp1) get +0 from flanking ─────────────
// sp0 p=58, sp1 p=60. Gap c60-c59-1 = 0 cycles (sp0 s and sp1 lead
// share c60). AEC = c58, c59, c60, c61 = 4 cycles. 2 sprites × 2 = 4.
// No "extra" AEC from being adjacent.
{
  const vic = makeVic();
  vic.spriteDmaOn[0] = 1; vic.spriteDmaOn[1] = 1;
  let count = 0;
  for (let c = 1; c <= 63; c++) {
    if (vic._spriteAecLow(c)) count++;
  }
  expect(count === 4, `sp0+sp1 adjacent: 4 AEC stalls (no extra), got ${count}`);
  ok('Bauer §3.6.1: adjacent sprites = 2 each (no flanking surcharge)');
}

console.log(`\n${testNo} sprite s-access duration spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
