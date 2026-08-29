// CIA port DDR arbitration spec audit. 10 tests derived from the
// MOS6526 datasheet — each port has its own DDR, and the on-pin value
// is (port-latch & DDR) | (external-pin & ~DDR). On C64 these wires:
//
// CIA1 PA ($DC00): keyboard column select (active-low) + joystick port 2
// CIA1 PB ($DC01): keyboard row read + joystick port 1
// CIA2 PA ($DD00): low 2 bits = VIC bank (inverted), bits 2-7 = IEC bus
//                  bit 2 ATN out, bit 3 CLK out, bit 4 DATA out, bit 5
//                  CLK in, bit 6 DATA in, bit 7 user port pin C
// CIA2 PB ($DD01): user port + RS-232

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

// ── 1: PA / PB DDR registers default to 0 (input) at boot ──────────────
{
  const cia = new CIA(2);
  expect(cia.portADir === 0x00, `portADir default = 0`);
  expect(cia.portBDir === 0x00, `portBDir default = 0`);
  ok('MOS6526: port DDR defaults to all-input ($00) at boot');
}

// ── 2: $DC02 / $DC03 read returns the DDR ──────────────────────────────
{
  const cia = new CIA(1);
  cia.write(0x02, 0x55);
  expect(cia.read(0x02) === 0x55, `$DC02 read = portADir`);
  cia.write(0x03, 0xAA);
  expect(cia.read(0x03) === 0xAA, `$DC03 read = portBDir`);
  ok('MOS6526: $DC02/$DC03 read DDR registers');
}

// ── 3: PA write only affects bits where DDR=1 (output) ─────────────────
// MOS6526: writing the data register only drives output bits. Reads
// blend output-bits with input-pin states.
{
  const cia = new CIA(2);
  cia.portADir = 0x0F;            // low nibble = output, high nibble = input
  cia.portA = 0x00;
  cia.write(0x00, 0xFF);          // write all 1s
  expect(cia.portA === 0xFF, `data write stores full byte in latch`);
  // But read with no external override returns (port & DDR) | (~DDR & 0xFF) for input bits.
  const v = cia.read(0x00);
  expect((v & 0x0F) === 0x0F, `output bits read latched value`);
  expect((v & 0xF0) === 0xF0, `input bits read external (default high)`);
  ok('MOS6526: PA read mixes (port & DDR) | (pin & ~DDR)');
}

// ── 4: writePortA callback fires on $DC00 write ────────────────────────
{
  let captured = null;
  const cia = new CIA(2);
  cia.writePortA = (val) => { captured = val; };
  cia.write(0x00, 0xAA);
  expect(captured === 0xAA, `writePortA invoked with $AA, got ${captured}`);
  ok('MOS6526: $DC00 write triggers writePortA callback');
}

// ── 5: DDR write also triggers writePortA (re-evaluates pin state) ────
{
  let captured = null;
  const cia = new CIA(2);
  cia.portA = 0xFF;
  cia.writePortA = (val) => { captured = val; };
  cia.write(0x02, 0x0F);          // change DDR to half-output
  expect(captured !== null,
    `DDR write must re-evaluate pin state via writePortA callback`);
  ok('MOS6526: DDR write re-invokes writePortA (pin state update)');
}

// ── 6: readPortA callback overrides default port-mux read ──────────────
{
  const cia = new CIA(2);
  cia.readPortA = () => 0x42;
  expect(cia.read(0x00) === 0x42,
    `readPortA callback overrides DDR-mux logic`);
  ok('MOS6526: readPortA callback overrides default $DC00 read logic');
}

// ── 7: CIA2 PA bits 0,1 conventionally select VIC bank (inverted) ─────
// On C64, the wire convention: PA bits 0,1 = !VA14, !VA15.
//   PA[1:0] = 11 → bank 0 ($0000-$3FFF)
//   PA[1:0] = 10 → bank 1 ($4000-$7FFF)
//   PA[1:0] = 01 → bank 2 ($8000-$BFFF)
//   PA[1:0] = 00 → bank 3 ($C000-$FFFF)
// We just verify the CIA register holds the value; the inversion happens
// in the C64Machine wiring.
{
  const cia2 = new CIA(2);
  cia2.write(0x02, 0x03);          // DDR: bits 0,1 output
  cia2.write(0x00, 0x00);          // PA bits 0,1 = 00 (bank 3)
  expect((cia2.portA & 0x03) === 0x00,
    `CIA2 PA[1:0]=00: register holds 0`);
  ok('MOS6526: CIA2 PA register holds VIC bank select bits');
}

// ── 8: CIA1 PA reads via keyboard mux (id=1 has special read) ──────────
// Our impl: id=1 routes PA reads through _readKeyboard() instead of the
// generic mux. Keyboard matrix scan returns 0xFF when no key pressed
// and the column select is 0xFF (no column active).
{
  const cia = new CIA(1);
  cia.portA = 0xFF;                // no column selected
  // No keys pressed in matrix (default 0xFF).
  expect(cia.read(0x01) === 0xFF,
    `CIA1 PB with no column / no key = $FF (idle)`);
  ok('MOS6526 + C64: CIA1 PB read via keyboard matrix');
}

// ── 9: Setting CIA1 column low + matching matrix bit → PB shows pressed
{
  const cia = new CIA(1);
  cia.write(0x02, 0xFF);            // PA all output
  cia.write(0x00, 0xFE);            // PA bit 0 = 0 (active-low column 0)
  cia.matrix[0] = 0x7F;             // simulate bit 7 pressed in column 0
  expect((cia.read(0x01) & 0x80) === 0,
    `CIA1 PB bit 7 must read 0 (key in col 0 row 7 pressed)`);
  ok('MOS6526 + C64: CIA1 keyboard column-row matrix read');
}

// ── 10: Reading non-selected column shows no key (idle high) ──────────
{
  const cia = new CIA(1);
  cia.write(0x02, 0xFF);
  cia.write(0x00, 0xFE);            // col 0 selected
  cia.matrix[0] = 0xFF;             // no keys in col 0
  cia.matrix[1] = 0x00;             // all keys "pressed" in col 1
  // Col 1 is NOT selected (PA bit 1 = 1). Its rows must NOT bleed into PB.
  expect(cia.read(0x01) === 0xFF,
    `non-selected column must not bleed into PB`);
  ok('MOS6526 + C64: keyboard scan only reads selected columns');
}

console.log(`\n${testNo} CIA port arbitration spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
