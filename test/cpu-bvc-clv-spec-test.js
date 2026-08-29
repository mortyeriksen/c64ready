// test/cpu-bvc-clv-spec-test.js
//
// Spec tests for 6502 BVC + CLV + setOverflow (= SO pin) interaction.
// Sparkle's GCR-byte-read pattern relies on this triad:
//   $F4E1: BVC $F4E1   ; wait for V=1 (= byte-ready signal from drive controller)
//   $F4E3: CLV         ; clear V flag
//   $F4E4: LDA $1C01   ; read GCR byte
//
// If V isn't cleared by CLV, OR if setOverflow fires multiple times per
// signal, drive reads garbage / re-reads same byte. This was the suspect
// bug area while debugging the Aloft Sparkle loader.
//
// Spec (per Synertek/MOS 6502 datasheet):
//  - CLV: clears V flag. 2 cycles. No other side effects.
//  - BVC: branches if V=0. 2 cy not taken (V=1), 3 cy taken (V=0, no page cross), 4 cy taken+page cross.
//  - SO pin (= our setOverflow()): asynchronously sets V=1. Persists until cleared.

import { CPU } from '../src/cpu.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// Minimal bus: 64KB RAM
function buildBus() {
  const ram = new Uint8Array(65536);
  return {
    read: (addr) => ram[addr & 0xFFFF],
    write: (addr, val) => { ram[addr & 0xFFFF] = val & 0xFF; },
    _ram: ram,
  };
}

function buildCpu() {
  const bus = buildBus();
  const cpu = new CPU(bus);
  // Match cpu-test.js setup pattern: don't reset, just set PC/SP/P directly
  cpu.pc = 0x0200;
  cpu.sp = 0xFF;
  cpu.setP(0x20);  // no flags set (V=0, others=0); bit 5 always 1
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  return { cpu, bus };
}

function stepInstruction(cpu) {
  // CPU starts at boundary. Clock once to start instruction. Continue until
  // atInstructionBoundary returns true (= instruction complete).
  let cy = 0;
  do {
    cpu.clock();
    cy++;
  } while (!cpu.atInstructionBoundary() && cy < 20);
  return cy;
}

// 1. CLV clears V flag exactly once, no delayed effects.
{
  console.log('Spec[CPU]: CLV ($B8) clears V flag in 2 cycles, immediately visible...');
  const { cpu, bus } = buildCpu();
  bus._ram[0x0200] = 0xB8;  // CLV
  bus._ram[0x0201] = 0xEA;  // NOP
  cpu.setP(0x60);  // V=1
  assert(cpu.V === 1, 'baseline V=1');
  const cy = stepInstruction(cpu);
  assert(cpu.V === 0, `CLV cleared V (got V=${cpu.V})`);
  assert(cy === 2, `CLV takes exactly 2 cycles (got ${cy})`);
  // V stays 0 across subsequent instructions until set externally
  stepInstruction(cpu);  // NOP
  assert(cpu.V === 0, 'V remains 0 after CLV + NOP');
  console.log('ok  – CLV clears V in 2 cy with no delayed re-set');
}

// 2. setOverflow() sets V=1 immediately and persists until CLV.
{
  console.log('Spec[CPU]: setOverflow() sets V=1, persists across non-CLV instructions...');
  const { cpu, bus } = buildCpu();
  bus._ram[0x0200] = 0xEA;  // NOP
  bus._ram[0x0201] = 0xEA;  // NOP
  bus._ram[0x0202] = 0xEA;  // NOP
  cpu.setP(0x20);  // V=0
  cpu.setOverflow();
  assert(cpu.V === 1, 'setOverflow() set V=1 immediately');
  stepInstruction(cpu);
  assert(cpu.V === 1, 'V persists across NOP #1');
  stepInstruction(cpu);
  assert(cpu.V === 1, 'V persists across NOP #2');
  stepInstruction(cpu);
  assert(cpu.V === 1, 'V persists across NOP #3');
  console.log('ok  – setOverflow() V=1 persists until cleared');
}

