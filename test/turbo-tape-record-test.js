// Turbo tape record + load round trip, at cycle resolution.
//
// The KERNAL saver (kernal-tape-save-test.js) writes through a Timer B interrupt,
// so its pulses carry the interrupt-latency jitter a real C64 has. A turbo saver
// is the opposite case and the harder one: `SEI`, screen blanked so the VIC steals
// no cycles, and the write line toggled from a counted delay loop. Every pulse is
// then exactly as long as the code says, which means the recorder has to
// timestamp each edge on the master cycle the store retires — one cycle late and
// the recorded byte is wrong.
//
// Two 6502 programs, hand-assembled below:
//
//   saver  — writes 24 bits as two pulse lengths, 232 cycles for a 0 and 392 for
//            a 1 (both multiples of 8, so the .tap quantization is exact and the
//            expected bytes are $1D and $31 with nothing to round)
//   loader — a turbo loader in the usual style: no interrupts, poll CIA1's
//            interrupt control register for the FLAG latch, count poll
//            iterations between edges, and classify against a threshold
//
// Recording is asserted byte-exact against the cycle arithmetic, and then the
// loader must recover the original bit pattern through the playback path.

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

// The bit pattern to save: both values, both transitions, and runs of each.
const BITS = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0];

// Delay-loop counts. The full wave is 10*X + 32 cycles — see the saver listing.
const X_ZERO = 20, X_ONE = 36;
const CYCLES_ZERO = 10 * X_ZERO + 32;      // 232
const CYCLES_ONE = 10 * X_ONE + 32;        // 392
const UNIT_ZERO = CYCLES_ZERO / 8;         // 29 = $1D
const UNIT_ONE = CYCLES_ONE / 8;           // 49 = $31

const CODE = 0xC000;
const BIT_TABLE = 0xC100;
const OUT = 0xC200;

// ── the saver ──────────────────────────────────────────────────────────────
// Cycle counts in the right column are what make the pulse lengths exact. Both
// arms of the bit test cost 7 cycles, so the value being written never shifts
// the timing.
const SAVER = [
  0x78,                          // C000  SEI
  0xA9, 0x0B,                    // C001  LDA #$0B
  0x8D, 0x11, 0xD0,              // C003  STA $D011   blank: no badlines, no DMA
  0xA9, 0x17,                    // C006  LDA #$17    motor on, write line low
  0x85, 0x01,                    // C008  STA $01
  0xA0, 0x00,                    // C00A  LDY #$00
  // loop: C00C
  0xB9, BIT_TABLE & 0xFF, BIT_TABLE >> 8, // C00C LDA $C100,Y        4
  0xF0, 0x05,                    // C00F  BEQ isZero              2 / 3
  0xA2, X_ONE,                   // C011  LDX #36                 2
  0x4C, 0x19, 0xC0,              // C013  JMP go                  3   → 7
  // isZero: C016
  0xA2, X_ZERO,                  // C016  LDX #20                 2
  0xEA,                          // C018  NOP                     2   → 7
  // go: C019
  0x86, 0xFC,                    // C019  STX $FC                 3
  0xA9, 0x1F,                    // C01B  LDA #$1F                2
  0x85, 0x01,                    // C01D  STA $01   RISING EDGE   3
  // h1: C01F
  0xCA,                          // C01F  DEX                     2
  0xD0, 0xFD,                    // C020  BNE h1                  5X-1
  0xA9, 0x17,                    // C022  LDA #$17                2
  0x85, 0x01,                    // C024  STA $01   FALLING EDGE  3
  0xA6, 0xFC,                    // C026  LDX $FC                 3
  // h2: C028
  0xCA,                          // C028  DEX                     2
  0xD0, 0xFD,                    // C029  BNE h2                  5X-1
  0xC8,                          // C02B  INY                     2
  0xC0, BITS.length,             // C02C  CPY #24                 2
  0xD0, 0xDC,                    // C02E  BNE loop                3
  // done: C030
  0x4C, 0x30, 0xC0,              // C030  JMP done
];
const SAVER_DONE = 0xC030;

