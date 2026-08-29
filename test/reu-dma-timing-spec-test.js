// REU DMA bus-arbitration spec audit, at the machine level.
//
// The REC takes the bus for the whole of a transfer: "during DMA, the
// computer's processor is temporarily halted", and "VIC DMA's take precedence
// over REC DMA's". The documented rates — 1 MB/s for stash and fetch, 500 KB/s
// for swap, against a ~1 MHz phi2 — are one C64-bus access per byte for stash,
// fetch and verify, and two for swap.
//
// The $FF00 option exists so software can bank I/O out and still start a
// transfer: with the option enabled the controller waits for a write to $FF00,
// and the transfer then reaches the RAM underneath the I/O space.

import { C64Machine } from '../src/machine.js';

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

// A machine with an REU fitted and the CPU parked in a JMP-self loop. The
// display is off by default so no bad line steals a cycle; `den` turns it on
// and parks the raster inside the display window, where bad lines actually
// occur, so a transfer there has to contend with the VIC.
function makeMachine({ model = '1750', den = false } = {}) {
  const m = new C64Machine();
  m.ready = true;
  m.attachReu(model);
  const ram = m.mem.ram;
  ram[0x1000] = 0x4C; ram[0x1001] = 0x00; ram[0x1002] = 0x10;   // JMP $1000
  m.cpu.pc = 0x1000;
  m.cpu.I = 1;
  m.mem.write(0xD011, den ? 0x1B : 0x0B);   // DEN, YSCROLL 3
  m.mem.write(0xD015, 0x00);                // no sprites → no sprite DMA
  if (den) {
    // Bad lines only happen in raster $30-$F7; a fresh machine starts at
    // raster 0, which a few hundred cycles never leaves.
    let guard = 100000;
    while (m.vic2.raster < 0x40 && guard-- > 0) m._runMasterCycle();
  }
  while (!m.cpu.atInstructionBoundary()) m._runMasterCycle();
  return m;
}

const wr = (m, r, v) => m.mem.write(0xDF00 + r, v);

// Program a transfer and start it immediately (FF00 decode disabled).
function program(m, { c64, reuAddr = 0, len, type }) {
  wr(m, 0x02, c64 & 0xFF);       wr(m, 0x03, (c64 >> 8) & 0xFF);
  wr(m, 0x04, reuAddr & 0xFF);   wr(m, 0x05, (reuAddr >> 8) & 0xFF);
  wr(m, 0x06, (reuAddr >> 16) & 0xFF);
  wr(m, 0x07, len & 0xFF);       wr(m, 0x08, (len >> 8) & 0xFF);
  wr(m, 0x01, 0x90 | type);
}

// Run master cycles until the transfer ends, counting how many the CPU lost.
function runTransfer(m, cap = 200000) {
  let cycles = 0, cpuRan = 0;
  while (m._reuBusHold && cycles < cap) {
    const pc = m.cpu.pc;
    const boundary = m.cpu.atInstructionBoundary();
    m._runMasterCycle();
    if (m.cpu.pc !== pc || !boundary !== !m.cpu.atInstructionBoundary()) cpuRan++;
    cycles++;
  }
  return { cycles, cpuRan };
}

// ── 1: a transfer halts the CPU for its whole duration ─────────────────
{
  const m = makeMachine();
  for (let i = 0; i < 64; i++) m.mem.ram[0x2000 + i] = i;
  const pcBefore = m.cpu.pc;
  program(m, { c64: 0x2000, len: 64, type: 0 });
  const { cycles, cpuRan } = runTransfer(m);
  expect(cpuRan === 0, `the CPU must not advance during a transfer, it ran ${cpuRan} cycles`);
  expect(m.cpu.pc === pcBefore, `the CPU's PC must be untouched by a transfer`);
  expect(cycles === 64, `64 bytes must take 64 bus cycles, took ${cycles}`);
  for (let i = 0; i < 64; i++) {
    expect(m.reu.ram[i] === i, `byte ${i} must reach expansion RAM`);
  }
  ok('REC: a transfer halts the CPU and takes one cycle per byte');
}

// ── 2: the CPU resumes the cycle after the transfer ────────────────────
{
  const m = makeMachine();
  program(m, { c64: 0x2000, len: 4, type: 0 });
  runTransfer(m);
  expect(m._reuBusHold === false, `the bus must be released when the transfer ends`);
  expect(m.cpu.atInstructionBoundary(),
    `the CPU should be parked between instructions while halted`);
  // One cycle of the JMP-self loop is an opcode fetch, so the CPU leaves the
  // boundary immediately. (Checking the PC would prove nothing: a three-cycle
  // JMP $1000 lands back on $1000.)
  m._runMasterCycle();
  expect(!m.cpu.atInstructionBoundary(),
    `the CPU must fetch again on the cycle after the bus is released`);
  ok('REC: the CPU resumes once the transfer releases the bus');
}

