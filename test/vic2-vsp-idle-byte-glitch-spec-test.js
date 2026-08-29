// vsp-idle-byte-glitch-spec-test.js
//
// Bauer §3.14.6 DMA delay / VSP — the idle-byte FETCH-ADDRESS glitch.
//
// testprogs/VICII/vsp-tester (vice-emu r46094) documents a hardware quirk:
//
//   "On real c64 hardware triggering a badline during idle state ('DMA
//    delay') causes the VIC to retrieve a different idle byte than usual in
//    the trigger cycle. Ordinarily idle bytes are sourced from $3fff (or
//    $39ff when ECM enabled). When DMA delay is triggered on real hardware
//    the idle byte is instead sourced from $38ff (6569 VICs) or $3807
//    (8565/8566 VICs) in the cycle the delay is triggered."
//
// The tester fills VIC memory so each byte equals its own address's MSB
// (then LSB), parks a 1-pixel sprite over the affected column, and reads
// the sprite-vs-data collision register to recover the byte the VIC
// fetched there. A pass requires the recovered address to be $38FF / $3807
// (or the chip-specific $38C7 / $38D7). The full PRG runs green in our
// emulator on all three variants; this unit test pins the underlying
// mechanism: the trigger-cycle idle g-access is sourced from the glitch
// address, and ONLY when the bad line is raised mid-line from idle state.
//
// The affected lineCycleIdleByte index is `triggerCycle + regOffset`: the
// detection cycle on 6569 (regOffset 0), the cycle before on 8565
// (regOffset -1, modelling the 1-cycle register-pipeline delay the renderer
// samples idle bytes through).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFails = [];
function expect(cond, msg) { if (!cond) currentFails.push(msg); }
function ok(label) {
  testNo++;
  if (currentFails.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFails) console.log(`     - ${m}`);
    currentFails = [];
  }
}

function makeVic(variant) {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  if (variant) v.vicVariant = variant;
  return v;
}

