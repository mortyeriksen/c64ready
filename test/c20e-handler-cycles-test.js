// 3AD "No more grey dots" handler-cycle alignment test.
//
// The demo's raster IRQ handler at $C20E executes a fixed-length prelude
// before its first cycle-counted color write at $C06B. Third-party VICE
// comparison reports our emulator's first $D020 write lands +3 cycles late
// (handler entry +2 cycles, +1 cycle accrued inside the handler before the
// first color write). The +2 at handler entry is a separate concern; this
// test pins down whether the cycle count *inside* the handler matches the
// NMOS-canonical totals.
//
// Sequence (no VIC, no BA stall — just CPU instruction timing):
//
//   $C20E: EE FF CF    INC $CFFF       6 cyc (RMW abs)
//   $C211: CE FF CF    DEC $CFFF       6 cyc (RMW abs)
//   $C214: A5 F7       LDA $F7         3 cyc (zp)
//   $C216: 8D 1B C2    STA $C21B       4 cyc (abs)
//   $C219: EA          NOP             2 cyc
//   $C21A: 50 00       BVC $C21C       3 cyc (V=0, taken, no page cross)
//   $C21C: C9 C9       CMP #$C9        2 cyc
//   $C21E: C9 C9       CMP #$C9        2 cyc
//   $C220: 24 EA       BIT $EA         3 cyc (zp)
//   $C222: A2 03       LDX #$03        2 cyc
//   $C224: CA          DEX             2 cyc
//   $C225: D0 FD       BNE $C224       3/2 cyc (loop 3 times)
//   $C227: EE 6C C2    INC $C26C       6 cyc (RMW abs)
//   $C22A: 20 66 C0    JSR $C066       6 cyc
//   $C066: A0 12       LDY #$12        2 cyc
//   $C068: B9 8C CF    LDA $CF8C,Y     4 cyc (abs,Y, no page cross: $CF9E)
//   $C06B: STA $D020   (start — not counted)
//
// DEX/BNE loop ($C224/$C225) executes:
//   - DEX (X=2, Z=0) + BNE taken     = 2 + 3 = 5
//   - DEX (X=1, Z=0) + BNE taken     = 2 + 3 = 5
//   - DEX (X=0, Z=1) + BNE not taken = 2 + 2 = 4
//   total loop after LDX = 14 cyc
//
// Per-instruction sum (handler-entry → first cycle of STA $D020 at $C06B):
//   6 + 6 + 3 + 4 + 2 + 3 + 2 + 2 + 3 + 2 + 14 + 6 + 6 + 2 + 4 = 65 cycles
//
// VICE third-party report:
//   - $C20E entered at r29 c50, $C06B entered at r31 c8.
//   - (31-29)*63 + 8 - 50 = 84 cycles.
//   - That's 19 cycles MORE than the pure-instruction sum of 65. The
//     extra 19 cycles match the sprite-DMA BA-low stall window on those
//     two raster lines (cy 55..62 of line 29 + cy 0..9 of line 30 minus
//     the AEC-non-stall fraction). So on VICE, pure-instruction-time =
//     65 cycles is consistent.
//   - Our emulator: 85 cycles per third-party. 85 - 65 = 20 cycles of
//     BA-stall on top of pure-instruction time → +1 cycle of BA stall
//     vs VICE, OR +1 cycle inside the pure-instruction path.
//
// This test runs the sequence on a synthetic CPU (no BA, no VIC) and
// verifies the pure-instruction cycle count is exactly 65.

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

