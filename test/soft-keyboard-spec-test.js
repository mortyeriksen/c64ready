// test/soft-keyboard-spec-test.js
//
// Locks the C64-facing behaviour the on-screen soft keyboard depends on. The
// soft keyboard (input.js softKeyboardInput → _matrixTap) delivers each key to
// the CIA1 matrix as a brief TAP at its KEY_MAP position. Here we tap those same
// positions against the REAL KERNAL and assert the effect: a letter/space types,
// Backspace (INST/DEL) deletes, RETURN submits.
//
// It also reproduces the Android event collision that caused a single Backspace
// to disappear: beforeinput starts a synthetic [0,0] tap, then Android emits a
// physical-looking keyup even though the physical keydown path did not claim the
// key. The ownership gate must ignore that unmatched keyup so the press survives
// four running frames and reaches the KERNAL before its timed release.

import { readFileSync, existsSync } from 'fs';
import { C64Machine } from '../src/machine.js';
import { KEY_MAP } from '../src/cia.js';
import { MatrixKeyOwnership, SoftKeyboardInsertState } from '../src/input-key-ownership.js';

function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } }

if (!['roms/kernal.bin', 'roms/basic.bin', 'roms/chargen.bin'].every(existsSync)) {
  console.log('# SKIP C64 ROMs not available'); process.exit(0);
}
const KERNAL  = new Uint8Array(readFileSync('roms/kernal.bin'));
const BASIC   = new Uint8Array(readFileSync('roms/basic.bin'));
const CHARGEN = new Uint8Array(readFileSync('roms/chargen.bin'));

const run = (m, n) => { for (let i = 0; i < n; i++) m.runFrame(); };
const col = (m) => m.mem.ram[0xD3];                    // cursor column on the current logical line

// Decode the cursor's screen row in the uppercase char set (screen codes).
function screenRow(m) {
  const row = m.mem.ram[0xD6]; let s = '';
  for (let i = 0; i < 16; i++) {
    const sc = m.mem.ram[0x0400 + row * 40 + i] & 0x3f;
    s += sc === 0x20 ? ' ' : (sc >= 1 && sc <= 26) ? String.fromCharCode(64 + sc)
       : (sc >= 0x30 && sc <= 0x39) ? String.fromCharCode(sc) : '?';
  }
  return s.replace(/\s+$/, '');
}
function boot() {
  const m = new C64Machine();
  m.loadROMs({ kernal: KERNAL, basic: BASIC, charRom: CHARGEN });
  m.reset(); run(m, 300);
  assert(m.mem.ram[0x2C] === 0x08, 'C64 reached BASIC READY');
  return m;
}
// A brief soft-key tap: press the KEY_MAP position, hold a few KERNAL scans,
// release.
function tap(m, code) {
  const pos = KEY_MAP[code];
  assert(pos, `KEY_MAP has a position for ${code}`);
  m.cia1.setKey(pos[0], pos[1], true);
  run(m, 14);
  m.cia1.setKey(pos[0], pos[1], false);
  run(m, 14);
}

// ── 1. a letter tap types the char ───────────────────────────────────────────
{
  const m = boot();
  const before = col(m);
  tap(m, 'KeyA');
  assert(col(m) === before + 1, `letter tap advances the cursor (${before}->${col(m)})`);
  assert(/A/.test(screenRow(m)), `letter appears on screen ("${screenRow(m)}")`);
}

// ── 2. consecutive space taps remain two spaces ──────────────────────────────
{
  const m = boot();
  tap(m, 'KeyA'); const afterA = col(m);
  const state = new SoftKeyboardInsertState();
  for (const payload of [' ', '. ']) {
    for (const ch of state.normalize(payload)) tap(m, ch === ' ' ? 'Space' : 'Period');
  }
  assert(col(m) === afterA + 2, `two space taps advance twice (${afterA}->${col(m)})`);
}

// ── 3. Backspace (INST/DEL) deletes one char — the reported bug's target ──────
{
  const m = boot();
  tap(m, 'KeyA'); tap(m, 'KeyA');                     // type "AA"
  const two = col(m);
  tap(m, 'Backspace');
  assert(col(m) === two - 1, `Backspace tap deletes one char (${two}->${col(m)})`);
}

// ── 4. Android unmatched keyup does not cancel the synthetic Backspace tap ────
{
  const m = boot();
  tap(m, 'KeyA');
  const c0 = col(m);
  const pos = KEY_MAP.Backspace;
  const ownership = new MatrixKeyOwnership(['Backspace']); // mobile keydown targeted the hidden input: unclaimed
  m.cia1.setKey(pos[0], pos[1], true);                // beforeinput starts the synthetic tap
  if (ownership.release('Backspace')) {               // Android keyup must not release an unclaimed key
    m.cia1.setKey(pos[0], pos[1], false);
  }
  run(m, 4);                                          // captured phone timing: four frames during the tap
  m.cia1.setKey(pos[0], pos[1], false);               // the synthetic 80 ms timer releases normally
  run(m, 14);
  assert(col(m) === c0 - 1, `Backspace survives Android's unmatched keyup (${c0}->${col(m)})`);
}

// ── 5. RETURN submits the logical line ───────────────────────────────────────
{
  const m = boot();
  tap(m, 'KeyA');
  const row0 = m.mem.ram[0xD6];
  tap(m, 'Enter'); run(m, 20);
  assert(m.mem.ram[0xD6] !== row0, `RETURN advances to a new screen line (${row0}->${m.mem.ram[0xD6]})`);
}

console.log('\nAll soft-keyboard spec tests passed.');
