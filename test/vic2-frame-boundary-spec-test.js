// Frame-boundary state preservation spec audit. 10 tests for the L311
// → L0 transition: which counters reset, which carry over, sprite DMA
// continuity, IRQ state, and the L0 special timing.
//
// Sources: Bauer §3.7.2 (display state), §3.5 (DEN latch), §3.8.1
// (sprite DMA rules), §3.12 (raster IRQ).

import { VIC2, CYCLES_PER_LINE, LINES_PER_FRAME } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
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

function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

// ── 1: raster wraps L311 → L0 at frame boundary ────────────────────────
{
  const vic = makeVic();
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.raster === 0,
    `after L311 ends: raster wraps to 0, got ${vic.raster}`);
  ok('VIC: raster wraps L311→L0 at frame boundary');
}

// ── 2: totalCycles increments continuously across frame wrap ───────────
{
  const vic = makeVic();
  for (let i = 0; i < CYCLES_PER_LINE * 311; i++) vic.clock(1);
  const before = vic.totalCycles;
  for (let i = 0; i < CYCLES_PER_LINE * 2; i++) vic.clock(1);
  expect(vic.totalCycles === before + CYCLES_PER_LINE * 2,
    `totalCycles must keep counting across wrap, got Δ=${vic.totalCycles - before}`);
  ok('VIC: totalCycles is monotone across L311→L0 wrap');
}

// ── 3: displayEnabled is reset at the start of L0 of each new frame ────
// Bauer §3.5 specifies the latch sets at L48, not at L0. Our impl
// pre-resets to false at L0.c1 and sets back to true if DEN is high any
// time during L48 — functionally equivalent (nothing between L0..L47
// reads displayEnabled in a way that depends on the prior frame's
// latched value, since bad-line check only fires in $30..$F7). Verify
// the reset is observable at L0.c1.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 49);
  expect(vic.displayEnabled === true, `pre L49: latched true`);
  vic.write(0x11, 0x0B);
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.displayEnabled === false,
    `at L0 with DEN=0: displayEnabled reset to false (will re-sample at next L48)`);
  ok('VIC: displayEnabled reset at L0.c1 each frame (functionally per Bauer §3.5)');
}

// ── 4: DEN cleared throughout next frame's L48 → displayEnabled resets
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 49);
  expect(vic.displayEnabled === true, `pre L49: latched true`);
  vic.write(0x11, 0x0B);
  // Run through full next frame's L48.
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  driveTo(vic, 49);
  expect(vic.displayEnabled === false,
    `next frame's L48 sees DEN=0: latch resets to false`);
  ok('Bauer §3.5: each frame\'s L48 re-samples DEN (no carry-over)');
}

// ── 5: Raster IRQ at L0 is delayed to cycle 2 across frame wrap ────────
// Bauer §3.12: raster compare at raster 0 fires at cycle 2, not cycle 1.
// Across frame wrap: at L311.c63 raster wraps to 0. The IRQ for raster
// 0 (if armed) fires at L0.c2.
{
  const vic = makeVic();
  let irqCycle = -1;
  vic.regs[0x12] = 0;
  vic.write(0x1A, 0x01);
  // Run a frame so the warmup IRQ at L0 fires once and clears.
  for (let i = 0; i < CYCLES_PER_LINE * 312; i++) vic.clock(1);
  vic.write(0x19, 0x01);          // ack
  vic.irqHandler = (s) => { if (s && irqCycle === -1) irqCycle = vic.cycleInLine; };
  vic.clock(1);                    // L0.c1 — should NOT fire
  expect(irqCycle === -1,
    `L0.c1: raster 0 IRQ must NOT fire (delayed to c2)`);
  vic.clock(1);                    // L0.c2 — fires
  expect(irqCycle === 2,
    `L0.c2: raster 0 IRQ fires per Bauer §3.12`);
  ok('Bauer §3.12: raster 0 IRQ delayed to cycle 2 across frame wrap');
}

