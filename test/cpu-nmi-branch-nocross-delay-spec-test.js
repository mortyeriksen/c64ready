// NMOS 6502/6510 branch-no-cross interrupt delay — NMI accept-cycle matrix.
//
// A taken branch with NO page cross polls interrupts at the END of branch
// cycle 2 (one cycle EARLIER than the usual penultimate poll). Whether that
// early poll caught a pending interrupt is decided PER SOURCE:
//   IRQ:  sampledIrqPrev && !sampledIrqLatePrev
//   NMI:  sampledNmiEdgePrev          (the NMI edge already visible last cycle)
// If the early poll missed the source, that source is delayed one extra
// instruction boundary (_branchIrqNoCrossDelay / _branchNmiNoCrossDelay).
//
// This pins the per-source split (cpu.js _queueBranchMicroOps + the
// sampledNmiEdge/sampledNmiEdgePrev sampling in clock()). Before the split a
// shared flag set the NMI delay from IRQ-only early-poll state, mis-phasing NMI
// acceptance after taken non-crossing branches.
//
//   Case A: NMI visible 1 cycle BEFORE the final branch cycle → accepted at the
//           first post-branch boundary (NO delay).
//   Case B: NMI first visible ON the final branch cycle        → delayed one
//           instruction boundary.
//   Case C: IRQ visible before final, NMI first visible on final → our core
//           accepts the (non-delayed) IRQ at the boundary; the NMI is branch-
//           delayed. KNOWN GAP documented below.

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

class LogMem {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xffff]; }
  write(a, v) { this.ram[a & 0xffff] = v & 0xff; }
}

// Program at $1000: BNE +2 (taken when Z=0, no page cross) → $1004, then NOPs.
// IRQ vector → $2000, NMI vector → $3000. Both handler pages are NOPs so the
// ACTUAL fetched vector is observable as the PC region the CPU lands in (the
// boundary `onInterruptAccept` reports the source that STARTED the sequence; a
// mid-sequence hijack only shows up in the vector PC).
function makeCPU() {
  const m = new LogMem();
  m.ram[0x1000] = 0xD0; m.ram[0x1001] = 0x02;
  for (let a = 0x1002; a < 0x1020; a++) m.ram[a] = 0xEA;   // NOPs (2 cycles each)
  for (let a = 0x2000; a < 0x2020; a++) m.ram[a] = 0xEA;   // IRQ handler NOPs
  for (let a = 0x3000; a < 0x3020; a++) m.ram[a] = 0xEA;   // NMI handler NOPs
  m.ram[0xFFFE] = 0x00; m.ram[0xFFFF] = 0x20;              // IRQ/BRK → $2000
  m.ram[0xFFFA] = 0x00; m.ram[0xFFFB] = 0x30;              // NMI → $3000
  const cpu = new CPU(m);
  cpu.reset();
  for (let i = 0; i < 8; i++) cpu.clock();
  cpu.pc = 0x1000; cpu.I = 0; cpu.Z = 0;
  cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  cpu.sampledIrq = cpu.sampledIrqPrev = cpu.sampledIrqLate = cpu.sampledIrqLatePrev = false;
  cpu.sampledNmiEdge = cpu.sampledNmiEdgePrev = false;
  cpu.irqLine = false; cpu.nmiEdge = false; cpu._pollI = cpu.I;
  cpu._branchIrqNoCrossDelay = false; cpu._branchNmiNoCrossDelay = false;
  return cpu;
}

// `setLines(cy, cpu)` runs just BEFORE clock() cy (1-based from the branch
// opcode fetch). Returns { boundary:{kind,cycle}|null, vec:'irq'|'nmi'|null }:
// boundary = the source that STARTED a sequence (onInterruptAccept); vec = the
// vector actually fetched, detected as the handler page the PC enters.
function run(setLines) {
  const cpu = makeCPU();
  let cycle = 0, boundary = null, commit = null, vec = null;
  cpu.onInterruptAccept = (kind) => { if (!boundary) boundary = { kind, cycle }; };
  // onInterruptVectorCommit reports the ACTUAL vector fetched at cy6 (the hijack
  // distinction); cross-checked below against the handler page the PC enters.
  cpu.onInterruptVectorCommit = (kind) => { if (!commit) commit = kind; };
  for (cycle = 1; cycle <= 24 && !vec; cycle++) {
    setLines(cycle, cpu);
    cpu.clock();
    const pc = cpu.pc;
    if (pc >= 0x2000 && pc < 0x2020) vec = 'irq';
    else if (pc >= 0x3000 && pc < 0x3020) vec = 'nmi';
  }
  return { boundary, commit, vec };
}

// Control: NMI continuously visible (no early-poll miss) — establishes the
// "first post-branch boundary" cycle index for this fixed program.
const ctrl = run((cy, cpu) => { cpu.nmiEdge = true; });

// ── Case A: NMI visible 1 cycle before final branch cycle → no delay ─────────
{
  const a = run((cy, cpu) => { if (cy >= 2) cpu.nmiEdge = true; });
  expect(a.boundary && a.boundary.kind === 'nmi', `Case A: NMI must start the sequence, got ${a.boundary ? a.boundary.kind : 'none'}`);
  expect(a.vec === 'nmi', `Case A: NMI vector fetched, got ${a.vec}`);
  expect(a.boundary && ctrl.boundary && a.boundary.cycle === ctrl.boundary.cycle,
    `Case A: NMI accepted at the first post-branch boundary (cy${ctrl.boundary && ctrl.boundary.cycle}); got cy${a.boundary && a.boundary.cycle}`);
  ok('NMOS: branch-no-cross NMI visible before final cycle → accepted at next boundary (no delay)');
}

