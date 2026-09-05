// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/input.js – All user input: control ports (joystick/gamepad/NEOS/mouse/
// paddle), the on-screen Key Map keyboard, the joystick-key redefine dialog, and
// the physical keyboard → C64 matrix bridge.
//
// Reads the live machine + running flag from state.js and drives the emulator's
// joyPort/paddle/cia1 inputs. Two core hooks (downloadSnapshot for the debug-
// snapshot shortcut, and clearing the paste buffer on blur) are
// dependency-injected via initInput(deps), so this module never imports main.js
// (keeps the module graph acyclic).
//
// Exports installNeosHook (re-run after each machine build), updateJoyPorts (the
// per-frame poll), and _releaseAllLatched (used on power-off / reset / state load).

import {
  canvas, swapPortsBtn, cpDeviceSelects, cpIndicators, cpDetails, cpGamepadRows, cpGamepad,
  touchControls, touchStick, touchStickKnob, touchButtons, mobileKbd,
  keymapModal, keymapBtn, keymapClose,
  joykeysModal, joykeysTitle, joykeysHint, joykeysGrid,
  btnJoykeysAll, btnJoykeysReset, btnJoykeysDone, btnJoykeysClose,
} from './dom.js';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';
import { machine, running } from './state.js';
import { KEY_MAP, CHAR_MAP } from './cia.js';
import { MatrixKeyOwnership } from './input-key-ownership.js';
import { appAccel } from './app-accel.js';
import * as ControlPort from './control-port.js';
import {
  dropSoftKeyboardFocus, isTouchCapable, resolveTouchStickInto,
} from './touch-joystick.js';

// Windows-only: the OS emulates AltGr as Ctrl+Alt, injecting a phantom
// `ControlLeft` keydown alongside `AltRight`. See the AltGr guard in the
// keydown handler. macOS has no AltGr; Linux uses ISO_Level3_Shift with no
// phantom Ctrl — so this quirk (and its guard) is scoped to Windows.
const IS_WINDOWS =
  /Win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || '') ||
  /Win/i.test(navigator.platform || '') ||
  /Windows/i.test(navigator.userAgent || '');

// ── Injected core hooks (assigned by initInput) ──────────────────────────────
let downloadSnapshot, clearPendingPaste, cycleCrtEffect, toggleVibesZoom, pasteFromShortcut;
let toggleVibesStudio;

// ── Control Port state ──────────────────────────────────────────────────────
// C64 joystick bits: active-low
// Bit 0 = Up, Bit 1 = Down, Bit 2 = Left, Bit 3 = Right, Bit 4 = Fire
// Key-joystick state. There are two independent key joysticks
// (device values 'keyboardJoystick1' / 'keyboardJoystick2'); each can be
// assigned to either control port. Which physical keys drive which direction
// is user-configurable (see JOY_KEY_DEFAULTS / joyKeys below). Two-button
// mapping per the common C64 convention:
//   fireA = primary fire (joystick bit 4)
//   fireB = secondary fire, wired into the UP line (bit 0)
const kbdJoyState = {
  1: { up: false, down: false, left: false, right: false, fireA: false, fireB: false },
  2: { up: false, down: false, left: false, right: false, fireA: false, fireB: false },
};
// Per-port latched gamepad direction state. Each port reads from the
// physical gamepad selected in its dropdown (see portGamepad below).
const gamepadState  = {
  1: { up: false, down: false, left: false, right: false, fire: false },
  2: { up: false, down: false, left: false, right: false, fire: false },
};
const mouseButtons  = { left: false, right: false };
const arrowShiftActive = { ArrowLeft: false, ArrowUp: false };
// Active tap-and-hold pointers on the on-screen key-joystick chips:
// pointerId -> chip element. Enables multitouch (diagonal + fire) and a
// reliable release even if the finger slides off the chip.
const _joyChipPointers = new Map();
const touchJoystickState = {
  up: false, down: false, left: false, right: false,
  fireA: false, fireB: false,
};
let _touchStickPointer = null;
// Pad geometry cached per drag (see _cacheTouchStickGeom) so pointermove does no
// layout reads. Center (cx,cy) in client coords + the knob travel radius.
let _touchStickCx = 0, _touchStickCy = 0, _touchStickRadius = 1;
const _touchStickResolved = {
  up: false, down: false, left: false, right: false,
  visualX: 0, visualY: 0,
};
// Pointer sampling can outrun both PAL input polling and display refresh.
// Keep the latest position hot, but paint only the newest sample at ~60 Hz.
const TOUCH_STICK_PAINT_MIN_MS = 15;
let _touchStickVisualX = 0, _touchStickVisualY = 0;
let _touchStickVisualActive = false;
let _touchStickPaintedActive = false;
let _touchStickVisualDirty = false;
let _touchStickPaintRaf = 0;
let _touchStickLastPaintTime = -Infinity;
const _touchButtonPointers = new Map();
// Per-physical-key state for CHAR_MAP presses. Keyed by event.code (stable
// across the press; event.key can mutate if host Shift is released mid-press).
// Value: { col, row, modifiedShift: null | 'pressed' | 'released' }.
const activeCharPresses = {};
// Generic physical-key presses claimed by the document keydown path. A keyup
// may release a matrix position only when its matching keydown was routed there.
// This keeps keyup events from editable controls (notably Android's hidden soft-
// keyboard input) from cancelling an independent synthetic matrix tap.
const activeMatrixPresses = new MatrixKeyOwnership(Object.keys(KEY_MAP));

// Per-port device assignment.
// 'none' | 'joystick' | 'mouse1351' | 'mouseNeos' | 'paddle'
//   | 'touchJoystick' | 'keyboardJoystick1' | 'keyboardJoystick2'.
// Legacy 'keyboardJoystick' from older builds migrates to 'keyboardJoystick1'.
const TOUCH_CAPABLE = isTouchCapable(
  navigator,
  !!window.matchMedia?.('(pointer: coarse)').matches
);
document.body.classList.toggle('touch-input-capable', TOUCH_CAPABLE);
for (const option of document.querySelectorAll('option[value="touchJoystick"]')) {
  if (!TOUCH_CAPABLE) {
    option.remove();
  } else {
    option.hidden = false;
    option.disabled = false;
  }
}

const portDevice = (() => {
  const defaults = { 1: 'none', 2: 'keyboardJoystick1' };
  const migrate = v => (v === 'keyboardJoystick' ? 'keyboardJoystick1' : v);
  try {
    const raw = localStorage.getItem('c64emu.controlPorts');
    if (raw) {
      const parsed = JSON.parse(raw);
      const valid = new Set([
        'none', 'joystick', 'mouse1351', 'mouseNeos', 'paddle',
        'touchJoystick', 'keyboardJoystick1', 'keyboardJoystick2',
      ]);
      const out = { ...defaults };
      for (const p of [1, 2]) {
        const v = migrate(parsed && parsed[p]);
        if (valid.has(v) && (v !== 'touchJoystick' || TOUCH_CAPABLE)) out[p] = v;
      }
      return out;
    }
  } catch {}
  return defaults;
})();

// ── Key-joystick key bindings ─────────────────────────────────────────────────
// Each key joystick maps six roles (up/down/left/right/fireA/fireB) to
// physical keys, identified by KeyboardEvent.code so the binding is layout-
// independent. Defaults:
//   Joy 1 — arrow keys + K (fire A) / L (fire B)
//   Joy 2 — WASD (W up, A left, S down, D right) + C (fire A) / V (fire B)
// User overrides persist to localStorage under c64emu.kbdJoyKeys.
const JOY_KEY_DIRS = ['up', 'down', 'left', 'right', 'fireA', 'fireB'];
const JOY_KEY_DEFAULTS = {
  1: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fireA: 'KeyK', fireB: 'KeyL' },
  2: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fireA: 'KeyC', fireB: 'KeyV' },
};
const joyKeys = (() => {
  const out = { 1: { ...JOY_KEY_DEFAULTS[1] }, 2: { ...JOY_KEY_DEFAULTS[2] } };
  try {
    const raw = localStorage.getItem('c64emu.kbdJoyKeys');
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const j of [1, 2]) {
        if (parsed && parsed[j]) {
          for (const dir of JOY_KEY_DIRS) {
            const code = parsed[j][dir];
            if (typeof code === 'string' && code) out[j][dir] = code;
          }
        }
      }
    }
  } catch {}
  return out;
})();
function persistJoyKeys() {
  try { localStorage.setItem('c64emu.kbdJoyKeys', JSON.stringify(joyKeys)); } catch {}
}
// Reverse lookup: event.code → direction, per joystick. Rebuilt on every
// binding change so the keydown/keyup path is a plain object read.
const _joyKeyRev = { 1: {}, 2: {} };
function _rebuildJoyKeyRev() {
  for (const j of [1, 2]) {
    const rev = {};
    for (const dir of JOY_KEY_DIRS) {
      const code = joyKeys[j][dir];
      if (code) rev[code] = dir;
    }
    _joyKeyRev[j] = rev;
  }
}
_rebuildJoyKeyRev();

// Which physical gamepad drives each port: a gamepad index (number) from
// navigator.getGamepads(), or null when none has been chosen. Persisted by
// index; an index that isn't currently connected falls back to the first
// connected pad at read time.
const portGamepad = (() => {
  const defaults = { 1: null, 2: null };
  try {
    const raw = localStorage.getItem('c64emu.controlPortGamepads');
    if (raw) {
      const parsed = JSON.parse(raw);
      const out = { ...defaults };
      for (const p of [1, 2]) {
        const v = parsed?.[p];
        if (Number.isInteger(v) && v >= 0) out[p] = v;
      }
      return out;
    }
  } catch {}
  return defaults;
})();

function persistPortGamepads() {
  try {
    localStorage.setItem('c64emu.controlPortGamepads', JSON.stringify(portGamepad));
  } catch {}
}

function anyPortIs(device) {
  return portDevice[1] === device || portDevice[2] === device;
}

// Key-joystick device helpers. There are two — 'keyboardJoystick1' and
// 'keyboardJoystick2' — and each can be assigned to either control port.
const isKbdJoy = dev => dev === 'keyboardJoystick1' || dev === 'keyboardJoystick2';
function anyKbdJoy() { return isKbdJoy(portDevice[1]) || isKbdJoy(portDevice[2]); }
// The joystick number (1|2) a device string refers to, or 0 if not a kbd joy.
const kbdJoyNum = dev =>
  dev === 'keyboardJoystick1' ? 1 : dev === 'keyboardJoystick2' ? 2 : 0;
// Which key joysticks are currently plugged into a port — drives which
// keys the keydown/keyup path diverts from the C64 matrix.
function _activeKbdJoys() {
  const s = new Set();
  const a = kbdJoyNum(portDevice[1]); if (a) s.add(a);
  const b = kbdJoyNum(portDevice[2]); if (b) s.add(b);
  return s;
}

// True if any port is driven by the host mouse (1351, NEOS, or paddle).
function anyMouseLike() {
  return anyPortIs('mouse1351') || anyPortIs('mouseNeos') || anyPortIs('paddle');
}

// Mouse-based modes that want pointer-lock. Paddle locks too so the host
// pointer is hidden and motion becomes pure motion (no cursor stuck at the
// canvas edge); for paddle we clamp the byte instead of wrapping it.
function anyPointerLockDevice() {
  return anyPortIs('mouse1351') || anyPortIs('mouseNeos') || anyPortIs('paddle');
}

function persistPortDevices() {
  try {
    localStorage.setItem('c64emu.controlPorts', JSON.stringify(portDevice));
  } catch {}
}

