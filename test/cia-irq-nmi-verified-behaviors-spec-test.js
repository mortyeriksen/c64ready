// Locks behaviors verified against real-HW oracles during the IRQ/CIA/NMI
// chain audit. Previously these were only confirmed by one-off harnesses; this
// pins them so a future timing change can't silently regress them.
//   1. Sprite-steal × interrupt deferral: an IRQ asserting during a sprite-DMA
//      (BA/AEC) steal is DEFERRED — the /IRQ line asserts but the AEC-frozen CPU
//      does not sample it until the steal ends, then takes it cleanly.
//   2. NMI delivery is SYMMETRIC with IRQ (post the _nmiSameCycle removal,
//      main f63090e): identical Timer-A underflow → interrupt-entry latency.
//   3. ICR ($DC0D) read value vs the Timer-A underflow sub-cycle: $00 before,
//      $01 (data, IR not yet latched — the ack-bug) ON the underflow cycle,
//      $81 (IR latched) the cycle after. (cia-int $Dx0D row matches real HW.)
import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { CIA } from '../src/cia.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`); currentFailures = []; }
}

const ROMS = { kernal: fs.readFileSync('roms/kernal.bin'), basic: fs.readFileSync('roms/basic.bin'), charRom: fs.readFileSync('roms/chargen.bin') };
const STEP = C64Machine.prototype._runMasterCycle;

// Minimal machine running a $C000 self-loop, $9000 handler, RAM IRQ/NMI vectors,
// KERNAL's 60Hz CIA1 IRQ killed. (Ported from sprite-steal-irq-trace.mjs.)
function bootBare(withSprites) {
  const m = new C64Machine();
  m.loadROMs({ kernal: Buffer.from(ROMS.kernal), basic: Buffer.from(ROMS.basic), charRom: Buffer.from(ROMS.charRom) });
  m.reset();
  for (let i = 0; i < 90; i++) m.runFrame();
  const ram = m.mem.ram;
  m.mem.write(0x01, 0x35);                          // RAM at $FFFE/$FFFA
  ram[0x9000] = 0xAD; ram[0x9001] = 0x0D; ram[0x9002] = 0xDC;   // LDA $DC0D (ack)
  ram[0x9003] = 0x4C; ram[0x9004] = 0x00; ram[0x9005] = 0x90;   // JMP $9000
  ram[0xC000] = 0x4C; ram[0xC001] = 0x00; ram[0xC002] = 0xC0;   // JMP $C000
  ram[0xFFFE] = 0x00; ram[0xFFFF] = 0x90; ram[0xFFFA] = 0x00; ram[0xFFFB] = 0x90;
  if (withSprites) { m.mem.write(0xD015, 0xFF); for (let s = 0; s < 8; s++) { m.mem.write(0xD000 + s*2, 0x18 + s*0x18); m.mem.write(0xD001 + s*2, 100); } ram[0xD011] = 0x1B; }
  m.mem.write(0xDC0D, 0x7F); m.mem.write(0xDC0E, 0x00);   // kill KERNAL CIA1 IRQ
  return m;
}
function reseatCpu(m) {
  const cpu = m.cpu;
  m.cia1.icrStatus = 0; m.cia1._irLatch = false; m.cia1._irNextPending = false; m.cia1._irAckRaceDelay = 0; m.cia1.cra = 0;
  m._cpuCiaIrqPending = false; m._cpuVicIrqPending = false; m._cpuVicIrqPrev = false; m._cpuNmiEdgeSeen = false; m._cpuNmiPending = false;
  cpu.irqLine = false; cpu.nmiLine = false; cpu.nmiEdge = false; cpu.sampledIrq = false; cpu.sampledIrqPrev = false;
  cpu._pollI = 0;
  cpu.pc = 0xC000; cpu.instructionCyclesRemaining = 0; cpu.microOpLen = 0; cpu.microOpHead = 0; cpu.I = 0;
}

