// BA-low × RMW-abs phase interaction spec test.
//
// Bauer §3.6.1: BA-low halts CPU READ cycles. Writes proceed under BA-low
// for the first 3 cycles (BA-low → AEC-low warmup). Once AEC asserts (3
// cycles after BA-low onset), writes also stall.
//
// RMW abs (INC/DEC/etc.) is a 6-cycle sequence (per 6502):
//   1. opcode fetch        (read)
//   2. operand low         (read)
//   3. operand high        (read)
//   4. read EA             (read)
//   5. dummy write old val (write)
//   6. real write new val  (write)
//
// Demo path observation (3AD): handler entering at cy 49 of line N gives
// an 84-cycle path to first $D020 store; entering at cy 51 gives 85 cycles.
// 1-cycle differential suggests an off-by-one in how our impl meters RMW
// writes against the BA→AEC warmup window.
//
// Expected behavior (Bauer-spec): for an RMW abs starting at cycle K where
// the sprite-DMA BA-low window onset is at cycle M (with AEC-low onset at
// M+3), the instruction completes:
//
//   K ≤ M-6:              completes at K+5 (no BA interaction)
//   M-5 ≤ K ≤ M-1:        cycles 1-4 (reads) ALL before M; cycles 5-6
//                          (writes) might land in BA-low + AEC-high window;
//                          NO stall (writes proceed under AEC-high).
//                          completes at K+5.
//   K = M:                cycle 1 (read) stalls. Wait BA-high.
//   K > M, < M+window:    early cycles stall.
//
// The critical comparison: RMW starting at M-1 (last cycle before BA-low)
// vs M-3 (3 cycles before): both should complete at K+5 (zero added stall)
// per spec. If our impl adds 1 cycle to one phase, that's the bug.

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

// Synthetic harness: drive a CPU + scripted BA/AEC contour. The "VIC" is
// replaced by a per-cycle script that decides whether BA is low and whether
// the next CPU step proceeds.
//
//   - BA-low at cycles [m_start, m_end] (inclusive)
//   - AEC-low at cycles [m_start+3, m_end] (Bauer 3-cycle warmup)
//   - CPU read cycles stall under BA-low; CPU write cycles stall only
//     under AEC-low (= BA-low for >= 3 consecutive cycles).
//
// Returns the global cycle at which `cpu.atInstructionBoundary()` is true
// AFTER the RMW completes.
function runRmwUnderBa(rmwStartCycle, baStartCycle, baEndCycle) {
  const mem = new FlatMemory();
  // Build a program at $0400 that lands the first byte of INC $CFFF
  // at exactly rmwStartCycle. After 7 reset cycles, global cycle is 7
  // (CPU at first instruction boundary). Pad with NOPs (2 cyc) and BIT zp
  // (3 cyc) so that total padding = rmwStartCycle - 7. Solve 2N + 3B = D.
  if (rmwStartCycle < 7) throw new Error(`rmwStartCycle ${rmwStartCycle} must be ≥7`);
  const D = rmwStartCycle - 7;
  if (D === 1) throw new Error(`rmwStartCycle 8 unreachable (need D≥0 with D=2N+3B; D=1 impossible)`);
  // Pick B = D % 2 (0 or 1), so D - 3B is even → N = (D - 3B) / 2.
  // But D=1 fails (B=1 gives -2, N=-1). Handled above. For D ≥ 2:
  let B, N;
  if (D % 2 === 0) { B = 0; N = D / 2; }
  else             { B = 1; N = (D - 3) / 2; }
  if (N < 0 || B < 0) throw new Error(`cannot construct padding for D=${D}`);
  let pc = 0x0400;
  for (let i = 0; i < B; i++) { mem.ram[pc++] = 0x24; mem.ram[pc++] = 0x00; }
  for (let i = 0; i < N; i++) { mem.ram[pc++] = 0xEA; }
  const incAddr = pc;
  mem.ram[incAddr] = 0xEE; mem.ram[incAddr+1] = 0xFF; mem.ram[incAddr+2] = 0xCF;  // INC $CFFF
  mem.ram[incAddr+3] = 0xEA;
  mem.ram[incAddr+4] = 0xEA;
  // Reset vector → $0400
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();    // consume reset

  // Drive the CPU cycle-by-cycle, applying BA/AEC stall rules.
  let globalCy = 7;
  let incFinishedAt = null;
  const MAX = 200;
  while (globalCy < MAX) {
    const baLow = globalCy >= baStartCycle && globalCy <= baEndCycle;
    const aecLow = baLow && globalCy >= baStartCycle + 3;
    const nextKind = cpu.peekNextBusKind();
    const blocked = aecLow || (baLow && nextKind === 'read');
    if (!blocked) {
      const pcBefore = cpu.pc;
      cpu.clock();
      // Detect INC completion: we executed cycle 6 of the INC sequence.
      // Simplest check: after running, PC has advanced past the INC's 3
      // bytes AND we're at an instruction boundary.
      if (cpu.atInstructionBoundary() && cpu.pc === incAddr + 3 && incFinishedAt === null) {
        incFinishedAt = globalCy;   // global cycle at end of INC's last micro-op
      }
    }
    globalCy++;
    if (incFinishedAt !== null) break;
  }
  return incFinishedAt;
}