// ── the loader ─────────────────────────────────────────────────────────────
// Collects COLLECT measurements. The first one is the wait from loop entry to
// the first edge (it spans the datasette's motor spin-up), so it is discarded;
// measurement k+1 is the interval that pulse k occupied.
const COLLECT = 20;
const POLL_THRESHOLD = 22;       // 232 cy ≈ 17 polls, 392 cy ≈ 29 polls
const LOADER = [
  0x78,                          // C000  SEI
  0xA9, 0x0B,                    // C001  LDA #$0B
  0x8D, 0x11, 0xD0,              // C003  STA $D011
  0xA9, 0x17,                    // C006  LDA #$17    motor on
  0x85, 0x01,                    // C008  STA $01
  0xAD, 0x0D, 0xDC,              // C00A  LDA $DC0D   clear a stale FLAG latch
  0xA2, 0x00,                    // C00D  LDX #$00
  // next: C00F
  0xA9, 0x00,                    // C00F  LDA #$00
  0x85, 0xFD,                    // C011  STA $FD     poll counter
  // poll: C013
  0xE6, 0xFD,                    // C013  INC $FD                 5
  0xAD, 0x0D, 0xDC,              // C015  LDA $DC0D               4
  0x29, 0x10,                    // C018  AND #$10                2
  0xF0, 0xF7,                    // C01A  BEQ poll                3  → 14/poll
  0xA5, 0xFD,                    // C01C  LDA $FD
  0xC9, POLL_THRESHOLD,          // C01E  CMP #22
  0xA9, 0x00,                    // C020  LDA #$00    (keeps carry)
  0x90, 0x02,                    // C022  BCC store   short → bit 0
  0xA9, 0x01,                    // C024  LDA #$01
  // store: C026
  0x9D, OUT & 0xFF, OUT >> 8,    // C026  STA $C200,X
  0xE8,                          // C029  INX
  0xE0, COLLECT,                 // C02A  CPX #20
  0xD0, 0xE1,                    // C02C  BNE next
  // done: C02E
  0x4C, 0x2E, 0xC0,              // C02E  JMP done
];
const LOADER_DONE = 0xC02E;

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

// Jump straight into machine code at an instruction boundary and run until it
// reaches its spin loop.
function runCode(machine, code, entry, spinPc, maxCycles) {
  machine.mem.ram.set(Uint8Array.from(code), entry);
  machine._quiesceToBoundary();
  machine.cpu.pc = entry;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    C64Machine.prototype._runMasterCycle.call(machine);
    if (machine.cpu.pc === spinPc && machine.cpu.atInstructionBoundary()) return cycle + 1;
  }
  return -1;
}

// ── record ────────────────────────────────────────────────────────────────
const machine = makeMachine();
machine.newBlankTape();
assert(machine.setTapeKey('REC') === true, 'RECORD engages on the blank tape');
machine.mem.ram.set(Uint8Array.from(BITS), BIT_TABLE);

const saveCycles = runCode(machine, SAVER, CODE, SAVER_DONE, 2_000_000);
assert(saveCycles > 0, `the turbo saver runs to completion (${saveCycles} cycles)`);
machine.setTapeKey('STOP');
const tap = machine.exportTapBytes();
const recorded = Array.from(tap.subarray(20));

// ── 1. the recording is exact, byte for byte ─────────────────────────────
{
  // The recording opens with the gap between RECORD engaging and the saver's
  // first edge: the head was already laying tape, so that stretch is a pulse of
  // its own. It is far shorter than any data pulse here, since this saver starts
  // writing immediately; a real one waits for the motor and records a long pause.
  const lead = recorded[0];
  assert(lead > 0 && lead < UNIT_ZERO,
    `the recording opens with the pre-roll gap, shorter than any data pulse (${lead} units)`);
  // Then one pulse per rising edge after the first, which opens the wave.
  const expected = BITS.slice(0, BITS.length - 1).map(b => (b ? UNIT_ONE : UNIT_ZERO));
  eq(recorded.slice(1), expected,
    'every turbo pulse records at its exact cycle-counted length');
  eq(recorded.length, BITS.length, 'the pre-roll gap, then one pulse per closed wave');
  // Nothing may have escaped into the long form: these are all short pulses.
  assert(!recorded.includes(0), 'no long-form escapes in a turbo recording');
}

// ── 2. a real turbo loader reads it back ────────────────────────────────
{
  const fresh = makeMachine();
  fresh.loadTap(tap);
  fresh.setTapeKey('PLAY');
  fresh.mem.ram.fill(0xEE, OUT, OUT + COLLECT);      // poison the landing zone

  const loadCycles = runCode(fresh, LOADER, CODE, LOADER_DONE, 4_000_000);
  assert(loadCycles > 0, `the turbo loader runs to completion (${loadCycles} cycles)`);

  const out = Array.from(fresh.mem.ram.subarray(OUT, OUT + COLLECT));
  // out[0] is the wait from loop entry to the first edge, which spans the motor
  // spin-up and the pre-roll gap, so it carries no data. From there each
  // measurement is the entry that ended at that edge.
  //
  // bits[0] survives the round trip now: the pre-roll gap gives its wave an
  // opening edge, where a recording that began at the first edge had none and
  // lost it. Real turbo formats spend a lead-in byte on that problem — see Turbo
  // Tape 64's $02 lead-in before its sync sequence — and this is the same idea,
  // arrived at by recording the tape from where the head actually started.
  const decoded = out.slice(1);
  const expected = BITS.slice(0, decoded.length);
  eq(decoded, expected, 'the turbo loader recovers the saved bit pattern');
}

if (failures) {
  console.error(`\n${failures} turbo tape assertion(s) failed`);
  process.exit(1);
}
console.log(`ok  - turbo tape: cycle-exact record (${recorded.length} pulses) and polled load-back`);
