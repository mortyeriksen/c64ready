// Open-top-border vBorder state-machine + multi-line propagation
// spec audit. Targets the DEN-trick path Nine uses to open the top
// vertical border (so its 9-digit multiplexed sprites + ghost-byte
// patterns become visible above the normal text-display window).
//
// Bauer §3.9 rules (paraphrased):
//
//   Rule 4 (bottom compare, cycle 63 of L_bottomCompare): SET vBorder
//     unconditionally. RSEL=1 → L251; RSEL=0 → L247.
//   Rule 5 (top compare, cycle 63 of L_topCompare): RESET vBorder if
//     and only if DEN=1. RSEL=1 → L51; RSEL=0 → L55.
//
//   Bauer's text says "cycle 63" but the silicon fires the compare at
//   the left-edge X-comparator within the line, then re-runs at c63 as
//   a latch / catch-up path. By the time the line ends, the
//   left-compare result is already visible. Our impl runs both phases;
//   either way the observable invariant is: when the post-top-compare
//   line begins (L52 c1 phi1), vBorderActive reflects the rule-5
//   result based on DEN at the compare cycle.
//
// What this file pins (Nine's actual demo path):
//
//   C2. DEN=1 sustained across L51 → vBorder cleared by L52 c1 (open
//       top entry).
//   C2b. DEN=0 across L51 → vBorder stays 1 (no top open).
//   C3.  Once vBorder is cleared at L51, it propagates through L52..L250
//        without any event re-setting it. L251 bottom compare re-sets.
//   C3b. With DEN=0 throughout, vBorder stays SET across the entire frame.
//   C3c. Mid-frame DEN=1 write does NOT retroactively open vBorder; the
//        next opportunity is the following frame's L51 compare.
//
// Does NOT load nine.prg.

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
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
  if (safety <= 0) throw new Error(`drive timeout: at r=${vic.raster} c=${vic.cycleInLine}`);
}

// ─── C2: DEN=1 across L51 c63 phi1 → vBorder clears (open top) ───────────
//
// Nine's path. Keep DEN=1 sustained (no late phi2 write to veto). The
// cycle-63 detect fires rule 5, queues vTopReset, latches at L52 c1
// phi1. Live-state assertion at L52 c1 (post-latch): vBorderActive=0.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                     // DEN=1, RSEL=1, YS=3
  vic.displayEnabled = true;

  driveTo(vic, 50, 0);
  expect(vic.vBorderActive === true,
    `pre L51: vBorder set (top border still closed)`);

  // L51 c63 → rule 5 fires (DEN=1 at detect), vTopReset queued.
  // Tentative FF flip happens at detect; latch at L52 c1 phi1.
  driveTo(vic, 52, 1);
  expect(vic.vBorderActive === false,
    `Bauer §3.9 rule 5: L51 c63 DEN=1 → L52 c1 latch clears vBorder`);
  ok('C2: DEN=1 across L51 c63 latches vBorder cleared at L52 c1 (open-top entry)');
}

// ─── C2b: DEN=0 at L51 c63 phi1 → rule 5 gate fails, vBorder stays SET ──
//
// Without the DEN=1 sample at the detect cycle, the top-compare rule
// never fires → vBorder stays at 1. Nine's "skip the open" path: clear
// DEN before raster 51 and keep it cleared past c63.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                     // start DEN=1
  vic.displayEnabled = true;
  driveTo(vic, 50, 60);
  vic.write(0x11, 0x0B);                     // DEN=0 by L50 c60 phi2
  driveTo(vic, 52, 1);
  expect(vic.vBorderActive === true,
    `Bauer §3.9 rule 5: DEN=0 at L51 c63 → vBorder stays SET (no top open)`);
  ok('C2b: DEN=0 across L51 c63 keeps vBorder set (top border NOT opened)');
}

// ─── C3: open-top vBorder propagates from L52 through L250 ───────────────
//
// Once cleared at L52 c1 latch, no further event clears or sets vBorder
// until L251 c63 bottom compare. Verify mid-display, late-display, and
// just-before-bottom-compare snapshots.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                     // DEN=1, RSEL=1
  vic.displayEnabled = true;

  driveTo(vic, 52, 1);
  expect(vic.vBorderActive === false, `pre: vBorder cleared by L51 top compare`);

  // Mid-display sample.
  driveTo(vic, 100, 30);
  expect(vic.vBorderActive === false,
    `C3: L100 (mid-display) — vBorder still cleared (no intervening event)`);

  // Late-display, just before bottom compare.
  driveTo(vic, 250, 30);
  expect(vic.vBorderActive === false,
    `C3: L250 (last open line) — vBorder still cleared`);

  // L251 c63 phi1 — bottom compare rule 4 fires, FF→1.
  // Latched at L252 c1 phi1.
  driveTo(vic, 252, 1);
  expect(vic.vBorderActive === true,
    `C3: L251 c63 bottom compare latches vBorder set by L252 c1`);
  ok('C3: vBorder cleared by L51 propagates through L250; L251 bottom compare re-sets it');
}

// ─── C3b: DEN=0 path — vBorder remains SET across entire frame ───────────
//
// Mirror of C3 for the "top never opened" path. After C2b's gate-fail,
// vBorder is still 1 at L52, L100, L251. The bottom compare's SET is a
// no-op (already 1); the next frame's L51 still has DEN=0 and never
// opens. This locks the "nothing accidentally opens" invariant.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;                     // DEN=0 from start, RSEL=1
  vic.displayEnabled = true;

  driveTo(vic, 52, 1);
  expect(vic.vBorderActive === true, `pre: vBorder set (DEN=0 path)`);

  driveTo(vic, 100, 30);
  expect(vic.vBorderActive === true,
    `C3b: L100 with DEN=0 — vBorder stays set (no top open)`);

  driveTo(vic, 250, 30);
  expect(vic.vBorderActive === true,
    `C3b: L250 with DEN=0 — vBorder still set`);

  driveTo(vic, 252, 1);
  expect(vic.vBorderActive === true,
    `C3b: L252 — bottom compare's set on already-set vBorder is a no-op`);
  ok('C3b: with DEN=0 throughout, vBorder stays SET across the entire frame');
}

// ─── C3c: DEN restored to 1 mid-frame doesn't retro-open vBorder ────────
//
// If the demo clears DEN before L51 c63 (so no top open this frame),
// then re-asserts DEN=1 at L100, vBorder must NOT retroactively clear.
// Only the next frame's L51 c63 detect can open it. This rules out
// "DEN write outside the top-compare cycle accidentally opens vBorder".
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;                     // start DEN=0
  vic.displayEnabled = true;
  driveTo(vic, 52, 1);
  expect(vic.vBorderActive === true, `pre L52: vBorder set (no top open)`);

  // Mid-display DEN=1.
  driveTo(vic, 100, 10);
  vic.write(0x11, 0x1B);
  driveTo(vic, 100, 50);
  expect(vic.vBorderActive === true,
    `C3c: DEN=1 mid-frame doesn't retroactively open vBorder`);

  // Drive to L250 — vBorder still set (top compare was passed at L51).
  driveTo(vic, 250, 30);
  expect(vic.vBorderActive === true,
    `C3c: L250 — vBorder still set; only next frame's L51 c63 can re-open`);
  ok('C3c: mid-frame DEN=1 write does not retro-open vBorder; needs next frame L51 c63');
}

console.log(`\n${testNo} vBorder open-top + propagation spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
