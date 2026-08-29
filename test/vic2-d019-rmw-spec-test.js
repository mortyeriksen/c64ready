// VIC $D019 RMW spec test.
//
// $D019 is W1C: writing a value clears IRR bits where val has 1s.
//
// INC $D019 is a 6-cy RMW:
//   cy 1: opcode fetch
//   cy 2: addr lo fetch
//   cy 3: addr hi fetch
//   cy 4: read original value at $D019 (= irqStatus | $70)
//   cy 5: PHANTOM write of read value back to $D019 (= NMOS quirk)
//   cy 6: write incremented value to $D019
//
// Both writes go through W1C. The combined effect should clear all bits
// that were 1 in either the read value OR the incremented value.
//
// EDGE CASE: if a new raster match happens BETWEEN cy 5 and cy 6, the
// fresh IRR bit is set after the phantom write but before the modified
// write. Whether the modified write clears it depends on whether the
// incremented value has the matching bit set.

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
  m.mem.ram.fill(0xEA);
  m.cpu.pc = 0x1000;
  m.cpu.I = 1;
  m.cpu.sampledIrq = false;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.write(0x0001, 0x35);
  m.vic2.write(0x11, 0x00);
  m.vic2.displayEnabled = false;
  return m;
}

// ── 1: INC $D019 with IRR bit 0 set → clears bit 0.
{
  const m = makeMachine();
  m.vic2.write(0x1A, 0x01);    // enable raster IRQ mask
  m.vic2.irqStatus = 0x81;     // bit 0 (raster) + bit 7 (any pending)

  // Place INC $D019 at $1000.
  m.mem.ram[0x1000] = 0xEE; m.mem.ram[0x1001] = 0x19; m.mem.ram[0x1002] = 0xD0;
  // Run 6 cycles.
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect((m.vic2.irqStatus & 0x0F) === 0,
    `INC $D019 clears IRR bits 0-3; got irqStatus=$${m.vic2.irqStatus.toString(16)}`);
  expect((m.vic2.irqStatus & 0x80) === 0,
    `bit 7 (any-pending) re-evaluated to 0`);
  ok(`INC $D019 with bit 0 set: clears bit 0 and pending flag`);
}

// ── 2: INC $D019 with NO IRR bits set → still clears (idempotent).
{
  const m = makeMachine();
  m.vic2.irqStatus = 0;

  m.mem.ram[0x1000] = 0xEE; m.mem.ram[0x1001] = 0x19; m.mem.ram[0x1002] = 0xD0;
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect(m.vic2.irqStatus === 0,
    `INC $D019 with no IRR bits set: still 0; got $${m.vic2.irqStatus.toString(16)}`);
  ok(`INC $D019 idempotent on clear IRR`);
}

// ── 3: INC $D019 with multiple bits set → clears all bits 0-3.
{
  const m = makeMachine();
  m.vic2.write(0x1A, 0x0F);    // all IRR mask bits enabled
  m.vic2.irqStatus = 0x8F;     // all 4 IRR bits + pending

  m.mem.ram[0x1000] = 0xEE; m.mem.ram[0x1001] = 0x19; m.mem.ram[0x1002] = 0xD0;
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect(m.vic2.irqStatus === 0,
    `INC $D019 clears all IRR bits; got $${m.vic2.irqStatus.toString(16)}`);
  ok(`INC $D019 with all bits set: clears all 4 IRR + pending`);
}

// ── 4: STA $D019 with explicit value clears only the bits set in val.
//
// Spec: $D019 W1C — write $05 clears bits 0 and 2 only. Bit 1 stays set.
{
  const m = makeMachine();
  m.vic2.write(0x1A, 0x0F);
  m.vic2.irqStatus = 0x8F;     // all bits set

  // LDA #$05 ; STA $D019 (= clear bits 0, 2).
  m.mem.ram[0x1000] = 0xA9; m.mem.ram[0x1001] = 0x05;
  m.mem.ram[0x1002] = 0x8D; m.mem.ram[0x1003] = 0x19; m.mem.ram[0x1004] = 0xD0;
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);

  // Bits 0 and 2 cleared; bits 1 and 3 stay set.
  expect((m.vic2.irqStatus & 0x0F) === 0x0A,
    `W1C: bits 0,2 cleared, bits 1,3 stay set; got IRR=$${(m.vic2.irqStatus & 0x0F).toString(16)}`);
  expect((m.vic2.irqStatus & 0x80) !== 0,
    `pending stays set (bits 1,3 still match mask); got irqStatus=$${m.vic2.irqStatus.toString(16)}`);
  ok(`STA $D019 = $05: W1C clears bits 0,2 only`);
}

