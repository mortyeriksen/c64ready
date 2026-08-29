// vic2-raster-irq-follow-no-trigger-spec-test.js
//
// Locks the VIC-Addendum raster-IRQ "edge triggered" rule and the
// testprogs/VICII/rasterirq/rasterirq_hold reference behavior.
//
// Spec citations:
//   - VIC-Addendum.txt, "Raster IRQ": "Raster comparison is edge
//     triggered. If $d012 is changed to always follow the raster counter
//     it will never trigger an IRQ condition." (patent US4572506)
//   - Bauer §3.12: "The test for reaching the interrupt raster line is
//     done in cycle 1 of every line ... It is possible to trigger an
//     interrupt immediately by writing to $d011/$d012, but the interrupt
//     can never occur more than once per raster line."
//
// The hold test runs a loop that writes `$d012 = current raster line` at
// each line's c63→c0 boundary (`stx $d012` at cy0). The comparator is then
// continuously HIGH (latch N == raster N across the boundary) → no rising
// edge → no IRQ. VICE (6569 AND 8565) reads $D019 == $70 (bit 0 clear) on
// every such line; the top border stays BLACK.
//
// Regression guard: the comparator edge detector must sample the VIC's TRUE
// raster counter (`this.raster`), not the CPU-visible (one-cycle-lagged)
// raster used for $D012 *reads*. Evaluating the boundary write against the
// lagged raster misreads it as a HIGH→LOW dip on line N-1, which falsely
// re-arms the cy1 sample and fires every line (border goes WHITE).

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

// Clock one full line, stopping at cycleInLine===0 of the NEXT line. The
// preceding clock() that wraps the line leaves `_lineJustEnded` set, so a
// write issued now reproduces the PRG's `stx $d012` landing at cy0 (the
// c63→c0 boundary where CPU-visible raster lags `this.raster` by 1).
function clockToLineStart(vic) {
  do { vic.clock(1); } while (vic.cycleInLine !== 0);
}

// ── 1: $D012 following the raster counter never triggers an IRQ
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);                  // enable raster IRQ
  vic.write(0x11, vic.regs[0x11] & 0x7F); // RST8 = 0
  vic.write(0x12, 16);                    // initial target = 16

  driveTo(vic, 16, 1);                    // let the natural L16 fire happen
  expect(irqCalls === 1, `natural L16.c1 fire happened (sanity), got ${irqCalls}`);
  vic.write(0x19, 0x01);                  // ack it (W1C bit 0)
  irqCalls = 0;

  // The "follow" loop: at the start of each line write $D012 = that line.
  for (let i = 0; i < 40; i++) {
    clockToLineStart(vic);                // pass previous line's cy1 sample
    expect((vic.irqStatus & 0x01) === 0,
      `$D019 bit0 stays clear entering L${vic.raster} (border BLACK, == VICE $70)`);
    vic.write(0x12, vic.raster & 0xFF);   // follow-write at the cy0 boundary
    expect(_fireSourceClean(vic),
      `no spurious mid-line dip armed by L${vic.raster} boundary write`);
  }
  expect(irqCalls === 0,
    `no raster IRQ fires while $D012 follows the raster counter, got ${irqCalls}`);

  ok('VIC-Addendum: $D012 following the raster counter never triggers an IRQ');
}

function _fireSourceClean(vic) {
  // The boundary follow-write must not have set the "comparator dipped"
  // re-arm flag — that is the exact bug this guards (using lagged raster).
  return vic._rasterCompMidLineDip === false;
}

// ── 2: A genuine boundary retarget (comparator was LOW) STILL fires
//   Guards against over-suppressing: writing $D012 = current raster at the
//   c63→c0 boundary when the comparator was LOW the previous line is a real
//   LOW→HIGH edge and must fire (Bauer §3.12 "trigger immediately").
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 200);                   // target far away → comparator LOW

  driveTo(vic, 99, 30);
  irqCalls = 0;
  clockToLineStart(vic);                  // now at L100.c0, _lineJustEnded set
  expect(vic.raster === 100, `at L100 boundary (got L${vic.raster})`);
  vic.write(0x12, 100);                   // retarget to current line at cy0
  expect(irqCalls === 1,
    `boundary write target=current raster (prev comparator LOW) fires once, got ${irqCalls}`);

  ok('boundary $D012 retarget from a LOW comparator still fires (Bauer §3.12)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
