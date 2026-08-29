// Sprite BA-low ordering at cycle 55. Bauer §3.8.1 rule 2 (2024
// revision): the DMA-start check fires at phi1 of cycle 55. For sprite 0,
// p-access is at cycle 58 and the BA-low window opens at cycle 55 (3-
// cycle lead). The freshly-started DMA bit MUST be visible to BA
// sampling on the SAME cycle — otherwise isSpriteBaLow() / baLow
// expose stale state for the first cycle of the window, and any
// observer (CPU RDY logic, machine.js stall accounting) sees BA come
// up one cycle late.
//
// The bug shape that this test guards against: sampling
//   spriteBaLowOnly = _spriteBaLow(cycle)
// before invoking _spriteSequencerCycle55() inside clock().

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 200000;
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

// ── 1: sprite 0 BA-low is asserted on the SAME cycle the DMA starts ────
{
  const vic = makeVic();
  const TARGET_RASTER = 0x32;
  // Enable sprite 0 with Y matching this raster.
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = TARGET_RASTER & 0xFF;
  driveTo(vic, TARGET_RASTER, 50);
  // Pre-state: DMA off, BA not yet asserted by sprite 0.
  expect(vic.spriteDmaOn[0] === 0, `pre-c55: sprite 0 DMA still off (cycle 50)`);
  expect(vic.isSpriteBaLow() === false, `pre-c55: sprite BA-low false (cycle 50)`);
  // Walk forward one cycle at a time, observing the c55 transition.
  driveTo(vic, TARGET_RASTER, 54);
  expect(vic.cycleInLine === 54, `at c54 before clock`);
  expect(vic.isSpriteBaLow() === false, `c54: sprite BA still high — outside window`);
  vic.clock(1);
  expect(vic.cycleInLine === 55, `advanced to c55`);
  expect(vic.spriteDmaOn[0] === 1, `c55: sprite 0 DMA latched on this cycle`);
  expect(vic.isSpriteBaLow() === true, `c55: sprite BA-low asserted SAME cycle as DMA start`);
  expect(vic.isBaLow() === true, `c55: unified BA-low asserted same cycle`);
  ok('sprite 0 BA-low asserts on cycle 55, same cycle as DMA-start');
}

// ── 2: sprites that don't match Y at c55 leave BA high ─────────────────
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 0x40;          // Y = $40 …
  driveTo(vic, 0x32, 55);          //  … but we're on raster $32
  expect(vic.spriteDmaOn[0] === 0, `Y mismatch: DMA stays off`);
  expect(vic.isSpriteBaLow() === false, `Y mismatch: BA stays high at c55`);
  ok('No DMA-start when Y mismatches → BA stays high at c55');
}

// ── 3: BA contour from c55..c59 is continuous (no 1-cycle gap at start) ─
{
  const vic = makeVic();
  const TARGET_RASTER = 0x40;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = TARGET_RASTER & 0xFF;
  driveTo(vic, TARGET_RASTER, 54);
  const observed = [];
  for (let c = 55; c <= 59; c++) {
    vic.clock(1);
    observed.push({ cycle: vic.cycleInLine, ba: vic.isSpriteBaLow() });
  }
  for (const o of observed) {
    expect(o.ba === true, `c${o.cycle}: sprite BA low (continuous window)`);
  }
  ok('Sprite 0 BA-low contour cycles 55..59 continuous (no startup gap)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