// Read a single gamepad into a direction set. Works for both
// "standard"-mapped pads and plain HID joysticks: the analog X/Y axes
// (axes 0/1) cover the stick on every device, the standard D-pad lives on
// buttons 12–15, and ANY pressed button counts as fire so single-trigger
// joysticks (whose button index varies) still register.
function _readPad(gp, out) {
  out.up = out.down = out.left = out.right = out.fire = false;
  if (!gp) return out;
  if (gp.axes.length >= 2) {
    if (gp.axes[1] < -0.3) out.up = true;
    if (gp.axes[1] >  0.3) out.down = true;
    if (gp.axes[0] < -0.3) out.left = true;
    if (gp.axes[0] >  0.3) out.right = true;
  }
  if (gp.buttons.length >= 16) {
    if (gp.buttons[12]?.pressed) out.up = true;
    if (gp.buttons[13]?.pressed) out.down = true;
    if (gp.buttons[14]?.pressed) out.left = true;
    if (gp.buttons[15]?.pressed) out.right = true;
  }
  for (let i = 0; i < gp.buttons.length; i++) {
    // D-pad buttons (12–15) are directions, not fire.
    if (i >= 12 && i <= 15) continue;
    if (gp.buttons[i]?.pressed) { out.fire = true; break; }
  }
  return out;
}

function _pollGamepadPort(p, gamepads) {
  const dst = gamepadState[p];
  const sel = portGamepad[p];
  // navigator.getGamepads()[index] is the pad whose .index === index (or
  // null). When the selected pad isn't present, fall back to the first
  // connected one — matching what the dropdown shows.
  let gp = (typeof sel === 'number') ? gamepads[sel] : null;
  if (!gp) {
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) { gp = gamepads[i]; break; }
    }
  }
  _readPad(gp || null, dst);
}

function pollGamepads() {
  if (portDevice[1] !== 'joystick' && portDevice[2] !== 'joystick') return;
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (portDevice[1] === 'joystick') _pollGamepadPort(1, gamepads);
  if (portDevice[2] === 'joystick') _pollGamepadPort(2, gamepads);
}

// ── NEOS mouse state (per-port). Logic lives in ./control-port.js. ──────────
const neosState = {
  1: ControlPort.createNeosState(),
  2: ControlPort.createNeosState(),
};

function _neosResetPort(p) { ControlPort.neosResetPort(neosState[p]); }

function _neosByte(p) {
  const cia = machine?.cia1;
  if (!cia) return 0xFF;
  const ddr = (p === 2) ? cia.portADir : cia.portBDir;
  return ControlPort.neosByte(neosState[p], ddr);
}

function _neosCheckStrobe(p) {
  const cia = machine?.cia1;
  if (!cia) return;
  const isPortA = (p === 2);
  const ddr = isPortA ? cia.portADir : cia.portBDir;
  const out = isPortA ? cia.portA    : cia.portB;
  ControlPort.neosCheckStrobe(neosState[p], ddr, out, machine.sidCycleCounter);
}

// Install hooks on CIA1 PRA + PRB writes. Both fire on data-register and
// DDR writes — see cia.js:330–353.
export function installNeosHook() {
  if (!machine?.cia1) return;
  const prevA = machine.cia1.writePortA;
  machine.cia1.writePortA = (val, viaDir, oldDdra) => {
    if (prevA) prevA(val, viaDir, oldDdra);
    if (portDevice[2] === 'mouseNeos') {
      _neosCheckStrobe(2);
      machine.joyPort2 = _neosByte(2);
    }
  };
  const prevB = machine.cia1.writePortB;
  machine.cia1.writePortB = (val) => {
    if (prevB) prevB(val);
    if (portDevice[1] === 'mouseNeos') {
      _neosCheckStrobe(1);
      machine.joyPort1 = _neosByte(1);
    }
  };
}

// Resolve a port's directional state given its device assignment. Pure
// logic lives in ./control-port.js.
function _portDirs(p) {
  const dev = portDevice[p];
  const j = kbdJoyNum(dev);
  return ControlPort.portDirs(dev, {
    gamepadState: gamepadState[p],
    kbdJoyState: j ? kbdJoyState[j] : null,
    mouseButtons,
    touchJoystickState,
  });
}

// Compute the active-low byte ANDed into $DC00/$DC01 for a port. NEOS uses
// its own encoding (nibble-multiplexed signed deltas + fire); everything
// else goes through the standard 5-bit joystick layout.
function _portByte(p) {
  if (portDevice[p] === 'mouseNeos') return _neosByte(p);
  return ControlPort.portByte(
    portDevice[p],
    gamepadState[p],
    kbdJoyState[kbdJoyNum(portDevice[p])] || null,
    mouseButtons,
    touchJoystickState
  );
}

const _indicatorText = { 1: null, 2: null };
const _indicatorActive = { 1: null, 2: null };

function _renderIndicator(p, byte = _portByte(p)) {
  const el = cpIndicators[p];
  if (!el) return;
  const dev = portDevice[p];
  let text, active;
  if (dev === 'mouseNeos') {
    const s = neosState[p];
    active = !!(s.leftBtn || s.rightBtn);
    text = active ? '●' : '';
  } else {
    text = ControlPort.byteIndicatorText(byte);
    active = text.length > 0;
  }
  if (_indicatorText[p] !== text) {
    el.textContent = text;
    _indicatorText[p] = text;
  }
  if (_indicatorActive[p] !== active) {
    el.style.color = active ? 'var(--green)' : 'var(--dim)';
    _indicatorActive[p] = active;
  }
}

// NEOS reports its RIGHT button on POTX ($D419) and nowhere else. The pin map
// at the top of the reference driver (mouse/neos/neosmouse.s in VICE's
// testprogs) lists pins 1-4 and 6 for the directions and fire, and pin 9
// (potx) for the RMB — there is no POTY line on the device.
//
// Both reference drivers read it as `lda $D419 / cmp #$FF`, taking carry set —
// exactly $FF — to mean pressed, so this is a whole-byte value and not a bit
// within a pot reading. POTY is left open.
function _applyNeosPotxOverride() {
  if (!machine) return;
  if (!anyPortIs('mouseNeos')) {
    machine.potXOverride = null;   // clear when NEOS is deselected
    return;
  }
  const rmb = neosState[1].rightBtn || neosState[2].rightBtn;
  machine.potXOverride = ControlPort.neosPotX(rmb);
}

export function updateJoyPorts() {
  _syncTouchControls();
  pollGamepads();
  const b1 = _portByte(1);
  const b2 = _portByte(2);
  if (machine) {
    machine.joyPort1 = b1;
    machine.joyPort2 = b2;
    // Whether a device reports a POSITION on the pot pins: paddle and 1351 do.
    // Everything else leaves them open, so $D419/$D41A read $FF and
    // paddle-detection routines conclude "no paddle". NEOS is not here because
    // it reports no position — it drives POTX directly through potXOverride
    // below. Re-asserted every frame, which also covers port changes, port
    // swaps and a freshly created machine.
    machine.potConnected = anyPortIs('paddle') || anyPortIs('mouse1351');
    _applyNeosPotxOverride();
  }
  _renderIndicator(1, b1);
  _renderIndicator(2, b2);
}

let _touchControlsVisible = null;
function _syncTouchControls() {
  if (!touchControls) return;
  const visible = TOUCH_CAPABLE && running && anyPortIs('touchJoystick');
  if (_touchControlsVisible === visible) return;
  touchControls.hidden = !visible;
  touchControls.setAttribute('aria-hidden', visible ? 'false' : 'true');
  _touchControlsVisible = visible;
}

function _releaseTouchControls() {
  _touchStickPointer = null;
  _touchButtonPointers.clear();
  touchJoystickState.up = false;
  touchJoystickState.down = false;
  touchJoystickState.left = false;
  touchJoystickState.right = false;
  touchJoystickState.fireA = false;
  touchJoystickState.fireB = false;
  _touchStickVisualX = 0;
  _touchStickVisualY = 0;
  _touchStickVisualActive = false;
  _touchStickPaintedActive = false;
  _touchStickVisualDirty = false;
  if (_touchStickPaintRaf) {
    cancelAnimationFrame(_touchStickPaintRaf);
    _touchStickPaintRaf = 0;
  }
  if (touchStick) {
    touchStick.classList.remove('touch-control-active');
    if (touchStickKnob) touchStickKnob.style.transform = '';
  }
  for (const button of Object.values(touchButtons || {})) {
    button?.classList.remove('touch-control-active');
  }
}


// Clear any latched keyboard-matrix bits that the key-joystick path
// might have left asserted, plus any held kbd-joy direction/fire bits.
function _releaseKbdJoyMatrix() {
  for (const j of [1, 2]) {
    for (const dir of JOY_KEY_DIRS) kbdJoyState[j][dir] = false;
  }
  if (!machine?.cia1) return;
  machine.cia1.setKey(0, 2, false);
  machine.cia1.setKey(0, 7, false);
  machine.cia1.setKey(1, 4, false);
  machine.cia1.setKey(2, 7, false);
  if (arrowShiftActive.ArrowLeft || arrowShiftActive.ArrowUp) {
    machine.cia1.setKey(1, 7, false);
    arrowShiftActive.ArrowLeft = false;
    arrowShiftActive.ArrowUp = false;
  }
}

// Friendly label for a KeyboardEvent.code used in a joystick binding.
function _joyKeyLabel(code) {
  if (!code) return '—';
  const ARROWS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (ARROWS[code]) return ARROWS[code];
  if (code.startsWith('Key'))    return code.slice(3);      // KeyN   → N
  if (code.startsWith('Digit'))  return code.slice(5);      // Digit4 → 4
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  const NAMED = {
    Space: 'SPACE', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP', Escape: 'ESC',
    ControlLeft: 'LCTRL', ControlRight: 'RCTRL', ShiftLeft: 'LSHIFT',
    ShiftRight: 'RSHIFT', AltLeft: 'LALT', AltRight: 'RALT',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    Backslash: '\\', Backquote: '`',
  };
  return NAMED[code] || code;
}

function _renderPortDetail(p) {
  const el = cpDetails[p];
  if (!el) return;
  const dev = portDevice[p];
  el.classList.toggle('cp-row-detail-joykeys', isKbdJoy(dev));
  if (dev === 'joystick') {
    el.innerHTML =
      'Gamepad / joystick: D-pad or left stick moves, any button = <strong>fire</strong>.';
  } else if (dev === 'mouse1351') {
    el.innerHTML =
      'Click the screen to lock the pointer. <strong>ESC</strong> releases the lock.<br>' +
      'Left button = <strong>Button 1</strong>, right button = <strong>Button 2</strong>.';
  } else if (dev === 'mouseNeos') {
    el.innerHTML =
      'Click the screen to lock the pointer. <strong>ESC</strong> releases the lock.<br>' +
      'Left = <strong>Button 1</strong> (joy fire). Right = <strong>Button 2</strong> (POTX bit 7).';
  } else if (dev === 'paddle') {
    el.innerHTML =
      'Click the screen to lock the pointer. <strong>ESC</strong> releases the lock.<br>' +
      'Mouse motion turns the paddle (clamped at end-stops).<br>' +
      'Left = <strong>paddle A fire</strong>, right = <strong>paddle B fire</strong>.';
  } else if (dev === 'touchJoystick') {
    el.innerHTML =
      'On-screen eight-way stick with <strong>A</strong> = fire and ' +
      '<strong>B</strong> = second button (UP line).';
  } else if (isKbdJoy(dev)) {
    const k = joyKeys[kbdJoyNum(dev)];
    // Each chip shows the role glyph and its bound key; when the key already
    // *is* the glyph (an arrow bound to its own direction) we show it once.
    // The chips are also tap-and-hold controls (data-joy-dir): pointer handlers
    // delegated on the detail row drive the stick straight from touch/mouse, so
    // a key-joystick is playable with no physical keyboard.
    const chip = (glyph, code, dir) => {
      const lbl = _joyKeyLabel(code);
      const inner = lbl === glyph ? glyph : glyph + ' ' + lbl;
      return `<kbd class="kbd cp-joy-dir" data-joy-dir="${dir}" role="button" aria-label="joystick ${dir}">${inner}</kbd>`;
    };
    // The wrapper becomes display:contents inside the wrapping flex detail, so
    // every chip and the redefine link participate in the same row/column gaps.
    const chips = [
      chip('↑', k.up, 'up'), chip('↓', k.down, 'down'),
      chip('←', k.left, 'left'), chip('→', k.right, 'right'),
      chip('●', k.fireA, 'fireA'), chip('●²', k.fireB, 'fireB'),
    ].join(' ');
    el.innerHTML =
      '<span class="cp-joy-keys">' + chips + '</span> ' +
      '<a class="cp-joy-edit-link" role="button" tabindex="0">✎ redefine</a>';
  } else {
    // 'none' — no device plugged in; CIA reads idle bits on this port.
    el.textContent = '';
  }
}

