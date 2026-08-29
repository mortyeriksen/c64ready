// Control-port spec: paddle device.
//
// A C64 paddle pair routes paddle A fire to the joystick LEFT line (bit 2)
// and paddle B fire to the FIRE line (bit 4). The emulator's "Paddle"
// device assignment maps host LMB → paddle A fire and host RMB → paddle B
// fire. Pointer-lock motion drives paddleX (clamped at end-stops, X-axis
// inverted so mouse-right turns the bat right).

import { portDirs, dirsToByte, portByte, byteIndicatorText } from '../src/control-port.js';

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
  return portDirs('paddle', {
    gamepadState: dummyGamepad,
    kbdJoyState:  dummyKbd,
    mouseButtons: buttons,
  });
}
function byteFor(buttons) {
  return portByte('paddle', dummyGamepad, dummyKbd, buttons);
}

// ── 1: idle (no buttons) returns idle directional bits ─────────────────
{
  const d = dirsFor({ left: false, right: false });
  expect(d.up === false && d.down === false && d.left === false &&
         d.right === false && d.fire === false,
    `expected all idle, got ${JSON.stringify(d)}`);
  expect(dirsToByte(d) === 0xFF,
    `idle byte must be $FF, got ${dirsToByte(d).toString(16)}`);
  expect(byteFor({ left: false, right: false }) === 0xFF,
    'direct byte helper must return $FF for idle paddle');
  ok('paddle: idle byte is $FF');
}

// ── 2: LMB → paddle A fire on joystick LEFT bit (bit 2) ────────────────
{
  const d = dirsFor({ left: true, right: false });
  expect(d.left === true && d.fire === false,
    `LMB must drive LEFT bit only; got left=${d.left}, fire=${d.fire}`);
  const b = dirsToByte(d);
  expect((b & 0x04) === 0,
    `bit 2 (LEFT) must be cleared, got byte=$${b.toString(16)}`);
  expect((b & 0x10) !== 0,
    `bit 4 (FIRE) must remain set, got byte=$${b.toString(16)}`);
  expect(byteFor({ left: true, right: false }) === b,
    'direct byte helper must match LMB-only paddle byte');
  expect(byteIndicatorText(b) === '←',
    `indicator text for LMB-only paddle must be "←", got "${byteIndicatorText(b)}"`);
  ok('paddle: LMB → paddle A fire (joystick bit 2)');
}

// ── 3: RMB → paddle B fire on joystick FIRE bit (bit 4) ────────────────
{
  const d = dirsFor({ left: false, right: true });
  expect(d.left === false && d.fire === true,
    `RMB must drive FIRE bit only; got left=${d.left}, fire=${d.fire}`);
  const b = dirsToByte(d);
  expect((b & 0x04) !== 0,
    `bit 2 (LEFT) must remain set, got byte=$${b.toString(16)}`);
  expect((b & 0x10) === 0,
    `bit 4 (FIRE) must be cleared, got byte=$${b.toString(16)}`);
  expect(byteFor({ left: false, right: true }) === b,
    'direct byte helper must match RMB-only paddle byte');
  ok('paddle: RMB → paddle B fire (joystick bit 4)');
}

// ── 4: Both buttons → both fire bits cleared ───────────────────────────
{
  const d = dirsFor({ left: true, right: true });
  const b = dirsToByte(d);
  expect((b & 0x04) === 0 && (b & 0x10) === 0,
    `both bits 2 and 4 must be cleared, got byte=$${b.toString(16)}`);
  expect(b === 0xEB,
    `both buttons → byte must be $EB, got $${b.toString(16)}`);
  expect(byteFor({ left: true, right: true }) === b,
    'direct byte helper must match both-buttons paddle byte');
  ok('paddle: LMB+RMB drive both paddle fire lines simultaneously');
}

// ── 5: Paddle never asserts UP / DOWN / RIGHT directional bits ─────────
{
  // No matter which buttons are pressed, paddle is a knob — it shouldn't
  // light up directional bits other than its fire-on-LEFT mapping.
  for (const buttons of [
    { left: false, right: false },
    { left: true,  right: false },
    { left: false, right: true  },
    { left: true,  right: true  },
  ]) {
    const d = dirsFor(buttons);
    expect(d.up === false && d.down === false && d.right === false,
      `paddle must never drive UP/DOWN/RIGHT (got ${JSON.stringify(d)})`);
  }
  ok('paddle: never drives UP / DOWN / RIGHT bits');
}

console.log(`\n${testNo} paddle control-port spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
