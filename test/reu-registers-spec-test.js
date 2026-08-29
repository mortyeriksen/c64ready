// REU register-file spec audit, derived from the MOS 8726 REC register set as
// published with the Commodore RAM Expansion Module User's Guides.
//
// $DF00 status   (r/o) 7 IRQ pending · 6 end of block · 5 fault · 4 size ·
//                      3-0 version. Reading clears bits 7-5.
// $DF01 command        7 execute · 6 reserved · 5 autoload · 4 FF00 decode
//                      disable · 3-2 reserved · 1-0 transfer type
// $DF02/03 C64 address · $DF04/05 REU address · $DF06 bank
// $DF07/08 transfer length ($0000 = 64K)
// $DF09 interrupt mask  7 enable · 6 end of block · 5 verify error
// $DF0A address control 7 fix C64 address · 6 fix REU address
//
// Power-up readback is $10 $10 $00 $00 $00 $00 $F8 $FF $FF $1F $3F, and the
// undriven bits do not read alike: the command register's spare bits read 0
// while the bank, mask and address-control registers pull theirs to 1.

import { REU, REU_MODELS, reuModel } from '../src/reu.js';

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

const hex = v => '$' + (v & 0xFF).toString(16).padStart(2, '0');
const rd = (reu, r) => reu.ioRead(0xDF00 + r);
const wr = (reu, r, v) => reu.ioWrite(0xDF00 + r, v);

// ── 1: power-up register values ────────────────────────────────────────
{
  const reu = new REU('1750');
  const want = [0x10, 0x10, 0x00, 0x00, 0x00, 0x00, 0xF8, 0xFF, 0xFF, 0x1F, 0x3F];
  for (let r = 0; r <= 0x0A; r++) {
    // Read status last-ish is irrelevant here: nothing has set bits 7-5 yet.
    const got = reu.ioPeek(0xDF00 + r);
    expect(got === want[r],
      `power-up $DF${r.toString(16).padStart(2, '0').toUpperCase()} must read ${hex(want[r])}, got ${hex(got)}`);
  }
  ok('REC: power-up register readback');
}

// ── 2: command register reserved bits read back as written ─────────────
{
  // §2.4.2: bits 6 and 3-2 are called "reserved" in the Commodore manuals, but
  // they are backed by real flip-flops — whatever is written is given back, and
  // no REU operation changes them. They are neither stuck low nor pulled high.
  const reu = new REU('1750');
  // Write every bit set but leave execute alone, so no transfer starts.
  wr(reu, 0x01, 0x7F);
  expect(reu.ioPeek(0xDF01) === 0x7F,
    `command register must read back exactly what was written, got ${hex(reu.ioPeek(0xDF01))}`);
  wr(reu, 0x01, 0x00);
  expect(reu.ioPeek(0xDF01) === 0x00,
    `the reserved bits must clear when written 0, got ${hex(reu.ioPeek(0xDF01))}`);
  // A transfer only touches bits 7 and 4; the reserved bits ride through it.
  wr(reu, 0x01, 0x4C);
  expect((reu.ioPeek(0xDF01) & 0x4C) === 0x4C,
    `the reserved bits must survive untouched, got ${hex(reu.ioPeek(0xDF01))}`);
  ok('REC: command register reserved bits read back as written');
}

// ── 3: mask/address-control spare bits read 1 ──────────────────────────
{
  const reu = new REU('1750');
  wr(reu, 0x09, 0x00);
  expect(reu.ioPeek(0xDF09) === 0x1F,
    `interrupt mask bits 4-0 must read 1, got ${hex(reu.ioPeek(0xDF09))}`);
  wr(reu, 0x0A, 0x00);
  expect(reu.ioPeek(0xDF0A) === 0x3F,
    `address control bits 5-0 must read 1, got ${hex(reu.ioPeek(0xDF0A))}`);
  wr(reu, 0x09, 0xE0);
  expect(reu.ioPeek(0xDF09) === 0xFF,
    `interrupt mask bits 7-5 must read back as written`);
  wr(reu, 0x0A, 0xC0);
  expect(reu.ioPeek(0xDF0A) === 0xFF,
    `address control bits 7-6 must read back as written`);
  ok('REC: interrupt-mask and address-control spare bits read 1');
}

