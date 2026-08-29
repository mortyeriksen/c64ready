// Control-port spec: NEOS mouse device.
//
// Protocol (c64os.com/post/neosreborn):
//   • Strobe line = joystick FIRE bit (bit 4) of the port's CIA register
//     (port 2 → $DC00 bit 4 via CIA1 PRA; port 1 → $DC01 bit 4 via PRB).
//   • Button-read mode: DDR bit 4 = input → bit 4 returns LMB (active-low).
//   • Strobe mode:      bits 0..3 = input, bit 4 = output. Each strobe
//                       edge cycles a 4-phase nibble readout:
//                         phase 0 = X high nibble
//                         phase 1 = X low  nibble
//                         phase 2 = Y high nibble
//                         phase 3 = Y low  nibble
//                       Snapshot of {pendingDX, pendingDY} happens on the
//                       wrap to phase 0; each axis is clamped to ±127.
//   • Inactive (any other DDR): byte = $FF, no phase ticks. Keyboard
//                               column-scan must not desync the phase.

import {
  createNeosState, neosResetPort, neosByte, neosCheckStrobe, neosMode, neosPotX,
  NEOS_IDLE_RESET_CY,
} from '../src/control-port.js';

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

const DDR_BUTTON   = 0x00;   // bit 4 input
const DDR_STROBE   = 0x10;   // bits 0..3 input, bit 4 output
const DDR_INACTIVE = 0xFF;   // keyboard column-scan, everything output

// ── 1: neosMode classifies DDR patterns ────────────────────────────────
// Strobe mode requires bits 0..3 input AND bit 4 output. Bits 5..7 are
// ignored (matrix scan / unused lines) — the C64 KERNAL might set those
// for its own reasons but NEOS doesn't care.
{
  expect(neosMode(0x00) === 'button',   `DDR=$00 → button (all input)`);
  expect(neosMode(0x10) === 'strobe',   `DDR=$10 → strobe`);
  expect(neosMode(0x30) === 'strobe',   `DDR=$30 → strobe (bit 5 ignored)`);
  expect(neosMode(0xF0) === 'strobe',   `DDR=$F0 → strobe (bits 5..7 ignored)`);
  expect(neosMode(0x0F) === 'button',   `DDR=$0F (bit 4 input) → button`);
  expect(neosMode(0xFF) === 'inactive', `DDR=$FF → inactive (kbd scan)`);
  expect(neosMode(0x1F) === 'inactive', `DDR=$1F (all output low) → inactive`);
  expect(neosMode(0x11) === 'inactive', `DDR=$11 (bit 0 output) → inactive`);
  ok('NEOS: neosMode classifies DDR correctly');
}

// ── 2: button-mode byte reflects LMB on bit 4 ──────────────────────────
{
  const s = createNeosState();
  expect(neosByte(s, DDR_BUTTON) === 0xFF, `idle button-read = $FF`);
  s.leftBtn = true;
  expect(neosByte(s, DDR_BUTTON) === 0xEF,
    `LMB pressed: bit 4 must be cleared, got $${neosByte(s, DDR_BUTTON).toString(16)}`);
  s.leftBtn = false;
  expect(neosByte(s, DDR_BUTTON) === 0xFF, `LMB released = $FF`);
  ok('NEOS: LMB drives bit 4 in button-read mode');
}

// ── 3: inactive byte stays idle ($FF) regardless of LMB ────────────────
// During normal keyboard scan (DDR = $FF), bit-4 transitions must NOT be
// counted as strobes (next test) and the byte must not interfere with the
// matrix-scan AND. Bit 4 here is the joystick FIRE line — independent of
// NEOS state.
{
  const s = createNeosState();
  expect(neosByte(s, DDR_INACTIVE) === 0xFF, `inactive idle = $FF`);
  // LMB in inactive mode falls back to "0xEF" because the driver could
  // be polling joy bit 4 without setting DDR to input.
  s.leftBtn = true;
  expect(neosByte(s, DDR_INACTIVE) === 0xEF, `inactive + LMB = $EF`);
  ok('NEOS: bit 4 still reflects LMB in inactive (polling) mode');
}

