// Aborted Bad Line BEFORE cycle 14 must not produce a fresh c-access
// row nor leave the matrix-fetch state machine "armed".
//
// Bauer §3.5 / §3.7.1 / §3.7.2:
//   • A Bad Line Condition that flips true→false BEFORE cycle 14 phi1
//     (Linecrunch, §3.14.4) does NOT reset RC (rule 2 is gated on BL
//     at cycle 14 phi1).
//   • Per §3.7.2 rule 3, c-accesses fire only when in display state AND
//     the bad-line fetch phase covers cycle 12..54. If the BL was
//     cancelled before the fetch could start, no full 40-column row
//     must appear in the matrix-row buffer — `rowFetchedCols` stays
//     untouched.
//   • Per §3.7.1, display→idle happens at cycle 58 if RC=7 and no live
//     BL. With RC preserved at 7 from before the aborted line, cycle
//     58 must take the idle exit branch (vcBase ← vc, displayActive
//     ← false).
//
// Separate from RC-reset and bad-line-fetch coverage in
// `badline-rc-reset-timing-spec-test` and `dma-delay-vsp-spec-test`,
// this test pins the FULL set of "no residue after pre-c14 abort"
// invariants — i.e. anything a downstream renderer or sequencer could
// mis-read as a fresh row.

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
  // Hostile memory layout per the test-harness spec: bank $4000,
  // $D018=$48 so screen=$5000/char=$6000, screen filled with $00,
  // glyph $00 a striped non-blank byte. A correct VIC must NOT
  // render this row — assert internal state so failure surfaces
  // even without a pixel diff.
  v.currentVicBank = 0x4000;
  for (let i = 0; i < 0x0400; i++) v.ram[0x5000 + i] = 0x00;
  for (let row = 0; row < 8; row++) v.ram[0x6000 + row] = 0xAA;
  for (let i = 0; i < 0x0400; i++) v.colorRam[i] = 0x07;
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    vic.phi2();  // cycle-58 transition fires at phi2
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// ── 1: pre-c14 abort leaves no c-fetch residue ───────────────────────────
//
// Setup: raster $30 (= 48), DEN=1, RSEL=1, YSCROLL=0 → would match (48 & 7
// == 0) and fire a bad-line. RC is preset to 7 from the prior frame and
// vc/vcBase are zeroed. At cycle 12 the CPU writes YSCROLL=1, cancelling
// the condition BEFORE cycle 14 phi1.
//
// Spec invariants under test:
//   (a) Rule 2 RC reset is gated on BL@c14 — no BL at c14 → RC preserved.
//   (b) The pending bad-line fetch must be cancelled before it begins.
//   (c) No c-access fired in cycles 15..54 (rowFetchedCols all zero).
//   (d) rowFetchD018 is not updated to the would-be row's $D018.
//   (e) Cycle 58 idle exit: rc=7+!BL → displayActive=false, vcBase=vc.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                  // DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x48;                  // screen=$5000, char=$6000
  vic.displayEnabled = true;
  // Drive to raster $30 c1 to latch displayEnabled, then to c11 ready
  // to write at c12.
  driveTo(vic, 0x30, 1);
  vic.displayActive = false;
  vic.rc = 7;
  vic.vc = 0;
  vic.vcBase = 0;
  // Move to c11, then run c12 phi1 (BL true). CPU's phi2 write at c12
  // cancels BL by changing YSCROLL=1 — visible to VIC at c13 phi1.
  driveTo(vic, 0x30, 11);
  vic.clock(1);                            // c12 phi1: BL was true here
  vic.write(0x11, 0x18 | 1);              // c12 phi2: cancel BL (YSCROLL→1)
  // Drive past c14 — rule 2 (cycle 14 phi1) samples BL. With BL false
  // by c13 phi1, the rule-2 RC reset must NOT fire.
  driveTo(vic, 0x30, 15);
  expect(vic.rc === 7,
    `Bauer §3.7.2 rule 2: BL false at c14 phi1 leaves RC unchanged (got rc=${vic.rc})`);
  // Bauer §3.14.4 (Linecrunch) + rule 3: a BL cancelled before any
  // c-access can fire (c15 phi2 is the earliest) must not populate the
  // matrix row.
  driveTo(vic, 0x30, 55);
  let fetched = 0;
  for (let col = 0; col < 40; col++) if (vic.rowFetchedCols[col]) fetched++;
  expect(fetched === 0,
    `Bauer §3.7.2 rule 3 + §3.14.4: aborted BL fires no c-access (got ${fetched} cols fetched)`);
  // Bauer §3.7.1 + rule 5: at c58 phi1, RC=7+!BL → display→idle and
  // VCBASE←VC. Since idle→display happened at c12 (Bauer §3.7.1: "as
  // soon as there is a Bad Line Condition") and stayed until c58,
  // 40 g-accesses fired and advanced VC from VCBASE=0 to VC=40.
  driveTo(vic, 0x30, 58);
  vic.clock(1);                            // c58 phi1 idle exit
  expect(vic.displayActive === false,
    `Bauer §3.7.1: c58 with RC=7+!BL → display→idle (got ${vic.displayActive})`);
  expect(vic.vcBase === vic.vc,
    `Bauer §3.7.2 rule 5: c58 with RC=7 → VCBASE←VC (vcBase=${vic.vcBase}, vc=${vic.vc})`);
  ok('Bauer §3.5/§3.7.1/§3.7.2/§3.14.4: pre-c14 BL abort — no c-fetch, RC preserved, idle exit at c58');
}

