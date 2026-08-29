// AEC is the BA *delay line* (Bauer §3.6.1): AEC goes low only after BA has
// been low for 3 CONTINUOUS cycles, and a single BA-high cycle resets the
// delay. The historical AEC sampler (_spriteAecLowHistoric, used by
// isAecLowPhi2 → the CPU write-stall gate) must therefore require BA low at
// c-1, c-2 AND c-3 — not just the c-3 endpoint.
//
// Why this matters (regression guard for Coma Light 13's FLI plasma):
// the endpoint-only test BA(c) && BA(c-3) is identical to the contiguous test
// for any unbroken BA-low run (sprite DMA, natural bad line), but WRONG across
// a 1-cycle gap. Coma's per-line FLI loop produces exactly such a gap: the
// sprite-DMA tail holds BA low through cy10, BA rises at cy11, then a
// *cancelled* bad line pulls BA low again at cy12-13. With endpoint-only AEC,
// the cy9/cy10 sprite tail (c-3 of cy12/cy13) made AEC read low at cy12-13 and
// stalled the pending STY $D011 store 2 cycles — creeping it past the FLI
// cancel deadline and collapsing the plasma into flat horizontal bands. With
// the delay-line model, the BA-high cy11 keeps AEC high so the store lands on
// time and the bad line cancels every line.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  vic.regs[0x15] = 0x00;       // sprites OFF → _spriteBaLow() is always false
  vic.displayEnabled = true;
  return vic;
}

// Force _isBaLowCycle(cycle) true for the current cycle via a pending bad-line
// (clause b of _isBadLineBaLow: BA low from startCycle-3..54). Then ask AEC.
function aecAt(vic, cycle, extBa) {
  vic.cycleInLine = cycle;
  vic._thisCycleInLine = cycle;
  vic.lineBadLineDisplayPending = true;   // makes _isBadLineBaLow(cycle>=12) true
  vic.lineBadLineStartCycle = 15;
  vic.lineMatrixFetchCol = -1;
  // Populate the per-cycle external-BA history (sprite || bad-line) buffer.
  vic.lineCycleExternalBaLow.fill(0);
  for (const [c, v] of Object.entries(extBa)) vic.lineCycleExternalBaLow[+c] = v;
  return vic.isAecLowPhi2();
}

// ── Test 1: contiguous BA-low run → AEC LOW at the 4th cycle ──────────
// BA low at cy9,10,11 and (live) cy12 → 4 contiguous → AEC low at cy12.
{
  const vic = makeVic();
  const aec = aecAt(vic, 12, { 9: 1, 10: 1, 11: 1 });
  expect(aec === true, `contiguous BA-low cy9..cy12: AEC must be LOW at cy12; got ${aec}`);
  ok('contiguous 3-cy BA-low warning → AEC low at the 4th cycle');
}

// ── Test 2: 1-cycle BA-high GAP at c-1 → AEC stays HIGH ───────────────
// The Coma case: BA low cy9,10 (sprite tail), HIGH cy11, low cy12 (cancelled
// bad line). The gap at cy11 resets the delay line → AEC high at cy12.
{
  const vic = makeVic();
  const aec = aecAt(vic, 12, { 9: 1, 10: 1, 11: 0 });
  expect(aec === false,
    `gap at cy11 (BA high) must reset the AEC delay line → AEC HIGH at cy12; got ${aec}`);
  ok('1-cy BA-high gap at c-1 resets the delay line → AEC high (Coma FLI cancel)');
}

// ── Test 3: gap at c-2 also keeps AEC high ────────────────────────────
{
  const vic = makeVic();
  const aec = aecAt(vic, 13, { 10: 1, 11: 0, 12: 1 });
  expect(aec === false,
    `gap at cy11 (c-2 of cy13) must keep AEC HIGH at cy13; got ${aec}`);
  ok('BA-high gap at c-2 keeps AEC high (only 2 contiguous low cycles)');
}

// ── Test 4: endpoint-only would have lied here — the discriminating case ─
// BA low at c-3 and c (endpoints) but HIGH in between. Old BA(c)&&BA(c-3)
// returned AEC-low; the delay-line model returns AEC-high.
{
  const vic = makeVic();
  const aec = aecAt(vic, 15, { 12: 1, 13: 0, 14: 1 });
  expect(aec === false,
    `endpoints low (cy12,cy15) but gap at cy13/14 → AEC must be HIGH; got ${aec}`);
  ok('endpoint-low / middle-high pattern → AEC high (delay-line, not endpoint test)');
}

// ── Test 5: prev-line wrap — the c-1/c-2/c-3 lookback crosses the line ─
// At cy1, the lookback indices are 0, -1, -2, which must wrap to cy63, 62, 61
// of the PREVIOUS line (prevLineExternalBaLow). Pin both polarities directly
// on the helper so the wrap can't silently break.
{
  const vic = makeVic();
  vic.lineCycleExternalBaLow.fill(0);
  vic.prevLineExternalBaLow.fill(0);
  // Contiguous tail of the previous line: cy61,62,63 all BA-low.
  vic.prevLineExternalBaLow[61] = 1;
  vic.prevLineExternalBaLow[62] = 1;
  vic.prevLineExternalBaLow[63] = 1;
  expect(vic._historicExternalBaLow(0) === true, `wrap: c=0 → prevLine[63]; got ${vic._historicExternalBaLow(0)}`);
  expect(vic._historicExternalBaLow(-1) === true, `wrap: c=-1 → prevLine[62]; got ${vic._historicExternalBaLow(-1)}`);
  expect(vic._historicExternalBaLow(-2) === true, `wrap: c=-2 → prevLine[61]; got ${vic._historicExternalBaLow(-2)}`);
  // A gap at cy62 of the previous line must read back as BA-high.
  vic.prevLineExternalBaLow[62] = 0;
  expect(vic._historicExternalBaLow(-1) === false, `wrap: prevLine[62] gap → BA-high; got ${vic._historicExternalBaLow(-1)}`);
  ok('c-1/c-2/c-3 contiguity lookback wraps into the previous line correctly');
}

console.log(`\n${testNo} AEC BA-gap contiguity spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