// ── 4: status read clears bits 7-5 ─────────────────────────────────────
{
  const reu = new REU('1750');
  reu._endOfBlock = true;
  reu._fault = true;
  reu._irqPending = true;
  const first = rd(reu, 0x00);
  expect((first & 0xE0) === 0xE0,
    `status must report the pending/end-of-block/fault bits it holds, got ${hex(first)}`);
  const second = rd(reu, 0x00);
  expect((second & 0xE0) === 0x00,
    `reading the status register must clear bits 7-5, got ${hex(second)}`);
  expect(second === 0x10, `a 1750's cleared status must read ${hex(0x10)}, got ${hex(second)}`);
  ok('REC: reading the status register clears bits 7-5');
}

// ── 5: status read releases /IRQ ───────────────────────────────────────
{
  const reu = new REU('1750');
  let line = false;
  reu.irqHandler = a => { line = a; };
  wr(reu, 0x09, 0xC0);        // enable + end-of-block mask
  reu._endOfBlock = true;
  reu._updateIrq();
  expect(line === true, `an unmasked end-of-block must assert /IRQ`);
  expect((reu.ioPeek(0xDF00) & 0x80) !== 0, `status bit 7 must report the pending interrupt`);
  rd(reu, 0x00);
  expect(line === false, `reading the status register must release /IRQ`);
  ok('REC: status read releases the interrupt line');
}

// ── 6: interrupt mask gates the line ───────────────────────────────────
{
  const reu = new REU('1750');
  let line = false;
  reu.irqHandler = a => { line = a; };
  wr(reu, 0x09, 0x00);        // interrupts disabled
  reu._endOfBlock = true;
  reu._updateIrq();
  expect(line === false, `end-of-block must not raise /IRQ while the mask disables interrupts`);
  wr(reu, 0x09, 0x80);        // enable, but no source masks
  expect(line === false, `enable alone must not raise /IRQ with no source unmasked`);
  wr(reu, 0x09, 0xC0);        // enable + end-of-block
  expect(line === true, `unmasking end-of-block with a flag set must raise /IRQ`);
  ok('REC: interrupt mask register gates the interrupt line');
}

// ── 7: registers mirror every 32 bytes across IO2 ──────────────────────
{
  const reu = new REU('1750');
  wr(reu, 0x02, 0x5A);
  for (const base of [0xDF00, 0xDF20, 0xDF40, 0xDF80, 0xDFE0]) {
    expect(reu.ioPeek(base + 0x02) === 0x5A,
      `register 2 must mirror at ${'$' + (base + 2).toString(16).toUpperCase()}`);
  }
  // Writes through a mirror reach the same register.
  reu.ioWrite(0xDFA2, 0xC3);
  expect(reu.ioPeek(0xDF02) === 0xC3, `a write through a mirror must reach the register`);
  ok('REC: the eleven registers mirror every 32 bytes');
}

// ── 8: the controller occupies the whole $DF00 page ────────────────────
{
  // §2.1: the offsets above $0A are not registers, but the controller still
  // drives $FF onto the bus for them across the entire page — they are not
  // open address space. REU detection routines walk the mirrors, so a byte
  // sampled from the data-bus latch instead of $FF is visible to software.
  const reu = new REU('1750');
  for (const a of [0xDF0B, 0xDF0F, 0xDF1F, 0xDF2B, 0xDF7C, 0xDFFF]) {
    expect(reu.ioRead(a) === 0xFF,
      `${'$' + a.toString(16).toUpperCase()} is inside the REU's page and must read $FF`);
  }
  // IO1 belongs to the cartridge, not the REU.
  for (const a of [0xDE00, 0xDE01, 0xDEFF]) {
    expect(reu.ioRead(a) === -1, `${'$' + a.toString(16).toUpperCase()} is IO1 and must not be claimed`);
  }
  expect(reu.ioWrite(0xDE01, 0x99) === false, `an IO1 write must not be claimed`);
  ok('REC: the controller occupies the whole $DF00 page');
}