// Short human label for a gamepad. The browser id is often long and
// includes vendor/product hex; trim it so the dropdown stays readable.
function _gamepadLabel(gp) {
  let id = (gp.id || 'Gamepad').trim();
  // Drop the trailing "(Vendor: xxxx Product: xxxx)" / "(STANDARD GAMEPAD ...)" noise.
  id = id.replace(/\s*\((?:Vendor|STANDARD GAMEPAD|Product).*?\)\s*$/i, '').trim();
  if (id.length > 28) id = id.slice(0, 27) + '…';
  return `#${gp.index}: ${id || 'Gamepad'}`;
}

// Which port's dropdown is currently open (1, 2, or null).
let openGamepadDropdown = null;

const _gamepadDropdownEscape = {
  close: () => { closeGamepadDropdown(); canvas.focus(); },
  isOpen: () => openGamepadDropdown != null,
};

function closeGamepadDropdown() {
  popEscapeLayer(_gamepadDropdownEscape);
  if (openGamepadDropdown == null) return;
  const d = cpGamepad[openGamepadDropdown];
  if (d.root) d.root.classList.remove('open');
  if (d.trigger) d.trigger.setAttribute('aria-expanded', 'false');
  openGamepadDropdown = null;
}

function toggleGamepadDropdown(p) {
  if (openGamepadDropdown === p) { closeGamepadDropdown(); return; }
  closeGamepadDropdown();
  const d = cpGamepad[p];
  if (!d.root) return;
  d.root.classList.add('open');
  if (d.trigger) d.trigger.setAttribute('aria-expanded', 'true');
  openGamepadDropdown = p;
  pushEscapeLayer(_gamepadDropdownEscape);
  const active = d.list && d.list.querySelector('.cp-dropdown-option.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function selectGamepad(p, idx) {
  portGamepad[p] = idx;
  persistPortGamepads();
  refreshGamepadSelect(p);
  closeGamepadDropdown();
  canvas.focus();
}

// Move the keyboard highlight within an open list (without committing).
function _highlightGamepadOption(list, opts, i) {
  opts.forEach((o, j) => o.classList.toggle('active', j === i));
  opts[i].scrollIntoView({ block: 'nearest' });
}

// Rebuild a port's dropdown from the live device list. Keeps the current
// selection if its pad is still connected, otherwise falls back to the
// first connected pad. When no pads are connected the dropdown is hidden
// and a plain "No gamepads detected" message shows instead.
function refreshGamepadSelect(p) {
  const d = cpGamepad[p];
  if (!d.root) return;
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const connected = [];
  for (const gp of gamepads) if (gp) connected.push(gp);

  if (!connected.length) {
    d.root.style.display = 'none';
    if (d.empty) d.empty.style.display = '';
    if (openGamepadDropdown === p) closeGamepadDropdown();
    return;
  }
  d.root.style.display = '';
  if (d.empty) d.empty.style.display = 'none';

  // Resolve the shown pad: the stored choice if still plugged in, else the
  // first connected one.
  const wantIdx = portGamepad[p];
  const selIdx = (typeof wantIdx === 'number' && connected.some(gp => gp.index === wantIdx))
    ? wantIdx
    : connected[0].index;

  const selPad = connected.find(gp => gp.index === selIdx);
  if (d.valueEl) d.valueEl.textContent = selPad ? _gamepadLabel(selPad) : '';

  d.list.innerHTML = '';
  for (const gp of connected) {
    const li = document.createElement('li');
    const isSel = gp.index === selIdx;
    li.className = 'cp-dropdown-option' + (isSel ? ' active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', isSel ? 'true' : 'false');
    li.dataset.index = String(gp.index);

    const check = document.createElement('span');
    check.className = 'cp-dropdown-check';
    check.textContent = isSel ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'cp-dropdown-option-label';
    label.textContent = _gamepadLabel(gp);

    li.append(check, label);
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      selectGamepad(p, gp.index);
    });
    d.list.appendChild(li);
  }
}

function refreshGamepadSelects() {
  refreshGamepadSelect(1);
  refreshGamepadSelect(2);
}

function _renderPortRow(p) {
  if (cpDeviceSelects[p]) cpDeviceSelects[p].value = portDevice[p];
  // The gamepad picker only makes sense when the port is a joystick.
  if (cpGamepadRows[p]) {
    cpGamepadRows[p].hidden = portDevice[p] !== 'joystick';
  }
  if (portDevice[p] === 'joystick') {
    refreshGamepadSelect(p);
  } else if (openGamepadDropdown === p) {
    closeGamepadDropdown();
  }
  _renderPortDetail(p);
}

function applyPortDevices() {
  _renderPortRow(1);
  _renderPortRow(2);
  if (!anyPointerLockDevice() && document.pointerLockElement) {
    document.exitPointerLock();
  }
  if (!anyKbdJoy()) {
    _releaseKbdJoyMatrix();
  }
  updateJoyPorts();
}

const _MOUSE_DEVICES = new Set(['mouse1351', 'mouseNeos', 'paddle']);

function setPortDevice(port, device) {
  if (device === 'touchJoystick' && !TOUCH_CAPABLE) device = 'none';
  const prev = portDevice[port];
  if (prev === device) return;
  portDevice[port] = device;
  // Leaving a key joystick on this port (and nobody else has one) —
  // release any latched matrix bits so they don't leak into BASIC.
  if (isKbdJoy(prev) && !anyKbdJoy()) {
    _releaseKbdJoyMatrix();
  }
  // Leaving any mouse-based device — clear mouse-button latches so a held
  // click doesn't keep firing on the new device.
  if (_MOUSE_DEVICES.has(prev) && !anyMouseLike()) {
    mouseButtons.left = false;
    mouseButtons.right = false;
  }
  // Release pointer lock if no port wants it any more.
  if (!anyPointerLockDevice() && document.pointerLockElement) {
    document.exitPointerLock();
  }
  // Reset NEOS state for the leaving port so stale deltas don't poison the
  // new device or the next time NEOS is selected.
  if (prev === 'mouseNeos') _neosResetPort(port);
  if (prev === 'touchJoystick' && !anyPortIs('touchJoystick')) {
    _releaseTouchControls();
  }
  _renderPortRow(port);
  persistPortDevices();
  updateJoyPorts();
}

function swapPorts() {
  const tmpDev = portDevice[1];
  portDevice[1] = portDevice[2];
  portDevice[2] = tmpDev;
  // The assigned gamepad follows the device to its new port.
  const tmpGp = portGamepad[1];
  portGamepad[1] = portGamepad[2];
  portGamepad[2] = tmpGp;
  _renderPortRow(1);
  _renderPortRow(2);
  persistPortDevices();
  persistPortGamepads();
  updateJoyPorts();
}

if (swapPortsBtn) {
  swapPortsBtn.addEventListener('click', () => {
    swapPorts();
    // Return focus to the emulator so subsequent keypresses don't go to
    // the button.
    canvas.focus();
  });
}
for (const p of [1, 2]) {
  const sel = cpDeviceSelects[p];
  if (!sel) continue;
  sel.addEventListener('change', () => {
    setPortDevice(p, sel.value);
    // Drop focus off the <select> — otherwise it would keep eating arrow
    // keys / Space / Enter that the user expects to reach the C64.
    sel.blur();
    canvas.focus();
  });
}
// "redefine" link under a key-joystick port opens its key dialog.
// Delegated on the detail row (its innerHTML is rebuilt on every device change).
for (const p of [1, 2]) {
  const el = cpDetails[p];
  if (!el) continue;
  const openIfLink = e => {
    if (!e.target.closest('.cp-joy-edit-link')) return;
    e.preventDefault();
    e.stopPropagation();
    const j = kbdJoyNum(portDevice[p]);
    if (j) _openJoyKeys(j);
  };
  el.addEventListener('click', openIfLink);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') openIfLink(e);
  });

  // Tap-and-hold the key-joystick chips (↑↓←→ ● ●²) to drive the stick from
  // touch or mouse — sets the same kbdJoyState the physical keys do, so a
  // key-joystick is usable with no keyboard. Delegated here so it survives the
  // innerHTML re-render on every device change. Pointer capture keeps the
  // release reliable if the finger slides off the chip; the per-pointer map lets
  // a direction + fire (or a diagonal) be held at once via multitouch.
  // A tap/click lights the chip (pressed state) as direct touch feedback. Only
  // the pointer path calls this, so the mapped physical keys never light the
  // chips — keyboard feedback is the port's direction/fire indicator, which
  // reflects joystick state from any source. Keyed on the chip's semantic
  // direction (data-joy-dir), NOT the bound key, so redefining keys just works.
  const setChip = (chip, on) => {
    const dir = chip.dataset.joyDir;
    const j = kbdJoyNum(portDevice[p]);
    if (!dir || !j) return;
    kbdJoyState[j][dir] = on;
    chip.classList.toggle('cp-joy-dir-active', on);
    updateJoyPorts();
  };
  el.addEventListener('pointerdown', e => {
    const chip = e.target.closest('.cp-joy-dir');
    if (!chip) return;
    e.preventDefault();                 // no text-select / synthetic click / scroll
    try { chip.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    _joyChipPointers.set(e.pointerId, chip);
    setChip(chip, true);
  });
  const releaseChip = e => {
    const chip = _joyChipPointers.get(e.pointerId);
    if (!chip) return;
    _joyChipPointers.delete(e.pointerId);
    setChip(chip, false);
  };
  el.addEventListener('pointerup', releaseChip);
  el.addEventListener('pointercancel', releaseChip);
  el.addEventListener('lostpointercapture', releaseChip);
}
for (const p of [1, 2]) {
  const d = cpGamepad[p];
  if (!d.trigger) continue;
  d.trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGamepadDropdown(p);
  });
  d.trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggleGamepadDropdown(p);
    }
  });
}

// Cache the pad geometry once per drag. The stick and knob do not move or resize
// while dragging (only the knob's CSS transform changes), so re-reading
// getBoundingClientRect on every pointermove would force a synchronous reflow
// against the rAF loop's concurrent DOM writes — main-thread jank exactly while a
// game is being played. Re-cached on each pointerdown; a resize/orientationchange
// releases the control (see below), so the cache never outlives its validity.
function _cacheTouchStickGeom() {
  if (!touchStick) return;
  const rect = touchStick.getBoundingClientRect();
  const knobSize = touchStickKnob?.getBoundingClientRect().width || 0;
  _touchStickCx = rect.left + rect.width / 2;
  _touchStickCy = rect.top + rect.height / 2;
  _touchStickRadius = Math.max(1, (rect.width - knobSize) / 2 - 4);
}

function _paintTouchStick(timestamp) {
  _touchStickPaintRaf = 0;
  if (!_touchStickVisualDirty || !touchStick || !touchStickKnob) return;
  if (timestamp - _touchStickLastPaintTime < TOUCH_STICK_PAINT_MIN_MS) {
    _touchStickPaintRaf = requestAnimationFrame(_paintTouchStick);
    return;
  }

  _touchStickVisualDirty = false;
  _touchStickLastPaintTime = timestamp;
  touchStickKnob.style.transform =
    `translate(calc(-50% + ${_touchStickVisualX.toFixed(1)}px), ` +
    `calc(-50% + ${_touchStickVisualY.toFixed(1)}px))`;
  if (_touchStickPaintedActive !== _touchStickVisualActive) {
    touchStick.classList.toggle('touch-control-active', _touchStickVisualActive);
    _touchStickPaintedActive = _touchStickVisualActive;
  }
}

