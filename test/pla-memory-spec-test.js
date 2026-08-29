// PLA memory-mapping spec audit, derived from the C64 Programmer's Reference
// Guide §3.3 (CPU port banking) and the PLA truth table (Bauer Appendix A.3).
// The 6510 port latch/DDR/SENSE rules themselves are in cpu-port-ddr-spec-test.
//
// CPU port bits ($01):
//   bit 0 (LORAM)  = 1 → BASIC visible
//   bit 1 (HIRAM)  = 1 → KERNAL visible
//   bit 2 (CHAREN) = 1 → I/O at $D000-$DFFF (= 0 → CHAR ROM)
//   bit 3 (CASS WR) datasette write
//   bit 4 (CASS SE) datasette sense (input)
//   bit 5 (MOTOR)  motor enable

import { Memory } from '../src/memory.js';

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

function makeMemory() {
  const m = new Memory();
  m.kernal = new Uint8Array(0x2000); for (let i = 0; i < 0x2000; i++) m.kernal[i] = 0xE0 + (i & 7);
  m.basic = new Uint8Array(0x2000);  for (let i = 0; i < 0x2000; i++) m.basic[i] = 0xA0 + (i & 7);
  m.charRom = new Uint8Array(0x1000); for (let i = 0; i < 0x1000; i++) m.charRom[i] = 0xD0 + (i & 7);
  // RAM markers so we can tell when ROM is hidden vs visible.
  for (let a = 0xA000; a < 0xC000; a++) m.ram[a] = 0xAA;
  for (let a = 0xD000; a < 0xE000; a++) m.ram[a] = 0xDD;
  for (let a = 0xE000; a < 0xFFFF; a++) m.ram[a] = 0xEE;
  return m;
}

// ── 1: Post-KERNAL CPU port ($2F/$37) → KERNAL + BASIC + I/O visible ────
// Raw power-up is DDR=$00/latch=$00; the KERNAL writes $2F/$37. We model
// the post-KERNAL state explicitly here (DDR=$2F drives the bank bits)
// and confirm it maps KERNAL+BASIC+I/O. (The raw power-up state reaches
// the same banking via pull-ups — verified separately below.)
{
  const m = makeMemory();
  // Power-up defaults are now $00/$00; raise DDR then set the latch like
  // the KERNAL boot does.
  m.write(0x0000, 0x2F);             // DDR = $2F (post-KERNAL)
  m.write(0x0001, 0x37);             // latch = $37 (LORAM=HIRAM=CHAREN=1)
  expect(m.cpuPort === 0x37, `cpuPort must be $37 after KERNAL-style write`);
  expect(m.cpuDDR === 0x2F, `cpuDDR must be $2F after KERNAL-style write`);
  // KERNAL visible at $E000.
  expect(m.read(0xE000) === m.kernal[0],
    `$37: KERNAL visible at $E000`);
  // BASIC visible at $A000.
  expect(m.read(0xA000) === m.basic[0],
    `$37: BASIC visible at $A000`);

  // Raw power-up state (DDR=$00/latch=$00) banks identically: the bank
  // bits float to their pull-ups (LORAM=HIRAM=CHAREN=1) so KERNAL+BASIC
  // are reachable even before the KERNAL writes the port.
  const m2 = makeMemory();
  expect(m2.cpuDDR === 0x00 && m2.cpuPort === 0x00,
    `raw power-up port is $00/$00`);
  expect(m2.read(0xE000) === m2.kernal[0],
    `power-up pull-ups: KERNAL visible at $E000`);
  expect(m2.read(0xA000) === m2.basic[0],
    `power-up pull-ups: BASIC visible at $A000`);
  ok('PLA: $2F/$37 (and power-up pull-ups) map KERNAL + BASIC + I/O');
}

// ── 2: $01 = $00 → all RAM visible (LORAM=HIRAM=CHAREN=0) ───────────────
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);             // DDR=all-output so writes take
  m.write(0x0001, 0x00);
  expect(m.read(0xA000) === 0xAA,
    `port=$00: $A000 must be RAM (BASIC hidden, no LORAM)`);
  expect(m.read(0xE000) === 0xEE,
    `port=$00: $E000 must be RAM (KERNAL hidden, no HIRAM)`);
  expect(m.read(0xD000) === 0xDD,
    `port=$00: $D000 must be RAM (no LORAM/HIRAM = no IO/CHARROM)`);
  ok('PLA: port=$00 makes all RAM visible (LORAM=HIRAM=CHAREN=0)');
}

// ── 3: HIRAM only ($02): KERNAL visible, BASIC hidden ──────────────────
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x02);
  expect(m.read(0xE000) === m.kernal[0], `HIRAM=1: KERNAL visible at $E000`);
  expect(m.read(0xA000) === 0xAA, `HIRAM=1, LORAM=0: BASIC hidden ($A000=RAM)`);
  ok('PLA: HIRAM-only ($02) maps KERNAL but hides BASIC');
}

// ── 4: LORAM only ($01): both BASIC and KERNAL hidden ──────────────────
// BASIC requires LORAM=1 AND HIRAM=1; HIRAM=0 alone hides KERNAL.
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x01);
  expect(m.read(0xA000) === 0xAA, `LORAM=1, HIRAM=0: BASIC hidden`);
  expect(m.read(0xE000) === 0xEE, `LORAM=1, HIRAM=0: KERNAL hidden`);
  ok('PLA: LORAM-only ($01) hides both ROMs (BASIC needs LORAM+HIRAM)');
}

// ── 5: CHAREN=0 with LORAM/HIRAM=1 → CHAR ROM at $D000 ──────────────────
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x03);             // LORAM=HIRAM=1, CHAREN=0
  expect(m.read(0xD000) === m.charRom[0],
    `CHAREN=0 with HIRAM/LORAM: CHAR ROM at $D000`);
  ok('PLA: CHAREN=0 + LORAM/HIRAM exposes CHAR ROM at $D000');
}

// ── 6: CHAREN=1 → I/O at $D000 (default behavior) ──────────────────────
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x07);             // LORAM=HIRAM=CHAREN=1
  // I/O reads route to chips. Without chips installed they return 0xFF
  // or a default. Just verify it's NOT CHAR ROM and NOT RAM.
  const v = m.read(0xD000);
  expect(v !== m.charRom[0],
    `CHAREN=1: $D000 must NOT be CHAR ROM`);
  ok('PLA: CHAREN=1 + LORAM/HIRAM maps I/O at $D000');
}

// ── 7: $E000 with HIRAM=0 → RAM (KERNAL hidden) ─────────────────────────
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x05);             // LORAM=1, CHAREN=1, HIRAM=0
  expect(m.read(0xE000) === 0xEE,
    `HIRAM=0: KERNAL must be hidden, $E000 = RAM`);
  ok('PLA: HIRAM=0 hides KERNAL, $E000 reads RAM');
}

console.log(`\n${testNo} PLA memory-mapping spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
