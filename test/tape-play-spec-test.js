// Pressing PLAY runs the tape, with or without a LOAD.
//
// The datasette has no motor switch of its own: the computer energises the line
// (CPU port $01 bit 5, 0 = run), and the KERNAL's interrupt handler does it as
// soon as it sees SENSE go low with the tape routines not already holding the
// motor ($C0 = 0). So at the READY prompt, a key down is enough — the tape moves
// with nothing typed at all, which is how you wind to a program by ear.
//
// Two halves to that, and both matter: the deck must not move on its own when
// the machine is not driving it, and it must move when the machine is.
import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

const ROMS = {
  kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
  basic: new Uint8Array(readFileSync('roms/basic.bin')),
  charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
};

/** A tape of plain pulses. Nothing has to decode; this is about the transport. */
function tapeOfPulses(n) {
  const tap = new Uint8Array(20 + n);
  for (let i = 0; i < 12; i++) tap[i] = 'C64-TAPE-RAW'.charCodeAt(i);
  tap[12] = 1;
  tap[16] = n & 255; tap[17] = (n >> 8) & 255; tap[18] = (n >> 16) & 255;
  for (let i = 0; i < n; i++) tap[20 + i] = [0x30, 0x42, 0x56][i % 3];
  return tap;
}

function booted() {
  const m = new C64Machine();
  m.loadROMs(ROMS);
  for (let i = 0; i < 150; i++) m.runFrame();     // to the READY prompt
  m.loadTap(tapeOfPulses(200000));
  return m;
}
const run = (m, frames) => { for (let i = 0; i < frames; i++) m.runFrame(); };

// ── At the prompt, with nothing typed ────────────────────────────────────────
{
  const m = booted();
  ok(!m.datasette.motorOn, 'the motor is off with no key down');
  ok(m.datasette.getSenseLevel() === 1, 'and SENSE reads high');
  ok((m.mem.peekForCpu(1) & 0x20) !== 0, 'the machine is not driving the motor line');

  m.setTapeKey('PLAY');
  run(m, 30);
  ok(m.datasette.getSenseLevel() === 0, 'PLAY pulls SENSE low');
  ok((m.mem.peekForCpu(1) & 0x20) === 0, 'and the KERNAL answers by energising the motor line');
  ok(m.datasette.motorOn, 'so the motor runs');

  const before = m.datasette.elapsedSeconds;
  run(m, 60);
  ok(m.datasette.elapsedSeconds > before + 0.5,
    `and tape passes the head with no LOAD typed (${before.toFixed(2)} → ${m.datasette.elapsedSeconds.toFixed(2)} s)`);

  // STOP is the key coming up, so the tape stands still again.
  m.setTapeKey('STOP');
  const at = m.datasette.elapsedSeconds;
  run(m, 30);
  ok(m.datasette.elapsedSeconds === at, 'STOP stands the tape still');
  ok(m.datasette.getSenseLevel() === 1, 'and lets SENSE back up');
}

// ── The deck does not run itself ─────────────────────────────────────────────
{
  // No ROMs, so nothing ever writes the port: a real deck sits with its key down
  // and the capstan still until the computer energises the line.
  const m = new C64Machine();
  m.loadTap(tapeOfPulses(20000));
  m.setTapeKey('PLAY');
  run(m, 60);
  ok(!m.datasette.motorOn, 'a key down does not move tape on its own');
  ok(m.datasette.elapsedSeconds === 0, 'and no tape passes the head');
}

// ── Winding keys, same rule ──────────────────────────────────────────────────
{
  const m = booted();
  m.setTapeKey('FF');
  run(m, 30);
  ok(m.datasette.motorOn, 'F.FWD gets the motor too — SENSE does not say which key');
  const at = m.datasette.elapsedSeconds;
  run(m, 30);
  ok(m.datasette.elapsedSeconds > at, 'and the tape winds forward');
}

if (failures) {
  console.error(`\n${failures} tape play assertion(s) failed`);
  process.exit(1);
}
console.log('tape play spec: PASS');
