// Touch-joystick geometry and control-port mapping specs.

import { dirsToByte, portByte, portDirs } from '../src/control-port.js';
import {
  dropSoftKeyboardFocus, hostTouchControls, isTouchCapable, resolveTouchStick,
  resolveTouchStickInto, restoreTouchControls,
} from '../src/touch-joystick.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const msg of currentFailures) console.log(`     - ${msg}`);
    currentFailures = [];
  }
}

const idlePad = { up: false, down: false, left: false, right: false, fire: false };
const idleKeys = {
  up: false, down: false, left: false, right: false, fireA: false, fireB: false,
};
const idleMouse = { left: false, right: false };

{
  expect(isTouchCapable({ maxTouchPoints: 1 }, false),
    'maxTouchPoints > 0 must enable touch controls');
  expect(isTouchCapable({ maxTouchPoints: 0 }, true),
    'a coarse primary pointer must enable touch controls');
  expect(!isTouchCapable({ maxTouchPoints: 0 }, false),
    'no touch points and a non-coarse pointer must disable touch controls');
  ok('touch capability requires a touch or coarse-pointer signal');
}

{
  const parent = name => ({
    name,
    children: [],
    appendChild(element) {
      element.parentNode?.removeChild(element);
      this.children.push(element);
      element.parentNode = this;
    },
    insertBefore(element, sibling) {
      element.parentNode?.removeChild(element);
      this.children.splice(this.children.indexOf(sibling), 0, element);
      element.parentNode = this;
    },
    removeChild(element) {
      this.children.splice(this.children.indexOf(element), 1);
      element.parentNode = null;
    },
  });
  const monitor = parent('monitor');
  const overlay = parent('vibes');
  const controls = { parentNode: null, nextSibling: null };
  const trailing = { parentNode: null };
  monitor.appendChild(controls);
  monitor.appendChild(trailing);
  controls.nextSibling = trailing;

  const home = hostTouchControls(controls, overlay);
  expect(controls.parentNode === overlay,
    'open viewer must host controls inside its fullscreen element');
  restoreTouchControls(controls, home);
  expect(controls.parentNode === monitor,
    'close viewer must restore controls to the monitor');
  expect(monitor.children[0] === controls && monitor.children[1] === trailing,
    'restore must preserve the controls original DOM position');
  ok('touch controls move into Retro Vibes fullscreen and return on close');
}

{
  const d = resolveTouchStick(3, -2, 40, 0.25);
  expect(!d.up && !d.down && !d.left && !d.right,
    `dead-zone motion must stay idle, got ${JSON.stringify(d)}`);
  ok('stick dead zone suppresses small movements');
}

const vectors = [
  ['right',  40,   0, { right: true }],
  ['down-right', 40, 40, { down: true, right: true }],
  ['down',    0,  40, { down: true }],
  ['down-left', -40, 40, { down: true, left: true }],
  ['left',  -40,   0, { left: true }],
  ['up-left', -40, -40, { up: true, left: true }],
  ['up',      0, -40, { up: true }],
  ['up-right', 40, -40, { up: true, right: true }],
];
for (const [label, x, y, expected] of vectors) {
  const d = resolveTouchStick(x, y, 40);
  for (const dir of ['up', 'down', 'left', 'right']) {
    expect(d[dir] === !!expected[dir],
      `${label}: expected ${dir}=${!!expected[dir]}, got ${d[dir]}`);
  }
  ok(`stick resolves ${label} sector`);
}

{
  const d = resolveTouchStick(90, -120, 30);
  expect(Math.abs(Math.hypot(d.visualX, d.visualY) - 30) < 0.001,
    `visual travel must clamp to radius 30, got ${Math.hypot(d.visualX, d.visualY)}`);
  expect(d.up && d.right, 'clamped upper-right drag must remain diagonal');
  ok('stick cap clamps visually without losing its direction');
}

