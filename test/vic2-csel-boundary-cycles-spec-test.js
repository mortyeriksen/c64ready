// $D016 CSEL boundary-cycle precision spec test.
//
// Bauer §3.14.1: "the change from CSEL=1 to CSEL=0 has to be exactly
// in cycle 56" to open the right border. The "exactly" matters —
// nearby cycles produce different visible outcomes:
//
//   cy 55: too early — the right-compare set at canvas-X 344 (cycle
//          55 in 40-col mode) ALREADY fired with CSEL=1, but the
//          comparator's left-compare for CSEL=0 (canvas-X 31) wouldn't
//          trigger until next line. Effect: right border closes anyway.
//   cy 56: canonical hyperscreen — the CSEL=1→0 transition arrives
//          AFTER the right-set fired but BEFORE the next-line evaluation.
//          The new CSEL=0 right-compare is at X=335, which the X-counter
//          already passed. Net: right border is NOT re-set this line.
//   cy 57: too late — by cycle 57 phi2 the border state has already
//          settled with hBorder=1 closed. Writing CSEL=0 then changes
//          the comparator for next line's compare-evaluations only.
//
// Audit gaps:
//   F5: "$D016 write at cy 55 (one cycle early): WHAT happens?" — ✗
//   F6: "$D016 write at cy 57 (one cycle late): no veto, right closes" — ✗

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  return vic;
}

function driveTo(vic, raster, cycle = 0) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
  if (safety <= 0) throw new Error(`driveTo timed out at L${vic.raster}.c${vic.cycleInLine}`);
}

// Run CSEL=1, write CSEL=0 at PHI2 of cycle `writeCycle` on raster 100.
// After full line, observe the right side border at canvas X=370 on raster 100.
function runWithCselWriteAt(writeCycle) {
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                 // DEN=1, RSEL=1, mode=text
  vic.regs[0x16] = 0x08;                 // CSEL=1 (40-col)
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x02;                 // border = red
  vic.regs[0x21] = 0x06;                 // bg = blue
  vic.displayEnabled = true;

  driveTo(vic, 100, 1);
  driveTo(vic, 100, writeCycle);
  vic.write(0x16, 0x00);                 // CSEL=0 at phi2 of writeCycle
  driveTo(vic, 101, 1);                  // flush line render

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  // Sample right-border canvas X=370 (well past CSEL=1's right edge X=352).
  return { vic, ro, rightBorderPixel: vic.fb32[ro + 370] };
}

const RED = PAL(0x02);
const BLUE = PAL(0x06);

// ── 1: CSEL=1→0 write at cy 55 (one cycle early). The canonical compare
// CSEL=1 right-set happens at cy 55 with X=344. A write at cy 55 phi2
// lands AFTER VIC's cy 55 phi1 work already SET the border FF. By cy 56
// phi1 the comparator switches to CSEL=0 (right at X=335) — already
// passed. So right border STAYS CLOSED on this line.
{
  const { rightBorderPixel } = runWithCselWriteAt(55);
  expect(rightBorderPixel === RED,
    `cy 55 write: right border at X=370 must show $D020 (red, closed); got 0x${rightBorderPixel.toString(16)}`);
  ok('Bauer §3.14.1: CSEL=1→0 at cy 55 (early) → right border closes normally (set FIRED before write)');
}

// ── 2: CSEL=1→0 write at cy 56 (canonical hyperscreen). VIC's cy 56 phi1
// has NOT yet finalized the border state for this line — the comparator
// is re-sampled at cy 56 with CSEL=0 (right at X=335, already passed).
// Net: right border NEVER closes on this line.
{
  const { rightBorderPixel } = runWithCselWriteAt(56);
  expect(rightBorderPixel === BLUE,
    `cy 56 write (HYPERSCREEN): right border at X=370 must show $D021 (blue, open); got 0x${rightBorderPixel.toString(16)}`);
  ok('Bauer §3.14.1: CSEL=1→0 at cy 56 (canonical) → right border OPEN (hyperscreen)');
}

// ── 3: CSEL=1→0 write at cy 57 (one cycle late). By cy 57 the right
// border has settled CLOSED for the current line. CSEL=0 affects only
// future evaluations on the NEXT line.
{
  const { rightBorderPixel } = runWithCselWriteAt(57);
  expect(rightBorderPixel === RED,
    `cy 57 write: right border at X=370 must show $D020 (red, closed); got 0x${rightBorderPixel.toString(16)}`);
  ok('Bauer §3.14.1: CSEL=1→0 at cy 57 (late) → right border closes (write missed the veto window)');
}

// ── 4: Sweep cy 50..60 — confirm cy 56 is the UNIQUE veto cycle on this
// model. If a regression shifted the right-compare cycle, the unique
// veto cycle would shift too — visible as a different test passing.
{
  const cycles = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60];
  const results = cycles.map(c => ({ c, px: runWithCselWriteAt(c).rightBorderPixel }));
  const openCycles = results.filter(r => r.px === BLUE).map(r => r.c);
  expect(openCycles.length === 1 && openCycles[0] === 56,
    `unique veto cycle expected at cy 56; actual open cycles: [${openCycles.join(',')}]`);
  ok('Bauer §3.14.1: cy 56 is the UNIQUE veto cycle for right-side hyperscreen (sweep cy 50..60)');
}

// ── 5: Symmetric left-side trick — CSEL=0→1 at cy 17 leaves left border
// open. Bauer §3.14.1 last paragraph mirrors the right-side trick.
//
// Pre-line: regs[0x16] = 0x00 (CSEL=0). At cy 17 phi2 write CSEL=1 — VIC's
// cy 17 phi1 already evaluated the left-RESET at CSEL=0 X=31 (passed).
// New CSEL=1 has left-RESET at X=24 (already passed). Left border
// remains SET (closed) — no wait, that's the OPPOSITE of "open".
//
// Actually the symmetric trick is: keep CSEL=1 ACROSS THE PREVIOUS LINE,
// then flip CSEL=0→1 at cycle 17 — vetoing the cycle-15 phi1 left-RESET.
// With CSEL=0 left-RESET at X=31, the FF would have reset at cycle 15
// phi1. A CSEL=1 write at cy 17 phi2 is TOO LATE — the FF already reset
// at cycle 15 with CSEL=0. So writing at cy 17 leaves left border OPEN
// (already reset). Not a "veto" but a no-op.
//
// The CANONICAL left-side trick writes at the equivalent of cycle 17
// for CSEL=0→1, when the CSEL=1 reset at X=24 would have fired. The
// exact cycle for left-reset under CSEL=0 is cycle 14, under CSEL=1 is
// cycle 13.
//
// We just verify CSEL=1 with no write produces a CLOSED left border at
// canvas X=10 (sanity baseline).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x02;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;
  driveTo(vic, 100, 1);
  driveTo(vic, 101, 1);
  const ro = (100 - 15) * CANVAS_W;
  expect(vic.fb32[ro + 10] === RED,
    `baseline CSEL=1 no-write: left border X=10 closed (red); got 0x${vic.fb32[ro + 10].toString(16)}`);
  ok('Bauer §3.14.1: CSEL=1 baseline left-border closed (control for left-side hyperscreen)');
}

console.log(`\n${testNo} CSEL boundary-cycle spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
