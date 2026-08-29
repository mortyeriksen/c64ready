// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Pure logic for the Control Port panel. Lives outside main.js so tests
// can exercise the byte builders and NEOS state machine without a DOM.
//
// Joystick byte layout (active-low, as fed to memory.js's joyPort1/2):
//   bit 0 = UP, bit 1 = DOWN, bit 2 = LEFT, bit 3 = RIGHT, bit 4 = FIRE
//
// Device value strings recognised here:
//   'none' | 'joystick' | 'mouse1351' | 'mouseNeos' | 'paddle'
//   | 'touchJoystick' | 'keyboardJoystick1' | 'keyboardJoystick2'
//   (+ legacy 'keyboardJoystick')

export const IDLE_DIRS = Object.freeze({
  up: false, down: false, left: false, right: false, fire: false,
});

// Active-low byte fed into machine.joyPort{1,2}.
export function dirsToByte(s) {
  let val = 0xFF;
  if (s.up)    val &= ~0x01;
  if (s.down)  val &= ~0x02;
  if (s.left)  val &= ~0x04;
  if (s.right) val &= ~0x08;
  if (s.fire)  val &= ~0x10;
  return val;
}

// Active-low byte for a configured port. Mirrors portDirs()+dirsToByte() but
// computes the common per-frame path directly. Positional arguments keep the
// frame loop from allocating source-wrapper or direction objects.
export function portByte(device, gamepadState, kbdJoyState, mouseButtons, touchJoystickState) {
  switch (device) {
    case 'joystick':
      return dirsToByte(gamepadState);

    case 'keyboardJoystick':
    case 'keyboardJoystick1':
    case 'keyboardJoystick2': {
      if (!kbdJoyState) return 0xFF;
      let val = 0xFF;
      if (kbdJoyState.up || kbdJoyState.fireB) val &= ~0x01;
      if (kbdJoyState.down)  val &= ~0x02;
      if (kbdJoyState.left)  val &= ~0x04;
      if (kbdJoyState.right) val &= ~0x08;
      if (kbdJoyState.fireA) val &= ~0x10;
      return val;
    }

    case 'touchJoystick': {
      if (!touchJoystickState) return 0xFF;
      let val = 0xFF;
      if (touchJoystickState.up || touchJoystickState.fireB) val &= ~0x01;
      if (touchJoystickState.down)  val &= ~0x02;
      if (touchJoystickState.left)  val &= ~0x04;
      if (touchJoystickState.right) val &= ~0x08;
      if (touchJoystickState.fireA) val &= ~0x10;
      return val;
    }

    case 'mouse1351': {
      let val = 0xFF;
      if (mouseButtons?.right) val &= ~0x01;
      if (mouseButtons?.left)  val &= ~0x10;
      return val;
    }

    case 'paddle': {
      let val = 0xFF;
      if (mouseButtons?.left)  val &= ~0x04;
      if (mouseButtons?.right) val &= ~0x10;
      return val;
    }

    case 'mouseNeos':
    case 'none':
    default:
      return 0xFF;
  }
}

const BYTE_INDICATOR_TEXT = (() => {
  const a = new Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let text = '';
    if ((byte & 0x01) === 0) text += text ? ' ↑' : '↑';
    if ((byte & 0x02) === 0) text += text ? ' ↓' : '↓';
    if ((byte & 0x04) === 0) text += text ? ' ←' : '←';
    if ((byte & 0x08) === 0) text += text ? ' →' : '→';
    if ((byte & 0x10) === 0) text += text ? ' ●' : '●';
    a[byte] = text;
  }
  return a;
})();

export function byteIndicatorText(byte) {
  return BYTE_INDICATOR_TEXT[byte & 0xFF];
}

