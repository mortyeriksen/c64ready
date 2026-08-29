// Control-port spec: keyboard joystick (two independent sticks).
//
// There are two keyboard joysticks — device values 'keyboardJoystick1' and
// 'keyboardJoystick2' — and each can be assigned to either control port. Both
// resolve their directions the same way: the caller passes the selected stick's
// held-key state as kbdJoyState. Fire A drives the joystick FIRE line (bit 4);
// Fire B is wired into the UP line (bit 0), the common C64 second-button
// convention. Which physical key maps to each role lives in main.js and does
// not affect this pure resolver.

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
const dummyMouse   = { left:false, right:false };
function kbd(over) {
  return { up:false, down:false, left:false, right:false, fireA:false, fireB:false, ...over };
}
function dirsFor(device, kbdState) {
  return portDirs(device, {
    gamepadState: dummyGamepad,
    kbdJoyState:  kbdState,
    mouseButtons: dummyMouse,
  });
}
function byteFor(device, kbdState) {
  return portByte(device, dummyGamepad, kbdState, dummyMouse);
}

for (const device of ['keyboardJoystick1', 'keyboardJoystick2']) {
  // ── idle → $FF ───────────────────────────────────────────────────────
  {
    const d = dirsFor(device, kbd());
    expect(dirsToByte(d) === 0xFF,
      `${device}: idle byte must be $FF, got $${dirsToByte(d).toString(16)}`);
    expect(byteFor(device, kbd()) === dirsToByte(d),
      `${device}: direct byte helper must match portDirs+dirsToByte for idle`);
    ok(`${device}: idle byte is $FF`);
  }

  // ── pure directions map to their bits ────────────────────────────────
  {
    const d = dirsFor(device, kbd({ up:true, left:true }));
    const b = dirsToByte(d);
    expect(d.up && d.left && !d.down && !d.right && !d.fire,
      `${device}: expected up+left only, got ${JSON.stringify(d)}`);
    expect((b & 0x01) === 0 && (b & 0x04) === 0 &&
           (b & 0x02) !== 0 && (b & 0x08) !== 0 && (b & 0x10) !== 0,
      `${device}: up+left byte wrong, got $${b.toString(16)}`);
    expect(byteFor(device, kbd({ up:true, left:true })) === b,
      `${device}: direct byte helper must match up+left byte`);
    expect(byteIndicatorText(b) === '↑ ←',
      `${device}: indicator text for up+left must be "↑ ←", got "${byteIndicatorText(b)}"`);
    ok(`${device}: up + left drive bits 0 and 2`);
  }

  // ── Fire A → joystick FIRE (bit 4) ───────────────────────────────────
  {
    const d = dirsFor(device, kbd({ fireA:true }));
    const b = dirsToByte(d);
    expect(d.fire === true && d.up === false,
      `${device}: fireA must set FIRE only, got ${JSON.stringify(d)}`);
    expect((b & 0x10) === 0,
      `${device}: bit 4 must clear on fireA, got $${b.toString(16)}`);
    expect(byteFor(device, kbd({ fireA:true })) === b,
      `${device}: direct byte helper must match fireA byte`);
    ok(`${device}: Fire A → joystick FIRE (bit 4)`);
  }

  // ── Fire B → UP line (bit 0), FIRE stays high ────────────────────────
  {
    const d = dirsFor(device, kbd({ fireB:true }));
    const b = dirsToByte(d);
    expect(d.up === true && d.fire === false,
      `${device}: fireB must set UP only, got ${JSON.stringify(d)}`);
    expect((b & 0x01) === 0,
      `${device}: bit 0 must clear on fireB, got $${b.toString(16)}`);
    expect((b & 0x10) !== 0,
      `${device}: bit 4 must stay set on fireB, got $${b.toString(16)}`);
    expect(byteFor(device, kbd({ fireB:true })) === b,
      `${device}: direct byte helper must match fireB byte`);
    ok(`${device}: Fire B → UP line (bit 0)`);
  }

  // ── Fire B OR up both light the UP line ──────────────────────────────
  {
    const d = dirsFor(device, kbd({ up:true, fireB:true }));
    expect(d.up === true, `${device}: up+fireB should still assert up`);
    ok(`${device}: Fire B merges with the UP direction`);
  }
}

// ── the two sticks are independent (state is passed per-stick) ──────────
{
  const d1 = dirsFor('keyboardJoystick1', kbd({ left:true }));
  const d2 = dirsFor('keyboardJoystick2', kbd());   // its own (idle) state
  expect(d1.left === true, 'stick 1 should read its own left press');
  expect(d2.left === false, 'stick 2 (idle state) should not see stick 1 input');
  ok('two keyboard joysticks resolve from independent state objects');
}

// ── legacy alias still resolves like a keyboard stick ──────────────────
{
  const d = dirsFor('keyboardJoystick', kbd({ right:true, fireA:true }));
  const b = dirsToByte(d);
  expect(d.right && d.fire,
    `legacy alias should map right+fire, got ${JSON.stringify(d)}`);
  expect((b & 0x08) === 0 && (b & 0x10) === 0,
    `legacy alias byte wrong, got $${b.toString(16)}`);
  expect(byteFor('keyboardJoystick', kbd({ right:true, fireA:true })) === b,
    'legacy alias direct byte helper should match portDirs+dirsToByte');
  ok('legacy keyboardJoystick alias resolves like a keyboard stick');
}

console.log(`\n${testNo} keyboard-joystick control-port spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