// ── 4: 4-phase strobe cycle produces Xhi → Xlo → Yhi → Ylo ─────────────
{
  const s = createNeosState();
  // Stage a +0x35 X delta and a +0x7B Y delta (both fit in signed 8-bit).
  s.pendingDX = 0x35;
  s.pendingDY = 0x7B;

  // Initial DDR is button. Driver flips to strobe mode and toggles bit 4.
  // First edge (low strobe): bit 4 goes from 1 → 0 → phase 3→0 → snapshot.
  let snapshotted = neosCheckStrobe(s, DDR_STROBE, 0x00);
  expect(snapshotted === true, `first strobe edge must trigger snapshot`);
  expect(s.snapDX === 0x35 && s.snapDY === 0x7B,
    `snapshot must capture pending deltas, got snapDX=$${s.snapDX.toString(16)} snapDY=$${s.snapDY.toString(16)}`);
  expect(s.pendingDX === 0 && s.pendingDY === 0, `pending must be consumed`);
  expect(neosByte(s, DDR_STROBE) === 0xF3,
    `phase 0 byte: 0xF0 | (0x35 >> 4) = 0xF3, got $${neosByte(s, DDR_STROBE).toString(16)}`);

  // 2nd edge: high strobe → phase 1 (X low nibble = 0x5).
  neosCheckStrobe(s, DDR_STROBE, 0x10);
  expect(s.phase === 1, `phase should be 1 after 2nd edge`);
  expect(neosByte(s, DDR_STROBE) === 0xF5,
    `phase 1 byte: 0xF0 | (0x35 & 0x0F) = 0xF5`);

  // 3rd edge: low → phase 2 (Y high nibble = 0x7).
  neosCheckStrobe(s, DDR_STROBE, 0x00);
  expect(s.phase === 2, `phase 2 after 3rd edge`);
  expect(neosByte(s, DDR_STROBE) === 0xF7, `phase 2 byte: 0xF7`);

  // 4th edge: high → phase 3 (Y low nibble = 0xB).
  neosCheckStrobe(s, DDR_STROBE, 0x10);
  expect(s.phase === 3, `phase 3 after 4th edge`);
  expect(neosByte(s, DDR_STROBE) === 0xFB, `phase 3 byte: 0xFB`);

  ok('NEOS: 4-phase strobe returns Xhi / Xlo / Yhi / Ylo in order');
}

// ── 5: same strobe value does not advance phase ────────────────────────
{
  const s = createNeosState();
  s.pendingDX = 5;
  // Two consecutive low strobes: only the first should tick.
  neosCheckStrobe(s, DDR_STROBE, 0x00);
  const phaseAfterFirst = s.phase;
  neosCheckStrobe(s, DDR_STROBE, 0x00);
  expect(s.phase === phaseAfterFirst, `same strobe value should not tick`);
  ok('NEOS: only level transitions on bit 4 advance the phase');
}

// ── 6: snapshot clamps to signed 8-bit range ───────────────────────────
{
  const s = createNeosState();
  s.pendingDX = 500;     // overflow positive
  s.pendingDY = -500;    // overflow negative
  neosCheckStrobe(s, DDR_STROBE, 0x00);    // → phase 0 → snapshot
  expect(s.snapDX === 127,  `+500 clamps to +127, got ${s.snapDX}`);
  expect(s.snapDY === -128, `-500 clamps to -128, got ${s.snapDY}`);
  // residue carries to next snapshot
  expect(s.pendingDX === 500 - 127, `residual = 373, got ${s.pendingDX}`);
  expect(s.pendingDY === -500 + 128, `residual = -372, got ${s.pendingDY}`);
  ok('NEOS: snapshot clamps to ±127 and carries the residual');
}