// ── 1: Sprite-steal × IRQ deferral ──────────────────────────────────────
// An IRQ that asserts while a sprite DMA holds the CPU off the bus (AEC low)
// must NOT be sampled until the steal releases — then it is taken cleanly.
{
  const m = bootBare(true); const cpu = m.cpu, vic = m.vic2;
  let g = 30000; while (!(vic.raster === 99 && vic.cycleInLine === 1) && --g) STEP.call(m);
  reseatCpu(m);
  m.mem.write(0xDC04, 118); m.mem.write(0xDC05, 0);   // underflow lands in the AEC steal (cy58-62)
  m.mem.write(0xDC0D, 0x81); m.mem.write(0xDC0E, 0x11);
  let deferredCy = false, entry = false, irqUpDuringSteal = false;
  const origE = cpu._queueInterruptMicroOps.bind(cpu);
  cpu._queueInterruptMicroOps = function (v, n) { entry = true; return origE(v, n); };
  for (let i = 0; i < 4000 && !entry; i++) {
    const aec = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : false;
    if (aec && cpu.irqLine && !cpu.sampledIrq) { irqUpDuringSteal = true; deferredCy = true; }
    STEP.call(m);
  }
  expect(irqUpDuringSteal, '/IRQ asserts during the AEC steal but the frozen CPU has not sampled it (deferred)');
  expect(entry, 'IRQ is taken once the steal releases (deferral, not loss)');
  ok('sprite-steal × IRQ: interrupt deferred while AEC-frozen, taken on release');
}

// ── 2: NMI delivery symmetric with IRQ ──────────────────────────────────
function measureLatency(useNmi) {
  const m = bootBare(false); const cpu = m.cpu, vic = m.vic2;
  reseatCpu(m);
  const cia = useNmi ? m.cia2 : m.cia1, base = useNmi ? 0xDD00 : 0xDC00;
  m.mem.write(base + 0x0E, 0x00); m.mem.write(base + 0x04, 0x40); m.mem.write(base + 0x05, 0x00);
  m.mem.write(base + 0x0D, 0x81); m.mem.write(base + 0x0E, 0x11);
  let cyc = 0, uf = -1, entry = -1;
  const oR = cia._raiseIcr.bind(cia); cia._raiseIcr = function (b) { if ((b & 1) && uf < 0) uf = cyc; return oR(b); };
  const oE = cpu._queueInterruptMicroOps.bind(cpu); cpu._queueInterruptMicroOps = function (v, n) { if (entry < 0 && uf >= 0) entry = cyc; return oE(v, n); };
  for (cyc = 0; cyc < 4000 && entry < 0; cyc++) STEP.call(m);
  return entry - uf;
}
{
  const irq = measureLatency(false), nmi = measureLatency(true);
  expect(irq > 0, `IRQ latency measured (got ${irq})`);
  expect(nmi === irq, `NMI underflow→entry latency must EQUAL the IRQ's (symmetric); IRQ=${irq} NMI=${nmi}`);
  ok(`NMI delivery symmetric with IRQ (both ${irq}cy underflow→entry, no _nmiSameCycle early delivery)`);
}

// ── 3: ICR ($DC0D) read value vs Timer-A underflow sub-cycle ─────────────
function armed(latch) {
  const c = new CIA(1); c.irqHandler = () => {};
  c.write(0x04, latch & 0xff); c.write(0x05, (latch >> 8) & 0xff);
  c.write(0x0D, 0x81); c.write(0x0E, 0x11);
  return c;
}
function toUnderflow(c) { for (let i = 0; i < 200; i++) { const b = c.icrStatus & 1; c.clock(1); if (!b && (c.icrStatus & 1)) return; } }
{
  // before underflow → $00
  const cB = armed(5); let n = 0; { const p = armed(5); for (; n < 200; n++) { const b = p.icrStatus & 1; p.clock(1); if (!b && (p.icrStatus & 1)) break; } }
  for (let i = 0; i < n; i++) cB.clock(1);                       // stop 1 short of the underflow
  expect((cB.read(0x0D) & 0x81) === 0x00, 'read BEFORE underflow returns $00');
  // on the underflow cycle → $01 (data set, IR not yet latched: the ack-bug)
  const c0 = armed(5); toUnderflow(c0);
  expect(c0.read(0x0D) === 0x01, 'read ON the underflow cycle returns $01 (data, IR not latched — ack-bug)');
  // one cycle later → $81 (IR latched)
  const c1 = armed(5); toUnderflow(c1); c1.clock(1);
  expect(c1.read(0x0D) === 0x81, 'read +1 cycle after underflow returns $81 (IR latched = clean ack)');
  ok('ICR $DC0D read value vs underflow sub-cycle: $00 → $01(ack-bug) → $81');
}

console.log(`\n${testNo} verified IRQ/CIA/NMI behavior locks; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
