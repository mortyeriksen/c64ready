// Per-line frame trace must record the live $D019 / $D01A state of the
// chip (irqStatus / irqMask), not the regs[] shadow.
//
// regs[0x19] only ever stores the LAST CLEAR-MASK BYTE the CPU wrote
// (W1C semantics — the value is consumed and the latch lives in
// irqStatus). regs[0x1A] retains whatever high bits the CPU wrote, but
// the live mask is irqMask. Tracing the regs[] view misleads diagnosis
// of IRQ-chain drift.

import { VIC2, LINES_PER_FRAME, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.frameTraceEnabled = true;
  vic.irqHandler = () => {};
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 400000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
}

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

// ── 1: $D019 trace mirrors irqStatus, not regs[0x19] ──────────────────
{
  const vic = makeVic();
  // Stage state: raster IRQ enabled, raster latch fired, asserted.
  // Drive past line 0 so the trace capture has fired at end-of-line.
  driveTo(vic, 0x10, 30);
  // Force a known IRQ state.
  vic.irqStatus = 0x83;          // raster + sprite-bg latched, asserted
  vic.irqMask = 0x05;            // raster + sprite-sprite enabled
  vic.regs[0x19] = 0x42;         // simulate stale "last write" byte
  vic.regs[0x1A] = 0xF7;         // simulate stale CPU-written mask

  // Drive to the end of THIS raster so _captureFrameTraceLine snapshots.
  driveTo(vic, 0x11, 1);          // crossed the line boundary
  const line = 0x10;
  expect(vic.frameTraceLineD019[line] === 0x83, `line $${line.toString(16)}: $D019 trace = irqStatus = $83 (got $${vic.frameTraceLineD019[line].toString(16)})`);
  expect(vic.frameTraceLineD019[line] !== 0x42, `did NOT capture stale regs[$19] = $42`);
  ok('Frame trace $D019 reflects live irqStatus, not regs[0x19]');
}

// ── 2: $D01A trace mirrors irqMask, not regs[0x1A] ─────────────────────
{
  const vic = makeVic();
  driveTo(vic, 0x20, 30);
  vic.irqStatus = 0x80;
  vic.irqMask = 0x09;            // raster + lightpen enabled
  vic.regs[0x1A] = 0xF9;         // CPU view (high nibble open bus = $F0)
  driveTo(vic, 0x21, 1);
  const line = 0x20;
  expect(vic.frameTraceLineD01A[line] === 0x09, `line $${line.toString(16)}: $D01A trace = irqMask = $09 (got $${vic.frameTraceLineD01A[line].toString(16)})`);
  expect(vic.frameTraceLineD01A[line] !== 0xF9, `did NOT capture stale regs[$1A] = $F9`);
  ok('Frame trace $D01A reflects live irqMask, not regs[0x1A]');
}

// ── 3: trace-only per-cycle arrays reset only when tracing is active ────
{
  const vic = makeVic();
  vic.lineCycleAccessType.fill(7);
  vic.lineCycleTextAccessPhi1.fill(7);
  vic.lineCycleTextAccessPhi2.fill(7);
  vic.lineCycleSpriteBaLow.fill(1);
  vic.lineCycleSpriteAecLow.fill(1);

  vic._clearCycleState();

  expect(vic.lineCycleAccessType[0] === 0, `trace access type cycle 0 reset to idle`);
  expect(vic.lineCycleTextAccessPhi1[0] === 0, `trace phi1 access cycle 0 reset to idle`);
  expect(vic.lineCycleTextAccessPhi2[0] === 0, `trace phi2 access cycle 0 reset to idle`);
  expect(vic.lineCycleSpriteBaLow[0] === 0, `trace sprite BA cycle 0 reset to 0`);
  expect(vic.lineCycleSpriteAecLow[0] === 0, `trace sprite AEC cycle 0 reset to 0`);
  ok('Frame trace per-cycle debug arrays are reset when trace capture is enabled');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