// ── 7: keyboard-scan DDR ($FF) does not tick the phase ─────────────────
// The C64 KERNAL toggles bit 4 of $DC00 every few cycles while scanning
// the keyboard (column patterns like $EF / $DF have bit 4 = 0). If those
// transitions were counted, the NEOS phase state would desync within one
// frame and the next mouse read would return garbage.
{
  const s = createNeosState();
  s.pendingDX = 10;
  const phaseBefore = s.phase;
  // Simulate many bit-4 transitions while DDR is "all output" (kbd scan).
  for (let i = 0; i < 100; i++) {
    neosCheckStrobe(s, DDR_INACTIVE, (i & 1) ? 0x10 : 0x00);
  }
  expect(s.phase === phaseBefore,
    `phase must not advance during inactive-mode bit-4 toggles, got phase=${s.phase}`);
  expect(s.pendingDX === 10, `pending must not be consumed`);
  ok('NEOS: keyboard-scan DDR ignores bit-4 transitions (no phase desync)');
}

// ── 8: neosResetPort restores the initial state ────────────────────────
{
  const s = createNeosState();
  // Mutate every field.
  s.phase = 2;
  s.pendingDX = 99; s.pendingDY = -50;
  s.snapDX = 10;    s.snapDY = -10;
  s.prevStrobe = 0;
  s.leftBtn = true; s.rightBtn = true;
  neosResetPort(s);
  expect(s.phase === 3, `phase must reset to 3`);
  expect(s.pendingDX === 0 && s.pendingDY === 0, `pending must clear`);
  expect(s.snapDX === 0 && s.snapDY === 0, `snapshot must clear`);
  expect(s.prevStrobe === 1, `prevStrobe must reset to 1`);
  expect(s.leftBtn === false && s.rightBtn === false, `buttons must clear`);
  ok('NEOS: neosResetPort restores initial state');
}

// ── 9: phase wraps cleanly through multiple full cycles ────────────────
{
  const s = createNeosState();
  s.pendingDX = 0x12;
  // Two full strobe cycles: 8 edges total. After each cycle (4 edges)
  // the phase wraps to 0 and a snapshot occurs.
  let snapshots = 0;
  for (let i = 0; i < 8; i++) {
    if (neosCheckStrobe(s, DDR_STROBE, (i & 1) === 0 ? 0x00 : 0x10)) snapshots++;
  }
  expect(snapshots === 2, `8 strobe edges → 2 snapshots, got ${snapshots}`);
  ok('NEOS: phase wraps cleanly across multiple cycles');
}

// ── 10: right button on POTX, as both reference drivers read it ─────────
// mouse/neos/mousecheese.s (marked "literal reference - DONT CHANGE") and
// mouse/neos/krakout.s in VICE's testprogs both do:
//     lda $D419 / cmp #$FF     ; carry set => RMB pressed
// Carry is set only for exactly $FF, so pressed must be $FF and released must be
// something else. A bit within a pot reading cannot satisfy that: the value has
// to be the whole byte.
{
  expect(neosPotX(true) === 0xFF,
    `RMB pressed must read $ff on POTX, got $${neosPotX(true).toString(16)}`);
  expect(neosPotX(false) !== 0xFF,
    `RMB released must NOT read $ff, got $${neosPotX(false).toString(16)}`);
  // The drivers' exact test, both ways round.
  const carrySet = v => v >= 0xFF;
  expect(carrySet(neosPotX(true)) === true, `cmp #$ff sets carry when pressed`);
  expect(carrySet(neosPotX(false)) === false, `cmp #$ff clears carry when released`);
  ok('NEOS: right button reads $ff on POTX pressed, non-$ff released');
}

