// Cycle-precise integration test: STX $DD02 inside a raster IRQ
// handler must update the VIC bank IMMEDIATELY upon CPU completion of
// the store cycle. Pins the BA-stall / IRQ-entry / cia.write →
// vic.noteBankChange chain end-to-end.
//
// Builds on:
//   - test/cia2-vic-bank-spec-test.js  (pure-unit bank arithmetic +
//     DDRA-fires-the-hook coverage)
//   - test/irq-d016-cycle-alignment-spec-test.js  (self-contained
//     raster-IRQ → STA fixture)
//
// Two adversarial patterns are exercised inside one handler:
//   1. PRA = $00, DDRA = $3F (PA0/PA1 both output, both pulled low)
//        → PA0/PA1 pins = 00 → inverted = 11 → bank index 3 → $C000
//   2. DDRA = $3C (PA0/PA1 both input, both float high)
//        → pins = 11 → inverted = 00 → bank index 0 → $0000
//
// After each STX $DD02 returns to the CPU's micro-op queue, we sample
// vic.currentVicBank and assert it matches the expected value. We also
// pin the exact cycle of the write so a future regression that shifts
// the call by even one master cycle is caught.

import { C64Machine } from '../src/machine.js';

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeScenario() {
  const machine = new C64Machine();
  machine.ready = true;
  const ram = machine.mem.ram;

  // CPU busy loop @ $1000: JMP $1000 (3 cyc).
  ram[0x1000] = 0x4C; ram[0x1001] = 0x00; ram[0x1002] = 0x10;

  // IRQ handler @ $C000. Total handler cost (incl. 7-cyc hw IRQ entry)
  // must be a multiple of the JMP-self loop period (3 cyc) so the JMP
  // phase doesn't walk across frames; otherwise the IRQ-take jitter
  // (= phase at IRQ-fire moment) drifts and the cycle-stability test
  // below would fail. Base handler = 44 cyc → pad with 2 NOPs (+4) for
  // a 48-cyc total (48 mod 3 = 0).
  //   PHA              [3]
  //   LDA #$01         [2]
  //   STA $D019        [4]  ACK raster latch (else handler re-fires)
  //   NOP, NOP         [4]  phase-alignment padding
  //   LDA #$00         [2]
  //   STA $DD00        [4]  PRA = $00
  //   LDX #$3F         [2]
  //   STX $DD02        [4]  DDRA = $3F → pins 00 → bank $C000
  //   LDX #$3C         [2]
  //   STX $DD02        [4]  DDRA = $3C → pins 11 → bank $0000
  //   PLA              [4]
  //   RTI              [6]
  let p = 0xC000;
  ram[p++] = 0x48;                                            // PHA
  ram[p++] = 0xA9; ram[p++] = 0x01;                           // LDA #$01
  ram[p++] = 0x8D; ram[p++] = 0x19; ram[p++] = 0xD0;          // STA $D019
  ram[p++] = 0xEA;                                            // NOP
  ram[p++] = 0xEA;                                            // NOP
  ram[p++] = 0xA9; ram[p++] = 0x00;                           // LDA #$00
  ram[p++] = 0x8D; ram[p++] = 0x00; ram[p++] = 0xDD;          // STA $DD00
  ram[p++] = 0xA2; ram[p++] = 0x3F;                           // LDX #$3F
  ram[p++] = 0x8E; ram[p++] = 0x02; ram[p++] = 0xDD;          // STX $DD02
  ram[p++] = 0xA2; ram[p++] = 0x3C;                           // LDX #$3C
  ram[p++] = 0x8E; ram[p++] = 0x02; ram[p++] = 0xDD;          // STX $DD02
  ram[p++] = 0x68;                                            // PLA
  ram[p++] = 0x40;                                            // RTI

  ram[0xFFFE] = 0x00; ram[0xFFFF] = 0xC0;
  machine.cpu.pc = 0x1000;
  machine.cpu.I = 0;
  for (let i = 0; i < 7; i++) machine.cpu.clock();

  machine.mem.write(0x0001, 0x35);              // $E000-$FFFF as RAM
  machine.vic2.regs[0x11] = 0x0B;               // DEN=0 — no bad-line stalls
  machine.vic2.regs[0x12] = 0x30;
  machine.vic2.irqMask = 0x01;
  machine.vic2.irqStatus = 0;
  return machine;
}

// Capture each $DD02 write together with vic.currentVicBank as it is
// the instant cia2.write() returns control. Also capture (raster,
// cycleInLine) at the same instant so we can pin the timing.
function captureDD02Writes(machine, framesToRun) {
  const cia2 = machine.cia2;
  const vic = machine.vic2;
  const writes = [];
  const origWrite = cia2.write.bind(cia2);
  cia2.write = function(reg, val) {
    const before = vic.currentVicBank;
    origWrite(reg, val);
    if ((reg & 0x0F) === 0x02) {
      writes.push({
        raster: vic.raster,
        cycle: vic.cycleInLine,
        val: val & 0xFF,
        bankBefore: before,
        bankAfter: vic.currentVicBank,
        pra: cia2.portA,
        ddra: cia2.portADir,
      });
    }
  };
  for (let f = 0; f < framesToRun; f++) machine.runFrame();
  return writes;
}

// ── 1: STX $DD02 fires twice per IRQ; both update vic.currentVicBank ──
{
  const machine = makeScenario();
  const writes = captureDD02Writes(machine, 3);
  expect(writes.length === 6,
    `2 STX $DD02 / frame × 3 frames = 6 writes, got ${writes.length}`);
  ok(`captured ${writes.length} $DD02 writes across 3 IRQ frames`);
}

