// Late bad-line partial c-access is LINE-LOCAL — synthetic spec.
//
// Bauer §3.7.2 rule 3 + §3.5: a bad-line condition raised late in the
// DMA window (cycles 12-54, e.g. by a mid-line YSCROLL write) starts the
// c-accesses at max(15, N). If the window runs out before col 40, the
// fetch is PARTIAL. The c-access state machine is line-local: the partial
// fetch must NOT continue into the next raster line's c-access window —
// the new line's window is owned by whatever bad-line state that line
// establishes. (The impl enforces this in more than one layer — this test
// locks the black-box invariant plus the exact partial-fetch byte layout,
// so any shift in the window / BA-delay / c-access timing fails here.)
//
// This is the mechanism behind FPP-style scrollers (FppScroller.prg):
// they force a late bad-line on every raster line. Without the line-local
// rule, the partial fetch continued cross-line and stomped the matrix
// buffer with residual cols fetched under the WRONG $D018 VM/CB — the
// scroller area rendered as stacked garbage sub-rows. The demo-boot
// regression for this lives outside the suite; this spec locks the
// hardware rule synthetically.
//
// Scenario (observed via prototype, byte-exact):
//   - text display, matrix1 at $0400 (marker-filled mid-frame), ys=3
//   - on display line $45 (RC=2, not a bad line), write YSCROLL=5 at
//     cycle 50 → late bad line: BA at 50, AEC 3 cycles later → c-accesses
//     at cycles 53/54 only. Observed: cols 36..38 = $FF (invalid fetches,
//     AEC not yet low) and col 39 = the marker (one valid fetch).
//   - switch $D018 to matrix2 ($0800) after the window closes.
//   - next line $46 (ys=5, no match): the buffer must be IDENTICAL —
//     no continuation cols, and no bytes fetched from matrix2.

import { VIC2, CYCLES_PER_LINE, LINES_PER_FRAME } from '../src/vic2.js';

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
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  return v;
}
function driveTo(vic, raster, cycle) {
  let safety = LINES_PER_FRAME * CYCLES_PER_LINE * 3;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`driveTo timeout r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

const v = makeVic();
v.ram.fill(0x11, 0x0400, 0x0800);   // matrix1 (initial fill, fetched by earlier bad lines)
v.ram.fill(0x22, 0x0800, 0x0C00);   // matrix2 (the WRONG source for any cross-line continuation)
v.regs[0x18] = 0x14;                // VM=$0400, CB=$1000
v.regs[0x11] = 0x1B;                // DEN=1, RSEL=1, YSCROLL=3
v.regs[0x16] = 0x08;

driveTo(v, 0x30, 1);                // DEN latch
driveTo(v, 0x45, 5);                // display row line (RC=2 after bad line $43); 0x45&7=5 ≠ ys=3
v.ram.fill(0x33, 0x0400, 0x0800);   // re-mark matrix1 so a late fetch is distinguishable

// ── 1: late YSCROLL match at cycle 50 → PARTIAL c-access this line ───────
driveTo(v, 0x45, 50);
v.write(0x11, 0x18 | 5);            // YSCROLL=5 == 0x45&7 → bad line from cycle 50
driveTo(v, 0x45, 56);               // window (≤54) closed
v.write(0x18, 0x24);                // VM=$0800 — bait for a (buggy) continuation
driveTo(v, 0x46, 1);
const endN = Array.from(v.rowScreenCodes);
{
  // BA at cycle 50 → AEC low 3 cycles later → invalid ($FF) c-accesses at
  // cycles 51..53 land in cols 36..38, one valid fetch (col 39 = marker).
  expect(endN[36] === 0xFF && endN[37] === 0xFF && endN[38] === 0xFF,
    `cols 36..38 are invalid-fetch $FF (got ${endN.slice(36, 39).map(x => x.toString(16)).join(',')})`);
  expect(endN[39] === 0x33,
    `col 39 is the single valid late fetch (marker $33, got $${endN[39].toString(16)})`);
  for (let c = 0; c < 36; c++) {
    expect(endN[c] === 0x11, `col ${c} untouched by the partial late fetch (got $${endN[c].toString(16)})`);
  }
  ok('late bad line at cycle 50 does a PARTIAL c-access (3× invalid $FF + 1 valid col)');
}

// ── 2: the partial fetch must NOT continue on the next line ─────────────
driveTo(v, 0x47, 1);
const endN1 = Array.from(v.rowScreenCodes);
{
  const fromMatrix2 = endN1.filter(x => x === 0x22).length;
  expect(fromMatrix2 === 0,
    `no cols fetched from the switched $D018 matrix on line N+1 (got ${fromMatrix2} × $22)`);
  let diffs = 0;
  for (let c = 0; c < 40; c++) if (endN1[c] !== endN[c]) diffs++;
  expect(diffs === 0,
    `matrix buffer identical across the line boundary (got ${diffs} changed cols)`);
  ok('partial late c-access is line-local — nothing continues into line N+1');
}

console.log(`\n${testNo} late-bad-line c-access line-local spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
