// raster-irq-edge-trigger-spec-test.js
//
// Locks in the spec mechanism for the VIC-II raster IRQ comparator.
// Citations:
//   - Bauer §3.12 "Raster IRQ" — the raster compare is evaluated once
//     per raster line, in the first cycle of the line (cycle 2 for
//     line 0 because the raster counter latches one cycle late at the
//     line 311→0 wrap).
//   - https://sourceforge.net/p/vice-emu/code/HEAD/tree/techdocs/VICII/VIC-Addendum.txt §"Raster IRQ" (lines 59–66) — the compare
//     is EDGE-TRIGGERED. Verbatim:
//       "Raster comparison is edge triggered. If $d012 is changed to
//        always follow the raster counter it will never trigger an
//        IRQ condition."
//
// Together those passages define the mechanism:
//   * The raster IRQ flop latches on a LOW→HIGH transition of the
//     comparator output (raster == target) observed AT A SAMPLE POINT.
//   * Sample points are cycle 1 of each raster line (cycle 2 on
//     line 0). There is no sampling between cycle-1 sample points.
//   * Mid-line CPU writes to $D011/$D012 change the comparator's input
//     but do NOT themselves latch the IRQ — they only change what the
//     NEXT sample observes. The implementation may carry an internal
//     "comparator dipped HIGH→LOW since last sample" flag so a later
//     sample can register a fresh rising edge even if the previous
//     sample already saw HIGH; this is permitted by the edge rule and
//     does not contradict the addendum (the latch still fires only at
//     a sample point).
//
// These tests are deliberately VIC-only (no CPU) so they exercise the
// comparator/edge mechanism directly. CPU+VIC IRQ chain integration
// is covered by raster-irq-chain-spec-test.js.

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