// ── 3: swap costs two bus cycles per byte ──────────────────────────────
{
  const m = makeMachine();
  program(m, { c64: 0x2000, len: 16, type: 2 });
  const { cycles } = runTransfer(m);
  expect(cycles === 32, `a 16-byte swap must take 32 bus cycles, took ${cycles}`);
  ok('REC: swap takes two bus cycles per byte');
}

// ── 4: verify costs one bus cycle per byte ─────────────────────────────
{
  const m = makeMachine();
  for (let i = 0; i < 16; i++) { m.mem.ram[0x2000 + i] = i; m.reu.ram[i] = i; }
  program(m, { c64: 0x2000, len: 16, type: 3 });
  const { cycles } = runTransfer(m);
  expect(cycles === 16, `a 16-byte verify must take 16 bus cycles, took ${cycles}`);
  ok('REC: verify takes one bus cycle per byte');
}

// ── 5: VIC DMA takes precedence, stretching the transfer ───────────────
{
  // With the display on, bad lines and their 40-cycle c-access windows steal
  // phi2 from the REC just as they do from the CPU, so the same transfer takes
  // strictly longer in wall-clock cycles while still moving the same bytes.
  const idle = makeMachine({ den: false });
  program(idle, { c64: 0x2000, len: 512, type: 0 });
  const idleRun = runTransfer(idle);

  const busy = makeMachine({ den: true });
  program(busy, { c64: 0x2000, len: 512, type: 0 });
  const busyRun = runTransfer(busy);

  expect(idleRun.cycles === 512,
    `with the display off a 512-byte transfer must take 512 cycles, took ${idleRun.cycles}`);
  // 512 cycles spans about eight raster lines, so at least one bad line and
  // its 40-cycle c-access window falls inside the transfer.
  expect(busyRun.cycles > idleRun.cycles,
    `VIC DMA must take precedence and stretch the transfer, ${busyRun.cycles} vs ${idleRun.cycles}`);
  for (let i = 0; i < 512; i++) {
    if (busy.reu.ram[i] !== busy.mem.ram[0x2000 + i]) {
      expect(false, `every byte must still transfer despite stolen cycles (byte ${i})`);
      break;
    }
  }
  ok('REC: VIC DMA takes precedence and stretches the transfer');
}

// ── 6: the $FF00 option defers the start to a write to $FF00 ───────────
{
  const m = makeMachine();
  m.mem.ram[0x2000] = 0x5E;
  wr(m, 0x02, 0x00); wr(m, 0x03, 0x20);
  wr(m, 0x04, 0x00); wr(m, 0x05, 0x00); wr(m, 0x06, 0x00);
  wr(m, 0x07, 0x01); wr(m, 0x08, 0x00);
  wr(m, 0x01, 0x80);                       // execute, FF00 decode ENABLED
  expect(m._reuBusHold === false,
    `with the FF00 option enabled the transfer must wait rather than start`);
  m.mem.write(0xFF00, 0x00);               // the trigger
  expect(m._reuBusHold === true, `a write to $FF00 must start the armed transfer`);
  runTransfer(m);
  expect(m.reu.ram[0] === 0x5E, `the deferred transfer must run once triggered`);
  ok('REC: the FF00 option defers the start to a write to $FF00');
}

// ── 7: the $FF00 write itself still reaches memory ─────────────────────
{
  const m = makeMachine();
  wr(m, 0x02, 0x00); wr(m, 0x03, 0x20);
  wr(m, 0x07, 0x01); wr(m, 0x08, 0x00);
  wr(m, 0x01, 0x80);
  m.mem.write(0xFF00, 0xA7);
  expect(m.mem.ram[0xFF00] === 0xA7,
    `the triggering store must still land in memory, got $${m.mem.ram[0xFF00].toString(16)}`);
  ok('REC: the triggering store lands in memory as well');
}

// ── 8: a deferred transfer reaches the RAM under I/O ───────────────────
{
  // This is what the FF00 option is for: bank I/O out, then trigger, and the
  // transfer sees the RAM beneath $D000-$DFFF instead of the chips.
  const m = makeMachine();
  for (let i = 0; i < 4; i++) m.mem.ram[0xD000 + i] = 0x60 + i;
  wr(m, 0x02, 0x00); wr(m, 0x03, 0xD0);    // C64 $D000
  wr(m, 0x04, 0x00); wr(m, 0x05, 0x00); wr(m, 0x06, 0x00);
  wr(m, 0x07, 0x04); wr(m, 0x08, 0x00);
  wr(m, 0x01, 0x80);                       // arm, waiting on $FF00
  m.mem.write(0x0000, 0x2F);               // DDR: port bits are outputs
  m.mem.write(0x0001, 0x34);               // I/O and ROM banked out — RAM at $D000
  m.mem.write(0xFF00, 0x00);               // trigger, with $DF00 no longer reachable
  runTransfer(m);
  for (let i = 0; i < 4; i++) {
    expect(m.reu.ram[i] === 0x60 + i,
      `the transfer must read the RAM under I/O, got $${m.reu.ram[i].toString(16)} at ${i}`);
  }
  ok('REC: a deferred transfer reaches the RAM under I/O');
}

