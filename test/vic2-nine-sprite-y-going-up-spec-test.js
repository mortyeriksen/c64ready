// Nine "Y going up" — multiplexer Y-rewrite spec coverage.
//
// Each frame, Nine decreases each digit sprite's Y so its display
// window walks UP the screen. The Y-rewrite happens mid-frame inside
// an IRQ handler. Spec invariants the demo relies on:
//
//   Bauer §3.8.1 rule 2 (cycle 55/56 phi1): if MxE is set AND Y
//   matches lower 8 bits of raster AND DMA was off, latch DMA on +
//   FF=1 + MCBASE=0.
//
//   Rule 6+7 (cycle 16): MC progresses by 3 per s-access line; MCBASE
//   := MC if FF=1. MC is NOT touched by Y register writes.
//
//   Sprite Y reuse (§3.8.1 closing paragraph): "If you change the Y
//   coordinate of a sprite to a later raster line during or after its
//   display has completed, so that the comparisons mentioned in rules
//   1 and 2 will match again, the sprite is displayed again at that
//   Y coordinate." — i.e., a Y rewrite is ONLY effective on a FUTURE
//   raster matching the new Y. A Y rewrite to a value that's already
//   passed has no rule-2 trigger until next frame.
//
// What this file pins:
//
//   F1.  Mid-frame Y rewrite to a SMALLER value (e.g., 100 → 30 at L80)
//        does NOT retro-restart display on L30 of the current frame.
//        Rule 2 fires only at cy55/56 of next frame's L30.
//
//   F1b. After the Y rewrite, no rule-2 fire happens for the rest of
//        the current frame (rasters 81..311) — sprite continues its
//        original display (if mid-display) or stays off.
//
//   F2.  A Y rewrite that lands DURING the original display window
//        (sprite started at L52, rewrite at L60) does NOT corrupt the
//        MC counter — MC continues advancing 3/line through the
//        original window's natural end at L72.
//
//   F2b. After the frame wrap, the new Y triggers a fresh DMA-restart
//        at next frame's L_newY c55 with a clean MCBASE=0 and a clean
//        MC progression.
//
// Does NOT load nine.prg.

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;
  vic.regs[0x18] = 0x14;
  return vic;
}

function driveTo(vic, raster, cycle = 1) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
  if (safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
}

// ─── F1: Y rewrite to a smaller value mid-frame — no retro-restart ──────
//
// Setup: sp0 enabled with Y=100 from frame start. Display window L101..L121.
// At L80 (well before original display), CPU writes Y=30. Spec: no
// rule-2 fire because L30 already passed.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 100;
  // Drive into L80 mid-line.
  driveTo(vic, 80, 30);
  expect(vic.spriteDmaOn[0] === 0,
    `pre L80: DMA off (sprite Y=100 not yet reached)`);
  // Y rewrite to 30 (a raster that already passed).
  vic.regs[0x01] = 30;

  // Drive through L100 c63 (original Y match line, now Y=30 so no match).
  driveTo(vic, 100, 56);
  expect(vic.spriteDmaOn[0] === 0,
    `F1: Y=30 (already passed) — original Y=100 no longer set, no DMA`);

  // Drive through L121 (original display end). Still no DMA.
  driveTo(vic, 121, 56);
  expect(vic.spriteDmaOn[0] === 0,
    `F1: through L121 — no retro-restart on the rasters already passed`);
  ok('F1: Y rewrite to a smaller value mid-frame does not retro-restart display');
}

// ─── F1b: after Y rewrite to smaller, no rule-2 fire in low-raster zone ─
//
// Bauer §3.8.1 rule 2 compares Y to the LOWER 8 BITS of the raster
// (raster is 9 bits, Y is 8). So Y=30 matches BOTH raster 30 AND
// raster 286 (= 30 + 256). The range L81..L255 has no possible match
// (lo-byte 81..255 never equals 30); L256..L285 has lo-byte 0..29
// (also no match); L286 has lo-byte 30 — MATCH.
//
// This test pins the "no match in no-match range" half. The 8-bit
// wraparound match is asserted separately in F1d.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 100;
  driveTo(vic, 80, 30);
  vic.regs[0x01] = 30;

  let dmaEvents = 0;
  for (let r = 81; r <= 285; r++) {
    driveTo(vic, r, 56);
    if (vic.spriteDmaOn[0] === 1) {
      dmaEvents++;
      currentFailures.push(`F1b: rogue DMA-on at L${r} c56 (Y=30, lo-byte ${r & 0xFF})`);
    }
  }
  expect(dmaEvents === 0,
    `F1b: no DMA-on in L81..L285 range (lo-byte != 30 across this span)`);
  ok('F1b: Y=30 — DMA stays off across L81..L285 (no 8-bit Y match in this range)');
}