function _queueTouchStickVisual(x, y, active) {
  const visualX = Math.round(x * 10) / 10;
  const visualY = Math.round(y * 10) / 10;
  if (
    visualX === _touchStickVisualX &&
    visualY === _touchStickVisualY &&
    active === _touchStickVisualActive
  ) return;

  _touchStickVisualX = visualX;
  _touchStickVisualY = visualY;
  _touchStickVisualActive = active;
  _touchStickVisualDirty = true;
  if (!_touchStickPaintRaf) {
    _touchStickPaintRaf = requestAnimationFrame(_paintTouchStick);
  }
}

function _updateTouchStick(e) {
  if (!touchStick || e.pointerId !== _touchStickPointer) return;
  const dx = e.clientX - _touchStickCx;
  const dy = e.clientY - _touchStickCy;
  const resolved = resolveTouchStickInto(
    dx, dy, _touchStickRadius, _touchStickResolved, 0.32
  );
  touchJoystickState.up = resolved.up;
  touchJoystickState.down = resolved.down;
  touchJoystickState.left = resolved.left;
  touchJoystickState.right = resolved.right;
  // updateJoyPorts() samples this state before every emulated frame. JavaScript
  // cannot deliver another pointer event while that frame is executing, so a
  // port/indicator update here would be redundant work with no input benefit.
  _queueTouchStickVisual(
    resolved.visualX,
    resolved.visualY,
    resolved.up || resolved.down || resolved.left || resolved.right
  );
}

function _releaseTouchStick(e) {
  if (!touchStick || e.pointerId !== _touchStickPointer) return;
  _touchStickPointer = null;
  touchJoystickState.up = false;
  touchJoystickState.down = false;
  touchJoystickState.left = false;
  touchJoystickState.right = false;
  _queueTouchStickVisual(0, 0, false);
}

function _dropSoftKeyboardFocus() {
  dropSoftKeyboardFocus(document.activeElement, mobileKbd, canvas);
}

if (touchStick) {
  touchStick.addEventListener('pointerdown', e => {
    if (_touchStickPointer !== null) return;
    e.preventDefault();
    e.stopPropagation();
    _dropSoftKeyboardFocus();
    _touchStickPointer = e.pointerId;
    try { touchStick.setPointerCapture(e.pointerId); } catch {}
    _cacheTouchStickGeom();
    _updateTouchStick(e);
  });
  touchStick.addEventListener('pointermove', _updateTouchStick);
  touchStick.addEventListener('pointerup', _releaseTouchStick);
  touchStick.addEventListener('pointercancel', _releaseTouchStick);
  touchStick.addEventListener('lostpointercapture', _releaseTouchStick);
}

function _syncTouchButtons() {
  for (const role of ['fireA', 'fireB']) {
    const active = Array.from(_touchButtonPointers.values()).includes(role);
    touchJoystickState[role] = active;
    touchButtons[role]?.classList.toggle('touch-control-active', active);
  }
  updateJoyPorts();
}

for (const role of ['fireA', 'fireB']) {
  const button = touchButtons[role];
  if (!button) continue;
  button.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    _dropSoftKeyboardFocus();
    try { button.setPointerCapture(e.pointerId); } catch {}
    _touchButtonPointers.set(e.pointerId, role);
    _syncTouchButtons();
  });
  const release = e => {
    if (!_touchButtonPointers.delete(e.pointerId)) return;
    _syncTouchButtons();
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

window.addEventListener('orientationchange', () => {
  _releaseTouchControls();
  updateJoyPorts();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') return;
  _releaseTouchControls();
  updateJoyPorts();
});

// Close on any click outside the open dropdown. The trigger/option handlers
// stopPropagation, so this only fires for genuine outside clicks.
document.addEventListener('click', (e) => {
  if (openGamepadDropdown == null) return;
  const d = cpGamepad[openGamepadDropdown];
  if (d.root && !d.root.contains(e.target)) closeGamepadDropdown();
});
// Keyboard navigation while a list is open. Capture phase + stopPropagation
// so arrows/Enter drive the menu instead of leaking to the emulator.
document.addEventListener('keydown', (e) => {
  if (openGamepadDropdown == null) return;
  const p = openGamepadDropdown;
  const d = cpGamepad[p];
  const opts = d.list ? Array.from(d.list.querySelectorAll('.cp-dropdown-option')) : [];
  if (!opts.length) return;
  let i = opts.findIndex(o => o.classList.contains('active'));
  if (i < 0) i = 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    _highlightGamepadOption(d.list, opts, Math.min(opts.length - 1, i + 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    _highlightGamepadOption(d.list, opts, Math.max(0, i - 1));
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    selectGamepad(p, Number(opts[i].dataset.index));
  }
}, true);
// Detect connect/disconnect from the live device list and refresh the
// pickers only when the set actually changes. The `gamepad{,dis}connected`
// events are the primary trigger, but browsers gate getGamepads() behind a
// first input (Chrome/WebKit fire the event only on first button/axis), and
// events can be missed if fired before this listener attached — so a slow
// standalone poll backs them up and works even before the machine is powered
// on (the per-frame pollGamepads only runs while running).
let _gamepadSig = null;
function pollGamepadConnections() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  let sig = '';
  for (const gp of gps) if (gp) sig += `${gp.index}~${gp.id};`;
  if (sig !== _gamepadSig) {
    _gamepadSig = sig;
    refreshGamepadSelects();
  }
}
window.addEventListener('gamepadconnected', pollGamepadConnections);
window.addEventListener('gamepaddisconnected', pollGamepadConnections);
setInterval(pollGamepadConnections, 300);
refreshGamepadSelects();
applyPortDevices();
installNeosHook();

// ── Key Map modal ────────────────────────────────────────────────────────
// Label each [col,row] matrix slot with its C64 face name.
// Where a SHIFT-combo on the same key produces a different symbol on the
// real C64 keycap (e.g. SHIFT+2 = "), the label shows "unshifted / shifted"
// so users know how to reach " # $ % & ' ( ) ! < > ? [ ] etc.
const C64_KEY_LABELS = {
  '0,0': 'INST/DEL',   '0,1': 'RETURN',     '0,2': 'CRSR →',
  '0,3': 'F7',         '0,4': 'F1',         '0,5': 'F3',
  '0,6': 'F5',         '0,7': 'CRSR ↓',
  '1,0': '3 / #',      '1,1': 'W',          '1,2': 'A',
  '1,3': '4 / $',      '1,4': 'Z',          '1,5': 'S',
  '1,6': 'E',          '1,7': 'SHIFT',
  '2,0': '5 / %',      '2,1': 'R',          '2,2': 'D',
  '2,3': "6 / &",      '2,4': 'C',          '2,5': 'F',
  '2,6': 'T',          '2,7': 'X',
  '3,0': "7 / '",      '3,1': 'Y',          '3,2': 'G',
  '3,3': '8 / (',      '3,4': 'B',          '3,5': 'H',
  '3,6': 'U',          '3,7': 'V',
  '4,0': '9 / )',      '4,1': 'I',          '4,2': 'J',
  '4,3': '0',          '4,4': 'M',          '4,5': 'K',
  '4,6': 'O',          '4,7': 'N',
  '5,0': '+',          '5,1': 'P',          '5,2': 'L',
  '5,3': '-',          '5,4': '. / >',      '5,5': ': / [',
  '5,6': '@',          '5,7': ', / <',
  '6,0': '£',          '6,1': '*',          '6,2': '; / ]',
  '6,3': 'CLR/HOME',   '6,4': 'RIGHT SHIFT', '6,5': '=',
  '6,6': '↑',          '6,7': '/ / ?',
  '7,0': '1 / !',      '7,1': '←',          '7,2': 'CTRL',
  '7,3': '2 / "',      '7,4': 'SPACE',      '7,5': 'C=',
  '7,6': 'Q',          '7,7': 'RUN/STOP',
};

// Layout-specific glyph cache. Populated lazily from
// navigator.keyboard.getLayoutMap() so labels reflect the user's actual
// keycaps (e.g. on a Norwegian layout, BracketRight = ¨, not ]).
// Chromium-only API; on other browsers we fall back to US labels.
let _layoutMap = null;
async function _ensureLayoutMap() {
  if (_layoutMap !== null) return;
  try {
    _layoutMap = navigator.keyboard?.getLayoutMap
      ? await navigator.keyboard.getLayoutMap()
      : new Map();
  } catch {
    _layoutMap = new Map();
  }
}

// Codes whose label should follow the user's keyboard layout when possible.
const _PRINTABLE_CODES = new Set([
  'Backquote', 'Minus', 'Equal',
  'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'IntlBackslash', 'IntlRo', 'IntlYen',
]);

// Friendly display name for a browser KeyboardEvent.code.
function _hostKeyLabel(code) {
  // Letters / digits / symbol keys: prefer the user's actual layout glyph.
  if (
    _layoutMap && _layoutMap.size > 0 &&
    (code.startsWith('Key') || code.startsWith('Digit') || _PRINTABLE_CODES.has(code))
  ) {
    const k = _layoutMap.get(code);
    if (k && k.length > 0) return k.toUpperCase();
  }

  // Fallbacks (non-Chromium browsers, or non-printing keys).
  if (code.startsWith('Key')) return code.slice(3);              // KeyA → A
  if (code.startsWith('Digit')) return code.slice(5);            // Digit1 → 1
  if (code.startsWith('Arrow')) return code.slice(5) + ' ARROW'; // ArrowLeft → LEFT ARROW
  const aliases = {
    'Backspace': 'Backspace', 'Delete': 'Delete', 'Tab': 'Tab',
    'Enter': 'Enter', 'Space': 'Space',
    'ShiftLeft': 'Left Shift', 'ShiftRight': 'Right Shift',
    'ControlLeft': 'Left Ctrl', 'ControlRight': 'Right Ctrl',
    'Minus': '- (minus)', 'Equal': '= (equals)',
    'BracketLeft': '[', 'BracketRight': ']',
    'Backslash': '\\', 'Slash': '/', 'Backquote': '` (backtick)',
    'Semicolon': ';', 'Quote': '\'', 'Comma': ',', 'Period': '.',
  };
  return aliases[code] || code;
}

// Group host-key codes by category for readable display.
function _categorize(code) {
  if (code.startsWith('Key'))    return 'Letters';
  if (code.startsWith('Digit'))  return 'Digits';
  if (
    /^F\d+$/.test(code) ||
    ['Backspace','Delete','Tab','Enter','Space','Escape'].includes(code) ||
    code.startsWith('Arrow') ||
    ['ShiftLeft','ShiftRight','ControlLeft','ControlRight'].includes(code)
  ) return 'Special keys';
  return 'Symbols';
}

// Order rows inside the Special section. F-keys come first as a contiguous
// block, then editing, cursor, modifiers, space, and finally the reserved
// Escape note. Lower sortKey = earlier.
const SPECIAL_ORDER = {
  'F1': 10, 'F3': 11, 'F5': 12, 'F7': 13,
  'F9': 14, 'F10': 15, 'F11': 16,
  // F12 (RESTORE) and shifted F2/F4/F6/F8 are injected with sortKey 17/18.
  'Tab': 20, 'Backspace': 20, 'Delete': 20,
  'Enter': 21,
  'ArrowLeft': 30, 'ArrowRight': 31, 'ArrowUp': 32, 'ArrowDown': 33,
  'ShiftLeft': 40, 'ShiftRight': 41,
  'ControlLeft': 42, 'ControlRight': 42,
  'Space': 50,
};

let _keymapBuilt = false;
function _buildKeymapGrid() {
  const grid = document.getElementById('keymap-grid');
  if (!grid) return;

  // Collapse multiple host keys that map to the same C64 slot into one row.
  const byTarget = new Map(); // "col,row" → [hostCode, ...]
  for (const [code, [c, r]] of Object.entries(KEY_MAP)) {
    const key = `${c},${r}`;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(code);
  }

  // Special keys keep the per-row "host = C64 face" rendering because the
  // mapping is non-obvious (F9 = RUN/STOP, Tab = INST/DEL, F11 = CLR/HOME, …).
  // Letters, digits, and symbols are identity-mapped on the C64 (typing 'A'
  // produces 'A', typing '*' produces '*'), so they get a flat list of
  // supported characters under their own heading instead of N redundant rows.
  const specialRows = [];
  for (const [target, codes] of byTarget) {
    if (_categorize(codes[0]) === 'Special keys') {
      specialRows.push({ target, codes });
    }
  }
  specialRows.push(
    { codes: ['F2'],     label: 'F2', sortKey: 10.5 },
    { codes: ['F4'],     label: 'F4', sortKey: 11.5 },
    { codes: ['F6'],     label: 'F6', sortKey: 12.5 },
    { codes: ['F8'],     label: 'F8', sortKey: 13.5 },
    { codes: ['F12'],    label: 'RESTORE (NMI)',              sortKey: 17 },
    { codes: ['Escape'], label: 'reserved (closes dialogs, exits fullscreen)', sortKey: 99 },
  );
  specialRows.sort((a, b) => {
    const ka = a.sortKey ?? Math.min(...a.codes.map(c => SPECIAL_ORDER[c] ?? 999));
    const kb = b.sortKey ?? Math.min(...b.codes.map(c => SPECIAL_ORDER[c] ?? 999));
    return ka - kb;
  });

  const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const html = [];

  html.push(`<h3>Special keys</h3>`);
  html.push(`<div class="keymap-section">`);
  for (const row of specialRows) {
    const hostHtml = row.codes
      .map(c => `<kbd class="kbd kbd-tap" data-code="${escapeHtml(c)}">${escapeHtml(_hostKeyLabel(c))}</kbd>`)
      .join(' / ');
    const c64Label = row.label ?? C64_KEY_LABELS[row.target] ?? row.target;
    html.push(`<div class="row">${hostHtml}<strong>= ${escapeHtml(c64Label)}</strong></div>`);
  }
  html.push('</div>');

  const charSection = (title, chars, note) => {
    html.push(`<h3>${title}</h3>`);
    html.push(`<div class="keymap-symbols">`);
    html.push(chars
      .map(ch => `<kbd class="kbd kbd-tap" data-char="${escapeHtml(ch)}">${escapeHtml(ch)}</kbd>`)
      .join(' '));
    html.push(`</div>`);
    if (note) html.push(`<div class="keymap-symbols-note">${note}</div>`);
  };

  charSection('Letters', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
  charSection('Digits', '0123456789'.split(''));
  charSection('Symbols', Object.keys(CHAR_MAP), '^ produces ↑ &middot; _ produces ←');

  // The app's own shortcuts, straight from APP_SHORTCUTS so this cannot drift
  // from what the dispatcher does. The modifier is stated once rather than
  // spelled out per row: both spellings work on every platform, so a reader has
  // nothing to match against their own, and two columns of near-identical
  // keycaps would be the longest section in the dialog for the least
  // information.
  if (APP_SHORTCUTS.length) {
    html.push(`<h3>App shortcuts</h3>`);
    html.push(`<div class="keymap-symbols-note">With <kbd class="kbd">⌘</kbd>+<kbd class="kbd">Shift</kbd> `
      + `on macOS, or <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Shift</kbd> elsewhere. `
      + `These reach the app, not the C64.</div>`);
    html.push(`<div class="keymap-section">`);
    for (const s of APP_SHORTCUTS) {
      html.push(`<div class="row"><kbd class="kbd">${escapeHtml(_hostKeyLabel(s.code))}</kbd>`
        + `<strong>= ${escapeHtml(s.label)}</strong></div>`);
    }
    html.push('</div>');
  }

  grid.innerHTML = html.join('');
  _keymapBuilt = true;
}


async function _openKeymap() {
  if (!keymapModal) return;
  await _ensureLayoutMap();
  if (!_keymapBuilt) _buildKeymapGrid();
  keymapModal.hidden = false;
  pushEscapeLayer(_keymapEscape);
}
function _closeKeymap() {
  if (!keymapModal) return;
  keymapModal.hidden = true;
  popEscapeLayer(_keymapEscape);
  // Don't leave a latched modifier asserted in BASIC after the dialog goes
  // away — otherwise the user's next host keystroke gets unexpectedly shifted.
  _releaseAllLatched();
}
const _keymapIsOpen = () => keymapModal && !keymapModal.hidden;
const _keymapEscape = { close: _closeKeymap, isOpen: _keymapIsOpen };

if (keymapBtn)   keymapBtn.addEventListener('click', _openKeymap);
if (keymapClose) keymapClose.addEventListener('click', _closeKeymap);
if (keymapModal) {
  keymapModal.addEventListener('click', e => {
    if (e.target === keymapModal) _closeKeymap();
  });
}

// On-screen keyboard: tapping a kbd in the keymap dialog injects the same
// key into the C64. 80ms hold gives the kernel keyboard scan (~60 Hz, every
// ~16ms) several scans to register the press, then we release.
const KEYMAP_TAP_HOLD_MS = 80;

// Codes that act as sticky modifiers on the on-screen keyboard: one click
// latches them down, a second click (or the next non-modifier tap) clears.
// This lets the user produce SHIFT+letter graphic chars, CTRL combos, and
// C= alt-graphic chars purely from clicks.
const KEYMAP_MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'F10', // C= (Commodore key)
]);