// 3. BVC with V=0 → branch TAKEN. BVC with V=1 → branch NOT TAKEN.
{
  console.log('Spec[CPU]: BVC ($50) takes branch when V=0, falls through when V=1...');
  // BVC +2 (= skip 2 bytes after branch)
  const { cpu, bus } = buildCpu();
  bus._ram[0x0200] = 0x50;  // BVC
  bus._ram[0x0201] = 0x02;  // +2
  bus._ram[0x0202] = 0xEA;  // NOP (would be skipped if BVC taken)
  bus._ram[0x0203] = 0xEA;  // NOP
  bus._ram[0x0204] = 0xA9;  // LDA #imm (= "branch target")
  bus._ram[0x0205] = 0x55;
  cpu.setP(0x20);  // V=0
  const cy1 = stepInstruction(cpu);
  assert(cpu.pc === 0x0204, `BVC taken with V=0 → PC=$0204 (got $${cpu.pc.toString(16)})`);
  assert(cy1 === 3, `BVC taken takes 3 cy (got ${cy1})`);
  console.log('ok  – BVC V=0 → branch taken (3 cy)');

  // Now test BVC NOT taken (V=1)
  const { cpu: cpu2, bus: bus2 } = buildCpu();
  bus2._ram[0x0200] = 0x50;
  bus2._ram[0x0201] = 0x02;
  bus2._ram[0x0202] = 0xA9;  // LDA #imm
  bus2._ram[0x0203] = 0xAA;
  cpu2.V = 1;
  const cy2 = stepInstruction(cpu2);
  assert(cpu2.pc === 0x0202, `BVC not taken with V=1 → PC=$0202 (got $${cpu2.pc.toString(16)})`);
  assert(cy2 === 2, `BVC not taken takes 2 cy (got ${cy2})`);
  console.log('ok  – BVC V=1 → fall through (2 cy)');
}

// 4. Sparkle's exact byte-read pattern: BVC self / CLV / LDA $1C01.
//    Set V via setOverflow, then run instructions. After BVC + CLV + LDA,
//    V must be 0 and A must be the loaded value.
{
  console.log('Spec[CPU]: BVC self / CLV / LDA $1C01 — Sparkle GCR-byte-read pattern...');
  const { cpu, bus } = buildCpu();
  cpu.pc = 0xF4E1;
  bus._ram[0xF4E1] = 0x50;  // BVC -2
  bus._ram[0xF4E2] = 0xFE;  // -2 (loops to self)
  bus._ram[0xF4E3] = 0xB8;  // CLV
  bus._ram[0xF4E4] = 0xAD;  // LDA abs
  bus._ram[0xF4E5] = 0x01;
  bus._ram[0xF4E6] = 0x1C;  // = $1C01
  bus._ram[0xF4E7] = 0xEA;  // NOP (where we stop)
  bus._ram[0x1C01] = 0x5A;  // GCR byte to read
  cpu.setP(0x20);  // V=0

  // BVC at PC=$F4E1 with V=0: branch self (= loops). Should NOT exit.
  let cy = 0;
  for (let i = 0; i < 5; i++) {
    cy += stepInstruction(cpu);
    if (cpu.pc !== 0xF4E1) break;
  }
  assert(cpu.pc === 0xF4E1, `BVC self with V=0 loops forever (PC stays at $F4E1, got $${cpu.pc.toString(16)})`);

  // Now signal byte ready
  cpu.setOverflow();
  assert(cpu.V === 1, 'setOverflow set V=1');

  // BVC with V=1: fall through to CLV at $F4E3
  cy += stepInstruction(cpu);
  assert(cpu.pc === 0xF4E3, `BVC fell through to CLV (PC=$F4E3, got $${cpu.pc.toString(16)})`);

  // CLV clears V
  cy += stepInstruction(cpu);
  assert(cpu.V === 0, `CLV cleared V (got V=${cpu.V})`);
  assert(cpu.pc === 0xF4E4, `PC=$F4E4 after CLV (got $${cpu.pc.toString(16)})`);

  // LDA $1C01 reads $5A
  cy += stepInstruction(cpu);
  assert(cpu.a === 0x5A, `LDA $1C01 loaded $5A into A (got $${cpu.a.toString(16)})`);
  assert(cpu.V === 0, `V remains 0 after LDA (got V=${cpu.V})`);
  console.log('ok  – Sparkle BVC/CLV/LDA pattern works as spec');
}