// ── Case B: NMI first visible ON the final branch cycle → delayed 1 boundary ─
{
  const b = run((cy, cpu) => { if (cy >= 3) cpu.nmiEdge = true; });
  expect(b.boundary && b.boundary.kind === 'nmi', `Case B: NMI must start the sequence, got ${b.boundary ? b.boundary.kind : 'none'}`);
  expect(b.vec === 'nmi', `Case B: NMI vector fetched, got ${b.vec}`);
  // Delayed past the immediate boundary by exactly one instruction (NOP = 2 cy).
  expect(b.boundary && ctrl.boundary && b.boundary.cycle === ctrl.boundary.cycle + 2,
    `Case B: NMI delayed one boundary (cy${ctrl.boundary && ctrl.boundary.cycle + 2}); got cy${b.boundary && b.boundary.cycle}`);
  ok('NMOS: branch-no-cross NMI first visible on final cycle → delayed one instruction boundary');
}

// ── Case C: IRQ before final, NMI on final → IRQ starts the sequence, NMI
// HIJACKS it. The IRQ was caught at the early poll (not branch-delayed) so it
// starts the sequence at the boundary; the NMI was missed at the early poll
// (branch-delayed) so it cannot start a sequence — but its edge is still
// pending and, per NMOS, redirects the in-flight sequence's cy6/7 vector fetch
// to $FFFA. So the BOUNDARY source is 'irq' yet the VECTOR fetched is the NMI
// handler ($3000). Verified cycle-band-exact against VICE, which hijacks the
// same window. This pins the hijack model (_seqSampleNmi / _seqResolveVector).
{
  const c = run((cy, cpu) => { if (cy >= 2) cpu.irqLine = true; if (cy >= 3) cpu.nmiEdge = true; });
  expect(c.boundary && c.boundary.kind === 'irq',
    `Case C: IRQ starts the sequence at the boundary (NMI branch-delayed); got ${c.boundary ? c.boundary.kind : 'none'}`);
  expect(c.vec === 'nmi',
    `Case C: the pending NMI HIJACKS the IRQ sequence → NMI vector ($3000) fetched; got vec=${c.vec}`);
  // The friend's exact distinction: boundary recognizer accepted IRQ, but the
  // committed vector is NMI. The onInterruptVectorCommit hook must report 'nmi'
  // and match the actually-fetched vector PC.
  expect(c.commit === 'nmi', `Case C: onInterruptVectorCommit must report the hijacked NMI vector; got ${c.commit}`);
  expect(c.commit === c.vec, `Case C: vectorCommit (${c.commit}) must match the fetched vector (${c.vec})`);
  expect(c.boundary && c.boundary.kind === 'irq' && c.commit === 'nmi', `Case C: boundaryAccept=irq, vectorCommit=nmi`);
  expect(c.boundary && ctrl.boundary && c.boundary.cycle === ctrl.boundary.cycle,
    `Case C: sequence starts at the first post-branch boundary (cy${ctrl.boundary && ctrl.boundary.cycle}); got cy${c.boundary && c.boundary.cycle}`);
  ok('NMOS: branch-no-cross IRQ(early)+NMI(late) → IRQ starts, pending NMI HIJACKS the vector to $FFFA');
}

// ── Case D: BRK with a /NMI asserting DURING the 7-cycle sequence → canonical
// NMOS hijack. The cy5 P-push (B=1, BRK signature) happens before the cy6
// vector decision, so a hijacked BRK fetches $FFFA yet still pushes B=1 (the
// NMI handler sees BRK-flagged status). Mirrors the BRK-based VICE oracle.
{
  const m = new LogMem();
  m.ram[0x1000] = 0x00; m.ram[0x1001] = 0xEA;             // BRK + signature byte
  for (let a = 0x1002; a < 0x1010; a++) m.ram[a] = 0xEA;
  for (let a = 0x2000; a < 0x2020; a++) m.ram[a] = 0xEA;  // BRK/IRQ handler ($FFFE)
  for (let a = 0x3000; a < 0x3020; a++) m.ram[a] = 0xEA;  // NMI handler ($FFFA)
  m.ram[0xFFFE] = 0x00; m.ram[0xFFFF] = 0x20;
  m.ram[0xFFFA] = 0x00; m.ram[0xFFFB] = 0x30;
  const cpu = new CPU(m);
  cpu.reset(); for (let i = 0; i < 8; i++) cpu.clock();
  cpu.pc = 0x1000; cpu.I = 0; cpu.sp = 0xFF;
  cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  cpu.nmiEdge = false; cpu.sampledNmiEdge = false; cpu.irqLine = false;
  let vec = null;
  for (let cy = 1; cy <= 14 && !vec; cy++) {
    if (cy === 3) cpu.nmiEdge = true;     // /NMI asserts mid-BRK-sequence (not at the boundary)
    cpu.clock();
    const pc = cpu.pc;
    if (pc >= 0x2000 && pc < 0x2020) vec = 'irq';
    else if (pc >= 0x3000 && pc < 0x3020) vec = 'nmi';
  }
  const pushedP = m.ram[0x01FD];          // cy5 push: $01FF=PCH,$01FE=PCL,$01FD=P
  expect(vec === 'nmi', `Case D (BRK+NMI): NMI vector hijacked, got vec=${vec}`);
  expect((pushedP & 0x10) === 0x10, `Case D: hijacked BRK still pushes B=1; pushed P=$${(pushedP || 0).toString(16)}`);
  ok('NMOS: BRK with /NMI mid-sequence → hijack to $FFFA, B=1 still pushed (BRK signature preserved)');
}

console.log(`\n${testNo} NMI branch-no-cross delay spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
