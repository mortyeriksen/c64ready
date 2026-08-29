// IRQ entry × VIC BA-stall interaction spec test.
//
// Bauer §3.6.1 + 6510 IRQ semantics: BA-low stalls CPU READ cycles but
// not WRITE cycles. AEC-low halts ALL CPU work. The 7-cycle IRQ entry
// sequence is:
//   1. dummy read   (read)   ← stalls under BA-low
//   2. dummy read   (read)   ← stalls under BA-low
//   3. push PCH     (write)
//   4. push PCL     (write)
//   5. push P       (write) — also sets I=1
//   6. read vec lo  (read)   ← stalls under BA-low
//   7. read vec hi  (read)   ← stalls under BA-low
//
// nine.prg's stable-raster IRQ pattern depends on this sequence having
// the expected per-cycle bus kinds AND the master clock applying the
// kind-aware stall correctly. If our model gets either wrong, the
// timed handler drifts and every $D011/$D016/$D018 write is misaligned.

import { CPU } from '../src/cpu.js';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

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

function makeCpu(handlerLo = 0x00, handlerHi = 0x90) {
  const mem = new FlatMemory();
  for (let i = 0; i < 64; i++) mem.ram[0x0400 + i] = 0xEA;       // NOP runway
  for (let i = 0; i < 64; i++) mem.ram[0x9000 + i] = 0xEA;       // ISR runway
  mem.ram[0xFFFE] = handlerLo;
  mem.ram[0xFFFF] = handlerHi;
  mem.ram[0xFFFC] = 0x00;
  mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();                       // consume reset
  cpu.I = 0; cpu._pollI = 0;
  return { cpu, mem };
}

// Park CPU at an instruction boundary with IRQ asserted, ready for the
// next clock() to start the 7-cycle IRQ entry.
function armIrqAtBoundary(cpu) {
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;
}

// ── 1: IRQ entry bus-kind sequence is exactly read,read,write,write,write,read,read
// peekNextBusKind() reports the bus access kind for the NEXT clock()
// call. A master clock that uses this to stall reads under BA-low must
// see this exact sequence to apply BA correctly per Bauer §3.6.1.
{
  const { cpu } = makeCpu();
  armIrqAtBoundary(cpu);
  const expected = ['read','read','write','write','write','read','read'];
  const got = [];
  for (let i = 0; i < 7; i++) {
    got.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 7; i++) {
    expect(got[i] === expected[i],
      `IRQ entry cycle ${i+1}: bus kind expected ${expected[i]}, got ${got[i]}`);
  }
  expect(cpu.pc === 0x9000,
    `after 7 entry cycles, PC = ISR vector $9000, got $${cpu.pc.toString(16)}`);
  ok('6510 IRQ entry exposes per-cycle bus kind read/read/write/write/write/read/read');
}

// ── 2: BA-low covering write cycles (3,4,5): pushes proceed, then BA-low
// covering reads (6,7) stalls until release.
//
// Because the IRQ entry queue is FIFO, the master clock must complete
// reads (1,2) under BA-high BEFORE the writes can run. Realistic pattern
// for nine.prg's IRQ at non-bad-line: BA stays high across cycles 1-2,
// then a sprite-DMA window pulls BA low across cycles 3-5 (writes still
// advance per Bauer §3.6.1), then BA may stay low into cycles 6-7
// (reads stall until BA releases).
{
  const { cpu } = makeCpu();
  armIrqAtBoundary(cpu);
  // Phase A: BA-high. Cycles 1, 2 (reads) advance.
  for (let i = 0; i < 2; i++) cpu.clock();
  expect(cpu.peekNextBusKind() === 'write',
    `after 2 reads, next op is write (push PCH), got ${cpu.peekNextBusKind()}`);
  // Phase B: BA-low for 50 master ticks. Pushes are writes — they advance.
  // After 3 writes complete, next op is read (vec lo) — stalls.
  let phaseBWrites = 0;
  for (let i = 0; i < 50; i++) {
    if (cpu.peekNextBusKind() === 'write') {
      cpu.clock();
      phaseBWrites++;
    }
    // else: stalled (read) under BA-low — master clock skips cpu.clock()
  }
  expect(phaseBWrites === 3,
    `BA-low across writes: exactly 3 pushes advance, got ${phaseBWrites}`);
  expect(cpu.peekNextBusKind() === 'read',
    `after 3 writes, next op is read (vec lo), got ${cpu.peekNextBusKind()}`);
  expect(cpu.pc !== 0x9000, `PC not yet loaded from vector`);
  expect(cpu.I === 1, `push-P committed I=1, got I=${cpu.I}`);
  // Phase C: BA-high. Vector-fetch reads (6, 7) complete.
  for (let i = 0; i < 2; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `after BA release, PC = ISR vector $9000, got $${cpu.pc.toString(16)}`);
  ok('Bauer §3.6.1: BA-low stalls IRQ entry reads but writes proceed');
}

