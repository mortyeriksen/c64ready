// Sub-cycle sprite-X vs same-cycle register-write spec test.
//
// Bauer §3.6.1 (X-counter) + §3.8.1: a sprite fires once per line at the pixel
// where the X-counter equals its live MxX (X reg + $D010 MSB). A CPU write to a
// sprite-X register ($D000-$D00E even / $D010) at PHI2 of a cycle is seen by the
// per-pixel X-comparator for the phi2-half pixels (canvas X & 4 != 0 within the
// cycle) of that same cycle. The VICE spritex testsuite C64 column proves the
// boundary is exactly the phi1/phi2 split (at a fixed write cycle the old->new
// flip is X=95 (phi1, OLD) vs X=96 (phi2, NEW)).
//
// Our cycle-incremental render runs at PHI1 (before the CPU phi2 write), so the
// just-rendered segment used the pre-write X. _applySpriteXSameCycleFixup (run
// from phi2(), after the write) re-renders that segment with the corrected X.
//
// Real-world case: The Hat (disk A) "GENESIS PROJECT" logo. Sprite 0 sits at
// X=8 (canvas 16); its match is in the phi2-half of cycle 14, and the demo
// writes $D010 at cy14 to set sprite 0..4's MSB. On a 6569 the write catches
// sprite 0 -> it displays HIGH (canvas 272), not LOW (canvas 16). Without the
// fixup sprite 0 stays low: the left-border text collapses and the logo's
// right third is a black column.
//
// This drives a full master cycle (vic.clock = phi1 render, then the CPU phi2
// write, then vic.phi2() = fixup) so the fixup is exercised. (Registered in
// test/all-test.js.)

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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
  vic.regs[0x11] = 0x1b;   // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;   // CSEL=1
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0e;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;
  for (let b = 0; b < 64; b++) vic.ram[0x0800 + b] = 0xFF;  // solid sprite 0 data
  vic.ram[0x07F8] = 0x20;                                    // sprite 0 pointer -> $0800
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety > 0 && !(vic.raster === raster && vic.cycleInLine === cycle)) vic.clock(1);
  if (safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
}

function spriteSpan(vic, canvasY, sprite = 0) {
  const ro = canvasY * CANVAS_W;
  let first = -1, last = -1, count = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === sprite) { if (first < 0) first = x; last = x; count++; }
  }
  return { first, last, count };
}

// Display sprite 0 at low X=8 (canvas 16), then on raster 55 write $D010 (set
// sprite 0 MSB -> X=264, canvas 272) as a CPU phi2 write at the given cycle,
// driving a full master cycle (clock = phi1, write = CPU phi2, phi2 = fixup).
function lineWithMsbWrite(writeCyc) {
  const vic = makeVic();
  vic.regs[0x15] = 0x01;   // enable sprite 0
  vic.regs[0x01] = 50;     // Y=50
  vic.regs[0x00] = 8;      // X low = 8  -> canvas 16
  vic.regs[0x10] = 0x00;   // MSB clear
  const R = 55;            // a line where sprite 0 is displaying
  driveTo(vic, R, writeCyc);   // phi1 of writeCyc: segment (writeCyc-1) rendered
  vic.write(0x10, 0x01);       // CPU phi2 write: set sprite 0 MSB
  vic.phi2();                  // VIC phi2: same-cycle-write fixup
  driveTo(vic, R + 1, 0);   // cy0 of next line: line R rendered, not yet cleared (#1)
  return spriteSpan(vic, R - 15, 0);
}

// ── 1: write at sprite 0's match cycle (cy14, phi2-half) catches it -> HIGH ──
{
  const s = lineWithMsbWrite(14);
  expect(s.count > 0 && s.first >= 260,
    `cy14 $D010 write must catch sprite 0 -> HIGH (canvas ~272), got first=${s.first} count=${s.count}`);
  ok('Bauer §3.8.1: $D010 write at the phi2-half match cycle catches sprite 0 (-> HIGH @272)');
}

// ── 2: write one cycle too late (cy15) misses the match -> sprite stays LOW ──
{
  const s = lineWithMsbWrite(15);
  expect(s.count > 0 && s.first < 100,
    `cy15 $D010 write is too late; sprite 0 stays LOW (canvas ~16/32), got first=${s.first} count=${s.count}`);
  ok('Bauer §3.8.1: $D010 write after the match cycle does NOT catch sprite 0 (-> LOW)');
}

console.log(`\n${testNo} sub-cycle sprite-X same-cycle-write spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