// ── 9: status size bit identifies the unit ─────────────────────────────
{
  // Bit 4 reads 1 on a 1750 and 0 on a 1700/1764 — the documented way to tell
  // a 512K unit from the smaller pair.
  for (const m of REU_MODELS) {
    const reu = new REU(m.id);
    const got = (reu.ioPeek(0xDF00) >> 4) & 1;
    expect(got === m.sizeBit,
      `${m.label}: status size bit must read ${m.sizeBit}, got ${got}`);
  }
  expect(reuModel('1750').sizeBit === 1, `the 1750 must report the 256K-chip size bit`);
  expect(reuModel('1700').sizeBit === 0, `the 1700 must report the 64K-chip size bit`);
  expect(reuModel('1764').sizeBit === 0, `the 1764 must report the 64K-chip size bit`);
  ok('REC: status size bit distinguishes a 1750 from a 1700/1764');
}

// ── 10: bank register width ────────────────────────────────────────────
{
  // Stock hardware decodes three bank bits whatever the installed RAM, so a
  // 1700 accepts bank 7 and merely aliases it; the larger units widen the
  // register to reach their capacity.
  for (const m of REU_MODELS) {
    const reu = new REU(m.id);
    wr(reu, 0x06, 0xFF);
    const got = reu.ioPeek(0xDF06);
    const mask = m.bankBits >= 8 ? 0xFF : ((1 << m.bankBits) - 1);
    expect(got === (mask | (~mask & 0xFF)) && got === 0xFF,
      `${m.label}: writing $FF to the bank register must read back all ones`);
    wr(reu, 0x06, 0x00);
    expect(reu.ioPeek(0xDF06) === (~mask & 0xFF),
      `${m.label}: bank register bits above the ${m.bankBits}-bit field must read 1`);
  }
  const stock = new REU('1700');
  wr(stock, 0x06, 0x07);
  expect((stock.ioPeek(0xDF06) & 0x07) === 0x07,
    `a 1700 must accept bank 7 in the register even though its RAM aliases`);
  ok('REC: bank register width follows the unit');
}

// ── 11: model capacities ───────────────────────────────────────────────
{
  const want = {
    '1700': 128, '1764': 256, '1750': 512,
    '1mb': 1024, '1750xl': 2048, '4mb': 4096, '8mb': 8192, '16mb': 16384,
  };
  for (const m of REU_MODELS) {
    const reu = new REU(m.id);
    expect(reu.ram.length === want[m.id] * 1024,
      `${m.label}: must provide ${want[m.id]} KB, got ${reu.ram.length / 1024} KB`);
    // Every capacity is a power of two, which the address wrap relies on.
    expect((reu.ram.length & (reu.ram.length - 1)) === 0,
      `${m.label}: capacity must be a power of two`);
  }
  expect(reuModel('nonsense').id === '1750',
    `an unknown model id must fall back to the default unit`);
  ok('REC: model capacities');
}

// ── 12: /RESET restores the registers but keeps expansion RAM ──────────
{
  const reu = new REU('1750');
  reu.ram[0x100] = 0x42;
  wr(reu, 0x02, 0x34); wr(reu, 0x03, 0x12);
  wr(reu, 0x09, 0xE0); wr(reu, 0x0A, 0xC0);
  reu.resetLine();
  expect(reu.ioPeek(0xDF02) === 0x00 && reu.ioPeek(0xDF03) === 0x00,
    `/RESET must restore the C64 address registers`);
  expect(reu.ioPeek(0xDF09) === 0x1F, `/RESET must restore the interrupt mask register`);
  expect(reu.ioPeek(0xDF0A) === 0x3F, `/RESET must restore the address control register`);
  expect(reu.ram[0x100] === 0x42, `/RESET must not clear expansion DRAM`);
  reu.powerUp();
  expect(reu.ram[0x100] === 0x00, `power-up must clear expansion RAM`);
  ok('REC: /RESET restores registers and leaves DRAM alone');
}

console.log(testsFailing === 0
  ? `\nAll ${testNo} tests passed`
  : `\n${testsFailing} of ${testNo} tests FAILED`);
if (testsFailing) process.exit(1);