{
  const out = {
    up: true, down: true, left: true, right: true,
    visualX: 99, visualY: 99,
  };
  const d = resolveTouchStickInto(40, 0, 40, out);
  expect(d === out, 'into resolver must return the caller-owned result object');
  expect(d.right && !d.up && !d.down && !d.left,
    'into resolver must populate the requested direction');
  resolveTouchStickInto(0, 0, 40, out);
  expect(!out.up && !out.down && !out.left && !out.right,
    'into resolver must clear prior directions inside the dead zone');
  expect(out.visualX === 0 && out.visualY === 0,
    'into resolver must clear prior visual coordinates');
  ok('touch resolver reuses and resets caller-owned output');
}

function touch(overrides) {
  return { ...idleKeys, ...overrides };
}

{
  const state = touch({ up: true, left: true, fireA: true });
  const direct = portByte('touchJoystick', idlePad, idleKeys, idleMouse, state);
  const resolved = portDirs('touchJoystick', {
    gamepadState: idlePad,
    kbdJoyState: idleKeys,
    mouseButtons: idleMouse,
    touchJoystickState: state,
  });
  expect(direct === dirsToByte(resolved),
    'direct touch byte must match portDirs + dirsToByte');
  expect(direct === 0xEA, `up+left+A must produce $EA, got $${direct.toString(16)}`);
  ok('touch directions and A map to joystick lines');
}

{
  const state = touch({ fireB: true });
  const byte = portByte('touchJoystick', idlePad, idleKeys, idleMouse, state);
  expect(byte === 0xFE, `B must drive only the UP line ($FE), got $${byte.toString(16)}`);
  ok('touch B maps to the C64 second-button UP line');
}

// A joystick press must not leave the hidden soft-keyboard input focused:
// Android raises its keyboard again on the next tap when it does.
{
  const kbd = { blurred: 0, blur() { this.blurred++; } };
  const screen = { focused: 0, focus() { this.focused++; } };

  expect(dropSoftKeyboardFocus(kbd, kbd, screen) === true,
    'a press must drop focus while the soft keyboard holds it');
  expect(kbd.blurred === 1 && screen.focused === 1,
    'dropping focus must blur the keyboard input and focus the screen');

  expect(dropSoftKeyboardFocus(kbd, kbd, null) === true,
    'a press must still release the keyboard with no fallback to focus');
  expect(kbd.blurred === 2, 'the fallback-less press must blur too');

  const other = { blur() { throw new Error('a foreign field must not be blurred'); } };
  expect(dropSoftKeyboardFocus(other, kbd, screen) === false,
    "a press must leave another element's focus alone");
  expect(dropSoftKeyboardFocus(null, kbd, screen) === false,
    'a press with nothing focused must not steal focus');
  expect(dropSoftKeyboardFocus(kbd, null, screen) === false,
    'no soft-keyboard input (desktop) must be a no-op');
  expect(kbd.blurred === 2 && screen.focused === 1,
    'the no-op cases must not touch focus at all');
  ok('a joystick press releases the soft keyboard so the device hides it');
}

// The hosted-away sibling can be gone by the time the viewer closes.
{
  const monitor = {
    children: [],
    appendChild(el) { this.children.push(el); el.parentNode = this; },
    insertBefore() { throw new Error('a detached sibling must not be inserted before'); },
  };
  const controls = { parentNode: null, nextSibling: { parentNode: null } };
  const home = { parent: monitor, nextSibling: controls.nextSibling };
  restoreTouchControls(controls, home);
  expect(controls.parentNode === monitor && monitor.children[0] === controls,
    'restore must append when the original next sibling is gone');
  restoreTouchControls(null, home);
  restoreTouchControls(controls, null);
  expect(monitor.children.length === 1, 'a restore with no element or home is a no-op');
  ok('touch controls restore even after their next sibling was removed');
}

console.log(`\n${testNo} touch-joystick specs; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
