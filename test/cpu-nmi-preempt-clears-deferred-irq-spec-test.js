// Regression lock: a /NMI that PREEMPTS a committed CLI;SEI slip must consume
// the boundary WITHOUT leaking the slipped IRQ afterwards.
//
// The NMOS CLI;SEI quirk: with an IRQ pending and I=1, CLI;SEI lets exactly one
// IRQ through at SEI's boundary (the admitting poll ran during SEI with the
// poll-visible I still 0 from CLI). That slip is valid only when no /NMI
// intervenes: if a /NMI preempts that same boundary (NMI has priority), the
// slip must NOT survive as a stale IRQ after the NMI handler — the IRQ is
// re-evaluated state-sensitively (I=1 masks it). A leaked slip fires an extra
// stack frame that desyncs interleaved IRQ+NMI raster engines (Codeboys &
// Endians $177b KIL; Aloft disc-1/2). Under the poll-I pipeline model there is
// no persistent commit state — this locks the observable either way.
import { CPU } from '../src/cpu.js';

let fails = 0;
const expect = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); fails++; } };

class Mem {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xffff]; }
  write(a, v) { this.ram[a & 0xffff] = v & 0xff; }
}

function makeCPU() {
  const m = new Mem();
  m.ram[0x1000] = 0x58;                                    // CLI
  m.ram[0x1001] = 0x78;                                    // SEI (slip boundary after this)
  for (let a = 0x1002; a < 0x1040; a++) m.ram[a] = 0xEA;   // main: NOPs
  for (let a = 0x2000; a < 0x2020; a++) m.ram[a] = 0xEA;   // IRQ handler: NOPs
  for (let a = 0x3000; a < 0x3020; a++) m.ram[a] = 0xEA;   // NMI handler: NOPs
  m.ram[0xFFFE] = 0x00; m.ram[0xFFFF] = 0x20;              // IRQ/BRK -> $2000
  m.ram[0xFFFA] = 0x00; m.ram[0xFFFB] = 0x30;              // NMI     -> $3000
  const cpu = new CPU(m);
  cpu.reset();
  for (let i = 0; i < 8; i++) cpu.clock();
  cpu.pc = 0x1000; cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  cpu.sampledIrq = cpu.sampledIrqPrev = cpu.sampledIrqLate = cpu.sampledIrqLatePrev = false;
  cpu.sampledNmiEdge = cpu.sampledNmiEdgePrev = false;
  cpu.irqLine = false; cpu.nmiEdge = false;
  cpu._branchIrqNoCrossDelay = false; cpu._branchNmiNoCrossDelay = false;
  cpu.I = 1; cpu._pollI = 1;                               // masked; IRQ pending throughout
  cpu.setIrqLine(true); cpu.sampledIrq = true; cpu.sampledIrqPrev = true;
  return cpu;
}

// ── Control: with no /NMI, CLI;SEI lets exactly one IRQ slip at SEI's boundary.
{
  const cpu = makeCPU();
  cpu.clock(); cpu.clock();            // CLI
  cpu.clock(); cpu.clock();            // SEI
  expect(cpu.I === 1, `control: after SEI I=1`);
  let vec = null;
  for (let i = 0; i < 9 && !vec; i++) {
    cpu.clock();
    if (cpu.pc >= 0x2000 && cpu.pc < 0x2020) vec = 'irq';
  }
  expect(vec === 'irq', `control: CLI;SEI slip must vector the IRQ despite I=1 (got ${vec})`);
}

// ── /NMI at the slip boundary: NMI preempts; slipped IRQ must NOT leak after.
{
  const cpu = makeCPU();
  cpu.clock(); cpu.clock();            // CLI
  cpu.nmiEdge = true;                  // /NMI edge arrives during SEI —
  cpu.clock(); cpu.clock();            // SEI (rotation samples the edge)
  let vec = null;
  for (let i = 0; i < 12 && !vec; i++) {
    cpu.clock();
    if (cpu.pc >= 0x3000 && cpu.pc < 0x3020) vec = 'nmi';
    else if (cpu.pc >= 0x2000 && cpu.pc < 0x2020) vec = 'irq';
  }
  expect(vec === 'nmi', `/NMI must preempt the slip boundary (took ${vec})`);
  // After the NMI handler runs (NOP field, I=1 from the sequence), the slipped
  // IRQ must NOT fire — the line is re-evaluated state-sensitively and I=1
  // masks it. A leak here is the Codeboys/Aloft extra-stack-frame bug.
  let irqFired = false;
  for (let i = 0; i < 24; i++) { cpu.clock(); if (cpu.pc >= 0x2000 && cpu.pc < 0x2020) { irqFired = true; break; } }
  expect(!irqFired, 'slipped IRQ must not leak after the NMI handler (no extra frame)');
}

if (fails) { console.log(`\n${fails} assertion(s) FAILED`); process.exit(1); }
console.log('ok - /NMI preempt consumes the CLI;SEI slip without leaking it (Codeboys/Aloft $177b class)');