function makeVic() {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout (raster=${vic.raster} cycle=${vic.cycleInLine}, want ${raster}/${cycle})`);
  }
}

// ── 1: Bauer §3.12 — sample point is cycle 1 of each line ───────────────
// A target raster's IRQ fires when the VIC reaches cycle 1 of that
// line, not before, not after.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);    // RST8 = 0
  vic.write(0x12, 50);

  driveTo(vic, 50, 0);                        // one cycle before sample
  expect(irqCalls === 0, `IRQ must not fire before the L50.c1 sample, got ${irqCalls}`);

  driveTo(vic, 50, 1);                        // sample point
  expect(irqCalls === 1, `IRQ must fire at L50.c1 sample, got ${irqCalls}`);
  expect((vic.irqStatus & 0x81) === 0x81, `latch + IRQ-pending bits set`);

  ok('Bauer §3.12: raster compare samples at cycle 1 of each raster line');
}

// ── 2: Bauer §3.12 — line 0 samples at cycle 2, not cycle 1 ─────────────
// The raster counter latches one cycle late at the 311→0 wrap, so for
// line 0 only, the per-line compare runs at cycle 2.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 0);                          // target = raster 0

  driveTo(vic, 0, 1);                          // L0.c1 — too early
  expect(irqCalls === 0, `L0.c1 must NOT fire (line 0 samples at c2), got ${irqCalls}`);

  driveTo(vic, 0, 2);                          // L0.c2 — sample point for line 0
  expect(irqCalls === 1, `L0.c2 must fire raster IRQ, got ${irqCalls}`);

  ok('Bauer §3.12: line 0 raster compare is delayed to cycle 2');
}

// ── 3: $D012 follow-raster mid-line writes fire ONCE per line ──────────
//
// Bauer §3.12 (verbatim): "It is possible to trigger an interrupt
// immediately by writing to $d011/$d012, but the interrupt can never
// occur more than once per raster line."
//
// The VIC-Addendum's "always follows raster ... never triggers IRQ"
// note describes a TIGHTER scenario (= $D012 written every cycle so
// the comparator never observes a LOW state). In the more realistic
// "once per line" pattern below, the comparator does dip to LOW at
// each raster increment, then rises HIGH again when $D012 catches up
// to the new raster — that's a real rising edge and must fire.
//
// Locks VICE/silicon behavior: OrbitUntold's IRQ chain relies on
// $D012=$f8 written at L248.c3 firing the L248 IRQ mid-line, since
// cycle 1 of L248 has already passed by then.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 50);                         // park target at L50 first

  driveTo(vic, 60, 1);                         // skim past L50's natural fire
  vic.write(0x19, 0x01);                       // ack the L50 IRQ
  irqCalls = 0;                                // reset counter — we measure from here

  // Walk lines 60..80 inclusive, writing target = current raster each
  // line, mid-line (after the cy-1 sample has already happened).
  // Each write is a LOW→HIGH transition (target changed from prev raster
  // to current) → fires once per line.
  for (let r = 60; r <= 80; r++) {
    driveTo(vic, r, 30);
    vic.write(0x12, r);                        // target := current raster
    vic.write(0x19, 0x01);                     // ack so each line's fire counts independently
  }
  driveTo(vic, 85, 5);                         // let a few more samples run

  // 21 lines × 1 fire/line = 21 IRQs.
  expect(irqCalls === 21,
    `mid-line $D012=raster fires once per line: expected 21, got irqCalls=${irqCalls}`);

  ok('Bauer §3.12: mid-line $D012=current-raster fires once per line (21 lines = 21 fires)');
}

// ── 4: Mid-line $D012 LOW→HIGH fires IMMEDIATELY on the current line ───
//
// Bauer §3.12 verbatim: "It is possible to trigger an interrupt
// immediately by writing to $d011/$d012." A write that brings the
// comparator HIGH mid-line fires the IRQ same-cycle, even if cycle 1
// has already passed.
//
// This is the OrbitUntold IRQ-chain mechanism: $D012=$f8 written at
// L248.c3 (long path) must fire L248 IRQ at c3.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 200);                        // far target — L100.c1 sees LOW

  driveTo(vic, 100, 30);                       // mid-L100, c1 sample passed
  vic.write(0x12, 100);                        // target := current raster (mid-line LOW→HIGH)

  expect(irqCalls === 1,
    `mid-line LOW→HIGH fires IRQ immediately, got ${irqCalls}`);

  driveTo(vic, 101, 2);                        // pass to next line — should NOT re-fire
  expect(irqCalls === 1,
    `once-per-line invariant: no re-fire at L101.c1, got ${irqCalls}`);

  ok('Bauer §3.12: mid-line $D012 LOW→HIGH fires immediately (once-per-line)');
}

// ── 5: Mid-line $D011 bit-7 LOW→HIGH fires immediately on this line ────
//
// Same mechanism as test 4 but exercised via the 9-bit target's high
// bit. Bit 7 of $D011 is bit 8 of the raster compare target.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);     // bit-7 = 0
  vic.write(0x12, 0);                          // target = raster 0 (bit-7=0)

  driveTo(vic, 256, 30);                       // mid-L256, bit-7 still 0 → LOW sample at c1
  // L0.c2 fired earlier (target=0 matched raster 0); ack it and zero the
  // counter so this test only measures the bit-7 retarget behavior.
  vic.write(0x19, 0x01);
  irqCalls = 0;
  vic.write(0x11, vic.regs[0x11] | 0x80);     // bit-7 := 1 → target = 256 (mid-line LOW→HIGH)

  expect(irqCalls === 1,
    `mid-line $D011 bit-7 retarget fires immediately on L256, got ${irqCalls}`);

  driveTo(vic, 257, 2);                        // pass L256→L257.c1
  expect(irqCalls === 1,
    `once-per-line: no re-fire when raster moves past target, got ${irqCalls}`);

  ok('Bauer §3.12: mid-line $D011 bit-7 LOW→HIGH fires immediately (once-per-line)');
}

// ── 6: Re-target mid-line to a FUTURE raster fires when that raster ─────
//        arrives — the normal edge-trigger re-arm.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 100);
  driveTo(vic, 100, 2);
  expect(irqCalls === 1, `initial fire at L100.c1`);
  vic.write(0x19, 0x01);

  vic.write(0x12, 110);                        // mid-line re-target to a future raster
  driveTo(vic, 110, 2);
  expect(irqCalls === 2,
    `L110.c1 sample produces fresh LOW→HIGH edge, got ${irqCalls}`);

  ok('VIC-Addendum: mid-line re-target to a future raster fires at that raster\'s sample');
}

// ── 7: Sustained HIGH does not refire (no LOW transition between samples)
//
// If the comparator stays continuously HIGH across two sample points
// without ever going LOW, the second sample must NOT fire. This is the
// direct edge-trigger semantic.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 100);
  driveTo(vic, 100, 2);
  expect(irqCalls === 1, `initial fire at L100.c1`);

  vic.write(0x19, 0x01);                       // ack the IRQ (clear $D019 latch)
  // Don't touch $D012. raster moves past 100. At L101.c1 comparator
  // is LOW (101 != 100); at L102.c1 still LOW. No refire.
  driveTo(vic, 102, 2);
  expect(irqCalls === 1,
    `with target unchanged, raster moving past target does NOT refire, got ${irqCalls}`);

  ok('VIC-Addendum: sustained HIGH (no LOW transition between samples) does not refire');
}

// ── 8: HIGH→LOW dip + recover across line wrap registers a fresh edge ───
//
// The edge rule treats "comparator dipped LOW between samples" as
// equivalent to "previous sample saw LOW" — so the next sample's HIGH
// is a fresh rising edge even if the previous sample also saw HIGH.
// This is needed to make re-targeting to the IMMEDIATELY-NEXT line
// (write $D012 = current_raster + 1 from within the L_n IRQ handler)
// produce a fire at L_(n+1).c1.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 100);
  driveTo(vic, 100, 2);                        // L100.c1 fires
  expect(irqCalls === 1, `initial fire`);

  vic.write(0x19, 0x01);
  // Mid-L100: target was 100 (HIGH for this line). Move it to 101
  // (HIGH→LOW dip mid-line — comparator now LOW for the remainder of
  // L100, then HIGH at L101.c1).
  vic.write(0x12, 101);

  driveTo(vic, 101, 2);                        // L101.c1 sample
  expect(irqCalls === 2,
    `L101.c1 must fire fresh edge after mid-line dip+recover, got ${irqCalls}`);

  ok('VIC-Addendum: HIGH→LOW dip re-arms the next sample\'s rising edge');
}

// ── 9: Edge-trigger applies even when ack happens AFTER the next sample
//
// The IRQ latch persists across sample points until W1C is performed.
// A new fire at a later sample requires a fresh LOW→HIGH transition;
// the previous unACKed latch does not block or duplicate it.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 100);
  driveTo(vic, 100, 2);
  expect(irqCalls === 1, `L100.c1 fires`);

  // Move target to 110 WITHOUT acking $D019. Latch bit stays set.
  vic.write(0x12, 110);
  driveTo(vic, 110, 2);
  expect(irqCalls === 2,
    `unACKed L100 latch does not suppress a fresh L110 fire, got ${irqCalls}`);
  expect((vic.irqStatus & 0x01) !== 0, `latch bit still set across both fires`);

  ok('Bauer §3.12: edge-triggered re-fire is independent of W1C state');
}

// ── Mid-line $D012 write at L248.c3 fires the L248 IRQ at once ───────────
// Bauer §3.12: "It is possible to trigger an interrupt immediately by writing
// to $d011/$d012". OrbitUntold's long-path frame lands $D012=$f8 at L248.c3,
// three cycles past the cycle-1 sample; without the mid-line fire the L248
// IRQ is skipped and the chain splits.
{
  const vic = makeVic();
  let irqFired = false, irqRaster = -1, irqCycle = -1;
  vic.irqHandler = (state) => {
    if (state && !irqFired) { irqFired = true; irqRaster = vic.raster; irqCycle = vic.cycleInLine; }
  };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);   // RST8 = 0
  vic.write(0x12, 250);                     // never matched on the way to L248
  driveTo(vic, 248, 3);
  expect(!irqFired, `pre-write: no IRQ has fired yet at L248.c3`);
  vic.write(0x12, 0xF8);                    // target now matches the current raster
  expect(irqFired, `mid-line $D012=$f8 at L248.c3 fires the L248 IRQ immediately (Bauer §3.12)`);
  expect(irqRaster === 248 && irqCycle === 3, `IRQ fires AT L248.c3, got r${irqRaster}.c${irqCycle}`);
  ok('Bauer §3.12: mid-line $D012 write that matches the current raster fires at the write cycle');
}

// ── Once per line: a dip and re-rise on the same line does not refire ────
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 200);
  driveTo(vic, 100, 20);
  vic.write(0x12, 100);                     // LOW→HIGH: fire #1
  expect(irqCalls === 1, `first fire`);
  vic.write(0x12, 200);                     // HIGH→LOW
  vic.write(0x12, 100);                     // LOW→HIGH again, same line
  expect(irqCalls === 1, `second LOW→HIGH on the same line must NOT re-fire (once per line)`);
  ok('Bauer §3.12: the raster IRQ can never occur more than once per raster line');
}

console.log(`\n${testNo} raster-IRQ edge-trigger spec tests; ${failing} fail`);
if (failing) process.exit(1);
