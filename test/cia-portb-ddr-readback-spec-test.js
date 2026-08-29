// CIA1 Port B ($DC01) DDR-aware read-back spec.
//
// MOS6526 datasheet: a port read returns, per bit, the OUTPUT LATCH for pins
// configured as output (DDR=1) and the external PIN STATE for pins configured
// as input (DDR=0). On CIA1, Port B's external pins are the keyboard-matrix
// rows (wired-AND of the selected columns) plus joystick port 1.
//
// REGRESSION PINNED: our CIA1 used to return _readKeyboard() unconditionally
// for $DC01, ignoring DDRB and the output latch. That made a value written to
// Port B invisible on read-back whenever any pin was an output. The TLR
// "cia-int" testprog JSRs straight into CIA register space and executes the
// registers as opcodes; test 5 sets DDRB=$FF and writes $60 (=RTS) to Port B,
// then fetches it as an instruction. Reading $FF instead of $60 turned the RTS
// into garbage and the CPU ran off into a BRK storm (test hung forever).
//
// Joystick-1 merging happens one layer up (memory.js _readCIA1), so these
// CIA-level tests cover only the DDR/latch/keyboard merge.

import { CIA } from '../src/cia.js';

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
const hx = v => '$' + (v & 0xff).toString(16).padStart(2, '0');

// ── 1: DDRB=0 (all inputs) → read returns the keyboard matrix (no keys) ──
// The normal KERNAL scan path: DDRB=$00, DDRA=$FF (columns are OUTPUTS), Port A
// drives columns low, read $DC01 returns the wired-AND of selected rows. No
// keys pressed → $FF. A column is only driven low by an output pin; see the
// cia-keyboard-ddra-column-select spec for the DDRA requirement.
{
  const cia = new CIA(1);
  cia.write(0x03, 0x00);              // DDRB = all inputs
  cia.write(0x02, 0xFF);              // DDRA = all outputs (column drivers)
  cia.write(0x00, 0x00);              // Port A: drive all columns low (active-low)
  expect(cia.read(0x01) === 0xFF,
    `DDRB=0, no keys: $DC01 must read $FF, got ${hx(cia.read(0x01))}`);
  ok('MOS6526: CIA1 Port B with DDRB=0 reads the keyboard matrix ($FF idle)');
}

// ── 2: DDRB=0 → a pressed key still shows through (keyboard unchanged) ────
// Pin-state path must remain intact: pressing col0/row1 pulls bit 1 low when
// column 0 is driven low. Column 0's PA0 pin must be an OUTPUT (DDRA bit set)
// to drive the column — an input pin floats high and selects nothing.
{
  const cia = new CIA(1);
  cia.write(0x03, 0x00);              // DDRB = inputs
  cia.write(0x02, 0xFF);              // DDRA = outputs (column drivers)
  cia.setKey(0, 1, true);             // press key at column 0, row 1
  cia.write(0x00, 0xFE);              // Port A: drive column 0 low (bit0=0)
  expect(cia.read(0x01) === 0xFD,
    `DDRB=0, col0/row1 pressed: $DC01 must read $FD (bit1 low), got ${hx(cia.read(0x01))}`);
  ok('MOS6526: CIA1 Port B with DDRB=0 still reflects pressed keys');
}

// ── 3: DDRB=$FF (all outputs) → read returns the OUTPUT LATCH, not keyboard ─
// This is the exact cia-int test-5 case: write $60 (RTS) with all pins output,
// read it back. Must be $60 regardless of the (idle) keyboard matrix.
{
  const cia = new CIA(1);
  cia.write(0x03, 0xFF);              // DDRB = all outputs
  cia.write(0x01, 0x60);             // Port B latch = $60 (= RTS opcode)
  expect(cia.read(0x01) === 0x60,
    `DDRB=$FF, latch=$60: $DC01 must read back $60, got ${hx(cia.read(0x01))} ` +
    `(returning $FF here is the bug that hangs cia-int test 5)`);
  // Even with a key "pressed", outputs must win — keyboard cannot pull an
  // output bit in this read model.
  cia.setKey(7, 5, true);
  cia.write(0x00, 0x00);              // select all columns
  expect(cia.read(0x01) === 0x60,
    `DDRB=$FF: output latch must be immune to keyboard, got ${hx(cia.read(0x01))}`);
  ok('MOS6526: CIA1 Port B with DDRB=$FF reads back the output latch');
}

// ── 4: Mixed DDRB → output bits read latch, input bits read keyboard ─────
// DDRB=$F0: high nibble output (latch), low nibble input (keyboard).
{
  const cia = new CIA(1);
  cia.write(0x03, 0xF0);              // high nibble out, low nibble in
  cia.write(0x01, 0xA5);             // latch = $A5 → output nibble = $A0
  cia.write(0x00, 0x00);              // select all columns; no keys → low nibble $0F
  const expected = (0xA5 & 0xF0) | (0xFF & 0x0F); // $A0 | $0F = $AF
  expect(cia.read(0x01) === expected,
    `mixed DDRB=$F0: expected ${hx(expected)} (latch hi-nibble | keyboard lo-nibble), got ${hx(cia.read(0x01))}`);
  ok('MOS6526: CIA1 Port B mixed DDR merges output latch + keyboard per bit');
}

// ── 5: DDRA/keyboard column select unaffected; Port A read still latch ───
// Sanity: the fix is Port-B-only. Port A read-back keeps the existing
// (latch & DDR)|(~DDR) model (joystick-2 merge is in memory.js).
{
  const cia = new CIA(1);
  cia.write(0x02, 0xFF);              // DDRA = outputs
  cia.write(0x00, 0x7F);             // Port A latch = $7F
  expect(cia.read(0x00) === 0x7F,
    `Port A DDRA=$FF latch=$7F must read $7F, got ${hx(cia.read(0x00))}`);
  ok('MOS6526: CIA1 Port A read-back unchanged (Port-B-only fix)');
}

console.log(`\n${testNo} CIA1 Port B DDR read-back spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
