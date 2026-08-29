// REU transfer-engine spec audit, derived from the MOS 8726 REC documentation
// shipped with the Commodore RAM Expansion Module User's Guides.
//
// Transfer types (command bits 1-0): 00 stash (C64→REU), 01 fetch (REU→C64),
// 10 swap, 11 verify. Documented behaviour under test here:
//   - a byte counter of $0000 transfers the full 64K
//   - the counter counts down to 1, not 0, so a length of N leaves it reading 1
//   - both address registers end pointing one location past the transfer range
//   - autoload reloads the addresses and counter from the values last written
//   - a verify mismatch halts at once with FAULT set and the addresses one
//     location above the byte that failed
//   - address control bit 7 fixes the C64 address, bit 6 the REU address
//   - the C64 address wraps $FFFF→$0000; the REU address wraps at the
//     installed capacity, which is what aliases bank 2 onto bank 0 on a 1700
//   - the transfer runs over the real C64 bus, so it sees the current banking

import { REU } from '../src/reu.js';
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

const hex4 = v => '$' + (v & 0xFFFF).toString(16).padStart(4, '0');

function makeReu(model = '1750') {
  const mem = new Memory();
  const reu = new REU(model);
  mem.installReu(reu);
  return { mem, reu };
}

const wr = (reu, r, v) => reu.ioWrite(0xDF00 + r, v);
const pk = (reu, r) => reu.ioPeek(0xDF00 + r);

// Program the controller. `cmd` is the low nybble of the command register;
// execute + FF00-decode-disable are added so the transfer starts immediately.
function program(reu, { c64, reuAddr = 0, len, type, autoload = false, addrCtrl = 0 }) {
  wr(reu, 0x02, c64 & 0xFF);          wr(reu, 0x03, (c64 >> 8) & 0xFF);
  wr(reu, 0x04, reuAddr & 0xFF);      wr(reu, 0x05, (reuAddr >> 8) & 0xFF);
  wr(reu, 0x06, (reuAddr >> 16) & 0xFF);
  wr(reu, 0x07, len & 0xFF);          wr(reu, 0x08, (len >> 8) & 0xFF);
  wr(reu, 0x0A, addrCtrl);
  wr(reu, 0x01, 0x90 | (autoload ? 0x20 : 0) | type);
}

function run(reu, cap = 200000) {
  let n = 0;
  while (reu.dmaActive && n < cap) { reu.dmaCycle(); n++; }
  return n;
}

const c64AddrOf = reu => pk(reu, 0x02) | (pk(reu, 0x03) << 8);
const lenOf     = reu => pk(reu, 0x07) | (pk(reu, 0x08) << 8);

// ── 1: stash moves C64 memory into expansion RAM ───────────────────────
{
  const { mem, reu } = makeReu();
  for (let i = 0; i < 8; i++) mem.ram[0x1000 + i] = 0xA0 + i;
  program(reu, { c64: 0x1000, reuAddr: 0x000, len: 8, type: 0 });
  const cycles = run(reu);
  for (let i = 0; i < 8; i++) {
    expect(reu.ram[i] === 0xA0 + i, `stash byte ${i} must reach expansion RAM`);
  }
  expect(cycles === 8, `stash must take one bus cycle per byte, took ${cycles} for 8`);
  ok('REC: stash copies C64 memory into expansion RAM');
}

// ── 2: fetch moves expansion RAM into C64 memory ───────────────────────
{
  const { mem, reu } = makeReu();
  for (let i = 0; i < 8; i++) reu.ram[i] = 0x50 + i;
  program(reu, { c64: 0x2000, reuAddr: 0x000, len: 8, type: 1 });
  const cycles = run(reu);
  for (let i = 0; i < 8; i++) {
    expect(mem.ram[0x2000 + i] === 0x50 + i, `fetch byte ${i} must reach C64 memory`);
  }
  expect(cycles === 8, `fetch must take one bus cycle per byte, took ${cycles} for 8`);
  ok('REC: fetch copies expansion RAM into C64 memory');
}