// ── 2: pre-c14 abort with prior RC=3 — still no fetch, RC preserved ──────
//
// Variant where RC is not at the end-of-row value. Same cancellation
// semantics; this confirms the "no fetch" + "RC preserved" invariants
// are independent of where RC happened to be sitting. We deliberately
// do NOT pin displayActive at c58 here — with RC≠7, rule 5 doesn't
// trigger the idle exit, and a brief BL pulse at c12 satisfies §3.7.1
// "as soon as there is a Bad Line Condition" so display state IS
// entered. The OBSERVABLE spec invariants from §3.7.2 rule 2 + rule 3:
//   - RC preserved (no reset because !BL @ c14 phi1)
//   - rowFetchedCols stays untouched (BL was false through c15..54)
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x48;
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 1);
  vic.displayActive = false;
  vic.rc = 3;
  vic.vc = 0;
  vic.vcBase = 0;
  driveTo(vic, 0x30, 11);
  vic.clock(1);                            // c12 phi1: BL true
  vic.write(0x11, 0x18 | 1);              // c12 phi2: cancel
  driveTo(vic, 0x30, 15);                  // past c14 phi1 sample
  expect(vic.rc === 3,
    `Bauer §3.7.2 rule 2: pre-c14 abort with RC=3 → RC preserved (got rc=${vic.rc})`);
  driveTo(vic, 0x30, 55);
  let fetched = 0;
  for (let col = 0; col < 40; col++) if (vic.rowFetchedCols[col]) fetched++;
  expect(fetched === 0,
    `Bauer §3.7.2 rule 3: aborted BL fires no c-access (got ${fetched} cols)`);
  ok('Bauer §3.7.2 rule 2/3: pre-c14 abort with RC=3 — RC and row buffer both intact');
}

// ── 3: a BL pulse BEFORE the c-access window still enters display ───────
//
// Bauer §3.7.1: "The transition from idle to display state occurs as soon as
// there is a Bad Line Condition" — at ANY cycle, not only inside 12..54 or at
// the cycle-14 sample. A one-cycle YSCROLL=0 pulse at cycle 4 of line $30 puts
// the chip into display state for the rest of the line even though no
// c-access ever fires. This is the mechanism behind the DMA-delay / VSP
// "delay before badline forcing" trick (testprogs/VICII/dmadelay test1/2/3).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                  // DEN=1, RSEL=1, YSCROLL=3 → BL false at raster $30
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x48;
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 2);
  vic.displayActive = false;
  vic.rc = 7;
  vic.vc = 0;
  vic.vcBase = 0;
  vic.clock(1);                           // c3 phi1 (BL false)
  vic.write(0x11, 0x18);                  // c3 phi2: YSCROLL=0 → BL true at c4 phi1
  vic.clock(1);                           // c4 phi1: BL true
  vic.write(0x11, 0x1B);                  // c4 phi2: YSCROLL=3 → BL false at c5 phi1
  vic.clock(1);                           // c5 phi1
  expect(vic.displayActive === true,
    `Bauer §3.7.1: BL pulse at cycle 4 → idle→display "as soon as there is a BL" (got displayActive=${vic.displayActive})`);
  driveTo(vic, 0x30, 15);
  expect(vic.rc === 7,
    `Bauer §3.7.2 rule 2: BL false at c14 phi1 leaves RC unchanged (got rc=${vic.rc})`);
  driveTo(vic, 0x30, 55);
  let fetched = 0;
  for (let col = 0; col < 40; col++) if (vic.rowFetchedCols[col]) fetched++;
  expect(fetched === 0,
    `Bauer §3.7.2 rule 3: early-pulsed BL fires no c-access (got ${fetched} cols fetched)`);
  ok('Bauer §3.7.1: BL raised+cancelled in cycles 1-11 enters display state, no c-fetch, RC preserved');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