// ─── F1d: 8-bit Y wraparound match — DMA fires at L286 c55 (Y+256) ──────
//
// Bauer §3.8.1 rule 2: Y compared to (raster & 0xFF). For Y ≤ 55, the
// sprite has TWO match opportunities per frame: L_Y in the display
// zone, AND L_(Y+256) in the bottom-border zone (since raster fits in
// 9 bits up to L311). With Y=30: original L30 missed (frame already
// past it), but L286 matches via the wrap → DMA-on fires.
//
// This is a SPEC requirement and (importantly) a hazard for any demo
// animating Y down through the 0..55 range: each frame the sprite
// gets a SECOND invisible display in the bottom border, doubling DMA
// cycle costs. Nine's IRQ chain budget depends on knowing this.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 100;
  driveTo(vic, 80, 30);
  vic.regs[0x01] = 30;

  driveTo(vic, 286, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `F1d: Y=30 matches raster 286 (lo-byte 30) — DMA fires per Bauer §3.8.1 8-bit Y compare`);
  expect(vic.spriteMCBase[0] === 0,
    `F1d: L286 DMA-start — MCBASE := 0`);
  ok('F1d: Y=30 wraps to a second match at L286 (Y+256) — bottom-border phantom display');
}

// ─── F1c: next-frame Y match triggers fresh DMA-on at L30 c55 ───────────
//
// The Y=30 rewrite IS effective at the next frame's L30 c55. Verify a
// clean DMA-on event with MCBASE=0 and FF=1.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 100;
  driveTo(vic, 80, 30);
  vic.regs[0x01] = 30;

  // Wrap to next frame's L30 c56.
  driveTo(vic, 311, 56);
  driveTo(vic, 30, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `F1c: next frame L30 c56 — DMA latches with new Y=30`);
  expect(vic.spriteMCBase[0] === 0,
    `F1c: next frame L30 — MCBASE := 0 on DMA-start`);
  expect(vic.spriteYExpandFF[0] === 1,
    `F1c: next frame L30 — advance-line FF set to 1 on DMA-start`);
  ok('F1c: Y rewrite effective at next frame — clean DMA-restart at new Y c55');
}

// ─── F2: Y rewrite during active display does not corrupt MC ────────────
//
// Sprite Y=51 starts display at L52 (rule 4 c58). At L60 c30, CPU
// rewrites Y to 40 (a raster that already passed THIS frame). Active
// display continues; MC should advance 3/line through L72 (natural end).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  driveTo(vic, 60, 30);
  expect(vic.spriteDmaOn[0] === 1,
    `pre L60: sprite mid-display (Y=51 → L52..L72)`);
  const mcBeforeRewrite = vic.spriteMC[0];

  // Y rewrite mid-display to a smaller (already-passed) value.
  vic.regs[0x01] = 40;

  // Drive line-by-line through end of display, sampling MC at each line's
  // c20 (after rule 7 has fired at c16 but before c58 reload).
  // MC progression for Y-expand=0: MC := MCBASE at c58 of prior line; MC
  // advances by 3 across the 3 s-accesses (c59/c61/c63). So at L_k c20,
  // MC is (MCBASE_of_Lk) + (advances if any s-access already ran on Lk —
  // none ran before c20). Effectively MC at c20 = MCBASE at c20 of Lk =
  // MC at end of Lk-1's s-accesses = 3 * (k - 51) for non-expanded.
  let lastMc = mcBeforeRewrite;
  for (let r = 61; r <= 71; r++) {
    driveTo(vic, r, 20);
    const mc = vic.spriteMC[0];
    if (mc <= lastMc) {
      currentFailures.push(`F2: MC must advance, but at L${r} MC=${mc} (prev ${lastMc})`);
    }
    lastMc = mc;
  }
  expect(currentFailures.length === 0,
    `F2: MC advances monotonically during active display despite Y rewrite`);

  // At L72 c20, MC should be 60 or 63 (last row before natural end at L72 c16).
  driveTo(vic, 72, 20);
  expect(vic.spriteMC[0] >= 60,
    `F2: at L72 c20, MC reached row 20's range (got ${vic.spriteMC[0]})`);

  // Natural end at L72 c58.
  driveTo(vic, 72, 58);
  expect(vic.spriteDisplayOn[0] === 0,
    `F2: L72 c58 — display off (natural end despite Y rewrite)`);
  ok('F2: Y rewrite mid-display to a smaller value does not corrupt MC counter');
}

// ─── F2b: next-frame fresh DMA-restart at new Y with clean MC ───────────
//
// After F2's scenario, the next frame's L40 c55 should fire a fresh
// rule 2: DMA on, MCBASE=0, FF=1. MC then advances 0,3,6,... through
// the new display window.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  driveTo(vic, 60, 30);
  vic.regs[0x01] = 40;

  // Wrap to next frame's L40 c56.
  driveTo(vic, 311, 56);
  driveTo(vic, 40, 56);
  expect(vic.spriteDmaOn[0] === 1, `F2b: next frame L40 c56 — DMA latched`);
  expect(vic.spriteMCBase[0] === 0,
    `F2b: next frame L40 — MCBASE := 0 (rule 2 reset, not stale 63)`);
  ok('F2b: next-frame Y match after mid-frame rewrite cleanly restarts display');
}

console.log(`\n${testNo} sprite Y-going-up spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