// ── 5b: CPU-visible raster (LDA $D012/$D011) reflects the L0 cy-2 hold ──
// Bauer §3.12: the raster-counter increment from 311→0 is deferred by one
// cycle at L0. The same delay that pushes the raster-IRQ compare to cy 2
// also pushes the CPU-visible counter value: a LDA $D012 at L0.c1 returns
// $37 (311 & $FF), and the RST8 bit ($D011 bit 7) is still set. Only at
// L0.c2 does $D012 read $00 and RST8 clear.
//
// Synthetic harness uses vic.clock() only; machine.js normally calls
// vic.phi2() after each master cycle which clears `_lineJustEnded`. We
// emulate that here by calling phi2() after every clock().
{
  const vic = makeVic();
  function step() { vic.clock(1); vic.phi2(); }
  // Run one warmup frame so we're past initial reset state.
  for (let i = 0; i < CYCLES_PER_LINE * LINES_PER_FRAME; i++) step();
  // We're now at L0.c0 (just-wrapped, but step's phi2 cleared lineJustEnded).
  step();
  expect(vic.raster === 0 && vic.cycleInLine === 1,
    `precondition: at L0.c1, got L${vic.raster}.c${vic.cycleInLine}`);
  const d012_c1 = vic.read(0x12);
  const d011_c1 = vic.read(0x11);
  expect(d012_c1 === ((LINES_PER_FRAME - 1) & 0xFF),
    `L0.c1: $D012 must return 311&$FF=$37, got $${d012_c1.toString(16)}`);
  expect((d011_c1 & 0x80) !== 0,
    `L0.c1: $D011 bit 7 (RST8) must be set (raster 311 has bit 8), got $${d011_c1.toString(16)}`);

  step();
  expect(vic.raster === 0 && vic.cycleInLine === 2, `at L0.c2`);
  const d012_c2 = vic.read(0x12);
  const d011_c2 = vic.read(0x11);
  expect(d012_c2 === 0,
    `L0.c2: $D012 must return 0, got $${d012_c2.toString(16)}`);
  expect((d011_c2 & 0x80) === 0,
    `L0.c2: $D011 bit 7 (RST8) must be clear, got $${d011_c2.toString(16)}`);

  ok('Bauer §3.12: CPU-visible $D012/$D011 RST8 hold at 311 through L0.c1');
}

// ── 5c: CPU write at cy-63 phi2 timestamps to the OLD line, not cy 0 ────
// Master-cycle ordering: vic.clock runs first (and wraps cycleInLine 63→0
// + raster++ at line end), then CPU phi2 runs. Without compensation, a
// CPU write at cy-63 phi2 would land logged at L_new.c0 instead of L_old
// .c63 — wrong for FF-compare / latch-window semantics. The
// _cpuVisibleRasterAndCycleForWrite helper fixes this symmetrically to
// the read path's _cpuVisibleRaster.
{
  const vic = makeVic();
  function step() { vic.clock(1); vic.phi2(); }
  vic.frameTraceEnabled = true;
  // Run to L100.c62, then advance into the cy-63→cy-0 master cycle and
  // write $D016 while inside that master cycle (between vic.clock and
  // vic.phi2 — exactly where _lineJustEnded is true).
  while (!(vic.raster === 100 && vic.cycleInLine === 62)) step();
  // Now run vic.clock once more — this is the cycle-63 master cycle. After
  // vic.clock, cycleInLine=0, raster=101, _lineJustEnded=true.
  vic.clock(1);
  expect(vic.raster === 101 && vic.cycleInLine === 0 && vic._lineJustEnded === true,
    `precondition: post-cy63 vic.clock, at L101.c0 with lineJustEnded=true`);
  // CPU phi2 write happens here in real master cycle.
  vic.write(0x16, 0x00);
  // The write should be timestamped at L100.c63, not L101.c0.
  const lastD016 = vic._d016WritesCurrent[vic._d016WritesCurrent.length - 1];
  expect(lastD016.raster === 100 && lastD016.cycleInLine === CYCLES_PER_LINE,
    `cy-63 phi2 write must be logged at L100.c63 (not L${lastD016.raster}.c${lastD016.cycleInLine})`);
  expect(vic._lastCselChangeRaster === 100 && vic._lastCselChangeCycle === CYCLES_PER_LINE,
    `_lastCselChange must record L100.c63 (got L${vic._lastCselChangeRaster}.c${vic._lastCselChangeCycle})`);
  // Now finish the master cycle.
  vic.phi2();
  expect(vic._lineJustEnded === false,
    `phi2 cleared lineJustEnded`);
  // Next mid-line write logs at live raster/cycle as usual.
  vic.clock(1); vic.phi2();    // L101.c1
  vic.write(0x16, 0x08);
  const nextD016 = vic._d016WritesCurrent[vic._d016WritesCurrent.length - 1];
  expect(nextD016.raster === 101 && nextD016.cycleInLine === 1,
    `mid-line write logs at live L101.c1 (got L${nextD016.raster}.c${nextD016.cycleInLine})`);
  ok('CPU writes at cy-63 phi2 timestamp to old line (symmetric to read-path compensation)');
}

