// NMOS 6502/6510 interrupt hijacking — the cycle window in which a /NMI takes
// over an IRQ or BRK sequence.
//
// Spec (NESdev "CPU interrupts", Interrupt hijacking): the 7-cycle BRK/IRQ
// sequence decides its vector after cycle 4 from the NMI edge detector's
// internal signal. Asserting /NMI during the first four ticks of the sequence
// makes it branch to the NMI vector ($FFFA) instead of the IRQ/BRK vector
// ($FFFE); asserted later, the IRQ/BRK vector stands and the NMI is taken
// after the first instruction of that handler. The edge detector polls /NMI
// during phi2 and raises its internal signal in phi1 of the following cycle,
// so an assertion in tick k is visible to the CPU from tick k+1: the hijacking
// edges are the ones presented in cycles 2-5, and cycle 6 is too late. VICE's
// 6510core.c encodes the same rule: after five sequence cycles it checks
// CLK >= nmi_clk + INTERRUPT_DELAY (2), i.e. nmi_clk within the first four.
//
// The machine presents an NMI edge to the CPU at the top of a cycle
// (setNmiLine → nmiEdge), which is what `setLines(cy)` does here just before
// clock() of that cycle. Matrix: present the edge in each cycle 1-7 of an IRQ
// sequence and of a BRK sequence, and check which vector is fetched and, when
// the IRQ/BRK vector stands, that the NMI follows the handler's first
// instruction.

import { CPU } from '../src/cpu.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`); currentFailures = [];
  }
}

class FlatMem {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xffff]; }
  write(a, v) { this.ram[a & 0xffff] = v & 0xff; }
}

// Program at $1000: NOPs, or a BRK when `brk` is set. IRQ/BRK vector → $2000,
// NMI vector → $3000; both handlers are NOPs so the fetched vector shows as
// the page the PC lands in.
function makeCPU(brk) {
  const m = new FlatMem();
  for (let a = 0x1000; a < 0x1020; a++) m.ram[a] = 0xEA;
  if (brk) m.ram[0x1000] = 0x00;
  for (let a = 0x2000; a < 0x2020; a++) m.ram[a] = 0xEA;
  for (let a = 0x3000; a < 0x3020; a++) m.ram[a] = 0xEA;
  m.ram[0xFFFE] = 0x00; m.ram[0xFFFF] = 0x20;
  m.ram[0xFFFA] = 0x00; m.ram[0xFFFB] = 0x30;
  const cpu = new CPU(m);
  cpu.reset();
  for (let i = 0; i < 8; i++) cpu.clock();
  cpu.pc = 0x1000; cpu.I = 0;
  cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  cpu.sampledIrq = cpu.sampledIrqPrev = cpu.sampledIrqLate = cpu.sampledIrqLatePrev = false;
  cpu.sampledNmiEdge = cpu.sampledNmiEdgePrev = false;
  cpu.irqLine = false; cpu.nmiEdge = false; cpu._pollI = cpu.I;
  cpu._branchIrqNoCrossDelay = false; cpu._branchNmiNoCrossDelay = false;
  return cpu;
}

// Run 40 cycles. `setLines(cy, cpu)` runs just before clock() of cycle cy
// (1-based). Records every boundary accept (source that started a sequence,
// with its cycle), every committed vector, and the first handler page entered.
function run(brk, setLines) {
  const cpu = makeCPU(brk);
  const accepts = [], commits = [];
  let cycle = 0, firstPage = null;
  cpu.onInterruptAccept = kind => accepts.push({ kind, cycle });
  cpu.onInterruptVectorCommit = kind => commits.push({ kind, cycle });
  for (cycle = 1; cycle <= 40; cycle++) {
    setLines(cycle, cpu);
    cpu.clock();
    const pc = cpu.pc;
    if (firstPage === null) {
      if (pc >= 0x2000 && pc < 0x2020) firstPage = 'irq';
      else if (pc >= 0x3000 && pc < 0x3020) firstPage = 'nmi';
    }
  }
  return { accepts, commits, firstPage };
}

// IRQ: raise the line at cycle 1; with a 2-cycle NOP in flight the sequence
// starts at a fixed boundary S (read off the control run). BRK: the opcode at
// $1000 is fetched in cycle 1, so S = 1.
const irqCtrl = run(false, (cy, cpu) => { if (cy >= 1) cpu.irqLine = true; });
const S_IRQ = irqCtrl.accepts[0]?.cycle;
const S_BRK = 1;

function seqCase(brk, S, k) {
  // Present the NMI edge at the top of sequence cycle k (and keep it, as the
  // machine's sticky edge does until it is consumed).
  return run(brk, (cy, cpu) => {
    if (!brk && cy >= 1) cpu.irqLine = true;
    if (cy === S + k - 1) cpu.nmiEdge = true;
  });
}

for (const brk of [false, true]) {
  const S = brk ? S_BRK : S_IRQ;
  const what = brk ? 'BRK' : 'IRQ';
  // Cycles 1-5: the edge is visible before the vector decision → hijack.
  for (let k = 1; k <= 5; k++) {
    const r = seqCase(brk, S, k);
    expect(r.firstPage === 'nmi', `${what}: /NMI edge presented in sequence cy${k} must hijack the vector to $FFFA (NESdev: asserted during the first four ticks); landed in ${r.firstPage} handler`);
    expect(r.commits[0]?.kind === 'nmi', `${what} cy${k}: committed vector must be the NMI vector; got ${r.commits[0]?.kind}`);
    expect(r.accepts.filter(a => a.kind === 'nmi').length === 0, `${what} cy${k}: a hijacking NMI is absorbed by the sequence, not taken again as a separate NMI`);
    ok(`${what} sequence: /NMI edge presented cy${k} → hijack to $FFFA, edge consumed`);
  }
  // Cycles 6-7: too late for the vector decision → IRQ/BRK vector stands and
  // the NMI follows the handler's first instruction (the 2-cycle NOP at $2000).
  for (let k = 6; k <= 7; k++) {
    const r = seqCase(brk, S, k);
    expect(r.firstPage === 'irq', `${what}: /NMI edge presented in sequence cy${k} is after the vector decision, so the $FFFE vector stands (NESdev: hijack only during the first four ticks); landed in ${r.firstPage} handler`);
    expect(r.commits[0]?.kind === 'irq', `${what} cy${k}: committed vector must be the IRQ/BRK vector; got ${r.commits[0]?.kind}`);
    const nmi = r.accepts.find(a => a.kind === 'nmi');
    expect(!!nmi, `${what} cy${k}: the late NMI must still be taken`);
    expect(nmi && nmi.cycle === S + 7 + 2, `${what} cy${k}: the late NMI is taken at the boundary after the handler's first instruction (cy${S + 9}); got cy${nmi && nmi.cycle}`);
    ok(`${what} sequence: /NMI edge presented cy${k} → $FFFE stands, NMI taken after the handler's first instruction`);
  }
}

console.log(`\n${testNo} interrupt hijack window spec tests; ${testsFailing} fail`);
process.exit(testsFailing ? 1 : 0);