// ── 3: swap exchanges both ways at half the rate ───────────────────────
{
  const { mem, reu } = makeReu();
  for (let i = 0; i < 4; i++) { mem.ram[0x1000 + i] = 0x11 + i; reu.ram[i] = 0x77 + i; }
  program(reu, { c64: 0x1000, reuAddr: 0x000, len: 4, type: 2 });
  const cycles = run(reu);
  for (let i = 0; i < 4; i++) {
    expect(mem.ram[0x1000 + i] === 0x77 + i, `swap must place the expansion byte ${i} in C64 memory`);
    expect(reu.ram[i] === 0x11 + i, `swap must place the C64 byte ${i} in expansion RAM`);
  }
  // Swap needs a read and a write on the C64 bus for every byte, which is the
  // documented halving of the transfer rate against stash and fetch.
  expect(cycles === 8, `swap must take two bus cycles per byte, took ${cycles} for 4`);
  ok('REC: swap exchanges both ways at two bus cycles per byte');
}

// ── 4: verify passes on matching blocks ────────────────────────────────
{
  const { mem, reu } = makeReu();
  for (let i = 0; i < 16; i++) { mem.ram[0x1000 + i] = i; reu.ram[i] = i; }
  program(reu, { c64: 0x1000, reuAddr: 0x000, len: 16, type: 3 });
  const cycles = run(reu);
  const st = reu.ioPeek(0xDF00);
  expect(cycles === 16, `verify must take one bus cycle per byte, took ${cycles} for 16`);
  expect((st & 0x20) === 0, `a matching verify must not set FAULT`);
  expect((st & 0x40) !== 0, `a completed verify must set end of block`);
  ok('REC: verify completes cleanly on matching blocks');
}

// ── 5: verify halts on a mismatch, one location past the failure ───────
{
  const { mem, reu } = makeReu();
  for (let i = 0; i < 16; i++) { mem.ram[0x1000 + i] = i; reu.ram[i] = i; }
  reu.ram[3] = 0xFF;                                  // byte 3 differs
  program(reu, { c64: 0x1000, reuAddr: 0x000, len: 16, type: 3 });
  const cycles = run(reu);
  const st = reu.ioPeek(0xDF00);
  // Four comparisons reach the bad byte, then one more cycle: a fault anywhere
  // but the final byte costs an extra comparison, which is what decides
  // end-of-block (see the tail case below). The counters do not move for it.
  expect(cycles === 5, `verify must halt one cycle past the mismatch, ran ${cycles} cycles`);
  expect((st & 0x20) !== 0, `a verify mismatch must set FAULT`);
  expect((st & 0x40) === 0,
    `a mismatch far from the end must not set end-of-block, status $${st.toString(16)}`);
  expect(c64AddrOf(reu) === 0x1004,
    `after a verify error the C64 address must point one past the failure, got ${hex4(c64AddrOf(reu))}`);
  expect((pk(reu, 0x04) | (pk(reu, 0x05) << 8)) === 0x0004,
    `after a verify error the REU address must point one past the failure`);
  ok('REC: verify halts on a mismatch with the addresses one past it');
}

// ── 5b: end-of-block after a verify error depends on the byte after it ──
{
  // QuickReuTest measures all three of these, cycle counts included. A fault on
  // the final byte ends the run; a fault one earlier costs one more comparison
  // cycle, and end-of-block is set only if that comparison was clean — two
  // mismatches running into the end of the block leave it clear.
  const mk = (badAt, alsoBadLast) => {
    const { mem, reu } = makeReu();
    for (let i = 0; i < 8; i++) { mem.ram[0x1000 + i] = i; reu.ram[i] = i; }
    reu.ram[badAt] = 0xFF;
    if (alsoBadLast) reu.ram[7] = 0xEE;
    program(reu, { c64: 0x1000, reuAddr: 0x000, len: 8, type: 3 });
    const cycles = run(reu);
    return { st: reu.ioPeek(0xDF00), cycles };
  };

  const last = mk(7, false);                 // fault on the final byte
  expect((last.st & 0x60) === 0x60, `a fault on the last byte sets fault and end-of-block`);
  expect(last.cycles === 8, `and runs exactly the bytes compared, ran ${last.cycles}`);

  const secondLastClean = mk(6, false);      // fault one earlier, last byte equal
  expect((secondLastClean.st & 0x60) === 0x60,
    `a fault on the next-to-last byte still sets end-of-block when the last matches`);
  expect(secondLastClean.cycles === 8, `costing one extra cycle, ran ${secondLastClean.cycles}`);

  const secondLastAlsoBad = mk(6, true);     // fault one earlier, last byte differs too
  expect((secondLastAlsoBad.st & 0x20) !== 0, `two mismatches at the tail still set fault`);
  expect((secondLastAlsoBad.st & 0x40) === 0,
    `but leave end-of-block clear, status $${secondLastAlsoBad.st.toString(16)}`);
  expect(secondLastAlsoBad.cycles === 8, `for the same cycle count, ran ${secondLastAlsoBad.cycles}`);
  ok('REC: end-of-block after a verify error follows the comparison past it');
}

