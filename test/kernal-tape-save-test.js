// End-to-end KERNAL tape SAVE regression — the recording counterpart of
// kernal-tape-load-test.js.
//
// The real KERNAL saves a BASIC program to a blank tape through the datasette's
// record path (CIA1 Timer B toggling CPU port $01 bit 3). The recorded .tap is
// then checked two independent ways:
//
//   1. decoded here, from the documented tape encoding, and asserted against the
//      standard structure: the short/medium/long pulse trio, the leader, the
//      $89..$81 / $09..$01 copy countdowns, a 192-byte header with the right
//      name and load addresses, the XOR checksum, and both copies of each block
//   2. loaded back by the real KERNAL through the playback path, which must land
//      the original bytes in RAM
//
// Encoding facts used (same set as the load test):
//   - TAP v1 stores pulse lengths as byte*8 PAL CPU cycles
//   - short/medium/long are $30/$42/$56 units, thresholds $39 and $4E
//   - pairs encode 0 as S/M, 1 as M/S, byte marker L/M, end of data L/S
//   - a byte frame is the marker, 8 bits LSB first, then an odd parity bit
//   - the first copy of a block counts down $89..$81, the repeat $09..$01

import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const S_M_THRESHOLD = 0x39 * 8;
const M_L_THRESHOLD = 0x4E * 8;

function makeMachine() {
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
    basic: new Uint8Array(readFileSync('roms/basic.bin')),
    charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
  });
  for (let i = 0; i < 100; i++) machine.runFrame();
  return machine;
}

// Decode a .tap payload into the S/M/L symbol stream its pulses represent.
function symbolsOf(tap) {
  const data = tap.subarray(20);
  const version = tap[12];
  const out = [];
  for (let i = 0; i < data.length;) {
    const b = data[i++];
    let cycles;
    if (b !== 0) cycles = b * 8;
    else if (version === 0) cycles = 2048;
    else if (i + 2 < data.length) {
      cycles = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
      i += 3;
    } else break;
    out.push(cycles < S_M_THRESHOLD ? 'S' : cycles < M_L_THRESHOLD ? 'M' : 'L');
  }
  return out.join('');
}

// Read one byte frame at `p`. Returns null at an end-of-data marker.
function readByte(sym, p) {
  if (sym[p] === 'L' && sym[p + 1] === 'S') return null;
  if (sym[p] !== 'L' || sym[p + 1] !== 'M') return { bad: `no byte marker at ${p}` };
  p += 2;
  let value = 0, parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const a = sym[p], b = sym[p + 1]; p += 2;
    if (a === 'M' && b === 'S') { value |= 1 << bit; parity ^= 1; }
    else if (!(a === 'S' && b === 'M')) return { bad: `bad bit pair ${a}${b} at ${p - 2}` };
  }
  const a = sym[p], b = sym[p + 1]; p += 2;
  const parityBit = (a === 'M' && b === 'S') ? 1 : 0;
  return { value, end: p, parityOk: parityBit === parity };
}

// Split the symbol stream into blocks: leader, countdown, payload, checksum.
function decodeBlocks(sym) {
  const blocks = [];
  let p = 0;
  while (p < sym.length) {
    let leader = 0;
    while (p < sym.length && sym[p] === 'S') { leader++; p++; }
    if (p >= sym.length) break;
    if (sym[p] === 'L' && sym[p + 1] === 'S') { p += 2; continue; }   // gap marker
    const bytes = [], parityErrors = [];
    for (;;) {
      const r = readByte(sym, p);
      if (r === null) { p += 2; break; }
      if (r.bad) { parityErrors.push(r.bad); break; }
      if (!r.parityOk) parityErrors.push(`parity at byte ${bytes.length}`);
      bytes.push(r.value);
      p = r.end;
      if (p >= sym.length) break;
    }
    if (!bytes.length) continue;
    blocks.push({
      leader,
      countdown: bytes.slice(0, 9),
      payload: bytes.slice(9, bytes.length - 1),
      checksum: bytes[bytes.length - 1],
      parityErrors,
    });
  }
  return blocks;
}

const xorOf = (bytes) => bytes.reduce((a, b) => a ^ b, 0);

// Drive the machine, feeding keystrokes, until `done` or the cycle budget runs out.
function runUntil(machine, text, done, maxCycles) {
  let pending = text;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if ((cycle % 20_000) === 0 && pending.length > 0) {
      pending = pending.slice(machine.bufferKeyboardText(pending));
    }
    C64Machine.prototype._runMasterCycle.call(machine);
    if (pending.length === 0 && done(machine)) return cycle + 1;
  }
  return -1;
}

// A one-line BASIC program: 10 PRINT"HI"
const PROGRAM = [0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00];
const LOAD_ADDRESS = 0x0801;

// ── SAVE ───────────────────────────────────────────────────────────────────
const machine = makeMachine();
machine.newBlankTape();
assert(machine.setTapeKey('REC') === true, 'RECORD engages on the blank tape');

// The KERNAL prints "PRESS RECORD & PLAY ON TAPE" and waits on SENSE, which the
// key press above already pulls low, so the save proceeds.
// The KERNAL parks the motor between the header pair and the data pair, so
// "motor off" alone means nothing. Wait for it to stay off.
let quiet = 0;
const saveCycles = runUntil(
  machine,
  '10 PRINT"HI"\rSAVE"TAPETEST",1\r',
  (m) => {
    if (m.datasette.dirty && !m.datasette.motorOn) return ++quiet > 2_000_000;
    quiet = 0;
    return false;
  },
  90_000_000,
);
assert(saveCycles > 0, `KERNAL SAVE completes within the cycle budget (${saveCycles})`);

