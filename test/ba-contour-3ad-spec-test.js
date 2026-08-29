// BA-low contour spec test for the 3AD demo's sprite-DMA configuration.
//
// Per Bauer §3.6.1 + §3.8.1 + VIC-Addendum sprite cycle layout (PAL 6569):
//
//   sprite N  | p-access | s-access | BA lookahead window
//   ----------+----------+----------+-----------------------
//      0      |   cy 58  |  cy 59   |  cy 55..59 of line N-1
//      1      |   cy 60  |  cy 61   |  cy 57..61 of line N-1
//      2      |   cy 62  |  cy 63   |  cy 59..63 of line N-1
//      3      |   cy  1  |  cy  2   |  cy 61..63 of line N-1 + 0..2 of N
//      4      |   cy  3  |  cy  4   |  cy  0..4  of line N
//      5      |   cy  5  |  cy  6   |  cy  2..6  of line N
//      6      |   cy  7  |  cy  8   |  cy  4..8  of line N
//      7      |   cy  9  |  cy 10   |  cy  6..10 of line N
//
// Flanking rule (§3.6.1): between two enabled sprite DMA windows whose
// gaps are < 3 cycles, BA does NOT release. The union of adjacent windows
// holds BA low.
//
// 3AD demo state at the IRQ-target line (raster 29):
//   - Sprites 0-6: Y=9, enabled, DMA-on (line 29 = last display line)
//   - Sprite 7:    Y=0, enabled, but display range was lines 0..20.
//                  DMA was cleared by MCBASE=63 on line 21, so on line 29
//                  sprite 7's DMA flag is OFF.
//
// Expected BA-low → BA-high release cycle on the line-29→30 boundary
// (DMA window for display on line 30, with sp0-6 DMA-on and sp7 DMA-off):
//
//                 BA-release at r30 c9
//
// If our BA model is off by 1+ cycles, that would explain the +1 cycle
// of BA stall vs VICE seen in the third-party handler-path comparison.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  return vic;
}

function setup3adState(vic) {
  vic.regs[0x15] = 0xFF;                       // all 8 enabled
  vic.regs[0x10] = 0x60;
  vic.regs[0x17] = 0x00;
  vic.regs[0x11] = 0x00;
  const xs = [24, 72, 120, 168, 216, 8, 56, 0];
  const ys = [ 9,  9,  9,   9,   9, 9,  9, 0];
  for (let s = 0; s < 8; s++) { vic.regs[s*2] = xs[s]; vic.regs[s*2+1] = ys[s]; }
}

function sample(vic) {
  return {
    r: vic.raster, cy: vic.cycleInLine,
    baLow: !!vic.isBaLow?.(),
    aecLow: !!(vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow?.()),
    dmaOn: Array.from(vic.spriteDmaOn),
  };
}

// ── 1: Demo state — sp7 DMA cleared on line 29; line-29→30 DMA window
//      releases BA at r30 c9 (Bauer §3.6.1).
{
  const vic = makeVic();
  setup3adState(vic);

  // Run for ~2 frames so the sprite-DMA state machine settles into the
  // demo's steady state: sp0-6 DMA continually re-armed by Y=9 match
  // (display lines 9..29 each frame), sp7 DMA cleared after line 20.
  const cyclesPerFrame = CYCLES_PER_LINE * 312;
  for (let i = 0; i < cyclesPerFrame * 2; i++) vic.clock(1);

  // Advance to line 29 cy 0.
  while (vic.raster !== 29 || vic.cycleInLine !== 0) vic.clock(1);

  // Confirm DMA flag state matches the demo's snapshot expectation.
  console.log('     line 29 cy 0:   spriteDmaOn=' + Array.from(vic.spriteDmaOn).join(','));
  expect(vic.spriteDmaOn[7] === 0,
    `sp7 (Y=0) DMA must be cleared by line 29 (its last display line was 20), got dmaOn[7]=${vic.spriteDmaOn[7]}`);
  for (let s = 0; s < 7; s++) {
    expect(vic.spriteDmaOn[s] === 1,
      `sp${s} (Y=9) DMA must be on at line 29 (within display range 9..29), got dmaOn[${s}]=${vic.spriteDmaOn[s]}`);
  }

  // Sample BA across the line-29→30 boundary.
  const samples = [];
  let snapshotAtLine29End = null;   // captured immediately after r29 c63 runs
  while (true) {
    vic.clock(1);
    samples.push(sample(vic));
    // Snap the line-29 contour right after r29 c63 — before line wrap zeros it.
    // After clock(1) finishing r29 c63, cycleInLine wraps to 0 and raster→30.
    // So the FIRST cycle where vic.raster===30 captures line 29's contour.
    if (vic.raster === 30 && vic.cycleInLine === 0 && !snapshotAtLine29End) {
      snapshotAtLine29End = Array.from(vic.lineCycleExternalBaLow);
    }
    if (vic.raster === 30 && vic.cycleInLine === 20) break;
    if (samples.length > 200) break;
  }

  // Diagnostic: was the line-29 BA contour actually recorded?
  if (snapshotAtLine29End) {
    console.log('     line 29 lineCycleExternalBaLow at end-of-line (before wrap):');
    const interesting = [50, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63];
    for (const c of interesting) console.log(`       [${c}] = ${snapshotAtLine29End[c]}`);
  }

  // Find the BA release for the sprite-DMA window that fires for display
  // on line 30 (= cy 55+ of line 29 through some cy on line 30).
  let releaseCy = null;
  let inRelevantWindow = false;
  let prevLow = false;
  for (const s of samples) {
    if (s.r === 29 && s.cy >= 55) inRelevantWindow = inRelevantWindow || s.baLow;
    if (s.r === 30) inRelevantWindow = inRelevantWindow || s.baLow;
    if (inRelevantWindow && prevLow && !s.baLow) { releaseCy = { r: s.r, cy: s.cy }; break; }
    prevLow = s.baLow;
  }
  expect(releaseCy !== null, 'expected to observe a BA low→high transition for the line-30-display window');
  if (releaseCy) {
    console.log(`     line-30-display window BA-release: r${releaseCy.r} c${releaseCy.cy} (Bauer expects r30 c9)`);
    expect(releaseCy.r === 30 && releaseCy.cy === 9,
      `BA-release expected r30 c9 per Bauer §3.6.1 (sp0-6 DMA-on, sp7 DMA-off); got r${releaseCy.r} c${releaseCy.cy}`);
  }
  ok('3AD demo state → BA-release at r30 c9 (matches Bauer §3.6.1)');
}