// ── 6: Sprite DMA flag persists across frame wrap (no auto-reset) ──────
// Bauer §3.8.1: sprite DMA is only cleared by rule 8 (MCBASE=63 at
// cycle 16). Frame wrap doesn't reset DMA.
//
// Pin: Y=54 fires the rasterY match TWICE per frame — once at L54 and
// once at L310 (raster 310 & $FF == 54). Bauer §3.8.1 rule 2 only
// re-arms DMA at the first match (DMA-on already early-returns), then
// at L310 the DMA flag is FALSE again (sprite ended at L75) so the
// second match starts a fresh DMA. That fresh DMA must survive the
// L311→L0 wrap unmolested.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[1] = 54;
  vic.displayEnabled = true;
  driveTo(vic, 310, 56);                // sp0 DMA-start at L310 cycle 55/56
  expect(vic.spriteDmaOn[0] === 1, `sp0 DMA started at Y=54 second match (L310)`);
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 1,
    `sp0 DMA must persist across L311→L0 wrap`);
  ok('Bauer §3.8.1: sprite DMA persists across frame wrap');
}

// ── 7: $D012 raster compare value persists across frame wrap ───────────
// $D012 is just a register; not affected by raster wrap.
{
  const vic = makeVic();
  vic.regs[0x12] = 0x42;
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.regs[0x12] === 0x42,
    `$D012 must persist across frame wrap`);
  ok('VIC: register state ($D012) persists across frame wrap');
}

// ── 8: cycleInLine is 0 at moment of frame-end wrap, then 1, 2... ──────
{
  const vic = makeVic();
  for (let i = 0; i < CYCLES_PER_LINE * 312; i++) vic.clock(1);
  // At this point we just finished L311.c63 → wrapped to L0.c0.
  expect(vic.raster === 0 && vic.cycleInLine === 0,
    `frame wrap: at L0.c0`);
  vic.clock(1);
  expect(vic.cycleInLine === 1, `next clock: L0.c1`);
  ok('VIC: frame wrap leaves L0.c0, next clock is L0.c1');
}

// ── 9: bottom-border vBorderActive carries into top of next frame ──────
// Bauer §3.9: vertical-border FF is set at the bottom-compare line
// (L251 with RSEL=1). It stays set through L311 and L0..L50, then
// resets at the next L51's top-compare.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 252);
  expect(vic.vBorderActive === true,
    `after L251: vBorder set (bottom compare fired)`);
  // Wrap into next frame.
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.vBorderActive === true,
    `at L0: vBorder still set (no top-compare yet this frame)`);
  driveTo(vic, 52);
  expect(vic.vBorderActive === false,
    `after next frame's L51: vBorder reset`);
  ok('Bauer §3.9: vBorder carries through frame wrap until next top compare');
}

// ── 10: PAL frame is exactly 312 × 63 = 19656 cycles ───────────────────
{
  const vic = makeVic();
  const t0 = vic.totalCycles;
  for (let i = 0; i < CYCLES_PER_LINE * LINES_PER_FRAME; i++) vic.clock(1);
  expect(vic.totalCycles - t0 === 19656,
    `PAL frame = 19656 cycles, got ${vic.totalCycles - t0}`);
  expect(vic.raster === 0 && vic.cycleInLine === 0,
    `back at L0.c0 after exactly 1 frame`);
  ok('VIC: PAL frame = 312 lines × 63 cycles = 19656 cycles exactly');
}

console.log(`\n${testNo} frame-boundary spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