machine.setTapeKey('STOP');            // release RECORD: commits the recording
const tap = machine.exportTapBytes();
assert(machine.hasUnsavedTapeWrites(), 'the recorded tape reports unsaved writes');

// ── 1. structure of what was written ──────────────────────────────────────
{
  eq(String.fromCharCode(...tap.subarray(0, 12)), 'C64-TAPE-RAW', 'recorded file has the TAP magic');
  eq(tap[12], 1, 'recorded as TAP v1');
  const size = tap[16] | (tap[17] << 8) | (tap[18] << 16) | (tap[19] << 24);
  eq(size, tap.length - 20, 'size field matches the payload');

  const sym = symbolsOf(tap);
  // Every pulse must classify as one of the three documented lengths — nothing
  // may land in the dead zones the KERNAL's reader would misread.
  assert(/^[SML]+$/.test(sym), 'every recorded pulse is a short, medium or long');

  const blocks = decodeBlocks(sym);
  assert(blocks.length === 4,
    `four blocks written: header twice, data twice (got ${blocks.length})`);

  const empty = { leader: 0, countdown: [], payload: [], checksum: -1, parityErrors: ['missing block'] };
  const [h1 = empty, h2 = empty, d1 = empty, d2 = empty] = blocks;

  // Leaders: a long one before the header, a shorter one before the data block,
  // and a brief re-sync before each repeat copy.
  assert(h1.leader > 20_000, `header leader is seconds long (${h1.leader} short pulses)`);
  assert(h2.leader > 30 && h2.leader < 200, `repeat copy re-syncs briefly (${h2.leader})`);
  assert(d1.leader > 2_000 && d1.leader < h1.leader,
    `data block leader is shorter than the header's (${d1.leader})`);

  // Copy markers.
  eq(h1.countdown, [0x89, 0x88, 0x87, 0x86, 0x85, 0x84, 0x83, 0x82, 0x81],
    'header first copy counts down $89..$81');
  eq(h2.countdown, [0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01],
    'header repeat copy counts down $09..$01');
  eq(d1.countdown, [0x89, 0x88, 0x87, 0x86, 0x85, 0x84, 0x83, 0x82, 0x81],
    'data first copy counts down $89..$81');
  eq(d2.countdown, [0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01],
    'data repeat copy counts down $09..$01');

  for (const [name, b] of [['header', h1], ['header copy', h2], ['data', d1], ['data copy', d2]]) {
    eq(b.parityErrors, [], `${name} block decodes with no framing or parity errors`);
    eq(b.checksum, xorOf(b.payload), `${name} block checksum is the XOR of its payload`);
  }

  // The header itself.
  eq(h1.payload.length, 192, 'header payload is 192 bytes');
  eq(h1.payload[0], 0x01, 'header type is $01 (relocatable PRG, what BASIC SAVE writes)');
  eq(h1.payload[1] | (h1.payload[2] << 8), LOAD_ADDRESS, 'header start address');
  eq(h1.payload[3] | (h1.payload[4] << 8), LOAD_ADDRESS + PROGRAM.length, 'header end address');
  eq(String.fromCharCode(...h1.payload.slice(5, 21)).trimEnd(), 'TAPETEST', 'header file name');
  eq(h1.payload, h2.payload, 'both header copies are identical');

  // The data block carries the BASIC program.
  eq(d1.payload, PROGRAM, 'data block payload is the saved program');
  eq(d1.payload, d2.payload, 'both data copies are identical');
}

// ── 2. the KERNAL loads its own recording back ────────────────────────────
{
  const fresh = makeMachine();
  fresh.loadTap(tap);
  fresh.setTapeKey('PLAY');
  // Wipe the target so a pass cannot be a leftover.
  fresh.mem.ram.fill(0, LOAD_ADDRESS, LOAD_ADDRESS + PROGRAM.length);

  const ramMatches = (m) => PROGRAM.every((b, i) => m.mem.ram[LOAD_ADDRESS + i] === b);
  const cycles = runUntil(
    fresh,
    'LOAD"TAPETEST",1\r',
    (m) => ramMatches(m) && m.datasette._pulseCount > 0 && !m.datasette.motorOn,
    60_000_000,
  );
  assert(cycles > 0,
    `KERNAL LOAD of the recorded tape completes (pc=$${fresh.cpu.pc.toString(16)} `
    + `status=$${fresh.mem.ram[0x90].toString(16)} pulses=${fresh.datasette._pulseCount})`);
  eq(fresh.mem.ram[0x90], 0, 'KERNAL status is OK — no checksum or framing error');
  for (let i = 0; i < PROGRAM.length; i++) {
    eq(fresh.mem.ram[LOAD_ADDRESS + i], PROGRAM[i], `loaded byte $${(LOAD_ADDRESS + i).toString(16)}`);
  }
  const end = LOAD_ADDRESS + PROGRAM.length;
  eq(fresh.mem.ram[0xAE], end & 0xFF, 'KERNAL end pointer low byte');
  eq(fresh.mem.ram[0xAF], end >> 8, 'KERNAL end pointer high byte');
}

if (failures) {
  console.error(`\n${failures} KERNAL tape save assertion(s) failed`);
  process.exit(1);
}
console.log(`ok  - KERNAL SAVE records a spec-conformant tape and loads it back (${tap.length} bytes)`);