function loadHandlerSeq(mem) {
  // Lay down the exact byte sequence the 3AD demo's IRQ handler uses,
  // from $C20E through the first $D020 store at $C06B.
  const set = (addr, ...bytes) => bytes.forEach((b, i) => mem.ram[addr + i] = b & 0xFF);
  set(0xC20E, 0xEE, 0xFF, 0xCF);                // INC $CFFF
  set(0xC211, 0xCE, 0xFF, 0xCF);                // DEC $CFFF
  set(0xC214, 0xA5, 0xF7);                      // LDA $F7
  set(0xC216, 0x8D, 0x1B, 0xC2);                // STA $C21B
  set(0xC219, 0xEA);                            // NOP
  set(0xC21A, 0x50, 0x00);                      // BVC $C21C
  set(0xC21C, 0xC9, 0xC9);                      // CMP #$C9
  set(0xC21E, 0xC9, 0xC9);                      // CMP #$C9
  set(0xC220, 0x24, 0xEA);                      // BIT $EA
  set(0xC222, 0xA2, 0x03);                      // LDX #$03
  set(0xC224, 0xCA);                            // DEX
  set(0xC225, 0xD0, 0xFD);                      // BNE $C224
  set(0xC227, 0xEE, 0x6C, 0xC2);                // INC $C26C
  set(0xC22A, 0x20, 0x66, 0xC0);                // JSR $C066
  set(0xC22D, 0x60);                            // RTS (won't reach in this test)
  set(0xC066, 0xA0, 0x12);                      // LDY #$12
  set(0xC068, 0xB9, 0x8C, 0xCF);                // LDA $CF8C,Y
  set(0xC06B, 0x8D, 0x20, 0xD0);                // STA $D020
  set(0xC06E, 0x60);                            // RTS
  // LDA $CF8C,Y data table — Y=$12 → $CF9E. Same page → no cross.
  for (let i = 0; i < 0x20; i++) mem.ram[0xCF8C + i] = 0x01 + (i & 0x0F);
  // $F7 = 0 (BVC offset = 0 → falls through to $C21C)
  mem.ram[0x00F7] = 0;
}

function makeCpu() {
  const mem = new FlatMemory();
  loadHandlerSeq(mem);
  mem.ram[0xFFFC] = 0x0E; mem.ram[0xFFFD] = 0xC2;   // reset → $C20E
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;   // irq dummy
  const cpu = new CPU(mem);
  cpu.reset();
  // Consume 7 reset cycles to land at PC=$C20E ready to fetch.
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 1;                          // disable IRQs (no IRQ source anyway)
  cpu.V = 0;                          // BVC must take (V clear)
  return { cpu, mem };
}

// ── 1: Pure-instruction handler runtime = 65 cycles ────────────────────
// Stop at the instruction BOUNDARY at PC=$C06B (= STA $D020 is about to
// fetch its first opcode byte). Using `cpu.pc===$C06B` alone is off by 1
// because PC moves to the next opcode 1 cycle before the previous
// instruction's last micro-op completes; atInstructionBoundary() pins the
// canonical "about-to-execute" moment.
{
  const { cpu } = makeCpu();
  expect(cpu.pc === 0xC20E, `pre: PC must = $C20E after reset, got $${cpu.pc.toString(16)}`);

  let cycles = 0;
  const MAX = 1000;
  while (cycles < MAX) {
    cpu.clock();
    cycles++;
    if (cpu.pc === 0xC06B && cpu.atInstructionBoundary()) break;
  }
  expect(cpu.pc === 0xC06B && cpu.atInstructionBoundary(),
    `must arrive at boundary PC=$C06B; got PC=$${cpu.pc.toString(16)} boundary=${cpu.atInstructionBoundary()} after ${cycles} cycles`);
  expect(cycles === 65,
    `handler prelude (from $C20E entry to STA $D020 boundary at $C06B) must be 65 NMOS-canonical cycles, got ${cycles} (Δ=${cycles - 65})`);
  ok(`handler prelude: $C20E → STA $D020 boundary at $C06B takes exactly 65 cycles`);
}

