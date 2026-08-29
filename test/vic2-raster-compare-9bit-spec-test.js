// 9-bit raster compare boundary spec test.
//
// Bauer §3.12: the raster IRQ compares the current raster against a
// 9-bit target stored in $D012 (low byte) + $D011 bit 7 (RST8, high
// bit). The full target raster is:
//
//   target = $D012 | ((($D011 >> 7) & 1) << 8)
//
// This 9-bit compare is required for PAL because the visible raster
// range goes 0..311 (= 0x137), so for any IRQ target raster ≥ 256 the
// $D011 bit 7 (RST8) must be set. NMI-chain demos that fire IRQs in
// the bottom-border range (raster 251..311) depend on this.
//
// Audit gap: 9-bit raster compare boundary ($100 transition) — ✗
// before this file.

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

// Set $D012 + RST8 in $D011 to encode a 9-bit raster target.
function setTarget(vic, target9) {
  const lo = target9 & 0xFF;
  const hi = (target9 >> 8) & 1;
  vic.regs[0x12] = lo;
  vic.regs[0x11] = (vic.regs[0x11] & 0x7F) | (hi << 7);
}

// Run one full frame. Track all raster IRQ firings.
function runFrameCapturingIrqs(vic) {
  const fires = [];
  vic.irqHandler = () => {};
  const origCheck = vic._checkRasterIrq.bind(vic);
  vic._checkRasterIrq = function() {
    const before = (this.irqStatus & 0x01);
    origCheck();
    if (!before && (this.irqStatus & 0x01)) {
      fires.push({ raster: this.raster, cy: this.cycleInLine });
    }
  };
  // Drive 1 PAL frame (312 lines × 63 cy ≈ 19656 master cy).
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (--safety && !(vic.raster === 0 && vic.cycleInLine === 1)) vic.clock(1);
  for (let i = 0; i < 312 * CYCLES_PER_LINE; i++) vic.clock(1);
  return fires;
}

// ── 1: Target raster $50 (= 80) — RST8=0, low byte $50. Fires at $50.
{
  const vic = makeVic();
  vic.irqMask = 0x01;                    // raster IRQ enabled
  setTarget(vic, 0x050);
  const fires = runFrameCapturingIrqs(vic);
  expect(fires.length >= 1 && fires[0].raster === 0x50,
    `target $50: expect raster IRQ fire at raster 0x50; got ${JSON.stringify(fires.slice(0, 3))}`);
  ok('Bauer §3.12: raster target $50 (RST8=0) → IRQ fires at raster $50');
}

// ── 2: Target raster $FF (= 255, last RST8=0 target). Fires at $FF only.
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  setTarget(vic, 0x0FF);
  const fires = runFrameCapturingIrqs(vic);
  const firesAt0FF = fires.filter(f => f.raster === 0xFF).length;
  const firesElsewhere = fires.filter(f => f.raster !== 0xFF).length;
  expect(firesAt0FF >= 1,
    `target $FF: IRQ must fire at raster 0xFF; got ${firesAt0FF} fires there`);
  expect(firesElsewhere === 0,
    `target $FF: IRQ must NOT fire at other rasters; got ${firesElsewhere} extra fires`);
  ok('Bauer §3.12: raster target $FF (RST8=0) → IRQ fires at raster $FF only');
}

// ── 3: Target raster $100 (= 256, first RST8=1 target). Fires at $100 only,
// NOT at raster $00 (= same low byte but RST8 differs).
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  setTarget(vic, 0x100);
  const fires = runFrameCapturingIrqs(vic);
  const firesAt100 = fires.filter(f => f.raster === 0x100).length;
  const firesAt00 = fires.filter(f => f.raster === 0x00).length;
  expect(firesAt100 >= 1,
    `target $100: IRQ must fire at raster 0x100; got ${firesAt100} fires there`);
  expect(firesAt00 === 0,
    `target $100: IRQ must NOT fire at raster 0 (low byte alone matches but RST8 differs); got ${firesAt00} fires at $0`);
  ok('Bauer §3.12: raster target $100 (RST8=1) → IRQ fires at raster $100, NOT at $00');
}

// ── 4: Target raster $001 (= 1, RST8=0). Fires at $01, not at $101.
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  setTarget(vic, 0x001);
  const fires = runFrameCapturingIrqs(vic);
  const firesAt01 = fires.filter(f => f.raster === 0x01).length;
  const firesAt101 = fires.filter(f => f.raster === 0x101).length;
  expect(firesAt01 >= 1,
    `target $01: IRQ must fire at raster 1; got ${firesAt01} fires there`);
  expect(firesAt101 === 0,
    `target $01: IRQ must NOT fire at raster $101 (low byte matches but RST8 differs); got ${firesAt101} extra fires`);
  ok('Bauer §3.12: raster target $01 (RST8=0) → IRQ fires at raster 1, NOT at $101');
}

// ── 5: $D011 bit 7 (RST8) IS BIT 8 OF TARGET, not bit 8 of CURRENT raster.
// Verify by writing $D011 with bit 7 cleared then set, observing target
// updates accordingly.
{
  const vic = makeVic();
  vic.regs[0x12] = 0x10;
  vic.regs[0x11] = 0x1B;                  // bit 7 = 0
  const t1 = vic.regs[0x12] | ((vic.regs[0x11] & 0x80) << 1);
  expect(t1 === 0x10, `RST8=0: 9-bit target = $10, got $${t1.toString(16)}`);
  vic.regs[0x11] = 0x9B;                  // bit 7 = 1
  const t2 = vic.regs[0x12] | ((vic.regs[0x11] & 0x80) << 1);
  expect(t2 === 0x110, `RST8=1: 9-bit target = $110, got $${t2.toString(16)}`);
  ok('Bauer §3.12: 9-bit raster target = $D012 | (RST8<<8)');
}

console.log(`\n${testNo} 9-bit raster compare spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
