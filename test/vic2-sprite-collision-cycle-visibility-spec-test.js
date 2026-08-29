// Sprite-collision register VISIBILITY timing (cycle-accurate $D01E/$D01F).
//
// A sprite pixel at canvas column X is emitted by the sprite sequencer at
// line cycle floor(X/8)+11 (sprite-X N → canvas N+8; canvas column of
// cycle C spans (C-11)*8 .. +7). The pixel paints into the framebuffer as
// the beam passes it, but on the 6569 the resulting collision becomes
// visible to a CPU read of $D01E/$D01F only ~2 cycles later — a pipeline
// between the sprite pixel and the readable register. Net: a read sees
// the collision at machine cycle floor(X/8)+11 + 3 = floor(X/8)+14.
//
// This is exactly the timing VICII/spritecollisions sprite-sprite-
// collision-cycle.prg and sprite-gfx-collision-cycle.prg measure: each
// steps two fully-overlapping single-pixel sprites right one pixel per
// frame and reads the collision register at a stabilized cycle, so the
// result flips from "collided" to "not yet" after exactly 2 positions.
// VICE (6569) read position verified at LIN 53 / CYC 21 (== our raster 53
// cycle 22 fetch; δ=+1 numbering). Without the register pipeline (commit
// at the pixel cycle, not +2) the collision was visible ~16 px (2 cycles)
// too early and the flip slipped to position 18, turning the border red.
// NB the FRAMEBUFFER is painted at the pixel cycle either way — only the
// register's CPU visibility is delayed — so opened-border sprite paint is
// unaffected.
//
// We drive the VIC clock with two overlapping single-pixel sprites and
// find the FIRST machine cycle at which $D01E latches, asserting it lands
// at floor(canvasX/8)+14 for a spread of X coordinates.

import { VIC2 } from '../src/vic2.js';

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
  // This test asserts MID-LINE render internals (per-cycle fb32/pipe/reg
  // state), which only the live incremental path exhibits — under the
  // Tier-3 line-batch mode pixels/commits land at line end or on a CPU
  // observer event, both byte-identical at every CPU-observable point.
  // Pin the live path so a LINE_BATCH=1 suite run still tests this contract.
  vic.lineBatchRender = false;
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Set up sprites 0 & 1 as fully-overlapping single top-left pixels at
// sprite-X = `regX`, Y = `y`, then drive the VIC clock and return the
// {raster, cycle} of the first machine cycle where $D01E latches.
function firstSpriteSpriteLatch(regX, y) {
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // text mode, DEN=1
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x03;             // enable sp0 + sp1
  vic.regs[0x00] = regX & 0xFF; vic.regs[0x01] = y;   // sp0 X/Y
  vic.regs[0x02] = regX & 0xFF; vic.regs[0x03] = y;   // sp1 X/Y (same)
  if (regX > 255) vic.regs[0x10] = 0x03;              // X-MSB for both
  vic.regs[0x27] = 0x01; vic.regs[0x28] = 0x03;
  // Sprite pointer $3F → data at $0FC0; only byte 0 set ($80) = one pixel.
  vic.ram[0x07F8] = 0x3F; vic.ram[0x07F9] = 0x3F;
  for (let i = 0; i < 64; i++) vic.ram[0x0FC0 + i] = 0;
  vic.ram[0x0FC0] = 0x80;
  for (let i = 0; i < 80 * 63; i++) {
    vic.clock(1);
    if (vic.regs[0x1E] !== 0) return { raster: vic.raster, cycle: vic.cycleInLine, val: vic.regs[0x1E] };
  }
  return null;
}

// ── 1: collision latches at floor(canvasX/8)+14 across the line ────────
{
  // Spread of X coords landing the single colliding pixel at distinct
  // line cycles, all comfortably inside the display window.
  const cases = [44, 100, 156, 200, 260];
  for (const regX of cases) {
    const canvasX = regX + 8;
    const expectedCycle = Math.floor(canvasX / 8) + 14;
    const got = firstSpriteSpriteLatch(regX, 50);
    expect(got !== null, `X=${regX}: $D01E must latch within the frame`);
    if (got) {
      expect(got.val === 0x03,
        `X=${regX}: $D01E must record sp0+sp1 ($03), got $${got.val.toString(16)}`);
      expect(got.cycle === expectedCycle,
        `X=${regX} (canvas ${canvasX}): sprite-pixel g-access at cycle ` +
        `${Math.floor(canvasX/8)+11} + 3-cycle pipeline defer → collision visible ` +
        `at cycle ${expectedCycle}, got cycle ${got.cycle}`);
    }
  }
  ok('6569 sprite collision becomes CPU-visible at floor(canvasX/8)+14 (3-cycle pipeline defer)');
}

// ── 2: visibility lands exactly 3 cycles after the g-access ───────────
// Committing the register at the pixel cycle (no pipeline) would make the
// collision visible 2 cycles (16 px) earlier — the bug that failed
// sprite-{sprite,gfx}-collision-cycle.prg. Pin the gap directly.
{
  const regX = 100;                          // canvas 108
  const gAccessCycle = Math.floor((regX + 8) / 8) + 11;  // = 24
  const got = firstSpriteSpriteLatch(regX, 50);
  expect(got !== null && got.cycle - gAccessCycle === 3,
    `collision-visible cycle must be g-access cycle (${gAccessCycle}) + 3, ` +
    `got ${got ? got.cycle : 'null'} (defer ${got ? got.cycle - gAccessCycle : '?'})`);
  ok('sprite-collision pipeline defer is exactly 3 cycles, not 1');
}

console.log(`\n${testNo} sprite-collision cycle-visibility spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