// Currently-latched on-screen modifiers. Map<code, {col, row}> so we know
// which matrix positions to release on unlatch / blur / power-off.
const _latchedModifiers = new Map();

function _refreshLatchVisuals() {
  if (!keymapModal) return;
  for (const el of keymapModal.querySelectorAll('.kbd-tap[data-code]')) {
    const code = el.getAttribute('data-code');
    el.classList.toggle('kbd-latched', _latchedModifiers.has(code));
  }
}

function _toggleLatch(code) {
  if (!machine?.cia1) return;
  if (_latchedModifiers.has(code)) {
    const { col, row } = _latchedModifiers.get(code);
    machine.cia1.setKey(col, row, false);
    _latchedModifiers.delete(code);
  } else {
    const pos = KEY_MAP[code];
    if (!pos) return;
    machine.cia1.setKey(pos[0], pos[1], true);
    _latchedModifiers.set(code, { col: pos[0], row: pos[1] });
  }
  _refreshLatchVisuals();
  _refreshShiftHeldClass();
}

export function _releaseAllLatched() {
  if (machine?.cia1) {
    for (const { col, row } of _latchedModifiers.values()) {
      machine.cia1.setKey(col, row, false);
    }
  }
  _latchedModifiers.clear();
  activeMatrixPresses.clear();
  // NEOS keeps a strobe phase and a cycle stamp taken from
  // machine.sidCycleCounter. That clock restarts at 0 on a hard reset or a new
  // machine, so the per-port state goes with it.
  for (const p of [1, 2]) _neosResetPort(p);
  if (machine) machine.potXOverride = null;
  _releaseTouchControls();
  _syncTouchControls();
  _refreshLatchVisuals();
  _refreshShiftHeldClass();
}

function _matrixTap(col, row) {
  if (!machine?.cia1) return;
  machine.cia1.setKey(col, row, true);
  setTimeout(() => machine.cia1.setKey(col, row, false), KEYMAP_TAP_HOLD_MS);
}

// Tap a CHAR_MAP entry. We force C64 Shift to whatever the symbol requires
// for the duration of the tap, then restore it — same pattern as the
// keydown symbol path, so a held physical Shift doesn't bleed through.
//
// When an on-screen modifier is latched, skip the shift management — the
// latch is the user's intent (they're typing a shifted graphic char), and
// the post-tap auto-release will clear it.
function _symbolTap({ col, row, shift }) {
  if (!machine?.cia1) return;
  if (_latchedModifiers.size > 0) {
    machine.cia1.setKey(col, row, true);
    setTimeout(() => machine.cia1.setKey(col, row, false), KEYMAP_TAP_HOLD_MS);
    return;
  }
  const lShift = machine.cia1.isKeyDown(1, 7);
  const rShift = machine.cia1.isKeyDown(6, 4);
  const anyShift = lShift || rShift;
  let pressedShift = false, releasedL = false, releasedR = false;
  if (shift && !anyShift) {
    machine.cia1.setKey(1, 7, true); pressedShift = true;
  } else if (!shift && anyShift) {
    if (lShift) { machine.cia1.setKey(1, 7, false); releasedL = true; }
    if (rShift) { machine.cia1.setKey(6, 4, false); releasedR = true; }
  }
  machine.cia1.setKey(col, row, true);
  setTimeout(() => {
    machine.cia1.setKey(col, row, false);
    if (pressedShift) machine.cia1.setKey(1, 7, false);
    if (releasedL)    machine.cia1.setKey(1, 7, true);
    if (releasedR)    machine.cia1.setKey(6, 4, true);
  }, KEYMAP_TAP_HOLD_MS);
}

function _sendCharTap(ch) {
  if (/^[A-Z]$/.test(ch)) {
    const pos = KEY_MAP['Key' + ch];
    if (pos) _matrixTap(pos[0], pos[1]);
    return;
  }
  if (/^[0-9]$/.test(ch)) {
    const pos = KEY_MAP['Digit' + ch];
    if (pos) _matrixTap(pos[0], pos[1]);
    return;
  }
  const m = CHAR_MAP[ch];
  if (m) _symbolTap(m);
}

function _sendCodeTap(code) {
  if (!machine) return;
  // F12 = RESTORE — NMI pulse, not a matrix key.
  if (code === 'F12') {
    machine.setRestoreNmiLine(true);
    setTimeout(() => machine?.setRestoreNmiLine(false), KEYMAP_TAP_HOLD_MS);
    return;
  }
  // F2/F4/F6/F8 = SHIFT + F1/F3/F5/F7 on the C64.
  const shiftedFn = { 'F2': 'F1', 'F4': 'F3', 'F6': 'F5', 'F8': 'F7' };
  if (shiftedFn[code]) {
    const pos = KEY_MAP[shiftedFn[code]];
    if (!pos) return;
    machine.cia1.setKey(1, 7, true);
    machine.cia1.setKey(pos[0], pos[1], true);
    setTimeout(() => {
      machine.cia1.setKey(pos[0], pos[1], false);
      machine.cia1.setKey(1, 7, false);
    }, KEYMAP_TAP_HOLD_MS);
    return;
  }
  // Arrow Left/Up on the C64 are SHIFT + CRSR Right/Down.
  if (code === 'ArrowLeft' || code === 'ArrowUp') {
    const pos = code === 'ArrowLeft' ? [0, 2] : [0, 7];
    machine.cia1.setKey(1, 7, true);
    machine.cia1.setKey(pos[0], pos[1], true);
    setTimeout(() => {
      machine.cia1.setKey(pos[0], pos[1], false);
      machine.cia1.setKey(1, 7, false);
    }, KEYMAP_TAP_HOLD_MS);
    return;
  }
  // Escape is reserved (browser fullscreen exit) — no matrix action.
  if (code === 'Escape') return;
  const pos = KEY_MAP[code];
  if (pos) _matrixTap(pos[0], pos[1]);
}

// ── Soft-keyboard (mobile) → keyboard MATRIX ────────────────────────────────
// The device soft keyboard (hidden #mobile-kbd, main.js) used to write only the
// KERNAL input buffer ($0277) — fine for BASIC (GETIN/CHRIN read it) but invisible
// to demos/games that poll the CIA1 matrix ($DC00/$DC01) directly for a key (the
// "HIT SPACE" bug). Route it through the real matrix instead, reusing the on-screen
// Key Map's tap path. A held matrix tap ALSO fills the KERNAL buffer via the normal
// IRQ keyboard scan, so this serves BASIC too — one path for both. Multi-char
// inserts (swipe/autocomplete) tap in sequence, each key's press+release completing
// before the next so there's no matrix overlap. (Inherent soft-keyboard limit:
// discrete taps only — no true key-hold for a game that needs a key held down.)
const _softKeyQueue = [];
let _softKeyPumping = false;

