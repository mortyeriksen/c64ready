// 8565 grey-dot — SAME-VALUE write case (testprogs/VICII/greydot).
//
// VICE addendum, "Grey Dots on 856x": writing a colour register ($D020-$D02E)
// while it is displaying graphics emits a light-grey (colour 15) pixel at the
// beam position — INDEPENDENT of the value written.
//
// The snapshot-diff path (_firstPixelBgColor, see vic2-grey-dot-spec-test.js)
// only catches writes that CHANGE the value: a write of the SAME value leaves
// the per-cycle register snapshots equal, so it is invisible there. That is
// exactly what greydot.prg does — it sprays identical $D021 writes across the
// active display every line. write() marks the beam pixel for those writes and
// _applyGreyDots overlays it at line-end.
//
// Beam pixel (calibrated to greydot.prg-8565.png): canvas X = (cycleInLine-13)*8.
// greydot writes at cycleInLine 17,21,...,53 → dots at X 32,64,...,320.

import { VIC2, C64_PALETTE } from '../src/vic2.js';

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

// our palette colour 15 (light grey) as packed RGBA — same derivation the
// renderer's PALETTE_RGBA uses, so this tracks a palette swap.
const c15 = C64_PALETTE[0x0F];
const GREY = (0xFF000000 | ((c15 & 0xFF) << 16) | (c15 & 0xFF00) | ((c15 >> 16) & 0xFF)) >>> 0;

// Minimal harness: put the VIC in active display on a visible row at a given
// cycle, then drive a single CPU write and run the line-end overlay.
function setup(variant, cycleInLine) {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = variant;
  vic.displayActive = true;
  vic._cycleRenderActiveCanvasY = 50;
  vic.cycleInLine = cycleInLine;
  vic.raster = 65;
  vic._greyDotCount = 0;
  return vic;
}

// ── 1: 8565 same-value $D021 write @ cy17 → grey dot recorded at X=32
{
  const vic = setup('8565', 17);
  vic.regs[0x21] = 6;
  vic.write(0x21, 6);                       // SAME value
  expect(vic._greyDotCount === 1, `expected 1 grey dot recorded, got ${vic._greyDotCount}`);
  expect(vic._greyDotXs[0] === 32, `expected dotX=32, got ${vic._greyDotXs[0]}`);
  vic._applyGreyDots(50);
  expect(vic.fb32[50 * 384 + 32] === GREY,
    `expected GREY at (50,32), got 0x${vic.fb32[50 * 384 + 32].toString(16)}`);
  ok('8565: same-value $D021 write @cy17 → grey dot at X=32');
}

// ── 2: position formula holds across the line (cy21→64, cy53→320)
{
  const vic = setup('8565', 21);
  vic.regs[0x21] = 2;
  vic.write(0x21, 2);
  expect(vic._greyDotXs[0] === 64, `cy21: expected dotX=64, got ${vic._greyDotXs[0]}`);

  const vic2 = setup('8565', 53);
  vic2.regs[0x21] = 5;
  vic2.write(0x21, 5);
  expect(vic2._greyDotXs[0] === 320, `cy53: expected dotX=320, got ${vic2._greyDotXs[0]}`);
  ok('8565: dotX = (cycleInLine-13)*8 across the active line (cy21→64, cy53→320)');
}

// ── 3: value-CHANGE write is NOT recorded here (left to the snapshot/seam path)
{
  const vic = setup('8565', 17);
  vic.regs[0x21] = 6;
  vic.write(0x21, 2);                       // DIFFERENT value
  expect(vic._greyDotCount === 0,
    `value-change write must not be recorded by the write-time path, got ${vic._greyDotCount}`);
  ok('8565: value-CHANGE write not double-counted (handled by _firstPixelBgColor)');
}

// ── 4: 6569 never records a write-time grey dot (gated on _is8565)
{
  const vic = setup('6569', 17);
  vic.regs[0x21] = 6;
  vic.write(0x21, 6);
  expect(vic._greyDotCount === 0, `6569 must not record a grey dot, got ${vic._greyDotCount}`);
  ok('6569: same-value write produces no grey dot');
}

// ── 5: writes outside the graphics window (X<32 or X>=352) are not recorded
{
  const vic = setup('8565', 60);            // dotX = (60-13)*8 = 376 (right border)
  vic.regs[0x21] = 6;
  vic.write(0x21, 6);
  expect(vic._greyDotCount === 0, `cy60 (X=376, off display) must not record, got ${vic._greyDotCount}`);

  const vic2 = setup('8565', 12);           // dotX = (12-13)*8 = -8 (left of display)
  vic2.regs[0x21] = 6;
  vic2.write(0x21, 6);
  expect(vic2._greyDotCount === 0, `cy12 (X=-8) must not record, got ${vic2._greyDotCount}`);
  ok('8565: grey dot only inside the graphics window [32,352)');
}

// ── 6: no grey dot when display is inactive (vertical border / blanking)
{
  const vic = setup('8565', 17);
  vic.displayActive = false;
  vic.regs[0x21] = 6;
  vic.write(0x21, 6);
  expect(vic._greyDotCount === 0, `displayActive=false must not record, got ${vic._greyDotCount}`);
  ok('8565: no grey dot when displayActive=false');
}

// ── 7: applies to other colour registers in $D020-$D02E (e.g. $D027 sprite0)
{
  const vic = setup('8565', 25);            // dotX = (25-13)*8 = 96
  vic.regs[0x27] = 1;
  vic.write(0x27, 1);                       // same value
  expect(vic._greyDotCount === 1 && vic._greyDotXs[0] === 96,
    `$D027 same-value write: expected 1 dot at X=96, got count=${vic._greyDotCount} x=${vic._greyDotXs[0]}`);
  ok('8565: grey dot applies across $D020-$D02E (verified $D027)');
}

console.log(`\n${testNo} 8565 same-value grey-dot tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