// ── 9: end of block raises /IRQ when the mask allows it ────────────────
{
  const m = makeMachine();
  wr(m, 0x09, 0xC0);                       // interrupts on + end-of-block mask
  program(m, { c64: 0x2000, len: 4, type: 0 });
  runTransfer(m);
  expect(m._reuIrqPending === true, `an unmasked end of block must assert the REU's /IRQ`);
  m._runMasterCycle();                     // the machine samples interrupts
  expect(m.cpu.irqLine === true, `the REU's /IRQ must reach the CPU's interrupt line`);
  m.mem.read(0xDF00);                      // reading status releases it
  expect(m._reuIrqPending === false, `reading the status register must release /IRQ`);
  m._runMasterCycle();
  expect(m.cpu.irqLine === false, `the CPU's interrupt line must follow the release`);
  ok('REC: end of block drives the CPU interrupt line through the mask');
}

// ── 10: a masked end of block leaves the line alone ────────────────────
{
  const m = makeMachine();
  wr(m, 0x09, 0x00);                       // interrupts disabled (power-up state)
  program(m, { c64: 0x2000, len: 4, type: 0 });
  runTransfer(m);
  expect(m._reuIrqPending === false,
    `end of block must not raise /IRQ while interrupts are disabled`);
  m._runMasterCycle();
  expect(m.cpu.irqLine === false, `the CPU's interrupt line must stay released`);
  ok('REC: a masked end of block leaves the interrupt line alone');
}

// ── 11: the bus trace names the REU as the phi2 owner ──────────────────
{
  const m = makeMachine();
  m.enableBusTrace(256);
  program(m, { c64: 0x2000, len: 8, type: 0 });
  runTransfer(m);
  const trace = m.busTraceSnapshot(64);
  const owners = new Set(trace.map(e => e.phi2Owner));
  expect(owners.has('reu'), `the bus trace must attribute stolen cycles to the REU`);
  const reuEntries = trace.filter(e => e.phi2Owner === 'reu');
  expect(reuEntries.length === 8, `all 8 transfer cycles must be attributed, got ${reuEntries.length}`);
  expect(reuEntries.every(e => e.cpuBlocked),
    `every REU-owned cycle must report the CPU as blocked`);
  m.disableBusTrace();
  ok('REC: the bus trace attributes transfer cycles to the REU');
}

// ── 12: detaching the unit frees the expansion port ────────────────────
{
  const m = makeMachine();
  expect(m.mem.read(0xDF01) === 0x10, `a fitted unit must answer at $DF01`);
  m.detachReu();
  expect(m.reu === null, `detaching must remove the unit`);
  expect(m._reuBusHold === false, `detaching must release the bus`);
  // With nothing on IO2 the address reads open bus, not a register.
  m.mem.write(0xDF01, 0x90);
  expect(m._reuBusHold === false, `a write to a vacant $DF01 must not start anything`);
  ok('REC: detaching the unit frees the expansion port');
}

// ── 13: a machine save state carries expansion RAM ─────────────────────
{
  const m = makeMachine();
  for (let i = 0; i < 32; i++) m.mem.ram[0x2000 + i] = 0xE0 + i;
  program(m, { c64: 0x2000, len: 32, type: 0 });
  runTransfer(m);
  const snap = m.serializeState();
  expect(snap.reu !== null, `a fitted unit must appear in the machine snapshot`);

  const fresh = new C64Machine();
  fresh.ready = true;
  fresh.attachReu('1750');
  fresh.restoreState(snap);
  for (let i = 0; i < 32; i++) {
    expect(fresh.reu.ram[i] === 0xE0 + i, `expansion RAM byte ${i} must survive a state round trip`);
  }

  // A machine with no unit fitted must ignore the block rather than fail.
  const bare = new C64Machine();
  bare.ready = true;
  let threw = null;
  try { bare.restoreState(snap); } catch (e) { threw = e; }
  expect(threw === null, `restoring an REU state onto a machine without one must not throw`);
  ok('REC: expansion RAM survives a machine save-state round trip');
}

console.log(testsFailing === 0
  ? `\nAll ${testNo} tests passed`
  : `\n${testsFailing} of ${testNo} tests FAILED`);
if (testsFailing) process.exit(1);