function _tapSoftChar(ch) {
  if (ch === '\n' || ch === '\r') { _sendCodeTap('Enter'); return; }
  if (ch === '\x14' || ch === '\b') { _sendCodeTap('Backspace'); return; }
  if (ch === ' ') { _sendCodeTap('Space'); return; }
  // C64 default (uppercase) charset: the unshifted letter key produces the
  // uppercase glyph, so map a typed letter to its key regardless of case — the
  // matrix POSITION is what a key-polling demo checks.
  if (ch >= 'a' && ch <= 'z') { _sendCharTap(ch.toUpperCase()); return; }
  _sendCharTap(ch);   // A-Z, 0-9, and CHAR_MAP symbols (shift handled there)
}

function _pumpSoftKeys() {
  const ch = _softKeyQueue.shift();
  if (ch === undefined) { _softKeyPumping = false; return; }
  _softKeyPumping = true;
  _tapSoftChar(ch);
  // Space the next press past this tap's hold+release (KEYMAP_TAP_HOLD_MS, as
  // _matrixTap uses) so each key is a distinct matrix event.
  setTimeout(_pumpSoftKeys, KEYMAP_TAP_HOLD_MS + 24);
}

// Entry point for the mobile soft keyboard (main.js): enqueue an insert and drain
// it through the matrix one key at a time.
export function softKeyboardInput(str) {
  if (!str || !machine?.cia1) return;
  for (const ch of str) _softKeyQueue.push(ch);
  if (!_softKeyPumping) _pumpSoftKeys();
}

// Holding physical Shift swaps each letter kbd's label to its PETSCII
// graphic glyph (rendered from the char ROM). Digits and symbols stay
// put — those sections of the dialog are reference info, not a live
// preview of what shift+key would produce.
// Screen code in the upper/graphics char set for SHIFT+letter (the graphic
// glyph). $41 = shift-A (♠), $42 = shift-B, …, $5A = shift-Z (♦).
const SHIFTED_SCREEN_CODE = {};
for (let i = 0; i < 26; i++) {
  SHIFTED_SCREEN_CODE[String.fromCharCode(0x41 + i)] = 0x41 + i;
}

// Render an 8×8 glyph from the char ROM (upper/graphics set) into a data
// URL. Returns null if the ROM hasn't been loaded yet — the caller retries
// the next time Shift is held.
function _renderCharRomGlyph(screenCode, scale = 3) {
  const rom = machine?.mem?.charRom;
  if (!rom) return null;
  const offset = screenCode * 8;
  if (offset + 8 > rom.length) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8 * scale;
  const ctx = canvas.getContext('2d');
  // Use the C64 accent color so the glyph reads against both the default
  // and the inverted (pressed) kbd backgrounds.
  ctx.fillStyle = '#65d8a3';
  for (let row = 0; row < 8; row++) {
    const byte = rom[offset + row];
    for (let col = 0; col < 8; col++) {
      if (byte & (0x80 >> col)) {
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
  }
  return canvas.toDataURL();
}

// Wrap each char-keyed kbd's text in a .kbd-default span and append a
// .kbd-shifted sibling with the shifted variant. Idempotent per-kbd — if
// the char ROM isn't ready, letter kbds are left for the next call to fill.
function _buildShiftLabels() {
  if (!keymapModal || !_keymapBuilt) return;
  for (const el of keymapModal.querySelectorAll('.kbd-tap[data-char]')) {
    if (el.querySelector('.kbd-shifted')) continue;
    const ch = el.getAttribute('data-char');
    if (SHIFTED_SCREEN_CODE[ch] == null) continue;
    const url = _renderCharRomGlyph(SHIFTED_SCREEN_CODE[ch]);
    if (!url) continue; // char ROM not ready yet — retry later
    const original = el.innerHTML;
    el.innerHTML = `<span class="kbd-default">${original}</span><span class="kbd-shifted"><img class="kbd-petscii" src="${url}" alt=""></span>`;
  }
}

// Whether Shift is currently "held" from the user's perspective: either a
// physical Shift key is down, or the on-screen Shift is latched. Drives the
// body.shift-held class which swaps kbd labels to their PETSCII variants.
let _physicalShiftHeld = false;
function _refreshShiftHeldClass() {
  const latchedShift =
    _latchedModifiers.has('ShiftLeft') || _latchedModifiers.has('ShiftRight');
  const held = _physicalShiftHeld || latchedShift;
  document.body.classList.toggle('shift-held', held);
  if (held) _buildShiftLabels();
}

// Transient "pressed" highlight on a tapped on-screen kbd. The matrix hold
// is only ~80ms — too brief to register visually — so we hold the inverted
// style ~200ms so the user clearly sees that the click landed.
const KEYMAP_FLASH_MS = 200;
function _flashKbdPress(el) {
  if (!el) return;
  el.classList.add('kbd-pressed');
  setTimeout(() => el.classList.remove('kbd-pressed'), KEYMAP_FLASH_MS);
}

// Resolve the on-screen kbd element that mirrors a host KeyboardEvent.
// CHAR_MAP symbols → [data-char="<typed char>"]; letters/digits derived
// from event.code; everything else → [data-code="<event.code>"].
function _kbdElForKeyEvent(e) {
  if (!_keymapBuilt || !keymapModal) return null;
  let charKey = null;
  if (e.key && e.key.length === 1 && CHAR_MAP[e.key]) {
    charKey = e.key;
  } else if (e.code && e.code.startsWith('Key')) {
    charKey = e.code.slice(3);   // KeyA → 'A'
  } else if (e.code && e.code.startsWith('Digit')) {
    charKey = e.code.slice(5);   // Digit1 → '1'
  }
  if (charKey) {
    return keymapModal.querySelector(`.kbd-tap[data-char="${CSS.escape(charKey)}"]`);
  }
  if (e.code) {
    return keymapModal.querySelector(`.kbd-tap[data-code="${CSS.escape(e.code)}"]`);
  }
  return null;
}

// Per-kbd timer for the "fade out" after a host keyup. Holding a key keeps
// the kbd lit for the full duration (no timer); releasing it kicks off a
// 200ms fade so a brief tap still gets perceivable feedback.
const _kbdFadeTimers = new Map();

function _onKbdKeydown(e) {
  if (!_keymapIsOpen()) return;
  const el = _kbdElForKeyEvent(e);
  if (!el) return;
  const t = _kbdFadeTimers.get(el);
  if (t) { clearTimeout(t); _kbdFadeTimers.delete(el); }
  el.classList.add('kbd-pressed');
}

function _onKbdKeyup(e) {
  const el = _kbdElForKeyEvent(e);
  if (!el) return;
  const existing = _kbdFadeTimers.get(el);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    el.classList.remove('kbd-pressed');
    _kbdFadeTimers.delete(el);
  }, KEYMAP_FLASH_MS);
  _kbdFadeTimers.set(el, t);
}

if (keymapModal) {
  keymapModal.addEventListener('click', e => {
    const tap = e.target.closest?.('.kbd-tap');
    if (!tap || !running) return;
    const code = tap.getAttribute('data-code');

    // Modifier click — toggle latch, don't fire a tap. The latched style
    // itself provides the visual feedback (no transient flash needed).
    if (code && KEYMAP_MODIFIER_CODES.has(code)) {
      _toggleLatch(code);
      return;
    }

    const ch = tap.getAttribute('data-char');
    if (ch) {
      _sendCharTap(ch);
    } else if (code) {
      _sendCodeTap(code);
    } else {
      return;
    }

    _flashKbdPress(tap);

    // Auto-clear any latched modifier after the tap's hold completes, so
    // the latch is one-shot by default. Fire slightly after the tap so the
    // modifier stays asserted during the C64's keyboard scan window.
    if (_latchedModifiers.size > 0) {
      setTimeout(_releaseAllLatched, KEYMAP_TAP_HOLD_MS + 16);
    }
  });
}

// No keydown listener for the KEY MAP dialog: closing on Escape is escape-stack's
// job now, and that was all this one did. Unlike the other modals it deliberately
// does NOT swallow other keys — they go on reaching the C64 so the on-screen
// keyboard can flash the matching kbd as live feedback.

// ── Key-Joystick key-binding dialog ─────────────────────────────────────────
// Opened from the "redefine" link under a port set to a key
// joystick. Rebinds all six roles for that joystick (up/down/left/right + two
// fire buttons) in one guided flow, or a single role via a row click. The next
// key you press becomes that binding; Esc cancels the in-progress capture.

let _joyKeysDialogJoy  = null;  // 1 | 2 | null (which joystick is being edited)
let _joyCaptureSeq     = null;  // remaining slots to capture, or null when idle
let _joyCapturePending = null;  // partial {slot: code} built up during a flow
const _joyKeysIsOpen = () => joykeysModal && !joykeysModal.hidden;
// Escape cancels a capture in progress if there is one, and otherwise closes the
// dialog — so the layer stays claimed across the first press.
const _joyKeysEscape = {
  close: () => { if (_joyCaptureSeq) _cancelJoyCapture(); else _closeJoyKeys(); },
  isOpen: _joyKeysIsOpen,
};

// Grid rows / capture-prompt metadata, in capture order.
const _JOY_ROLES = [
  { slot: 'up',    glyph: '↑',  name: 'Up' },
  { slot: 'down',  glyph: '↓',  name: 'Down' },
  { slot: 'left',  glyph: '←',  name: 'Left' },
  { slot: 'right', glyph: '→',  name: 'Right' },
  { slot: 'fireA', glyph: '●',  name: 'Fire A' },
  { slot: 'fireB', glyph: '●²', name: 'Fire B' },
];
const _joyRole = slot => _JOY_ROLES.find(r => r.slot === slot);
// Lone modifiers aren't bindable on their own — wait for a "real" key.
const _JOY_SKIP_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

function _renderJoyKeysGrid() {
  const j = _joyKeysDialogJoy;
  if (!j || !joykeysGrid) return;
  const k = joyKeys[j];
  const activeSlot = _joyCaptureSeq && _joyCaptureSeq[0];
  const capturing = !!_joyCaptureSeq;
  joykeysGrid.innerHTML = _JOY_ROLES.map(r =>
    `<button type="button" class="joykeys-row${r.slot === activeSlot ? ' capturing' : ''}"` +
    ` data-slot="${r.slot}"${capturing ? ' disabled' : ''}>` +
      `<span class="joykeys-row-glyph">${r.glyph}</span>` +
      `<span class="joykeys-row-name">${r.name}</span>` +
      `<kbd class="kbd joykeys-row-key">${_joyKeyLabel(k[r.slot])}</kbd>` +
    `</button>`
  ).join('');
}

function _setJoyActionsDisabled(disabled) {
  for (const b of [btnJoykeysAll, btnJoykeysReset]) if (b) b.disabled = disabled;
}

function _resetJoyKeysHint() {
  if (!joykeysHint) return;
  joykeysHint.innerHTML =
    'Click <strong>Redefine all keys</strong> to rebind the whole stick, or ' +
    'click any single control below to change just that key.';
}

function _renderJoyCapturePrompt(note) {
  if (!joykeysHint) return;
  const r = _joyRole(_joyCaptureSeq[0]);
  const done = Object.keys(_joyCapturePending).length;
  const total = done + _joyCaptureSeq.length;
  const progress = total > 1 ? ` <span class="joykeys-dim">(${done + 1} of ${total})</span>` : '';
  const prefix = note ? `<span class="joykeys-dim">${note} — </span>` : '';
  joykeysHint.innerHTML =
    `${prefix}Press a key for <strong>${r.glyph} ${r.name}</strong>${progress} … ` +
    `<span class="joykeys-dim">Esc to cancel</span>`;
}

function _startJoyCapture(slots) {
  _joyCaptureSeq = slots.slice();
  _joyCapturePending = {};
  _setJoyActionsDisabled(true);
  _renderJoyKeysGrid();
  _renderJoyCapturePrompt();
}