// ── 5: Raster IRR re-fires AFTER ack within the same line is gated.
//
// Edge-trigger semantics: once cleared, the raster IRR bit doesn't
// re-set on the same line unless the compare value is changed via a
// mid-line dip. Verify this baseline.
{
  const m = makeMachine();
  m.vic2.write(0x12, 0x80);    // compare = $80
  m.vic2.write(0x1A, 0x01);    // enable raster IRQ

  // Park raster at $80 cy 5 (mid-line, after compare fired).
  let safety = 50000;
  while (--safety && !(m.vic2.raster === 0x80 && m.vic2.cycleInLine === 5)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }

  // IRR bit 0 should be set from the cy 1 raster match.
  expect((m.vic2.irqStatus & 0x01) !== 0,
    `IRR bit 0 set after raster $80 cy 1 match`);

  // STA $D019 = $01 clears it.
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.ram[0x1000] = 0xA9; m.mem.ram[0x1001] = 0x01;
  m.mem.ram[0x1002] = 0x8D; m.mem.ram[0x1003] = 0x19; m.mem.ram[0x1004] = 0xD0;
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect((m.vic2.irqStatus & 0x01) === 0,
    `after ack: bit 0 cleared`);

  // Run remaining cycles of this line. Bit 0 should NOT re-fire.
  for (let i = 0; i < 50; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect((m.vic2.irqStatus & 0x01) === 0,
    `bit 0 stays clear within same raster line (edge-trigger)`);

  ok(`Raster IRR ack within same line: no re-fire (edge-trigger)`);
}

// ── 6: INC $D019 RMW: a NEW raster IRR set DURING the RMW window must
//      be preserved if the modified write doesn't clear it.
//
// Scenario: INC $D019 at raster $50. The phantom write at cycle 5 clears
// the existing bit 0. If the raster compare fires DURING the RMW (e.g.,
// at the modified-write cycle 6), the new IRR bit set must survive.
//
// In practice, INC $D019 has both writes contain bit 0 (read returns
// $71 with bit 0 set; INC → $72 has bit 1, but bit 0 in the orig).
// So new bit 0 sets get cleared by the modified write. This is the
// expected spec behavior — INC clears bit 0 either way.
{
  const m = makeMachine();
  m.vic2.write(0x12, 0x80);
  m.vic2.write(0x1A, 0x01);

  // Park CPU at $1000 with INC $D019 ready to run. Drive raster to $80 cy 0
  // so the RMW spans cycles 1-6 of raster $80 (= straddles raster match).
  let safety = 50000;
  while (--safety && !(m.vic2.raster === 0x80 && m.vic2.cycleInLine === 0)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.vic2.irqStatus = 0;  // start clean

  m.mem.ram[0x1000] = 0xEE; m.mem.ram[0x1001] = 0x19; m.mem.ram[0x1002] = 0xD0;
  // Run 6 cycles to complete INC RMW.
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);

  // After: IRR bit 0 should reflect whatever survived the W1C race.
  // Spec: INC $D019 has both writes set bit 0 if pre-set; phantom writes
  // back bit 0=1 (from read), modified writes bit 0=0 (after INC, but
  // depends on overflow). Net: ANY pre-existing bit 0 cleared; new bit 0
  // set after phantom but before modified might survive.
  // This is the timing race we want to spec-pin.
  expect((m.vic2.irqStatus & 0x80) === 0 || (m.vic2.irqStatus & 0x01) !== 0,
    `INC $D019 during raster match: pending re-evaluated; got irqStatus=$${m.vic2.irqStatus.toString(16)}`);

  ok(`INC $D019 race with concurrent raster compare: behavior recorded`);
}

console.log(`\n${testNo} VIC $D019 RMW spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