function driveToCycle(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// Distinguishable sentinels so the asserted byte unambiguously identifies
// which address the idle g-access sourced from.
const NORMAL_3FFF = 0x11;   // ordinary idle source $3FFF
const GLITCH_38FF = 0x88;   // 6569 glitch source
const GLITCH_3807 = 0x77;   // 8565 glitch source
function plant(vic) {
  vic.ram[0x3FFF] = NORMAL_3FFF;
  vic.ram[0x38FF] = GLITCH_38FF;
  vic.ram[0x3807] = GLITCH_3807;
}

// Drive an idle raster line ($30-$F7) up to `triggerCycle`, then raise a
// mid-line Bad Line Condition by matching YSCROLL to (raster & 7). Returns
// the vic positioned one cycle past the trigger (detection cycle processed).
//
// Raster 50: with YSCROLL=3 at cycle 14, (50 & 7)=2 ≠ 3 → NOT a bad line,
// so the sequencer stays idle (no bad line at 48/49/50 for YSCROLL=3). At
// `triggerCycle` we write YSCROLL=2 → (50 & 7)=2 = YSCROLL → bad line. The
// write becomes visible at the next cycle's phi1 (= triggerCycle + 1), where
// the bad-line rising edge fires. Mirrors the real PRG (trigger STA at cy53).
function setupIdleTrigger(vic, triggerCycle) {
  vic.regs[0x11] = 0x18 | 3;   // DEN=1, RSEL=1, YSCROLL=3
  vic.displayEnabled = true;
  driveToCycle(vic, 0x30, 1);  // latch displayEnabled
  driveToCycle(vic, 50, triggerCycle);
  return vic;
}

// ─── 1: 6569 — mid-line idle trigger sources idle byte from $38FF ─────────
{
  const vic = makeVic('6569');
  plant(vic);
  setupIdleTrigger(vic, 53);
  expect(vic.displayActive === false,
    `pre: raster 50 must be idle (no bad line with YSCROLL=3), got displayActive=${vic.displayActive}`);
  expect(vic._isBadLine(50, vic.regs) === false,
    `pre: YSCROLL=3 on raster 50 is not a bad line`);
  // CPU writes YSCROLL=2 at cy53; detection (_onBadLineConditionEdge) at cy54 phi1.
  vic.regs[0x11] = 0x18 | 2;
  vic.clock(1);  // advance to cy54 — detect + capture
  expect(vic.cycleInLine === 54, `now at cy54, got ${vic.cycleInLine}`);
  expect(vic._isBadLine(50, vic.regs) === true,
    `post-write: YSCROLL=2 on raster 50 is now a bad line`);
  expect(vic._vspGlitchGCycle === 54,
    `6569 (regOffset 0): glitch latched at the detection cycle 54, got ${vic._vspGlitchGCycle}`);
  expect(vic.lineCycleIdleByte[54] === GLITCH_38FF,
    `6569: trigger-cycle idle byte sourced from $38FF (got ${vic.lineCycleIdleByte[54].toString(16)}, expected ${GLITCH_38FF.toString(16)})`);
  // A non-trigger idle cycle is still the ordinary $3FFF source.
  expect(vic.lineCycleIdleByte[40] === NORMAL_3FFF,
    `6569: non-trigger idle cycle 40 still sources $3FFF (got ${vic.lineCycleIdleByte[40].toString(16)})`);
  ok('§3.14.6: 6569 mid-line idle trigger sources idle byte from $38FF at detection cycle');
}

// ─── 2: 8565 — glitch byte is $3807 at the prior (pipeline) index ─────────
{
  const vic = makeVic('8565');
  plant(vic);
  setupIdleTrigger(vic, 53);
  vic.regs[0x11] = 0x18 | 2;
  vic.clock(1);  // cy54 detect; 8565 patches index 53 (cy + regOffset)
  expect(vic.lineCycleIdleByte[53] === GLITCH_3807,
    `8565: idle byte at index 53 (cy54 + regOffset -1) sourced from $3807 (got ${vic.lineCycleIdleByte[53].toString(16)})`);
  expect(vic.lineCycleIdleByte[54] !== GLITCH_3807,
    `8565: detection cycle 54 itself is NOT the affected index`);
  ok('§3.14.6: 8565 mid-line idle trigger sources idle byte from $3807 at cy-1 (pipeline offset)');
}

// ─── 3: gate — a trigger raised while in DISPLAY state must NOT glitch ────
//
// The quirk is specific to "triggering a badline during idle state". A bad
// line raised mid-line while the sequencer is already in display state
// (e.g. the §3.7.2 r3 late-VSP-from-display case) does not corrupt the idle
// source — there is no idle g-access to corrupt.
{
  const vic = makeVic('6569');
  plant(vic);
  setupIdleTrigger(vic, 53);
  vic.displayActive = true;     // force display state at the trigger
  vic.regs[0x11] = 0x18 | 2;
  vic.clock(1);
  expect(vic._vspGlitchGCycle === -1,
    `display-state trigger must not latch the glitch, got ${vic._vspGlitchGCycle}`);
  expect(vic.lineCycleIdleByte[54] !== GLITCH_38FF,
    `display-state trigger must leave the idle byte un-glitched`);
  ok('§3.14.6: bad line raised from DISPLAY state does not glitch the idle source');
}

// ─── 4: gate — a canonical cycle-14 bad line must NOT glitch ──────────────
//
// The glitch only fires for the mid-line idle→display transition (cycle >
// 14). A normal bad line that fires at the canonical cycle 14 leaves the
// idle source untouched.
{
  const vic = makeVic('6569');
  plant(vic);
  vic.regs[0x11] = 0x18 | 2;    // YSCROLL=2 → raster 50 IS a bad line at cy14
  vic.displayEnabled = true;
  driveToCycle(vic, 0x30, 1);
  driveToCycle(vic, 50, 30);    // well past cycle 14
  expect(vic._vspGlitchGCycle === -1,
    `canonical cy14 bad line must not latch the glitch, got ${vic._vspGlitchGCycle}`);
  ok('§3.14.6: canonical cycle-14 bad line does not glitch the idle source');
}

// ─── 5: gate — a fully idle line (no trigger) leaves every idle byte $3FFF ─
{
  const vic = makeVic('6569');
  plant(vic);
  vic.regs[0x11] = 0x18 | 3;    // YSCROLL=3 → raster 50 idle, no write
  vic.displayEnabled = true;
  driveToCycle(vic, 0x30, 1);
  driveToCycle(vic, 51, 1);     // run all of raster 50
  let glitched = 0;
  for (let c = 12; c <= 58; c++) if (vic.lineCycleIdleByte[c] !== NORMAL_3FFF) glitched++;
  expect(glitched === 0,
    `idle line with no trigger must source every idle byte from $3FFF, ${glitched} cycles differed`);
  ok('§3.14.6: untriggered idle line sources every idle g-access from $3FFF');
}

console.log(`\n${testNo - failing}/${testNo} passing`);
if (failing > 0) { process.exitCode = 1; }
export const __failing = failing;