// ── 2: Per-instruction breakdown — pin down which instruction drifts ──
// If test 1 fails with N != 65, this test localizes which instruction's
// duration disagrees with NMOS canonical. We record the cycle at which
// each instruction *begins* and assert it against the expected schedule.
{
  const { cpu } = makeCpu();
  const expected = [
    { pc: 0xC20E, startCy: 0,  name: 'INC $CFFF' },     // 6 cyc
    { pc: 0xC211, startCy: 6,  name: 'DEC $CFFF' },     // 6 cyc
    { pc: 0xC214, startCy: 12, name: 'LDA $F7' },       // 3 cyc
    { pc: 0xC216, startCy: 15, name: 'STA $C21B' },     // 4 cyc
    { pc: 0xC219, startCy: 19, name: 'NOP' },           // 2 cyc
    { pc: 0xC21A, startCy: 21, name: 'BVC $C21C' },     // 3 cyc (taken,no-cross)
    { pc: 0xC21C, startCy: 24, name: 'CMP #$C9' },      // 2 cyc
    { pc: 0xC21E, startCy: 26, name: 'CMP #$C9' },      // 2 cyc
    { pc: 0xC220, startCy: 28, name: 'BIT $EA' },       // 3 cyc
    { pc: 0xC222, startCy: 31, name: 'LDX #$03' },      // 2 cyc
    { pc: 0xC224, startCy: 33, name: 'DEX (iter 1)' },  // 2 cyc
    { pc: 0xC225, startCy: 35, name: 'BNE iter 1' },    // 3 cyc taken
    { pc: 0xC224, startCy: 38, name: 'DEX (iter 2)' },  // 2 cyc
    { pc: 0xC225, startCy: 40, name: 'BNE iter 2' },    // 3 cyc taken
    { pc: 0xC224, startCy: 43, name: 'DEX (iter 3)' },  // 2 cyc
    { pc: 0xC225, startCy: 45, name: 'BNE iter 3' },    // 2 cyc not taken
    { pc: 0xC227, startCy: 47, name: 'INC $C26C' },     // 6 cyc
    { pc: 0xC22A, startCy: 53, name: 'JSR $C066' },     // 6 cyc
    { pc: 0xC066, startCy: 59, name: 'LDY #$12' },      // 2 cyc
    { pc: 0xC068, startCy: 61, name: 'LDA $CF8C,Y' },   // 4 cyc, no page cross
    { pc: 0xC06B, startCy: 65, name: 'STA $D020 (target)' },
  ];

  let cycles = 0;
  let idx = 0;
  // Verify the very first instruction boundary is at cycle 0.
  expect(cpu.pc === expected[0].pc && cycles === expected[0].startCy,
    `step 0: pre PC=$${cpu.pc.toString(16)}@cy${cycles}, expected $${expected[0].pc.toString(16)}@cy${expected[0].startCy}`);
  idx++;

  const MAX = 1000;
  while (idx < expected.length && cycles < MAX) {
    // Advance to next instruction boundary.
    const startCy = cycles;
    // Issue one clock at a time; check boundary by atInstructionBoundary().
    do {
      cpu.clock();
      cycles++;
    } while (!cpu.atInstructionBoundary() && cycles - startCy < 20);

    const exp = expected[idx];
    expect(cpu.pc === exp.pc,
      `at cy ${cycles}: PC=$${cpu.pc.toString(16)}, expected ${exp.name} @ $${exp.pc.toString(16)}`);
    expect(cycles === exp.startCy,
      `${exp.name}: expected to begin at cy ${exp.startCy}, actually began at cy ${cycles} (Δ=${cycles - exp.startCy})`);
    idx++;
  }

  ok('per-instruction breakdown matches NMOS canonical cycle counts');
}

// ── 3: Same sequence with $F7 = 1, 2, 3 — total cycles must shift by
//      exactly $F7 because the BVC offset moves the post-BVC start point
//      forward by $F7 bytes inside the CMP/CMP/BIT data pattern. With $F7
//      = 1, we land mid-CMP at $C21D ($C9 byte read as opcode → CMP #imm
//      with operand $C9 → CMP #$C9, 2 cyc). The cumulative cycle count
//      for the post-BVC path needs to be evaluated by walking the path.
//
//      For this test, just sanity-check that $F7=0 vs $F7=3 both reach
//      $C06B and the totals differ in a predictable way — confirming the
//      $F7-self-modify mechanism works in our emulator.
{
  const totals = [];
  for (const f7 of [0, 1, 2, 3]) {
    const { cpu, mem } = makeCpu();
    mem.ram[0x00F7] = f7;
    let cycles = 0;
    const MAX = 1000;
    while (cpu.pc !== 0xC06B && cycles < MAX) { cpu.clock(); cycles++; }
    expect(cpu.pc === 0xC06B,
      `$F7=${f7}: must reach $C06B, got PC=$${cpu.pc.toString(16)} after ${cycles} cy`);
    totals.push({ f7, cycles });
  }
  console.log('     $F7→cycles:', totals.map(t => `${t.f7}=${t.cycles}`).join(' '));
  ok('handler reaches $C06B for all $F7 ∈ {0,1,2,3}');
}

console.log(`\n${testNo} 3AD handler cycle-alignment tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