function _recordJoyCapture(code) {
  // Within a multi-key flow, don't let one key cover two roles at once.
  const multi = _joyCaptureSeq.length + Object.keys(_joyCapturePending).length > 1;
  if (multi && Object.values(_joyCapturePending).includes(code)) {
    _renderJoyCapturePrompt(`${_joyKeyLabel(code)} already used`);
    return;
  }
  const slot = _joyCaptureSeq.shift();
  _joyCapturePending[slot] = code;
  if (_joyCaptureSeq.length === 0) {
    Object.assign(joyKeys[_joyKeysDialogJoy], _joyCapturePending);
    persistJoyKeys();
    _rebuildJoyKeyRev();
    _joyCaptureSeq = null;
    _joyCapturePending = null;
    _setJoyActionsDisabled(false);
    _renderJoyKeysGrid();
    _resetJoyKeysHint();
    _renderPortDetail(1);
    _renderPortDetail(2);
  } else {
    _renderJoyKeysGrid();
    _renderJoyCapturePrompt();
  }
}

function _cancelJoyCapture() {
  _joyCaptureSeq = null;
  _joyCapturePending = null;
  _setJoyActionsDisabled(false);
  _renderJoyKeysGrid();
  _resetJoyKeysHint();
}

function _openJoyKeys(j) {
  if (!joykeysModal) return;
  _joyKeysDialogJoy = j;
  _joyCaptureSeq = null;
  _joyCapturePending = null;
  if (joykeysTitle) joykeysTitle.textContent = `Key Joystick ${j} — Keys`;
  _setJoyActionsDisabled(false);
  _renderJoyKeysGrid();
  _resetJoyKeysHint();
  joykeysModal.hidden = false;
  pushEscapeLayer(_joyKeysEscape);
  if (btnJoykeysDone) btnJoykeysDone.focus();
}

function _closeJoyKeys() {
  popEscapeLayer(_joyKeysEscape);
  if (!joykeysModal) return;
  _joyCaptureSeq = null;
  _joyCapturePending = null;
  joykeysModal.hidden = true;
  _joyKeysDialogJoy = null;
  canvas.focus();
}

if (btnJoykeysAll) btnJoykeysAll.addEventListener('click', () => _startJoyCapture(JOY_KEY_DIRS));
if (btnJoykeysReset) btnJoykeysReset.addEventListener('click', () => {
  const j = _joyKeysDialogJoy;
  if (!j) return;
  joyKeys[j] = { ...JOY_KEY_DEFAULTS[j] };
  persistJoyKeys();
  _rebuildJoyKeyRev();
  _renderJoyKeysGrid();
  _renderPortDetail(1);
  _renderPortDetail(2);
});
if (btnJoykeysDone)  btnJoykeysDone.addEventListener('click', _closeJoyKeys);
if (btnJoykeysClose) btnJoykeysClose.addEventListener('click', _closeJoyKeys);
if (joykeysModal) {
  joykeysModal.addEventListener('click', e => { if (e.target === joykeysModal) _closeJoyKeys(); });
}
// Row click → rebind just that one role.
if (joykeysGrid) {
  joykeysGrid.addEventListener('click', e => {
    if (_joyCaptureSeq) return;   // a flow is already running (rows are disabled)
    const row = e.target.closest('.joykeys-row');
    if (row && row.dataset.slot) _startJoyCapture([row.dataset.slot]);
  });
}
// Capture-phase key handling. While the dialog is open, keys never reach the
// C64: during a capture the next key becomes the binding; otherwise keys are
// swallowed (default actions still fire so Tab / Enter / Space drive the
// buttons). Escape never arrives here — escape-stack.js takes it first, and its
// layer knows to cancel a capture in progress before closing the dialog.
document.addEventListener('keydown', e => {
  if (!_joyKeysIsOpen()) return;
  if (_joyCaptureSeq) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || _JOY_SKIP_CODES.has(e.code)) return;
    _recordJoyCapture(e.code);
    return;
  }
  e.stopImmediatePropagation();
}, { capture: true });

// Every app-level shortcut, in one place. The dispatcher below, and the App
// shortcuts section of the KEY MAP dialog, both read this — so a new shortcut is
// one entry here and nothing else, and the help can't drift from the behaviour.
//
// `code` is a KeyboardEvent.code, which is layout- and Shift-independent, so
// 'KeyZ' matches Z on a Norwegian keyboard and with Shift held. `run` is called
// with no arguments; it decides for itself whether it can act. Keep the list in
// the order it should read in the dialog.
const APP_SHORTCUTS = [];

export function registerAppShortcut(entry) {
  APP_SHORTCUTS.push(entry);
}

// The letters the browser or OS will not give up, whatever we do: preventDefault
// cannot stop these, so nothing may be bound to them. W/T/N/Q are new window,
// new tab, reopen tab and quit — Ctrl+Shift+ and Cmd+Shift+ alike, with
// Cmd+Shift+Q logging the Mac out; M and H are macOS minimise and hide; I/J/C
// open Chrome's DevTools from Ctrl+Shift+ and never reach the page. P is the
// private window in Firefox and Edge, and Firefox marks that shortcut reserved —
// the browser acts on it before content sees the event, so preventDefault never
// gets a say.
const RESERVED_CODES = new Set([
  'KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyM', 'KeyH', 'KeyI', 'KeyJ', 'KeyC', 'KeyP',
]);

// The app's own shortcuts. `run` closes over the injected hooks, which initInput
// assigns later — it is only ever called from an event, so the binding is set by
// then. Registered here rather than at each feature's call site so the dialog
// order is the order of this list.
registerAppShortcut({
  code: 'KeyV', label: 'Paste clipboard',
  run: () => pasteFromShortcut?.(),
});
registerAppShortcut({
  code: 'KeyF', label: 'Cycle CRT look',
  run: () => cycleCrtEffect(),
});
registerAppShortcut({
  code: 'KeyZ', label: 'Zoom VIBES button 10x',
  run: () => toggleVibesZoom(),
});
registerAppShortcut({
  code: 'KeyX', label: 'Retro Vibes Studio mode',
  run: () => toggleVibesStudio?.(),
});
// Developer-only; on the same chord as the rest.
registerAppShortcut({
  code: 'KeyS', label: 'Debug snapshot',
  run: () => { if (machine) downloadSnapshot(); },
});

if (APP_SHORTCUTS.some(s => RESERVED_CODES.has(s.code))) {
  throw new Error('app shortcut bound to a key the browser will not release');
}

document.addEventListener('keydown', e => {
  // A focused text field (e.g. the Fetch-ROMs URL inputs) owns its own keys —
  // never map them onto the C64 matrix, or typing/paste there both leak to the
  // emulator and get preventDefault'd (which blocks the browser's own paste).
  // Read up here because the accelerator below needs it too: with a field
  // focused the chord stands down, so Cmd+Shift+V and Ctrl+Shift+V still paste
  // into the field the way the host means them to.
  const _kt = e.target;
  const _inField = !!(_kt && (_kt.tagName === 'INPUT' || _kt.tagName === 'TEXTAREA' || _kt.isContentEditable));

  // App shortcuts, from the registry above. Dispatched ahead of the matrix
  // mapping because every letter we use is also a C64 key — reached by that
  // mapping, Ctrl+Shift+F would type an F — and ahead of the `running` gate, so
  // a halted machine can still be inspected. Only the bound letter is taken: the
  // Ctrl and Shift of the chord reach the matrix as themselves, so every other
  // Ctrl / Ctrl+Shift combination still belongs to the C64.
  if (appAccel(e, _inField)) {
    const hit = APP_SHORTCUTS.find(s => s.code === e.code);
    if (hit) {
      e.preventDefault();
      hit.run();
      return;
    }
  }

  if (_inField) return;

  // Cmd is not a C64 key, so a Cmd chord that isn't one of ours is not the
  // machine's either. Bailing out here matters most on macOS, where the browser
  // swallows the keyup of a letter pressed with Cmd held: routed to the matrix,
  // Cmd+V would press V on the C64 and never release it. Leaving the keydown
  // alone also lets the browser raise its own `paste` event, which main.js
  // listens for — so Cmd+V still pastes, by the host's route rather than ours.
  // Ctrl is untouched by this: it IS a C64 key and keeps working as one.
  if (e.metaKey) return;

  if (!running) return;

  // Divert keys bound to any plugged-in key joystick (each has its own
  // bindings; a key shared by both drives both). Only the mapped keys are
  // consumed, so unbound keys still reach the C64 matrix normally.
  if (anyKbdJoy()) {
    let matched = false;
    for (const j of _activeKbdJoys()) {
      const dir = _joyKeyRev[j][e.code];
      if (dir) { kbdJoyState[j][dir] = true; matched = true; }
    }
    if (matched) { updateJoyPorts(); e.preventDefault(); return; }
  }

  // Mirror physical-key activity into the on-screen Key Map (if open).
  _onKbdKeydown(e);
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    _physicalShiftHeld = true;
    _refreshShiftHeldClass();
  }

  // ── Windows AltGr guard ─────────────────────────────────────────────────
  // Windows emulates AltGr as Ctrl+Alt: pressing AltGr injects a phantom
  // `ControlLeft` keydown just before `AltRight`. That spurious Ctrl maps to the
  // C64 CTRL key [7,2] and — on European layouts (Norwegian et al., where AltGr
  // types @ [ ] { } \ | ~ $) — would shift the typed symbol or, if the phantom
  // Ctrl keyup is lost, stick CTRL down (silently breaking loaders that exact-CMP
  // the col-7 keyboard read: the "hit space" bug). Once AltGr is fully down the
  // event reports getModifierState('AltGraph'); any Ctrl seen then is the phantom,
  // so release [7,2] and don't route the Ctrl/Alt of AltGr as a matrix key (the
  // symbol key itself falls through to CHAR_MAP). The initial phantom ControlLeft
  // arrives before AltGraph is set, but no emulator frame runs between the two
  // synthesised keydowns, so the C64 never samples that transient press.
  if (IS_WINDOWS && e.getModifierState && e.getModifierState('AltGraph')) {
    machine.cia1.setKey(7, 2, false);
    if (e.code === 'ControlLeft' || e.code === 'ControlRight' ||
        e.code === 'AltLeft'     || e.code === 'AltRight') return;
  }

  // arrow left/up require SHIFT simulation on C64
  if (e.code === 'ArrowLeft') {
    machine.cia1.setKey(0, 2, true); // CRSR RIGHT
    if (!machine.cia1.isKeyDown(1, 7)) machine.cia1.setKey(1, 7, true); // simulate shift
    arrowShiftActive.ArrowLeft = true;
    e.preventDefault(); return;
  }
  if (e.code === 'ArrowUp') {
    machine.cia1.setKey(0, 7, true); // CRSR DOWN
    if (!machine.cia1.isKeyDown(1, 7)) machine.cia1.setKey(1, 7, true);
    arrowShiftActive.ArrowUp = true;
    e.preventDefault(); return;
  }

  // F12 = RESTORE — NMI pulse (not a keyboard-matrix key on real silicon).
  // Press asserts NMI; release deasserts. The CPU latches on the rising edge.
  if (e.code === 'F12') {
    machine.setRestoreNmiLine(true);
    e.preventDefault();
    return;
  }

  // F2/F4/F6/F8 = shifted F1/F3/F5/F7
  const shiftedFn = { 'F2': 'F1', 'F4': 'F3', 'F6': 'F5', 'F8': 'F7' };
  if (shiftedFn[e.code]) {
    machine.cia1.setKey(1, 7, true); // SHIFT
    machine.cia1.setKey(...KEY_MAP[shiftedFn[e.code]], true);
    e.preventDefault(); return;
  }

  // Symbol path: route printable characters via CHAR_MAP so the C64 sees the
  // same symbol the user typed, regardless of host layout. We override C64
  // Shift to match what the C64 needs for this character, tracking exactly
  // which shift keys we touched so keyup can undo it. The C64 has two shift
  // keys ([1,7] left, [6,4] right) and treats either as "shift on", so a held
  // host Right-Shift would otherwise leak through and shift our symbol.
  // event.code is the stable per-press key (event.key can mutate if host
  // Shift toggles mid-press).
  if (e.key && e.key.length === 1 && CHAR_MAP[e.key]) {
    const { col, row, shift } = CHAR_MAP[e.key];
    const lShiftDown = machine.cia1.isKeyDown(1, 7);
    const rShiftDown = machine.cia1.isKeyDown(6, 4);
    const shiftDown = lShiftDown || rShiftDown;
    let pressedLShift = false;
    let releasedLShift = false;
    let releasedRShift = false;
    if (shift && !shiftDown) {
      machine.cia1.setKey(1, 7, true); pressedLShift = true;
    } else if (!shift && shiftDown) {
      if (lShiftDown) { machine.cia1.setKey(1, 7, false); releasedLShift = true; }
      if (rShiftDown) { machine.cia1.setKey(6, 4, false); releasedRShift = true; }
    }
    machine.cia1.setKey(col, row, true);
    activeCharPresses[e.code] = { col, row, pressedLShift, releasedLShift, releasedRShift };
    e.preventDefault();
    return;
  }

  const pos = KEY_MAP[e.code];
  if (pos) {
    activeMatrixPresses.claim(e.code);
    machine.cia1.setKey(pos[0], pos[1], true);
    e.preventDefault();
  }
});