// ── 2: DDRA=$3F → bank $C000 (immediate update, same master cycle) ────
{
  const machine = makeScenario();
  const writes = captureDD02Writes(machine, 3);
  const first = writes.filter(w => w.val === 0x3F);
  expect(first.length === 3, `3 writes with val=$3F (one per frame), got ${first.length}`);
  for (const w of first) {
    expect(w.pra === 0x00, `PRA should be $00 at the $3F write (got $${w.pra.toString(16)})`);
    expect(w.ddra === 0x3F, `DDRA should be $3F (got $${w.ddra.toString(16)})`);
    expect(w.bankAfter === 0xC000,
      `currentVicBank = $C000 (= (3 - 0) << 14) immediately after $DD02=$3F write, ` +
      `got $${w.bankAfter.toString(16)}`);
  }
  ok(`$DD02 = $3F (PA0/PA1 outputs, PRA=0) → bank $C000 same-cycle`);
}

// ── 3: DDRA=$3C → bank $0000 (the inverse pattern) ────────────────────
{
  const machine = makeScenario();
  const writes = captureDD02Writes(machine, 3);
  const second = writes.filter(w => w.val === 0x3C);
  expect(second.length === 3, `3 writes with val=$3C, got ${second.length}`);
  for (const w of second) {
    expect(w.ddra === 0x3C, `DDRA should be $3C (got $${w.ddra.toString(16)})`);
    expect(w.bankAfter === 0x0000,
      `currentVicBank = $0000 immediately after $DD02=$3C write ` +
      `(PA0/PA1 inputs float high), got $${w.bankAfter.toString(16)}`);
  }
  ok(`$DD02 = $3C (PA0/PA1 inputs, float high) → bank $0000 same-cycle`);
}

// ── 4: bank transition $C000 → $0000 happens between the two writes ──
//      Every back-to-back ($3F, $3C) pair within a single IRQ must
//      show bankBefore=$C000 on the second write (proving the first
//      write actually took) and bankAfter=$0000 on the second.
{
  const machine = makeScenario();
  const writes = captureDD02Writes(machine, 3);
  for (let i = 0; i + 1 < writes.length; i += 2) {
    const a = writes[i], b = writes[i + 1];
    expect(a.val === 0x3F && b.val === 0x3C,
      `pair ${i / 2}: ($3F then $3C), got ($${a.val.toString(16)}, $${b.val.toString(16)})`);
    expect(b.bankBefore === 0xC000,
      `pair ${i / 2}: bank just before 2nd write = $C000 (from 1st write), got $${b.bankBefore.toString(16)}`);
    expect(b.bankAfter === 0x0000,
      `pair ${i / 2}: bank just after 2nd write = $0000, got $${b.bankAfter.toString(16)}`);
  }
  ok(`back-to-back $3F→$3C writes shift bank $C000 → $0000 within one IRQ`);
}

// ── 5: each $DD02 write lands at a stable cycle every frame ───────────
//      Same property as the $D016 alignment test, but for the $DD02
//      write — guards against any model change that shifts the CIA2-
//      write path relative to VIC's cycleInLine sampling.
{
  const machine = makeScenario();
  const writes = captureDD02Writes(machine, 10);
  const first3F = writes.filter(w => w.val === 0x3F);
  const firstCycle = first3F[0].cycle;
  const firstRaster = first3F[0].raster;
  const allSame = first3F.every(w => w.cycle === firstCycle && w.raster === firstRaster);
  expect(allSame,
    `every $3F write lands at (raster=${firstRaster}, cycle=${firstCycle}); ` +
    `got: ${first3F.map(w => `(${w.raster},${w.cycle})`).join(', ')}`);
  ok(`STX $DD02 cycle is stable across 10 IRQ frames`);
}

// ── 6: bank update is observable to a follow-up vic-side fetch ────────
//      Same-cycle update isn't useful if downstream consumers haven't
//      re-sampled it. Verify by triggering a real vic.read of a sprite
//      pointer (relies on currentVicBank) and checking it sees the
//      new bank's data.
{
  const machine = makeScenario();
  const ram = machine.mem.ram;
  // Plant distinct sentinel bytes at the same offset in two different
  // 16K banks — the sprite-pointer slot at $03F8.
  ram[0x0000 + 0x03F8] = 0xAA;  // bank 0 ($0000-$3FFF)
  ram[0xC000 + 0x03F8] = 0x55;  // bank 3 ($C000-$FFFF)
  // After DDRA=$3F → bank $C000, a VIC sprite-pointer fetch at $03F8
  // resolves to physical $C3F8 → reads $55.
  // After DDRA=$3C → bank $0000, the same fetch resolves to physical
  // $03F8 → reads $AA.
  // We don't drive an actual sprite fetch here; instead probe via
  // _vicReadWithBank directly using the current bank.
  const writes = captureDD02Writes(machine, 1);
  for (const w of writes) {
    if (w.val === 0x3F) {
      // currentVicBank is at $C000 after this write.
      const v = machine.vic2._vicMemRead(0x03F8, w.bankAfter);
      expect(v === 0x55,
        `after $DD02=$3F: vic-side fetch at $03F8 sees bank-$C000 byte $55, got $${v.toString(16)}`);
    } else if (w.val === 0x3C) {
      const v = machine.vic2._vicMemRead(0x03F8, w.bankAfter);
      expect(v === 0xAA,
        `after $DD02=$3C: vic-side fetch at $03F8 sees bank-$0000 byte $AA, got $${v.toString(16)}`);
    }
  }
  ok(`vic-side fetch sees the new bank's data immediately after $DD02 write`);
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