// ── 6: a byte counter of zero transfers 64K ────────────────────────────
{
  const { mem, reu } = makeReu();
  mem.ram[0x0000] = 0xC5;
  mem.ram[0xFFFF] = 0x3B;
  program(reu, { c64: 0x0000, reuAddr: 0x000, len: 0x0000, type: 0 });
  const cycles = run(reu);
  expect(cycles === 65536, `a length of $0000 must transfer 64K, transferred ${cycles}`);
  expect(reu.ram[0x0000] === 0xC5 && reu.ram[0xFFFF] === 0x3B,
    `the full 64K block must reach expansion RAM`);
  ok('REC: a byte counter of $0000 transfers the full 64K');
}

// ── 7: post-transfer register end state ────────────────────────────────
{
  const { reu } = makeReu();
  program(reu, { c64: 0x1000, reuAddr: 0x000, len: 0x0010, type: 0 });
  run(reu);
  expect(c64AddrOf(reu) === 0x1010,
    `the C64 address must end one past the transfer range, got ${hex4(c64AddrOf(reu))}`);
  expect((pk(reu, 0x04) | (pk(reu, 0x05) << 8)) === 0x0010,
    `the REU address must end one past the transfer range`);
  expect(lenOf(reu) === 1, `the byte counter must count down to 1, got ${lenOf(reu)}`);
  ok('REC: addresses end past the range and the counter ends at 1');
}

// ── 8: the command register after a transfer ───────────────────────────
{
  const { reu } = makeReu();
  program(reu, { c64: 0x1000, len: 4, type: 0 });
  run(reu);
  const cmd = reu.ioPeek(0xDF01);
  expect((cmd & 0x80) === 0, `execute must clear when the transfer ends, got $${cmd.toString(16)}`);
  expect((cmd & 0x10) !== 0, `the FF00 option is consumed by use, so its disable bit must set again`);
  ok('REC: execute clears and the FF00 option is consumed');
}

// ── 9: autoload reloads the written values ─────────────────────────────
{
  const { reu } = makeReu();
  program(reu, { c64: 0x1000, reuAddr: 0x20000, len: 0x0010, type: 0, autoload: true });
  run(reu);
  expect(c64AddrOf(reu) === 0x1000,
    `autoload must restore the C64 address written before the transfer, got ${hex4(c64AddrOf(reu))}`);
  expect((pk(reu, 0x04) | (pk(reu, 0x05) << 8)) === 0x0000,
    `autoload must restore the REU address`);
  expect((pk(reu, 0x06) & 0x07) === 0x02, `autoload must restore the bank register`);
  expect(lenOf(reu) === 0x0010, `autoload must restore the byte counter, got ${lenOf(reu)}`);
  ok('REC: autoload reloads the addresses and counter written before the transfer');
}

// ── 10: fixed C64 address ──────────────────────────────────────────────
{
  const { mem, reu } = makeReu();
  mem.ram[0x1000] = 0x5C;
  // Bit 7 fixes the C64 side: one source byte fills a block of expansion RAM.
  program(reu, { c64: 0x1000, reuAddr: 0, len: 8, type: 0, addrCtrl: 0x80 });
  run(reu);
  for (let i = 0; i < 8; i++) {
    expect(reu.ram[i] === 0x5C, `a fixed C64 address must repeat the same byte at ${i}`);
  }
  expect(c64AddrOf(reu) === 0x1000, `a fixed C64 address must not advance`);
  ok('REC: address control bit 7 fixes the C64 address');
}