// ── 1: Baseline — RMW abs completes in 6 cycles when no BA window ─
{
  // BA-low window far in the future; RMW starts at cy 9 and should finish
  // at cy 9+5 = 14.
  const finished = runRmwUnderBa(9, 9999, 9999);
  expect(finished === 14,
    `RMW abs with no BA stall starting at cy 9 must finish at cy 14, got ${finished}`);
  ok('baseline: INC abs takes exactly 6 cycles with no BA interaction');
}

// ── 2: RMW start = M-5 — all 4 reads complete BEFORE BA-low onset ──
// BA-low onset at cy M. RMW starting at K=M-5 has reads at K,K+1,K+2,K+3
// = M-5, M-4, M-3, M-2 (all before M). Writes at K+4, K+5 = M-1, M (one
// before, one AT BA-low). Both writes should proceed (AEC is high at M
// and M+1; AEC asserts only at M+3).
//
// Expected completion: K+5 = M (no stall).
{
  const M = 55;
  const finished = runRmwUnderBa(M - 5, M, M + 18);     // start cy 50, BA 55..73
  expect(finished === M,
    `RMW starting at M-5 must complete at M=${M} (zero stall, write under AEC-high), got ${finished}`);
  ok(`RMW abs at M-5 (start cy ${M-5}, BA-low at ${M}): completes at M=${M}, no stall`);
}

// ── 3: RMW start = M-3 — last 2 reads AND both writes hit BA-low+AEC-high
// Reads at K,K+1,K+2,K+3 = M-3,M-2,M-1,M. Last read (cy 4 of INC) is AT
// BA-low onset (cycle M). That read must stall. Writes (cy 5,6) come after.
//
// Per Bauer: any read at BA-low cycle stalls. So cycle 4 (read EA) stalls.
// After BA released, CPU resumes — reads continue, then writes. But wait —
// the stall must wait until BA goes high. BA goes high at baEndCycle+1.
//
// Expected: completion much later (after BA window ends + remaining cycles).
{
  const M = 55, baEnd = 72;          // BA window cy 55..72, BA-high from cy 73
  const finished = runRmwUnderBa(M - 3, M, baEnd);   // start cy 52
  // Pure-instruction = K+5 = 57. But cycle 4 (read EA) at cy 55 stalls.
  // Stall duration = baEnd+1 - M = 73-55 = 18 cycles. Then cycle 4 resumes
  // at cy 73. Cycles 4,5,6 at cy 73,74,75. Completes at cy 75.
  expect(finished === 75,
    `RMW at M-3 (start cy 52): read EA at cy 55 stalls until cy 73, completes at cy 75. Got ${finished}`);
  ok(`RMW abs at M-3 (start cy 52, BA-low 55..72): read stalls, completes at cy 75`);
}

// ── 4: RMW start = M-2 — last read JUST BEFORE BA, writes hit BA-low
// Reads at M-2, M-1, M, M+1. Wait — reads cy 1..4 are at K..K+3 = 53..56.
// So reads at cy 55, 56 stall (BA-low). Writes at cy 5,6 = K+4, K+5 = 57, 58.
//
// Expected: cycle 3 (operand high) at cy 55 stalls. Resumes at cy 73.
// Cycles 3,4,5,6 at cy 73,74,75,76. Completes at cy 76.
{
  const M = 55, baEnd = 72;
  const finished = runRmwUnderBa(M - 2, M, baEnd);   // start cy 53
  expect(finished === 76,
    `RMW at M-2 (start cy 53): operand-high read at cy 55 stalls until cy 73, completes at cy 76. Got ${finished}`);
  ok(`RMW abs at M-2: reads stall at BA-low onset, completes at cy 76`);
}

// ── 5: RMW start = M-1 — only the operand-low read coincides with BA-low
{
  const M = 55, baEnd = 72;
  const finished = runRmwUnderBa(M - 1, M, baEnd);   // start cy 54
  // Reads cy 1,2,3,4 at cy 54,55,56,57. Cycle 2 (operand low) at cy 55
  // stalls. Resumes cy 73. Cycles 2,3,4,5,6 at cy 73,74,75,76,77. Completes 77.
  expect(finished === 77,
    `RMW at M-1 (start cy 54): operand-low read at cy 55 stalls, completes at cy 77. Got ${finished}`);
  ok(`RMW abs at M-1: completes at cy 77`);
}

// ── 6: RMW start = M — opcode-fetch read coincides with BA-low onset
{
  const M = 55, baEnd = 72;
  const finished = runRmwUnderBa(M, M, baEnd);       // start cy 55
  // Cycle 1 (opcode fetch) at cy 55 stalls. Resumes cy 73. Cycles 1-6 at
  // cy 73-78. Completes 78.
  expect(finished === 78,
    `RMW at M (start cy 55): opcode-fetch stalls, completes at cy 78. Got ${finished}`);
  ok(`RMW abs at M: full 6-cycle stall + execute, completes at cy 78`);
}

console.log(`\n${testNo} BA × RMW-abs phase tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
