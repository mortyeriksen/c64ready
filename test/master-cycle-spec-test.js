// Master-cycle spec — drives the integration through C64Machine._runMasterCycle()
// rather than a custom test rig. Pins the symmetric BA model (Bauer §3.5
// strict reading): "RDY halts a read access. Writes are not affected."
// Both bad-line BA and sprite BA halt a read on the SAME cycle BA goes low.
//
// History: an earlier split-asymmetric model (sprite-BA stall delayed 1 cy
// via `_prevSpriteBaLow` gate) was hypothesized to match measured NMOS
// silicon, but breaks FppScroller and Nine. The OrbitUntold drift that
// motivated the asymmetric model was instead resolved by Bauer §3.12
// mid-line raster-IRQ firing. Under symmetric BA + the
// mid-line IRQ fix, all three demos pass.

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

function makeMachine() {
  const m = new C64Machine();
  m.reset();
  // Replace the VICE power-up RAM pattern with a NOP carpet so wherever the
  // CPU lands it stays on instruction boundaries we can reason about. NOP
  // ($EA) is queued as 2 read microops, so sprite-BA blocking applies on
  // every CPU bus cycle.
  m.mem.ram.fill(0xEA);
  // Park the CPU at $1000 in instruction-boundary state — bypasses the
  // 7 internal-op reset prologue (those don't have read kind, which would
  // skew the BA-stall observations below).
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  return m;
}

function cpuStateTuple(cpu) {
  return `${cpu.pc}:${cpu.instructionCyclesRemaining}:${cpu.microOpHead}`;
}