// 5. setOverflow during BVC loop: V transitions 0→1 mid-spin, BVC exits.
//    No spurious double-read.
{
  console.log('Spec[CPU]: setOverflow during BVC-self loop releases the loop exactly once...');
  const { cpu, bus } = buildCpu();
  cpu.pc = 0x0200;
  bus._ram[0x0200] = 0x50;   // BVC -2
  bus._ram[0x0201] = 0xFE;
  bus._ram[0x0202] = 0xB8;   // CLV (exit target)
  bus._ram[0x0203] = 0xEA;   // NOP
  cpu.setP(0x20);  // V=0

  // Spin 10 BVC iterations with V=0 — should still be in loop
  for (let i = 0; i < 10; i++) stepInstruction(cpu);
  assert(cpu.pc === 0x0200, 'BVC still looping at $0200');

  // Fire setOverflow once mid-spin
  cpu.setOverflow();
  // Next BVC instruction exits
  stepInstruction(cpu);
  assert(cpu.pc === 0x0202, `BVC fell through after one setOverflow (PC=$0202, got $${cpu.pc.toString(16)})`);

  // CLV clears
  stepInstruction(cpu);
  assert(cpu.V === 0, 'CLV cleared V');

  // Continue: BVC self should re-loop if V stays 0
  // Run NOP, then put another BVC-self
  bus._ram[0x0204] = 0x50;
  bus._ram[0x0205] = 0xFE;
  cpu.pc = 0x0204;
  for (let i = 0; i < 5; i++) stepInstruction(cpu);
  assert(cpu.pc === 0x0204, 'BVC self with V=0 re-loops after CLV');

  console.log('ok  – setOverflow releases BVC exactly once per signal');
}

// 6. Critical for the bug: setOverflow called multiple times BEFORE CLV
//    is observed by ONE BVC fall-through, not multiple.
{
  console.log('Spec[CPU]: multiple setOverflow() calls before CLV result in ONE BVC exit...');
  const { cpu, bus } = buildCpu();
  cpu.pc = 0x0200;
  bus._ram[0x0200] = 0x50;
  bus._ram[0x0201] = 0xFE;
  bus._ram[0x0202] = 0xB8;  // CLV
  bus._ram[0x0203] = 0xEA;  // NOP
  cpu.setP(0x20);  // V=0

  for (let i = 0; i < 5; i++) stepInstruction(cpu);
  assert(cpu.pc === 0x0200, 'BVC looping');

  // Multiple setOverflow calls — should set V=1 (idempotent), not stack
  cpu.setOverflow();
  cpu.setOverflow();
  cpu.setOverflow();
  assert(cpu.V === 1, 'V=1 after multiple setOverflow');

  // BVC exits ONCE
  stepInstruction(cpu);
  assert(cpu.pc === 0x0202, 'BVC fell through (one exit)');
  stepInstruction(cpu);  // CLV
  assert(cpu.V === 0, 'CLV cleared V');

  // V should NOT magically be re-set from a "queued" setOverflow
  stepInstruction(cpu);  // NOP
  assert(cpu.V === 0, 'V remains 0 — no queued setOverflow re-fires V');
  console.log('ok  – setOverflow() is idempotent (sets V=1, doesn\'t queue)');
}

console.log('\nAll CPU BVC/CLV/setOverflow spec tests passed.');