// ── 11: fixed REU address ──────────────────────────────────────────────
{
  const { mem, reu } = makeReu();
  for (let i = 0; i < 8; i++) mem.ram[0x1000 + i] = 0x30 + i;
  // Bit 6 fixes the expansion side: the last byte written is what remains.
  program(reu, { c64: 0x1000, reuAddr: 0, len: 8, type: 0, addrCtrl: 0x40 });
  run(reu);
  expect(reu.ram[0] === 0x37, `a fixed REU address must leave the last byte written`);
  expect(reu.ram[1] === 0x00, `a fixed REU address must not advance`);
  expect(c64AddrOf(reu) === 0x1008, `the C64 address must still advance`);
  ok('REC: address control bit 6 fixes the REU address');
}

// ── 12: both addresses fixed ───────────────────────────────────────────
{
  const { mem, reu } = makeReu();
  mem.ram[0x1000] = 0x9E;
  program(reu, { c64: 0x1000, reuAddr: 0, len: 8, type: 0, addrCtrl: 0xC0 });
  run(reu);
  expect(reu.ram[0] === 0x9E && reu.ram[1] === 0x00,
    `with both addresses fixed only one location is touched`);
  expect(c64AddrOf(reu) === 0x1000, `neither address may advance`);
  ok('REC: address control bits 7-6 can fix both addresses');
}

// ── 13: the C64 address wraps $FFFF→$0000 ──────────────────────────────
{
  const { mem, reu } = makeReu();
  mem.ram[0xFFFE] = 0x11; mem.ram[0xFFFF] = 0x22;
  mem.ram[0x0000] = 0x33; mem.ram[0x0001] = 0x44;
  program(reu, { c64: 0xFFFE, reuAddr: 0, len: 4, type: 0 });
  run(reu);
  // Overflow is not detected — the address simply continues from $0000.
  expect(reu.ram[0] === 0x11 && reu.ram[1] === 0x22,
    `the bytes before the wrap must transfer`);
  expect(reu.ram[2] === 0x33 && reu.ram[3] === 0x44,
    `the C64 address must continue from $0000 after $FFFF`);
  expect(c64AddrOf(reu) === 0x0002, `the C64 address must end wrapped, got ${hex4(c64AddrOf(reu))}`);
  ok('REC: the C64 address wraps from $FFFF to $0000');
}

// ── 14: expansion RAM wraps at the installed capacity ──────────────────
{
  // A 1700 has 128K, so bank 2 aliases onto bank 0 — the documented probe for
  // telling a 1700 from a 1764.
  const small = makeReu('1700');
  small.mem.ram[0x1000] = 0x7E;
  program(small.reu, { c64: 0x1000, reuAddr: 0x20000, len: 1, type: 0 });
  run(small.reu);
  expect(small.reu.ram[0x00000] === 0x7E,
    `a 1700 must alias bank 2 onto bank 0`);

  // A 1764 has 256K, so the same address is real storage.
  const big = makeReu('1764');
  big.mem.ram[0x1000] = 0x7E;
  program(big.reu, { c64: 0x1000, reuAddr: 0x20000, len: 1, type: 0 });
  run(big.reu);
  expect(big.reu.ram[0x20000] === 0x7E, `a 1764 must store bank 2 in its own RAM`);
  expect(big.reu.ram[0x00000] === 0x00, `a 1764 must not alias bank 2 onto bank 0`);
  ok('REC: expansion RAM wraps at the installed capacity');
}

// ── 15: a 1764's unpopulated banks float instead of mirroring ───────────
{
  // Jumper J1 puts 256ki chips in a 1764 but only one of the controller's two
  // DRAM banks is fitted, so the counter's 512K span has banks 4-7 unbacked.
  // They are NOT mirrors of 0-3: reads take the DRAM data bus, which holds the
  // last byte written, and writes go nowhere.
  const { mem, reu } = makeReu('1764');
  mem.ram[0x1000] = 0x5A;
  program(reu, { c64: 0x1000, reuAddr: 0x40000, len: 1, type: 0 });   // bank 4
  run(reu);
  expect(reu.ram[0x00000] === 0x00,
    `a write into an unpopulated bank must not land in bank 0`);

  // The write drove $5A onto the DRAM bus, so reading the hole gives it back.
  program(reu, { c64: 0x2000, reuAddr: 0x40000, len: 1, type: 1 });   // fetch
  run(reu);
  expect(mem.ram[0x2000] === 0x5A,
    `an unpopulated read must return the floating bus, got $${mem.ram[0x2000].toString(16)}`);

  // A 1750 has both banks fitted, so the same address is real storage.
  const full = makeReu('1750');
  full.mem.ram[0x1000] = 0x5A;
  program(full.reu, { c64: 0x1000, reuAddr: 0x40000, len: 1, type: 0 });
  run(full.reu);
  expect(full.reu.ram[0x40000] === 0x5A, `a 1750 must back bank 4 with real DRAM`);
  ok('REC: a 1764\'s unpopulated banks float rather than mirror');
}

