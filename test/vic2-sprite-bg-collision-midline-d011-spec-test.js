// Sprite-vs-background collision across a mid-line $D011 write — synthetic
// characterization spec.
//
// This locks the mechanism behind nine.prg's startup VIC-detection probe
// (linusakesson.net/scene/nine/explanation.php §5): the demo measures the
// host VIC's pixel-pipeline delay by clearing $D01F, writing $D011 at a
// precise cycle, and reading whether sprite 0 collided with the background.
// Getting that timing wrong flips the demo's timed-code variant selection
// (the demo-boot check for this lives outside the suite; the collision
// outcome here is anchored by the VICE-verified nine fix and the sprite
// collision suites).
//
// Synthetic geometry (no demo binary):
//   - text mode, all-code-0 matrix, glyph row 0 = $FF → background
//     foreground pixels exist ONLY on RC=0 lines.
//   - ys=3 → first bad line raster $33 (51): the ONLY RC=0 fg row in the
//     probed window.
//   - sprite 0: one row of $FF at X=50, Y=50 → overlaps the fg row on
//     raster 51 only, at pixels rendered by cycles ~17..20.
//   - probe at raster $33 cycle C (for C = 1..62): read $D01F (clears the
//     latch), then write $D011=$1C (YSCROLL 3→4). Run past the row and
//     read the latch.
//
// The per-cycle map has two REAL mechanism edges:
//   - C=14→15: the DMA-window cancel boundary (Bauer §3.7.2 rule 3): a
//     YSCROLL un-match before the queued c-fetch starts cancels the bad
//     line → no display row at 51 → no fg → no collision.
//   - C=21→22: the collision-latch pixel pipeline: from C=22 the fg∧sprite
//     overlap pixels have already latched BEFORE the probe's clearing read,
//     so the post-write read sees 0. C=15..21 the latch fires AFTER the
//     clear → reads 1.
//
// Baseline generated from the current implementation (2026-07-17), which
// renders nine's probe correctly (VICE x64sc -VICIImodel 0 anchored).
// If ANY of the bad-line-window, c-access, render, or collision-pipeline
// timing shifts, some cell flips and this fails.

import { VIC2, CYCLES_PER_LINE, LINES_PER_FRAME } from '../src/vic2.js';

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

function makeProbeVic() {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  v.colorRam.fill(6);
  v.charRom[0] = 0xFF;                // code-0 glyph: fg on RC=0 only
  v.ram[0x07F8] = 0x0D;               // sprite 0 pointer → $0340
  v.ram[0x0340] = 0xFF; v.ram[0x0341] = 0xFF; v.ram[0x0342] = 0xFF; // 1-row solid sprite
  v.regs[0x18] = 0x14;                // VM=$0400, CB=$1000
  v.regs[0x11] = 0x1B;                // DEN=1, RSEL=1, YSCROLL=3
  v.regs[0x16] = 0x08;
  v.regs[0x15] = 0x01;                // sprite 0 enabled
  v.regs[0x00] = 0x32;                // X=50
  v.regs[0x01] = 0x32;                // Y=50 → display row = raster 51
  v.regs[0x21] = 0x06;
  v.regs[0x27] = 0x05;
  return v;
}
function driveTo(vic, raster, cycle) {
  let safety = LINES_PER_FRAME * CYCLES_PER_LINE * 3;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`driveTo timeout r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// ── 1: control — without the $D011 write the sprite collides on raster 51 ─
{
  const v = makeProbeVic();
  driveTo(v, 0x33, 1);
  v.read(0x1F);                       // clear latch
  driveTo(v, 0x3C, 1);
  expect((v.read(0x1F) & 1) === 1,
    'control: sprite 0 over the RC=0 fg row must latch $D01F bit 0');
  ok('control: sprite-bg collision latches on the RC=0 row without any mid-line write');
}

// ── 2: per-cycle probe map (clear + $D011=$1C at cycle C of raster $33) ──
//
//               cycle C:  1                                                            62
const BASELINE_MAP = '00000000000000111111100000000000000000000000000000000000000000';
{
  const map = [];
  for (let C = 1; C <= 62; C++) {
    const v = makeProbeVic();
    driveTo(v, 0x33, C);
    v.read(0x1F);                     // clear latch (the probe's first read)
    v.write(0x11, 0x1C);              // YSCROLL 3→4 mid-line
    driveTo(v, 0x3C, 1);              // run past the sprite/fg row
    map.push(v.read(0x1F) & 1);
  }
  const got = map.join('');
  // Named edge assertions first — the two mechanism boundaries.
  expect(map[13] === 0 && map[14] === 1,
    `DMA-window cancel edge at C=14→15 (got C14=${map[13]}, C15=${map[14]})`);
  expect(map[20] === 1 && map[21] === 0,
    `collision-latch pipeline edge at C=21→22 (got C21=${map[20]}, C22=${map[21]})`);
  expect(got === BASELINE_MAP,
    `full per-cycle map matches baseline\n       got      ${got}\n       baseline ${BASELINE_MAP}`);
  ok('mid-line $D011 probe map: DMA-window cancel + collision pixel-pipeline edges are cycle-exact');
}

console.log(`\n${testNo} sprite-bg collision mid-line $D011 spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