// ── 3: AEC-low halts ALL IRQ entry cycles (writes + reads)
// AEC = bad-line + sprite overlap blocks the CPU bus completely. Even
// writes don't proceed under AEC-low.
{
  const { cpu } = makeCpu();
  armIrqAtBoundary(cpu);
  // Master clock under AEC-low: skip cpu.clock() entirely.
  for (let i = 0; i < 100; i++) {
    // No cpu.clock() call — AEC-low blocks everything.
  }
  expect(cpu.pc !== 0x9000,
    `under AEC-low: IRQ entry must not progress`);
  expect(cpu.I === 0,
    `under AEC-low: I flag still 0 (push-P never ran), got I=${cpu.I}`);
  // Release AEC. Full 7 cycles run.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `after AEC release, full 7-cycle entry completes, PC=$${cpu.pc.toString(16)}`);
  ok('AEC-low halts every IRQ entry cycle — both reads and writes');
}

// ── 4: Mid-entry BA pulse — entry resumes mid-sequence
// Realistic cart scenario: BA pulses high/low across the IRQ entry as
// sprite/bad-line BA windows open and close. The total cycle count is
// 7 plus however long BA blocked any read cycles.
{
  const { cpu } = makeCpu();
  armIrqAtBoundary(cpu);
  // BA-low from start to cycle 2 done (blocks first 2 reads).
  // Master clock holds 5 ticks of BA-low — no advance.
  let masterTicks = 0;
  let cpuCycles = 0;
  // BA-low: 5 master ticks, no read can advance (next is read).
  for (let i = 0; i < 5; i++) {
    masterTicks++;
    if (cpu.peekNextBusKind() === 'write') {
      cpu.clock();
      cpuCycles++;
    }
  }
  expect(cpuCycles === 0, `BA-low at start: no advance yet, got ${cpuCycles}`);
  // BA-high for cycles 1+2 (the 2 dummy reads).
  for (let i = 0; i < 2; i++) {
    cpu.clock();
    masterTicks++;
    cpuCycles++;
  }
  expect(cpuCycles === 2 && cpu.peekNextBusKind() === 'write',
    `after 2 reads complete, next op is write, got cycles=${cpuCycles} kind=${cpu.peekNextBusKind()}`);
  // BA-low again — but pushes (writes) still advance.
  for (let i = 0; i < 50; i++) {
    masterTicks++;
    if (cpu.peekNextBusKind() === 'write') {
      cpu.clock();
      cpuCycles++;
    }
  }
  expect(cpuCycles === 5, `3 pushes ran under BA-low, total CPU cycles=${cpuCycles}`);
  // BA-high again for the final 2 vector-fetch reads.
  for (let i = 0; i < 2; i++) {
    cpu.clock();
    cpuCycles++;
  }
  expect(cpuCycles === 7 && cpu.pc === 0x9000,
    `entry done in 7 CPU cycles, PC=$${cpu.pc.toString(16)}`);
  ok('Mid-entry BA pulse: entry advances writes through BA, resumes reads on release');
}

// ── 5: I=1 commit happens at cycle 5 (push P), not earlier
// Real silicon: the I flag is set as part of the push-P micro-op.
// Crucially, even if BA-low stalls cycles 1-2 indefinitely, I stays 0
// until the push-P write completes. nine.prg's CLI/SEI tricks rely on
// I being committed ONLY at this exact cycle.
{
  const { cpu } = makeCpu();
  armIrqAtBoundary(cpu);
  // Stall cycles 1+2 (BA-low) by not clocking the reads.
  expect(cpu.I === 0, `pre-entry: I=0, got I=${cpu.I}`);
  // Run only the writes (cycles 3, 4, 5) — push P sets I=1.
  let advances = 0;
  for (let i = 0; i < 50 && advances < 3; i++) {
    if (cpu.peekNextBusKind() === 'write') {
      const iBefore = cpu.I;
      cpu.clock();
      advances++;
      if (advances === 3) {
        expect(cpu.I === 1, `I=1 must be set after push-P (cycle 5), got I=${cpu.I}`);
      } else {
        expect(iBefore === 0 && cpu.I === 0,
          `I stays 0 through push-PCH/PCL (cycles 3,4), got I=${cpu.I} after advance ${advances}`);
      }
    }
  }
  ok('IRQ entry: I=1 commits exactly at cycle 5 (push P), not earlier');
}

console.log(`\n${testNo} IRQ × BA-stall spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