// Resolve a port's logical direction state from the current device.
// Caller supplies the shared input sources:
//   gamepadState     — { up,down,left,right,fire } latched from navigator.getGamepads
//   kbdJoyState      — { up,down,left,right,fireA,fireB }; fireA→FIRE, fireB→UP
//   mouseButtons     — { left, right }
//
// NEOS does NOT go through this function — its byte is computed by
// neosByte() which encodes nibble-multiplexed deltas and DDR-mode rules.
export function portDirs(device, { gamepadState, kbdJoyState, mouseButtons, touchJoystickState }) {
  switch (device) {
    case 'joystick':
      return gamepadState;

    case 'keyboardJoystick':    // legacy alias for keyboardJoystick1
    case 'keyboardJoystick1':
    case 'keyboardJoystick2':
      // Two independent key joysticks (see main.js JOY_KEY_DEFAULTS): the
      // caller passes the selected one's held-key state as kbdJoyState.
      // Fire B is wired to the UP line — the standard C64 second-button
      // convention used by Sega Master System adapters, Mega Drive pads
      // through passive adapters, and many "two-button" C64 sticks.
      return {
        up:    !!(kbdJoyState.up || kbdJoyState.fireB),
        down:  !!kbdJoyState.down,
        left:  !!kbdJoyState.left,
        right: !!kbdJoyState.right,
        fire:  !!kbdJoyState.fireA,
      };

    case 'touchJoystick':
      return {
        up:    !!(touchJoystickState?.up || touchJoystickState?.fireB),
        down:  !!touchJoystickState?.down,
        left:  !!touchJoystickState?.left,
        right: !!touchJoystickState?.right,
        fire:  !!touchJoystickState?.fireA,
      };

    case 'mouse1351':
      // 1351 wiring: the LEFT button sits on the joystick FIRE line
      // (bit 4) and the RIGHT button on the joystick UP line (bit 0) —
      // matching the real Commodore 1351 and what GEOS reads. LMB → FIRE,
      // RMB → UP.
      return {
        up:    !!mouseButtons.right,
        down:  false,
        left:  false,
        right: false,
        fire:  !!mouseButtons.left,
      };

    case 'paddle':
      // Real C64 paddle pairs route paddle A fire to the joystick LEFT
      // line (bit 2) and paddle B fire to the FIRE line (bit 4). LMB →
      // paddle A fire, RMB → paddle B fire.
      return {
        up:    false,
        down:  false,
        left:  !!mouseButtons.left,
        right: false,
        fire:  !!mouseButtons.right,
      };

    case 'mouseNeos':
    case 'none':
    default:
      return IDLE_DIRS;
  }
}

// ── NEOS mouse protocol ────────────────────────────────────────────────
// Reference: c64os.com/post/neosreborn
//
// The mouse is read via the joystick FIRE bit on the port (bit 4 of
// $DC00 for port 2, bit 4 of $DC01 for port 1).
//
//   • Button-read mode  — DDR bit 4 = input. Bit 4 carries the LMB.
//   • Strobe-read mode  — bits 0..3 = input, bit 4 = output. Toggling
//                         bit 4 cycles a 4-phase nibble readout:
//                         Xhi → Xlo → Yhi → Ylo, snapshot at phase 0.
//   • Inactive          — anything else (e.g. keyboard scan with DDR=$FF).
//                         No phase ticks, no driving of bits.
//
// Right button is on SID $D419 (POTX, pin 9) as a WHOLE-BYTE value — see
// neosPotX() below. POTY (pin 5) is not connected.

export function neosMode(ddr) {
  if (!(ddr & 0x10))          return 'button';
  if ((ddr & 0x1F) === 0x10)  return 'strobe';
  return 'inactive';
}

// POT counts per mouse unit for a 1351. A real 1351 reports a 6-bit position
// counter in POT bits 1..6, so the byte a driver reads moves by TWO per unit;
// bit 0 is not part of the count. Every 1351 driver takes this into account —
// mouse/1351/mmtest.asm in VICE's testprogs does:
//
//     lda $D419 / sec / sbc old / and #$7F   ; 7-bit difference
//     cmp #$40 / bcs neg                     ; >= $40 => negative
//     lsr / beq nothing_changed              ; delta = difference >> 1
//
// so the difference is HALVED: the byte must advance by 2 per unit for a
// driver to recover the motion, and for a lone one-unit step to register at
// all (a difference of 1 halves to 0, which the driver reads as no movement).
export const M1351_POT_STEP = 2;

// POTX byte for a NEOS-assigned port. Both reference drivers shipped with
// VICE's testprogs (mouse/neos/mousecheese.s — extracted from the original
// "mouse cheese" program and marked "literal reference - DONT CHANGE" — and
// mouse/neos/krakout.s) read the right button as:
//
//     lda $D419
//     cmp #$FF        ; carry set  => RMB pressed
//
// Carry is set only when the byte is exactly $FF, so the button is a
// whole-byte value and not a bit within the pot reading. Released is anything
// other than $FF; $00 keeps it unambiguous.
export function neosPotX(rmb) { return rmb ? 0xFF : 0x00; }