// ── 15: transfers run over the real C64 bus ────────────────────────────
{
  const { mem, reu } = makeReu();
  // Character ROM under $D000 with different bytes in the RAM beneath it. A
  // transfer reading $D000 must see whatever the current banking exposes, not
  // the underlying RAM — that is what makes the $FF00 trigger worth having.
  mem.charRom = new Uint8Array(4096).fill(0xCC);
  for (let i = 0; i < 4; i++) mem.ram[0xD000 + i] = 0x55;
  mem.write(0x0000, 0x2F);           // DDR: port bits are outputs
  mem.write(0x0001, 0x33);           // LORAM+HIRAM on, CHAREN off → CHARROM at $D000
  program(reu, { c64: 0xD000, reuAddr: 0, len: 4, type: 0 });
  run(reu);
  for (let i = 0; i < 4; i++) {
    expect(reu.ram[i] === 0xCC,
      `a transfer must read through the current banking (character ROM), got $${reu.ram[i].toString(16)}`);
  }
  ok('REC: transfers read through the live memory map');
}

// ── 16: the 6510 port does not answer a DMA ────────────────────────────
{
  const { mem, reu } = makeReu();
  mem.write(0x0000, 0x2F);           // DDR
  mem.write(0x0001, 0x37);           // banking latch
  mem.ram[0x0000] = 0x81; mem.ram[0x0001] = 0x82;
  program(reu, { c64: 0x0000, reuAddr: 0, len: 2, type: 0 });
  run(reu);
  // The port decode is inside the CPU, which is off the bus during a transfer,
  // so the DRAM underneath answers instead of the DDR/banking registers.
  expect(reu.ram[0] === 0x81 && reu.ram[1] === 0x82,
    `a DMA read of $00/$01 must return DRAM, got $${reu.ram[0].toString(16)} $${reu.ram[1].toString(16)}`);

  // And writing there must not re-bank the machine mid-transfer.
  reu.ram[0] = 0x00; reu.ram[1] = 0x00;
  program(reu, { c64: 0x0000, reuAddr: 0, len: 2, type: 1 });
  run(reu);
  expect(mem.cpuPort === 0x37, `a DMA write to $01 must not disturb the banking latch`);
  expect(mem.ram[0x0001] === 0x00, `a DMA write to $01 must land in DRAM`);
  ok('REC: the 6510 on-chip port stays silent during a transfer');
}

// ── 17: save-state packing is lossless ─────────────────────────────────
{
  const { reu } = makeReu('1mb');
  reu.ram[0x00000] = 0x01;
  reu.ram[0x7FFFF] = 0x02;
  reu.ram[0xFFFFF] = 0x03;
  program(reu, { c64: 0x1234, reuAddr: 0x5678, len: 0x0042, type: 2, autoload: true });
  const snap = reu.serialize();

  // All-zero blocks are dropped, so a nearly empty expansion costs almost
  // nothing in a state slot.
  expect(snap.ram.blocks.length === 3,
    `only the three non-zero blocks should be stored, got ${snap.ram.blocks.length}`);

  const fresh = new REU('1mb');
  fresh.deserialize(snap);
  expect(fresh.ram[0x00000] === 0x01 && fresh.ram[0x7FFFF] === 0x02 && fresh.ram[0xFFFFF] === 0x03,
    `expansion RAM must round-trip through a save state`);
  expect(fresh.ram.reduce((a, b) => a + b, 0) === 6,
    `no bytes may appear that were not there before`);
  for (let r = 0; r <= 0x0A; r++) {
    expect(fresh.ioPeek(0xDF00 + r) === reu.ioPeek(0xDF00 + r),
      `register $${r.toString(16)} must round-trip through a save state`);
  }
  ok('REC: save-state packing round-trips registers and RAM');
}

console.log(testsFailing === 0
  ? `\nAll ${testNo} tests passed`
  : `\n${testsFailing} of ${testNo} tests FAILED`);
if (testsFailing) process.exit(1);
