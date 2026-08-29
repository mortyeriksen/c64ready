// $D018 written AFTER a failed/aborted bad line must not become the
// next-row source — no c-fetch, no row-source latching, no pixels.
//
// Bauer §3.7.2: the internal video matrix/color line is loaded only by
// c-accesses fired in cycles 12-54 of a bad-line. Per §3.5 the bad-line
// condition is the gate: no BL → no c-access → no fresh matrix row.
//
// Practical concern (the scene-class snapshot this test guards against):
//   1. A bad-line at raster R fires briefly, then is aborted before any
//      c-access actually runs (or all c-accesses were invalid AEC-lag
//      reads).
//   2. The CPU later writes $D018 to point at a hostile VM/CB pair
//      (here: $48 → screen=$5000, char=$6000) on a non-bad-line raster.
//   3. The rendering must NOT pick up that $D018 as a row source. The
//      VIC has nothing to render from — `rowFetchedCols` is still all
//      zero from the failed line, so the renderer falls through to the
//      background color, not the striped char-0 glyph at $6000.
//
// What we assert (Bauer-derived):
//   • Bauer §3.7.2 rule 3: c-accesses fire only when BL true in c12-54.
//     With BL false across $30..$32, NO column is ever marked fetched
//     (`rowFetchedCols` stays all-zero).
//   • Per-row source registers are only latched at c-fetch start (the
//     hardware reads $D018 as the c-fetch begins; without a c-fetch,
//     no new row source can be latched). We pin this via the model's
//     `rowFetchD018` register — it must not reflect the hostile $48.
//
// `seg.rowFetchedCols[col]` is the renderer's matrix-mode gate, so the
// spec invariant is also directly pixel-observable.

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
  v.currentVicBank = 0x4000;
  // Hostile harness: $5000 = all zero (= char $00), $6000 = striped
  // glyph for char $00. If our impl ever lets $D018=$48 leak into
  // a row source without a c-fetch, the renderer would draw this
  // striped pattern across the screen.
  for (let i = 0; i < 0x0400; i++) v.ram[0x5000 + i] = 0x00;
  for (let row = 0; row < 8; row++) v.ram[0x6000 + row] = 0xAA;
  for (let i = 0; i < 0x0400; i++) v.colorRam[i] = 0x07;
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

function countFetched(vic) {
  let n = 0;
  for (let col = 0; col < 40; col++) if (vic.rowFetchedCols[col]) n++;
  return n;
}

// ── 1: failed BL @ $30 + later $D018=$48 + later $D011 restore ──────────
//
// Schedule (YSCROLL=7 cancel so no subsequent raster matches):
//   raster $30, cy 12: write $D011 = $1F (cancel BL via YSCROLL=7)
//   raster $31, cy 20: write $D018 = $48 (hostile VM/CB)
//   raster $32, cy 20: write $D011 = $18 (restore YSCROLL=0; raster
//                       $32 = 50, 50&7 = 2 ≠ 0, still NOT a bad-line)
//
// Across $30..$32, raster & 7 ∈ {0,1,2} so YSCROLL=7 keeps BL false the
// whole time, and the final $D011=$18 restore lands well past c14 and
// 50&7=2 ≠ 0 so no late BL either. NO c-fetch is ever justified.
//
// Expected through all three rasters:
//   • No column is ever marked fetched.
//   • `rowFetchD018` is never $48 — it's only updated by a real begin-
//     fetch path. The starting value (matches whatever the regs hold)
//     persists.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                  // DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;                  // harmless VM/CB ($0400/$0000 from bank 0 perspective)
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 1);
  // Initial conditions: RC=7, no display, fresh frame state.
  vic.displayActive = false;
  vic.rc = 7;
  vic.vc = 0;
  vic.vcBase = 0;
  // c12 phi1: BL true → queue. c12 phi2 write cancels.
  driveTo(vic, 0x30, 11);
  vic.clock(1);                            // c12: queue
  vic.write(0x11, 0x18 | 7);              // YSCROLL=7 cancel (no match on $30..$32)
  // Drive through end of raster $30 — no fetch should happen.
  while (!(vic.raster === 0x31 && vic.cycleInLine === 1)) vic.clock(1);
  expect(countFetched(vic) === 0,
    `raster $30 (failed BL): no col fetched (got ${countFetched(vic)})`);
  expect(vic.rowFetchD018 !== 0x48,
    `raster $30: rowFetchD018 not latched to hostile $48 (got $${vic.rowFetchD018.toString(16)})`);

  // raster $31: write hostile $D018 at cycle 20.
  driveTo(vic, 0x31, 20);
  vic.write(0x18, 0x48);                  // hostile VM/CB
  // Drive through end of raster $31. Raster 49 & 7 = 1, YSCROLL=7 (set
  // by the cancel above) → no BL.
  while (!(vic.raster === 0x32 && vic.cycleInLine === 1)) vic.clock(1);
  expect(countFetched(vic) === 0,
    `raster $31 (no BL): hostile $D018 must not seed any row, got ${countFetched(vic)} fetched`);
  expect(vic.rowFetchD018 !== 0x48,
    `raster $31: rowFetchD018 still not $48 (got $${vic.rowFetchD018.toString(16)})`);

  // raster $32 cycle 20: write $D011=$18 (YSCROLL=0). Raster 50 & 7 = 2,
  // YSCROLL=0 — no match, no BL.
  driveTo(vic, 0x32, 20);
  vic.write(0x11, 0x18);
  while (!(vic.raster === 0x33 && vic.cycleInLine === 1)) vic.clock(1);
  expect(countFetched(vic) === 0,
    `raster $32 (no BL): $D018=$48 + $D011=$18 must not produce a row, got ${countFetched(vic)} fetched`);
  expect(vic.rowFetchD018 !== 0x48,
    `raster $32: rowFetchD018 still not $48 (got $${vic.rowFetchD018.toString(16)})`);
  ok('Bauer §3.5/§3.7.2: $D018 write without a real BL c-fetch never becomes the row source');
}

// ── 2: control — real BL DOES latch $D018 into rowFetchD018 ─────────────
//
// Symmetric control test: same hostile $D018 value, but on a raster
// that IS a bad-line. The c-fetch should run, rowFetchD018 should
// reflect $48, and rowFetchedCols should be all 1s. This proves the
// latch path is alive and that the "no row" outcome in test 1 above
// isn't from a stuck rowFetchD018 latch.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                  // DEN=1, YSCROLL=0
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 1);
  // Write the hostile $D018 well before raster $38's c14 BL fire.
  driveTo(vic, 0x37, 20);
  vic.write(0x18, 0x48);
  // Raster $38 = 56, 56 & 7 = 0, YSCROLL=0 → canonical BL @ c14.
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);
  expect(vic.rowFetchD018 === 0x48,
    `control: real BL fetch latches $D018=$48 into rowFetchD018 (got $${vic.rowFetchD018.toString(16)})`);
  expect(countFetched(vic) === 40,
    `control: real BL fills all 40 cols (got ${countFetched(vic)})`);
  ok('Control: a real BL c-fetch DOES latch $D018=$48 — proves the latch path is alive');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
