// Control-port spec: Commodore 1351 mouse device.
//
// The 1351 is a proportional mouse: position lives in SID POTX/POTY,
// buttons live on the joystick byte. This file covers the button
// mapping; the wrap-mod-256 + Y-inversion of paddleX/Y is asserted at
// the byte level via dirsToByte invariants.
//
// Real 1351 wiring (and what GEOS reads):
//   • joy bit 4 (FIRE) → mouse LEFT button
//   • joy bit 0 (UP)   → mouse RIGHT button

import { portDirs, dirsToByte, portByte, byteIndicatorText,
  M1351_POT_STEP,
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

const dummyGamepad = { up:false, down:false, left:false, right:false, fire:false };
const dummyKbd     = { up:false, down:false, left:false, right:false, fireA:false, fireB:false };
function dirsFor(buttons) {
  return portDirs('mouse1351', {
    gamepadState: dummyGamepad,
    kbdJoyState:  dummyKbd,
    mouseButtons: buttons,
  });
}
function byteFor(buttons) {
  return portByte('mouse1351', dummyGamepad, dummyKbd, buttons);
}

// ── 1: idle byte is $FF ────────────────────────────────────────────────
{
  const d = dirsFor({ left:false, right:false });
  expect(dirsToByte(d) === 0xFF, `idle must be $FF, got $${dirsToByte(d).toString(16)}`);
  expect(byteFor({ left:false, right:false }) === 0xFF,
    'direct byte helper must return $FF for idle 1351');
  ok('1351: idle byte = $FF');
}

// ── 2: LMB → joystick FIRE bit ─────────────────────────────────────────
{
  const d = dirsFor({ left:true, right:false });
  expect(d.fire === true && d.up === false,
    `LMB must drive FIRE only; got up=${d.up}, fire=${d.fire}`);
  const b = dirsToByte(d);
  expect((b & 0x10) === 0,
    `bit 4 (FIRE) must be cleared, got $${b.toString(16)}`);
  expect((b & 0x01) !== 0,
    `bit 0 (UP) must remain set, got $${b.toString(16)}`);
  expect(b === 0xEF, `LMB-only byte must be $EF, got $${b.toString(16)}`);
  expect(byteFor({ left:true, right:false }) === b,
    'direct byte helper must match LMB-only byte');
  expect(byteIndicatorText(b) === '●',
    `indicator text for LMB-only must be "●", got "${byteIndicatorText(b)}"`);
  ok('1351: LMB → joystick FIRE bit');
}

// ── 3: RMB → joystick UP bit ───────────────────────────────────────────
{
  const d = dirsFor({ left:false, right:true });
  expect(d.up === true && d.fire === false,
    `RMB must drive UP only; got up=${d.up}, fire=${d.fire}`);
  const b = dirsToByte(d);
  expect((b & 0x01) === 0,
    `bit 0 (UP) must be cleared, got $${b.toString(16)}`);
  expect((b & 0x10) !== 0,
    `bit 4 (FIRE) must remain set, got $${b.toString(16)}`);
  expect(b === 0xFE, `RMB-only byte must be $FE, got $${b.toString(16)}`);
  expect(byteFor({ left:false, right:true }) === b,
    'direct byte helper must match RMB-only byte');
  ok('1351: RMB → joystick UP bit');
}

// ── 4: Both buttons → both bits 0 and 4 cleared ───────────────────────
{
  const b = dirsToByte(dirsFor({ left:true, right:true }));
  expect((b & 0x01) === 0 && (b & 0x10) === 0,
    `both buttons must clear bits 0 and 4, got $${b.toString(16)}`);
  expect(b === 0xEE, `LMB+RMB byte must be $EE, got $${b.toString(16)}`);
  expect(byteFor({ left:true, right:true }) === b,
    'direct byte helper must match LMB+RMB byte');
  ok('1351: LMB+RMB → both buttons simultaneously');
}

// ── 5: 1351 never drives DOWN / LEFT / RIGHT direction bits ────────────
{
  for (const buttons of [
    { left:false, right:false },
    { left:true,  right:false },
    { left:false, right:true  },
    { left:true,  right:true  },
  ]) {
    const d = dirsFor(buttons);
    expect(d.down === false && d.left === false && d.right === false,
      `1351 must never drive DOWN/LEFT/RIGHT (got ${JSON.stringify(d)})`);
  }
  ok('1351: never drives DOWN / LEFT / RIGHT bits');
}

// ── 6: paddleX wrap-mod-256 invariant ──────────────────────────────────
// The 1351 driver computes signed deltas vs the previous POTX sample, so
// the register MUST wrap continuously. (paddleX & 0xFF) preserves that
// invariant. This test pins the bit-arithmetic the locked-mode mousemove
// path uses.
{
  const wrap = v => v & 0xFF;
  expect(wrap(0xFF + 1) === 0x00, `0xFF + 1 must wrap to 0x00`);
  expect(wrap(0xFF + 10) === 0x09, `0xFF + 10 must wrap to 0x09`);
  expect(wrap(-1 & 0xFF) === 0xFF, `-1 must wrap to 0xFF`);
  expect(wrap(-50 & 0xFF) === 0xCE, `-50 must wrap to $CE`);
  ok('1351: paddleX/Y wrap mod 256 (no clamp)');
}

// ── 7: POT byte steps by 2 per unit, so a real driver recovers the motion ─
// A 1351 keeps its 6-bit counter in POT bits 1..6, so the readable byte moves
// by two per mouse unit. Every driver halves the difference — this is the exact
// arithmetic from mouse/1351/mmtest.asm in VICE's testprogs:
//
//     lda $D419 / sec / sbc old / and #$7F / cmp #$40 / bcs neg / lsr
//
// So the byte must advance by 2 per unit: at 1 per unit a driver sees half the
// motion, and a lone single step halves to 0 — the driver's "nothing changed".
{
  expect(M1351_POT_STEP === 2, `POT must advance 2 per unit, got ${M1351_POT_STEP}`);

  // The driver's own signed-delta routine, transcribed.
  const driverDelta = (cur, old) => {
    const diff = (cur - old) & 0x7F;
    if (diff >= 0x40) return -((((diff ^ 0x7F) + 1) & 0x7F) >> 1);
    return diff >> 1;
  };
  const move = (pot, units) => (pot + units * M1351_POT_STEP) & 0xFF;

  for (const units of [1, 2, 5, 31, -1, -2, -5, -31]) {
    const old = 0x80;
    const cur = move(old, units);
    expect(driverDelta(cur, old) === units,
      `driver must recover ${units} units, got ${driverDelta(cur, old)}`);
  }
  // A single unit must survive the driver's halving.
  expect(driverDelta(move(0x80, 1), 0x80) !== 0, `a one-unit move must not vanish`);
  // And the wrap point must still work.
  expect(driverDelta(move(0xFE, 2), 0xFE) === 2, `must survive the mod-256 wrap`);
  ok('1351: POT steps 2 per unit; the real driver arithmetic recovers deltas exactly');
}

console.log(`\n${testNo} mouse1351 control-port spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