// ── 2: AEC-release lags BA-release by exactly 3 cycles (Bauer §3.6.1)
//      AEC follows BA after 3 cycles of warning. Should release at r30 c12.
{
  const vic = makeVic();
  setup3adState(vic);
  const cyclesPerFrame = CYCLES_PER_LINE * 312;
  for (let i = 0; i < cyclesPerFrame * 2; i++) vic.clock(1);
  while (vic.raster !== 29 || vic.cycleInLine !== 0) vic.clock(1);

  const samples = [];
  while (true) {
    vic.clock(1);
    samples.push(sample(vic));
    if (vic.raster === 30 && vic.cycleInLine === 20) break;
    if (samples.length > 200) break;
  }

  let baRelease = null, aecRelease = null;
  let inRelevantWindow = false;
  let prevBa = false, prevAec = false;
  for (const s of samples) {
    if (s.r === 29 && s.cy >= 55) inRelevantWindow = inRelevantWindow || s.baLow;
    if (s.r === 30) inRelevantWindow = inRelevantWindow || s.baLow;
    if (inRelevantWindow && prevBa && !s.baLow && !baRelease) baRelease = s;
    if (inRelevantWindow && prevAec && !s.aecLow && !aecRelease) aecRelease = s;
    prevBa = s.baLow;
    prevAec = s.aecLow;
  }
  // Diagnostic dump: BA/AEC sequence across the relevant window.
  console.log('     BA/AEC sequence around line-29→30 boundary:');
  let lastBa = null, lastAec = null;
  for (const s of samples) {
    if (s.r === 29 && s.cy < 55) continue;
    if (s.r === 30 && s.cy > 15) break;
    if (s.baLow !== lastBa || s.aecLow !== lastAec) {
      console.log(`       r${s.r} c${String(s.cy).padStart(2)}   BA=${s.baLow?'low':'HIGH'}   AEC=${s.aecLow?'low':'HIGH'}`);
      lastBa = s.baLow; lastAec = s.aecLow;
    }
  }
  // Direct probe of the historic-BA buffer the AEC formula reads at cy 1.
  console.log('     prevLineExternalBaLow at relevant cycles:');
  for (const c of [55, 58, 60, 61, 62, 63]) {
    console.log(`       prevLineExternalBaLow[${c}] = ${vic.prevLineExternalBaLow[c]}`);
  }
  console.log('     lineCycleExternalBaLow at relevant cycles:');
  for (const c of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    console.log(`       lineCycleExternalBaLow[${c}] = ${vic.lineCycleExternalBaLow[c]}`);
  }
  // Bauer §3.6.1: once AEC has been pulled low (3 cycles after BA-low
  // onset), it remains low for as long as BA remains continuously low.
  // It must NOT toggle high while BA is still low.
  //
  // Locate the cycles where AEC has already asserted (first AEC-low after
  // BA-low onset of the line-30-display window) and BA is still low. AEC
  // must be low at every one of those.
  let aecAssertedAt = null;
  const violations = [];
  let windowStartCy = null;
  for (const s of samples) {
    if (s.r === 29 && s.cy < 55) continue;
    if (s.r === 30 && s.cy > 12) break;
    if (windowStartCy === null && s.baLow) windowStartCy = s;
    if (!s.baLow) break;                          // window ended (BA released)
    if (aecAssertedAt === null && s.aecLow) aecAssertedAt = s;
    if (aecAssertedAt !== null && !s.aecLow) {
      violations.push({ r: s.r, cy: s.cy });
    }
  }
  expect(windowStartCy !== null, 'sprite-DMA BA-low window must be observed');
  expect(aecAssertedAt !== null, 'AEC must assert low at some point during the BA-low window');
  expect(violations.length === 0,
    `Bauer §3.6.1: AEC must remain low while BA is continuously low. Observed ${violations.length} cycle(s) where AEC went HIGH while BA was still low: ` +
    violations.slice(0, 5).map(v => `r${v.r}c${v.cy}`).join(', '));
  ok('AEC stays low for the entire BA-low window (no mid-window glitch)');
}

console.log(`\n${testNo} BA-contour spec tests for 3AD demo config; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