document.addEventListener('keyup', e => {
  // Always fade out the matching on-screen kbd, even if the emulator isn't
  // running — otherwise a power-off mid-press would leave it stuck lit.
  _onKbdKeyup(e);
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    // e.shiftKey on a Shift keyup reflects whether the *other* Shift is
    // still held, so it's the right "any shift down" signal here.
    _physicalShiftHeld = e.shiftKey;
    _refreshShiftHeldClass();
  }

  if (!running) return;

  if (anyKbdJoy()) {
    let matched = false;
    for (const j of _activeKbdJoys()) {
      const dir = _joyKeyRev[j][e.code];
      if (dir) { kbdJoyState[j][dir] = false; matched = true; }
    }
    if (matched) { updateJoyPorts(); e.preventDefault(); return; }
  }

  if (e.code === 'ArrowLeft') {
    machine.cia1.setKey(0, 2, false);
    if (arrowShiftActive.ArrowLeft) { machine.cia1.setKey(1, 7, false); arrowShiftActive.ArrowLeft = false; }
    e.preventDefault(); return;
  }
  if (e.code === 'ArrowUp') {
    machine.cia1.setKey(0, 7, false);
    if (arrowShiftActive.ArrowUp) { machine.cia1.setKey(1, 7, false); arrowShiftActive.ArrowUp = false; }
    e.preventDefault(); return;
  }

  // F12 (RESTORE) keyup: deassert NMI line.
  if (e.code === 'F12') {
    machine.setRestoreNmiLine(false);
    e.preventDefault();
    return;
  }

  const shiftedFn = { 'F2': 'F1', 'F4': 'F3', 'F6': 'F5', 'F8': 'F7' };
  if (shiftedFn[e.code]) {
    machine.cia1.setKey(1, 7, false);
    machine.cia1.setKey(...KEY_MAP[shiftedFn[e.code]], false);
    e.preventDefault(); return;
  }

  // Symbol path keyup: release the base key, then undo whichever Shift edits
  // keydown made — but only if the host's real Shift state agrees, so a
  // genuine still-held Shift isn't dropped (and a since-released Shift isn't
  // re-asserted). We track left and right shift independently because the C64
  // reads them at different matrix positions even though it treats either as
  // "shift on".
  const state = activeCharPresses[e.code];
  if (state) {
    delete activeCharPresses[e.code];
    machine.cia1.setKey(state.col, state.row, false);
    if (state.pressedLShift && !e.shiftKey) {
      machine.cia1.setKey(1, 7, false);
    }
    if (state.releasedLShift && e.shiftKey) {
      machine.cia1.setKey(1, 7, true);
    }
    if (state.releasedRShift && e.shiftKey) {
      machine.cia1.setKey(6, 4, true);
    }
    e.preventDefault();
    return;
  }

  const pos = KEY_MAP[e.code];
  if (pos && activeMatrixPresses.release(e.code)) {
    machine.cia1.setKey(pos[0], pos[1], false);
    e.preventDefault();
  }
});

window.addEventListener('blur', () => {
  _releaseKbdJoyMatrix();
  // Release any in-flight CHAR_MAP presses so a focus loss while holding a
  // symbol (e.g. Cmd+Tab during '(') doesn't leave the base key or our
  // synthesised Shift latched on the C64 matrix. We never *re-press* shift
  // here — host modifiers are by definition released across a blur.
  if (machine?.cia1) {
    for (const code of Object.keys(activeCharPresses)) {
      const state = activeCharPresses[code];
      machine.cia1.setKey(state.col, state.row, false);
      if (state.pressedLShift) machine.cia1.setKey(1, 7, false);
      delete activeCharPresses[code];
    }
    // A blur guarantees no keyup will arrive for keys pressed before it (the OS
    // routes it elsewhere), so release the ENTIRE keyboard matrix — not just the
    // tracked CHAR_MAP/latched keys above. A plain physical key on the generic
    // KEY_MAP path (Control, Space, letters, Return) is tracked nowhere and would
    // otherwise stay stuck: e.g. macOS Ctrl+←/→ (switch Space) swallows the
    // Control keyup, leaving CTRL [7,2] held — which silently breaks loaders that
    // poll the col-7 row with an exact compare (the "hit space" bug). Joystick
    // input lives in joyPort1/2 (re-derived each frame), so this doesn't touch it.
    machine.cia1.matrix.fill(0xFF);
  }
  // Also drop any on-screen-modifier latches; the user is no longer driving
  // the dialog and a stuck SHIFT/CTRL/C= would confuse the next session.
  _releaseAllLatched();
  _physicalShiftHeld = false;
  _refreshShiftHeldClass();
  mouseButtons.left = false;
  mouseButtons.right = false;
  updateJoyPorts();
  clearPendingPaste();
});

// ── Mouse / paddle wiring ───────────────────────────────────────────────────
// SID's $D419 / $D41A return 8-bit paddle X/Y from the analog ADCs. The host
// mouse feeds three different C64 input devices depending on the selected
// port mode:
//
//   • Mouse (1351) — pointer-locked. movementX/Y wrap mod 256 into paddleX/Y;
//     a 1351 driver reads signed deltas off the POT register.
//   • Mouse (NEOS) — pointer-locked. Deltas accumulate per port and are
//     nibble-multiplexed onto the joystick byte; see installNeosHook.
//   • Paddle — unlocked. Absolute canvas position maps to paddleX/Y.
//
// Joystick / Key Joystick / None: mouse input is fully inert.
//
// Sub-unit delta carry so slow mouse motion still registers when we scale
// movementX/Y down (otherwise truncate-to-zero would kill it).
let _mouseFracX = 0;
let _mouseFracY = 0;
let _neosFracX  = 0;
let _neosFracY  = 0;
const _MOUSE_SENSITIVITY = 0.5;
// The 1351 needs its own accumulator because its POT byte advances by
// ControlPort.M1351_POT_STEP (2) per mouse unit, not 1 — see that constant.
// Halving the unit rate against _MOUSE_SENSITIVITY keeps the on-screen pointer
// speed independent of that step.
const _M1351_SENSITIVITY = _MOUSE_SENSITIVITY / ControlPort.M1351_POT_STEP;
let _m1351FracX = 0;
let _m1351FracY = 0;
// NEOS delivers an 8-bit signed delta per full strobe cycle. The snapshot
// step inside _neosCheckStrobe clamps to ±127, so we just need a sensible
// per-pixel scale here.
const _NEOS_SENSITIVITY  = _MOUSE_SENSITIVITY * 0.6;

canvas.addEventListener('mousemove', e => {
  if (!machine) return;
  if (!anyMouseLike()) return;

  if (document.pointerLockElement === canvas) {
    // Delta-based path: 1351, NEOS, and Paddle all integrate motion.
    _mouseFracX += e.movementX * _MOUSE_SENSITIVITY;
    _mouseFracY += e.movementY * _MOUSE_SENSITIVITY;
    const dx = _mouseFracX | 0;
    const dy = _mouseFracY | 0;
    _mouseFracX -= dx;
    _mouseFracY -= dy;

    // 1351: wrap paddle bytes mod 256 (Y inverted to match POTY convention).
    // Its own frac accumulator, because the POT byte steps by 2 per unit.
    if (anyPortIs('mouse1351')) {
      _m1351FracX += e.movementX * _M1351_SENSITIVITY;
      _m1351FracY += e.movementY * _M1351_SENSITIVITY;
      const ux = _m1351FracX | 0;
      const uy = _m1351FracY | 0;
      _m1351FracX -= ux;
      _m1351FracY -= uy;
      const S = ControlPort.M1351_POT_STEP;
      machine.paddleX = (machine.paddleX + ux * S) & 0xFF;
      machine.paddleY = (machine.paddleY - uy * S) & 0xFF;
    }
    // NEOS: independent sensitivity + frac accumulator. The snapshot inside
    // _neosCheckStrobe clamps to ±127, so we accumulate raw deltas here.
    if (anyPortIs('mouseNeos')) {
      _neosFracX += e.movementX * _NEOS_SENSITIVITY;
      _neosFracY += e.movementY * _NEOS_SENSITIVITY;
      const ndx = _neosFracX | 0;
      const ndy = _neosFracY | 0;
      _neosFracX -= ndx;
      _neosFracY -= ndy;
      for (const p of [1, 2]) {
        if (portDevice[p] !== 'mouseNeos') continue;
        neosState[p].pendingDX -= ndx;
        neosState[p].pendingDY -= ndy;
      }
    }
    // Paddle: a single paddle knob = one axis. We drive POTX only; POTY is
    // the second paddle on the port and isn't useful with a single mouse.
    // POTX rises as the knob turns counter-clockwise, so moving the host
    // mouse right needs to decrease POTX for the bat to track direction.
    if (anyPortIs('paddle')) {
      machine.paddleX = Math.max(0, Math.min(255, (machine.paddleX | 0) - dx));
    }
  }
});

// Click to request pointer lock when a delta-based mouse device is active.
// The browser returns the lock on ESC automatically.
canvas.addEventListener('click', () => {
  if (!anyPointerLockDevice()) return;
  if (document.pointerLockElement === canvas) return;
  if (typeof canvas.requestPointerLock === 'function') {
    try {
      canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      canvas.requestPointerLock();
    }
  }
});

// Mouse buttons: left = fire for any mouse-like port. Right is the 1351's UP
// line and the NEOS right button on POTX; Paddle ignores it. contextmenu is
// suppressed for any mouse-like device so the right button reaches the emulator.
function _syncNeosButtons() {
  if (!anyPortIs('mouseNeos')) return;
  for (const p of [1, 2]) {
    if (portDevice[p] !== 'mouseNeos') continue;
    neosState[p].leftBtn  = mouseButtons.left;
    neosState[p].rightBtn = mouseButtons.right;
  }
}

canvas.addEventListener('mousedown', e => {
  if (!anyMouseLike()) return;
  if (e.button === 0) mouseButtons.left = true;
  else if (e.button === 2) mouseButtons.right = true;
  _syncNeosButtons();
  e.preventDefault();
  updateJoyPorts();
});
window.addEventListener('mouseup', e => {
  if (!anyMouseLike()) return;
  if (e.button === 0) mouseButtons.left = false;
  else if (e.button === 2) mouseButtons.right = false;
  _syncNeosButtons();
  updateJoyPorts();
});
canvas.addEventListener('contextmenu', e => {
  // Suppress the browser context menu whenever any mouse-based device is
  // active so the right button reaches the emulator.
  if (anyMouseLike()) e.preventDefault();
});

// On lock release: drop latched buttons so a click-then-ESC doesn't leave
// fire stuck on for any mouse-like port.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) {
    mouseButtons.left = false;
    mouseButtons.right = false;
    _syncNeosButtons();
    updateJoyPorts();
  }
});

// ── Dependency injection ─────────────────────────────────────────────────────
export function initInput(deps) {
  ({ downloadSnapshot, clearPendingPaste, cycleCrtEffect, toggleVibesZoom, pasteFromShortcut,
     toggleVibesStudio } = deps);
}