// The mouse restarts its nibble sequencer when the clk line has been idle for
// a while, so every read begins at Xhi no matter how the previous one ended.
// Drivers depend on it. Some read fewer than the four edges a full sequence
// needs — arkanoid's routine (mouse/neos/arkanoid.s in VICE's testprogs)
// clobbers the port index it uses for `$DC00,X` halfway through, so its last
// two strobe writes land on whatever CIA register `X & 15` selects and only
// two edges arrive. The idle reset is what keeps the next read aligned.
//
// The gaps within one read are set by the drivers' delay loops: ~56 cycles
// after the first edge, ~7 for the rest. Between reads it is a whole frame
// (19656). Anything comfortably between the two works; this is a behavioural
// model, not a measured hardware constant.
export const NEOS_IDLE_RESET_CY = 1000;

export function createNeosState() {
  return {
    phase: 3,
    pendingDX: 0, pendingDY: 0,
    snapDX:    0, snapDY:    0,
    prevStrobe: 1,
    lastEdgeCy: null,
    leftBtn: false, rightBtn: false,
  };
}

export function neosResetPort(s) {
  s.phase = 3;
  s.pendingDX = 0; s.pendingDY = 0;
  s.snapDX = 0;    s.snapDY = 0;
  s.prevStrobe = 1;
  s.lastEdgeCy = null;
  s.leftBtn = false;
  s.rightBtn = false;
}

// Compute the byte returned to memory.js for a NEOS-assigned port.
// `ddr` is the relevant CIA1 PRA or PRB direction register.
export function neosByte(s, ddr) {
  const mode = neosMode(ddr);
  if (mode === 'strobe') {
    let nibble;
    switch (s.phase) {
      case 0: nibble = (s.snapDX >>> 4) & 0x0F; break; // X high
      case 1: nibble = s.snapDX & 0x0F;          break; // X low
      case 2: nibble = (s.snapDY >>> 4) & 0x0F; break; // Y high
      case 3: nibble = s.snapDY & 0x0F;          break; // Y low
      default: nibble = 0;
    }
    return 0xF0 | nibble;
  }
  // Button-read OR inactive: LMB on joystick FIRE bit (per c64os spec).
  return s.leftBtn ? 0xEF : 0xFF;
}

// Tick the NEOS phase counter on a bit-4 transition. Returns true if a
// snapshot was just taken (phase wrapped to 0).
// `nowCy` is a free-running master-cycle count (machine.sidCycleCounter);
// omitting it disables the idle reset.
export function neosCheckStrobe(s, ddr, out, nowCy = null) {
  if (neosMode(ddr) !== 'strobe') return false;
  const newStrobe = (out & 0x10) ? 1 : 0;
  // Idle long enough? The sequencer restarts and clk returns to its rest
  // state, so the next low is a fresh Xhi. Evaluated before the no-transition
  // early-return below, because a driver may leave clk low at the end of one
  // read and open the next by writing low again — no transition at all, yet
  // the sequence must still start at Xhi.
  //
  // The distance is an unsigned 32-bit difference: the clock is
  // machine.sidCycleCounter, which restarts at 0 on a hard reset or a fresh
  // machine while this state persists, and wraps at 2^32. A signed compare
  // reads those as a large negative gap and never resets.
  if (nowCy !== null && s.lastEdgeCy !== null &&
      ((nowCy - s.lastEdgeCy) >>> 0) > NEOS_IDLE_RESET_CY) {
    s.phase = 3;
    s.prevStrobe = 1;          // clk rests high
  }
  if (newStrobe === s.prevStrobe) return false;
  if (nowCy !== null) s.lastEdgeCy = nowCy >>> 0;
  s.prevStrobe = newStrobe;
  s.phase = (s.phase + 1) & 3;
  if (s.phase === 0) {
    s.snapDX = Math.max(-128, Math.min(127, s.pendingDX | 0));
    s.snapDY = Math.max(-128, Math.min(127, s.pendingDY | 0));
    s.pendingDX -= s.snapDX;
    s.pendingDY -= s.snapDY;
    return true;
  }
  return false;
}