// ── 11: an idle clk line restarts the sequencer at Xhi ──────────────────
// The mouse resets its nibble counter once clk has been idle a while, and clk
// rests high. Drivers rely on it: arkanoid.s ends a read by writing $00 (clk
// low) and opens the next one by writing low again — no transition at all. If
// an idle gap did not restore the rest state, that read would be taken for Ylo
// and every frame afterwards would sit one phase out. Verified against
// mouse/neos/arkanoid.prg, which the testprog readme names as the timeout test.
{
  const s = createNeosState();
  s.pendingDX = 0x21; s.pendingDY = 0x43;
  let t = 10_000;
  // A complete read: four edges, tight gaps.
  for (const lvl of [0x00, 0x10, 0x00, 0x10]) { neosCheckStrobe(s, DDR_STROBE, lvl, t); t += 60; }
  expect(s.phase === 3, `phase back to 3 after a full read, got ${s.phase}`);
  // Driver leaves clk LOW at the end of the read.
  neosCheckStrobe(s, DDR_STROBE, 0x00, t);
  // Idle, then the next read opens by writing LOW again — not a transition.
  t += NEOS_IDLE_RESET_CY + 1;
  s.pendingDX = 0x21;
  neosCheckStrobe(s, DDR_STROBE, 0x00, t);
  expect(s.phase === 0, `after an idle gap a low write must start at Xhi (phase 0), got ${s.phase}`);
  expect(neosByte(s, DDR_STROBE) === 0xF2,
    `phase 0 must serve the X high nibble ($f2), got $${neosByte(s, DDR_STROBE).toString(16)}`);
  ok('NEOS: idle clk restores the rest state so the next read starts at Xhi');
}

// ── 12: gaps inside one read must NOT restart the sequencer ─────────────
{
  const s = createNeosState();
  s.pendingDX = 0x55;
  let t = 50_000;
  neosCheckStrobe(s, DDR_STROBE, 0x00, t);       // phase 0
  t += NEOS_IDLE_RESET_CY - 1;                   // long, but under the limit
  neosCheckStrobe(s, DDR_STROBE, 0x10, t);
  expect(s.phase === 1, `a sub-timeout gap must keep advancing normally, got ${s.phase}`);
  ok('NEOS: gaps shorter than the idle limit do not restart the sequencer');
}

// ── 13: the idle gap is an unsigned distance ────────────────────────────
// The clock passed in is machine.sidCycleCounter, which restarts at 0 on a hard
// reset or a fresh machine while this state persists, and wraps at 2^32. The gap
// must therefore be measured as an unsigned distance, so that a clock behind the
// stored stamp still counts as idle.
{
  // Stamp from late in a long session, then the clock restarts near 0.
  const s = createNeosState();
  s.pendingDX = 0x33;
  neosCheckStrobe(s, DDR_STROBE, 0x00, 5_000_000);   // lastEdgeCy = 5e6; consumes the delta
  s.pendingDX = 0x33;                                // stage the next read's delta
  neosCheckStrobe(s, DDR_STROBE, 0x00, 200);         // clock restarted; low again, no transition
  expect(s.phase === 0, `after a clock restart a low write must start at Xhi, got ${s.phase}`);
  expect(neosByte(s, DDR_STROBE) === 0xF3,
    `phase 0 must serve the X high nibble ($f3), got $${neosByte(s, DDR_STROBE).toString(16)}`);

  // Same across a 32-bit wrap: stamp just below 2^32, now just above it.
  const w = createNeosState();
  w.pendingDX = 0x33;
  neosCheckStrobe(w, DDR_STROBE, 0x00, 0xFFFFFF00);
  const justAfterWrap = (0xFFFFFF00 + 300) >>> 0;    // small unsigned value
  neosCheckStrobe(w, DDR_STROBE, 0x10, justAfterWrap);
  expect(w.phase === 1,
    `a 300-cycle gap across the wrap is NOT idle, so the phase advances normally, got ${w.phase}`);
  ok('NEOS: idle gap uses an unsigned distance (survives clock restart and wrap)');
}

console.log(`\n${testNo} NEOS control-port spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
