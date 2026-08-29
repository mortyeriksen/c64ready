// MOS 6526 CIA1 — keyboard column select honors DDRA.
//
// CIA1 Port A drives the keyboard-matrix column lines (active-low). A column is
// actively selected ONLY by an OUTPUT pin driven low; pins configured as inputs
// (DDRA bit = 0) float high via the matrix pull-ups and select nothing. The
// scan must therefore apply DDRA to the Port A latch, not read the raw latch.
//
// Bug this pins: _readKeyboard() previously used raw this.portA, so a stale
// output-latch bit could "select" a column on a pin configured as an input —
// an impossible matrix state. KERNAL scan uses DDRA=$FF (where the masked value
// equals the raw latch), so normal typing was unaffected; code that scans with
// DDRA != $FF would read phantom keys. Mirrors the read($DC00)/vicBank PA model.
//
// Synthetic, derived from the 6526 port-pin rules.

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

// ── 1: DDRA=$FF — driven-low column selects, pressed row reads low ───────
{
  const cia = new CIA(1); cia.irqHandler = () => {};
  cia.setKey(2, 3, true);                 // press col 2 / row 3 → matrix[2] bit 3 = 0
  cia.write(0x02, 0xFF);                   // DDRA: all outputs
  cia.write(0x00, ~(1 << 2) & 0xFF);       // select column 2 (active-low)
  const scan = cia.read(0x01);             // portBDir=0 → pure keyboard read
  expect((scan & (1 << 3)) === 0,
    `DDRA=$FF: column 2 driven low → row 3 reads low, got $${scan.toString(16)}`);
  expect((scan & ~(1 << 3) & 0xFF) === (0xFF & ~(1 << 3)),
    `DDRA=$FF: only the pressed row is low`);
  ok('MOS6526: CIA1 keyboard scan selects a column driven low by an output pin');
}

// ── 2: DDRA=$00 — the same latch pattern selects NO column (input pins) ──
{
  const cia = new CIA(1); cia.irqHandler = () => {};
  cia.setKey(2, 3, true);                 // same key held
  cia.write(0x00, ~(1 << 2) & 0xFF);       // latch holds a column-select pattern
  cia.write(0x02, 0x00);                   // DDRA: all inputs → pins float high
  const scan = cia.read(0x01);
  expect(scan === 0xFF,
    `DDRA=$00: input pins select no column, keyboard reads $FF, got $${scan.toString(16)}`);
  ok('MOS6526: CIA1 keyboard column select honors DDRA (input pins select nothing)');
}

// ── 3: mixed DDRA — only the output-low pin among the selected bits counts ─
{
  const cia = new CIA(1); cia.irqHandler = () => {};
  cia.setKey(0, 5, true);                  // col 0 / row 5
  cia.setKey(1, 6, true);                  // col 1 / row 6
  // Latch selects cols 0 AND 1 (both bits low), but only PA0 is an output.
  cia.write(0x00, ~((1 << 0) | (1 << 1)) & 0xFF);
  cia.write(0x02, 0x01);                   // DDRA: PA0 output, PA1 input
  const scan = cia.read(0x01);
  expect((scan & (1 << 5)) === 0, `col 0 (output-low) selected → row 5 low`);
  expect((scan & (1 << 6)) !== 0, `col 1 (input, floats high) NOT selected → row 6 stays high`);
  ok('MOS6526: with mixed DDRA only output-low column lines select matrix rows');
}

console.log(`\n${testNo} CIA1 keyboard DDRA column-select spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