function driveTo(m, raster, cycle) {
  let safety = 200000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveTo timed out at L${m.vic2.raster}.c${m.vic2.cycleInLine}`);
}

// ── 1: sprite-BA stalls reads same-cycle (Bauer §3.5 strict reading) ────
// Bauer §3.5: "RDY halts a read access. Writes are not affected." The
// strict reading is symmetric — sprite-BA AND bad-line BA both halt reads
// on the very cycle BA goes low. The "in-flight read completes" refinement
// is not in Bauer or VIC-Addendum.txt. With mid-line raster-IRQ firing
// (Bauer §3.12)
// OU's IRQ chain locks under symmetric BA — the earlier split-asymmetric
// model was compensating for a missing IRQ-firing mechanism, not modeling
// a real silicon quirk.
{
  const m = makeMachine();
  m.vic2.spriteDmaOn[0] = 1;            // pre-seed DMA so BA window manifests

  driveTo(m, 10, 54);                    // raster 10 (well clear of any bad-line range)
  expect(m.vic2.isSpriteBaLow() === false, `pre-c55: vic.isSpriteBaLow false`);

  // Cycle 55: spriteBaLow flips true → CPU read stalls same-cycle.
  const before55 = cpuStateTuple(m.cpu);
  C64Machine.prototype._runMasterCycle.call(m);
  expect(m.vic2.cycleInLine === 55, `advanced to cycle 55`);
  expect(m.vic2.isSpriteBaLow() === true, `c55: sprite BA low`);
  expect(cpuStateTuple(m.cpu) === before55,
    `c55: CPU blocked on first sprite-BA-low cycle (symmetric, Bauer §3.5)`);

  // Cycle 56: sprite BA still low → still blocked.
  const before56 = cpuStateTuple(m.cpu);
  C64Machine.prototype._runMasterCycle.call(m);
  expect(m.vic2.cycleInLine === 56, `advanced to cycle 56`);
  expect(m.vic2.isSpriteBaLow() === true, `c56: sprite BA still low`);
  expect(cpuStateTuple(m.cpu) === before56,
    `c56: CPU blocked (BA still low)`);

  ok('sprite-BA stalls reads same-cycle (symmetric BA, Bauer §3.5)');
}

// ── 2: bad-line BA blocks read same-cycle (no _prev gate) ──────────────
// Bad-line BA halts reads on the very cycle BA goes low — preserves the
// 43-cycle bad-line window Bauer §3.6.1 specifies. Stable-IRQ rasterbar
// demos depend on this exact timing.
{
  const m = makeMachine();
  // Enable bad lines: DEN=1, RSEL=1, YSCROLL=3 → bad line at any raster
  // ≥ $30 where (raster & 7) === 3. We'll use raster $33.
  m.vic2.regs[0x11] = 0x1B;
  m.vic2.displayEnabled = true;
  // Lock raster bit-7 / RST8 stays in $D011 above. No sprite DMA.

  driveTo(m, 0x33, 11);                  // raster $33 = 51 → bad line; cycle 11 is just before BA goes low
  expect(m.vic2.isBaLow() === false, `pre-c12: BA still high`);
  expect(m.vic2.isSpriteBaLow() === false, `pre-c12: not a sprite-BA case`);

  // Cycle 12: bad-line BA goes low (no sprite component → badLineBaLow path).
  // Read MUST be blocked the same cycle, no _prev gate.
  const before12 = cpuStateTuple(m.cpu);
  C64Machine.prototype._runMasterCycle.call(m);
  expect(m.vic2.cycleInLine === 12, `advanced to cycle 12`);
  expect(m.vic2.isBaLow() === true && m.vic2.isSpriteBaLow() === false,
    `c12: bad-line BA low (sprite-BA still high) — got baLow=${m.vic2.isBaLow()} spriteBaLow=${m.vic2.isSpriteBaLow()}`);
  expect(cpuStateTuple(m.cpu) === before12,
    `c12: CPU blocked on first bad-line BA cycle (no delay for the bad-line path) — got ${cpuStateTuple(m.cpu)}`);

  ok('bad-line BA blocks read same-cycle (matches sprite-BA path under NMOS RDY)');
}

// ── 3: CIA timer reads expose the CPU phi2 value ──────────────────────
// MOS6526: the data bus is driven during phi2 reads, and the interval
// timers count phi2 pulses. The machine integration clocks CIA internals
// before the CPU phase so IRQ pins are available at opcode boundaries, but
// $DC04-$DC07 reads must still return the counter value latched for the CPU
// bus phase of that same master cycle.
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD;             // LDA $DC04
  m.mem.ram[0x1001] = 0x04;
  m.mem.ram[0x1002] = 0xDC;
  m.cia1.timerA = 0x0023;
  m.cia1.latchA = 0x003f;
  m.cia1.cra = 0x01;                   // Timer A counts phi2

  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cia1.timerA === 0x001f,
    `precondition: Timer A decremented over 4 master cycles to $001f, got $${m.cia1.timerA.toString(16)}`);
  expect(m.cpu.a === 0x20,
    `LDA $DC04 must see Timer A low byte from CPU phi2 read window ($20), got $${m.cpu.a.toString(16)}`);

  m.cpu.pc = 0x1100;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.ram[0x1100] = 0xAD;             // LDA $DC06
  m.mem.ram[0x1101] = 0x06;
  m.mem.ram[0x1102] = 0xDC;
  m.cia1.timerA = 0x0100;               // keep Timer A away from underflow
  m.cia1.timerB = 0x0044;
  m.cia1.latchB = 0x003f;
  m.cia1.crb = 0x01;                   // Timer B counts phi2

  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cia1.timerB === 0x0040,
    `precondition: Timer B decremented over 4 master cycles to $0040, got $${m.cia1.timerB.toString(16)}`);
  expect(m.cpu.a === 0x41,
    `LDA $DC06 must see Timer B low byte from CPU phi2 read window ($41), got $${m.cpu.a.toString(16)}`);

  ok('CIA timer counter reads use the CPU phi2 read window');
}

// ── 4: IRQ is NOT sampled while RDY/AEC holds an opcode boundary ──────
// Bauer: "IRQs are only recognized if RDY is high." While RDY/AEC blocks
// the CPU, we must NOT refresh sampledIrq from the live pin — doing so
// would let the CPU accept an IRQ immediately on release that real
// silicon wouldn't have sampled until a later CPU cycle. IRQ sampling
// resumes when cpu.clock() resumes, so the AEC-release boundary's first
// cycle samples the pin, the next boundary check accepts.
{
  const m = makeMachine();
  m.mem.ram[0xFFFE] = 0x00;
  m.mem.ram[0xFFFF] = 0x90;
  m.cpu.pc = 0x1000;
  m.cpu.I = 0;
  m.cpu.sampledIrq = false;
  m.cpu.setIrqLine(true);
  // Asymmetric IRQ pipeline (2026-05-20): VIC 1-cy, CIA 2-cy, NMI 2-cy.
  // _sampleCpuInterrupts applies _cpuVicIrqPending + _cpuCiaIrqStaged to
  // cpu.irqLine each master cycle. Set VIC pending so the pipeline
  // preserves IRQ line state (= 1-cy direct propagation for VIC).
  m._cpuVicIrqPending = true;
  m.vic2.isAecLow = () => true;
  m.vic2.isAecLowPhi2 = () => true;

  const before = cpuStateTuple(m.cpu);
  C64Machine.prototype._runMasterCycle.call(m);
  expect(cpuStateTuple(m.cpu) === before,
    `AEC-low boundary stall must not advance CPU state`);
  // The interrupt latch does NOT age through stalled cycles — hardware-proven by
  // testprogs/interrupts/irqdma real-C64 dumps (freeze = 0/16384 on every stall sweep).
  expect(m.cpu.sampledIrq === false,
    `AEC-low boundary stall keeps sampledIrq false (NOP-first; irqdma-proven latch freeze)`);

  m.vic2.isAecLow = () => false;
  m.vic2.isAecLowPhi2 = () => false;
  // After AEC release: the first cpu.clock() boundary check sees
  // sampledIrq=false (we did NOT refresh during the block). It decodes
  // a NOP (2 cy), samples the pin during NOP, then the NEXT boundary
  // accepts the IRQ. Total: 2 (NOP) + 7 (IRQ entry) = 9 master cycles.
  for (let i = 0; i < 9; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc === 0x9000,
    `after AEC release, NOP-first vectors to $9000 in 9 cycles; got $${m.cpu.pc.toString(16)}`);

  ok('AEC-held opcode boundary samples pending IRQ before release');
}

console.log(`\n${testNo} master-cycle integration spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
