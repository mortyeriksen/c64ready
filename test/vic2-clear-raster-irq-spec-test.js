// vic.clearRasterIrq() must clear ONLY the raster IRQ latch (bit 0),
// then recompute bit 7 (IRQ-asserted-to-CPU) from the remaining enabled-
// and-latched sources. Unconditionally clearing bit 7 would deassert the
// IRQ line even though a sprite-collision or lightpen IRQ is still
// pending and unmasked — silently dropping that interrupt.
//
// Mirrors the $D019 W1C / $D01A mask recomputation paths.

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// IRQ latch bits:
//   0x01 = raster, 0x02 = sprite-bg, 0x04 = sprite-sprite, 0x08 = lightpen
// Mask uses the same bit positions; bit 7 is "asserted to CPU".

// ── 1: only raster pending → clear deasserts the line ──────────────────
{
  const vic = makeVic();
  vic.irqMask = 0x01;        // raster IRQ enabled
  vic.irqStatus = 0x81;      // raster latched + asserted
  let lastIrq = null;
  vic.irqHandler = (level) => { lastIrq = !!level; };
  vic.clearRasterIrq();
  expect((vic.irqStatus & 0x01) === 0, `raster latch cleared`);
  expect((vic.irqStatus & 0x80) === 0, `IRQ line deasserted (no other source enabled+latched)`);
  ok('clearRasterIrq with no other pending source deasserts bit 7');
}

// ── 2: raster + sprite-bg both latched and enabled → keep bit 7 ────────
{
  const vic = makeVic();
  vic.irqMask = 0x03;        // raster + sprite-bg enabled
  vic.irqStatus = 0x83;      // both latched + asserted
  vic.irqHandler = () => {};
  vic.clearRasterIrq();
  expect((vic.irqStatus & 0x01) === 0, `raster latch cleared`);
  expect((vic.irqStatus & 0x02) !== 0, `sprite-bg latch preserved`);
  expect((vic.irqStatus & 0x80) !== 0, `bit 7 KEPT high — sprite-bg is still latched and unmasked`);
  ok('clearRasterIrq keeps bit 7 high while another source is pending');
}

// ── 3: raster latched + sprite-bg latched but masked → deassert ────────
{
  const vic = makeVic();
  vic.irqMask = 0x01;        // only raster enabled
  vic.irqStatus = 0x83;      // raster + sprite-bg latched, asserted via raster
  vic.irqHandler = () => {};
  vic.clearRasterIrq();
  expect((vic.irqStatus & 0x02) !== 0, `sprite-bg latch preserved (W1C is via $D019, not here)`);
  expect((vic.irqStatus & 0x80) === 0, `bit 7 deasserted — sprite-bg is latched but masked`);
  ok('clearRasterIrq deasserts when remaining sources are masked');
}

// ── 4: lightpen pending and enabled → keep bit 7 ───────────────────────
{
  const vic = makeVic();
  vic.irqMask = 0x09;        // raster + lightpen enabled
  vic.irqStatus = 0x89;      // both latched + asserted
  vic.irqHandler = () => {};
  vic.clearRasterIrq();
  expect((vic.irqStatus & 0x80) !== 0, `bit 7 still high (lightpen still pending)`);
  ok('clearRasterIrq does not silently drop a pending lightpen IRQ');
}

// ── 5: bit-7 was already low and no enabled latches → stays low ────────
{
  const vic = makeVic();
  vic.irqMask = 0x00;
  vic.irqStatus = 0x01;      // raster latched but masked → bit 7 was 0
  vic.irqHandler = () => {};
  vic.clearRasterIrq();
  expect((vic.irqStatus & 0x01) === 0, `raster latch cleared`);
  expect((vic.irqStatus & 0x80) === 0, `bit 7 stays low`);
  ok('clearRasterIrq from a quiescent state stays quiescent');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
