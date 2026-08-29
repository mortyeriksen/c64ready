// Auto-load invariants (src/main.js _basicReady + chunk-fed keyboard typing).
//
// main.js defers a load until BASIC is idle at the READY prompt (PRG loads after
// a hard reset; disk/tape auto-loads from the current state), then types the
// load command. That UI code is not headless-testable, but the machine-level
// facts it relies on ARE — and if a future machine change breaks them, the
// auto-load would silently load into a half-booted machine or type a command
// that never executes. This pins those facts:
//
//   1. READY detector: ram[$C6]==0 && ram[$CC]==0 && ram[$2C]==0x08 is FALSE
//      during the cold-boot RAM test and becomes TRUE exactly when the screen
//      shows "READY." (and stays true while idle).
//   2. The KERNAL keyboard buffer holds 10 bytes, so a >10-char command
//      (LOAD"*",8,1 is 12) must be chunk-fed across frames — feeding ≤10 at a
//      time and topping up as BASIC drains it executes the full command. While
//      the command is buffered / executing, the READY detector reads false
//      (the busy→ready edge main.js uses to know a LOAD has finished).

import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function makeMachine() {
  const m = new C64Machine();
  m.loadROMs({
    kernal:  new Uint8Array(readFileSync('roms/kernal.bin')),
    basic:   new Uint8Array(readFileSync('roms/basic.bin')),
    charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
  });
  return m;
}

// Mirror of main.js's detectors, verified against the live machine here.
const basicReady = m => {
  const r = m.mem.ram;
  return r[0x00C6] === 0 && r[0x00CC] === 0 && r[0x002C] === 0x08;
};
// "READY." in screen codes: R E A D Y .
const READY = [18, 5, 1, 4, 25, 46];
const screenHasReady = m => {
  const s = m.mem.ram;
  for (let p = 0x0400; p < 0x07e8 - READY.length; p++) {
    let ok = true;
    for (let k = 0; k < READY.length; k++) if ((s[p + k] & 0x7f) !== READY[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
};

// ── 1. READY detector tracks the real boot ──────────────────────────────────
{
  const m = makeMachine();
  m.runFrame();
  assert(!basicReady(m), 'READY detector must be false on the first frame (mid RAM-test)');

  let readyFrame = -1;
  for (let f = 2; f <= 250; f++) {
    m.runFrame();
    if (basicReady(m)) { readyFrame = f; break; }
  }
  assert(readyFrame > 0, 'BASIC must reach READY within 250 frames');
  assert(screenHasReady(m), 'when the detector fires, the screen must actually show "READY."');

  // Stays ready while idle.
  for (let i = 0; i < 20; i++) m.runFrame();
  assert(basicReady(m), 'READY detector must stay true while BASIC idles at the prompt');
}

// ── 2. >10-char command is executable via chunked keyboard feeding, and the
//      busy→ready edge that signals "command finished" is observable ──────────
{
  const m = makeMachine();
  for (let f = 0; f < 250 && !basicReady(m); f++) m.runFrame();
  assert(basicReady(m), 'precondition: at READY prompt');

  // POKE53280,0\r is 12 chars (>10-byte buffer), like LOAD"*",8,1\r. Border is
  // non-zero after boot (light blue, 14); the command sets it to black (0).
  let rest = 'POKE53280,0\r';
  assert(rest.length > 10, 'sanity: the command exceeds the 10-byte keyboard buffer');
  let sawBusy = false;
  for (let tick = 0; tick < 60 && rest.length > 0; tick++) {
    rest = rest.slice(m.bufferKeyboardText(rest));
    m.runFrame();
    if (!basicReady(m)) sawBusy = true;   // buffer draining / line executing
  }
  assert(rest.length === 0, 'the whole command must get fed within the budget');
  assert(sawBusy, 'while a command is buffered/executing the READY detector must read false');
  // Let BASIC finish the queued line and return to READY.
  for (let i = 0; i < 8; i++) m.runFrame();
  assert(basicReady(m), 'BASIC must return to READY after the command runs');
  assert((m.mem.read(0xD020) & 0x0f) === 0,
    `POKE53280,0 must set the border to black; got $${(m.mem.read(0xD020) & 0x0f).toString(16)}`);
}

console.log('PASS autoload-ready-detect-spec-test.js');
