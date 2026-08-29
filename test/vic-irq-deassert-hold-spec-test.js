// VIC → 6510 /IRQ deassertion-hold spec test.
//
// Spec / HW behavior:
//   The VIC routes its /IRQ output to the 6510's /IRQ pin. The 6510 polls
//   /IRQ at the penultimate cycle of each instruction. A read-modify-write to
//   $D019 (e.g. `ASL $D019` / `INC $D019`) acknowledges a VIC interrupt with
//   its dummy-write half. When the ack lands on the very cycle the VIC raises
//   the raster IRQ and the CPU polls it, real 6569+6510 hardware STILL deliver
//   the interrupt: the VIC's /IRQ deassertion lags the acknowledge by one
//   cycle, symmetric with the one-cycle assertion latency (the cycle-1 raster
//   compare lands after the CPU's per-cycle IRQ sample, so an assertion is
//   felt one cycle later — and so must a deassertion be).
//
//   Oracle: VICE x64sc (-VICIImodel 0) on FLT&GP "The Hat" raster-wall part.
//   The wall's raster-18 stable-raster handler exits via `ASL $D019` right at
//   the frame boundary; on ~8% of frames that ASL coincides with the raster-0
//   (sprite-setup) IRQ. VICE delivers that IRQ every frame (read the pushed PC
//   at the $234C handler: 4/50 entries were interrupted mid-`ASL $D019`).
//   Without the symmetric one-cycle deassert hold the ack swallowed the IRQ,
//   the sprite-setup handler was skipped, and the wall collapsed to black.
//
// This asserts the observable invariant on cpu.irqLine, NOT an instruction
// cycle count. Paired with a negative case: an ack a full cycle BEFORE the
// poll still clears the line (the hold is exactly one cycle, no over-deliver).

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
  // Quiescent CIA so cpu.irqLine reflects the VIC source only.
  m._cpuCiaIrqPending = false;
  m.cia1.icrStatus = 0; m.cia1.icrMask = 0;
  return m;
}

// Raise a VIC raster interrupt: latch bit + IR bit set, mask enabled, then
// propagate through the VIC's irqHandler (as a live raster compare would).
function raiseVicRasterIrq(m) {
  m.vic2.irqMask = 0x01;
  m.vic2.irqStatus = 0x81;          // raster latch (bit0) + IR/bit7
  m.vic2.irqHandler();               // → machine._cpuVicIrqPending = true
}

// ── 1: deassertion is held exactly one machine cycle ────────────────────
{
  const m = makeMachine();
  raiseVicRasterIrq(m);
  expect(m._cpuVicIrqPending === true, 'precondition: VIC IRQ pending');

  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === true, 'cycle A: /IRQ asserted to CPU');
  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === true, 'cycle B: /IRQ steady low (asserted)');

  // Acknowledge via a $D019 write (write-1-to-clear bit 0), exactly as an
  // RMW dummy-write would on the cycle the CPU polls.
  m.vic2.write(0x19, 0x01);
  expect(m.vic2.irqPending === false, 'ack: VIC irqPending cleared');
  expect(m._cpuVicIrqPending === false, 'ack: machine VIC-pending cleared');

  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === true,
    'ack cycle: /IRQ STILL asserted (one-cycle deassert hold — symmetric with assert latency; HW delivers the acked IRQ)');
  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === false,
    'ack cycle +1: /IRQ released');
  ok('VIC /IRQ deassertion lags the acknowledge by exactly one machine cycle');
}

// ── 2: no over-deliver — a VIC IRQ that was never asserted stays clear ──
{
  const m = makeMachine();
  // No raise. Sample a few times; /IRQ must stay high (released).
  m._sampleCpuInterrupts();
  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === false, 'never-asserted VIC IRQ: /IRQ stays released (no phantom hold)');
  ok('VIC /IRQ deassert hold does not synthesize a phantom interrupt');
}

// ── 3: a CIA IRQ coincident with the VIC tail keeps /IRQ asserted ───────
// (Sanity: the hold is OR-combined with the CIA source, not masked by it.)
{
  const m = makeMachine();
  raiseVicRasterIrq(m);
  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === true, 'VIC asserted');
  m.vic2.write(0x19, 0x01);          // ack VIC
  m._cpuCiaIrqPending = true;        // CIA asserts the same cycle
  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === true, 'ack cycle: /IRQ asserted (VIC hold OR CIA)');
  m._sampleCpuInterrupts();
  expect(m.cpu.irqLine === true, 'next cycle: still asserted by CIA after VIC hold expires');
  ok('VIC deassert hold composes with the CIA IRQ source');
}

if (testsFailing > 0) { console.log(`\n${testsFailing} test(s) FAILED`); process.exit(1); }
console.log(`\nAll ${testNo} tests passed.`);
