// MxYE / sprite-crunch / D018 mid-line p-access spec audit. Targets the
// behaviors `nine.prg` requires per `https://www.linusakesson.net/scene/nine/explanation.php` rules 2 and 3:
//   - Bauer §3.8.1 rule 3 (2024): cycle 56 PHI1, if MxYE=1 AND DMA on,
//     the advance-line FF is XORed (toggled). MxYE is sampled BEFORE the
//     CPU's same-cycle $D017 write — a SET landing at phi2 is too late to
//     invert this cycle (see test 11, ground truth = spritecrunch2).
//   - Bauer §3.8.1 rule 7a: at cycle 15 phi1, if the CPU clears MxYE for
//     a sprite whose FF was 0, FF is force-set AND a sprite-crunch is
//     latched; cycle 16 then computes MCBASE from a bit-interleave
//     formula instead of MCBASE := MC. This is what produces the
//     triple-height anchor sprites in nine.prg.
//   - DEMO-NINE rule 3: sprite p-access reads the LIVE $D018 value at the
//     fetch cycle, not a line-start snapshot.
//
// Plus 2 tests verifying the D017 / D018 CPU-write trace lands in the
// frame-trace buffers when frameTraceEnabled=true.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Drive the VIC to a specific (raster, cycle) by clocking from current
// position. Used to position the chip just before a CPU write.
function driveTo(vic, targetRaster, targetCycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === targetRaster && vic.cycleInLine === targetCycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
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

// ── 1: cycle-56 phi1 toggles FF for MxYE=1 sprites with DMA on ─────────
// Bauer §3.8.1 rule 3 (2024): at cycle 56, if the MxYE bit is set in
// $D017 (sampled at phi1) and DMA is on, the advance-line flip-flop is
// inverted. Here MxYE is set going into the cycle, so the phi1 pass toggles.
{
  const vic = makeVic();
  // Enable sprite 0 with DMA already on, MxYE=1.
  vic.regs[0x15] = 0x01;             // sprite 0 enabled
  vic.regs[0x17] = 0x01;             // sprite 0 Y-expanded
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;        // start at 1
  // Drive to cycle 56. Cycle 56 runs the toggle at line end of frame
  // start; just clock through cycles 0..56 of line 0.
  driveTo(vic, 0, 56);
  expect(vic.spriteYExpandFF[0] === 0,
    `cycle 56 with MxYE=1 + DMA on: FF must toggle 1→0, got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 3 (2024): cycle 56 toggles FF when MxYE=1 + DMA on');
}

// ── 2: cycle-56 phi2 does NOT toggle FF if MxYE=0 ──────────────────────
// Per rule 1, FF is forced to 1 while MxYE=0. The cycle-56 toggle only
// applies if MxYE bit is set.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;             // MxYE off
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;
  driveTo(vic, 0, 56);
  expect(vic.spriteYExpandFF[0] === 1,
    `MxYE=0: FF must remain 1, got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 1: MxYE=0 → FF stays 1 (cycle 56 toggle gated)');
}

// ── 3: cycle-56 phi2 does NOT toggle FF if DMA off ─────────────────────
// Rule 3 requires DMA on (sprite actively fetching). Without DMA, the
// toggle is gated out.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;             // sprite disabled (no DMA start)
  vic.regs[0x17] = 0x01;             // MxYE=1 (would toggle if DMA on)
  vic.regs[0x01] = 200;              // sprite 0 Y=200 (no Y match at line 0)
  vic.spriteDmaOn[0] = 0;            // DMA off
  vic.spriteYExpandFF[0] = 1;
  driveTo(vic, 0, 56);
  expect(vic.spriteYExpandFF[0] === 1,
    `DMA off: cycle 56 toggle gated, FF must stay 1, got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 3: cycle 56 toggle gated when DMA off');
}

// ── 4: cycle-15 + clear MxYE with FF=0 → crunchPending latched ─────────
// Bauer §3.8.1 rule 7a: at cycle 15 phi1, if CPU clears MxYE bit and the
// matching FF was 0, the sprite-crunch trigger is latched, and FF is
// force-set to 1 (rule 1). Stay in line 0 to avoid cycle-56 of any prior
// line touching FF.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;             // sprite disabled to avoid DMA start
  vic.regs[0x17] = 0x01;             // MxYE=1 set
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;             // pre-set DMA on (rule 7a needs sprite tracked)
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;        // arrange FF=0 just before cycle 15
  vic.clock(1);                       // advance to cycle 15
  vic.write(0x17, 0x00);              // CPU clears MxYE during cycle 15
  expect(vic._spriteCrunchPending[0] === 1,
    `clearing MxYE at cycle 15 with FF=0: crunchPending must be 1, got ${vic._spriteCrunchPending[0]}`);
  expect(vic.spriteYExpandFF[0] === 1,
    `clearing MxYE always force-sets FF to 1 (rule 1), got FF=${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 7a: clearing MxYE at cycle 15 with FF=0 latches crunchPending');
}

// ── 5: cycle-15 clear with FF=1 — Bauer 7a FF gate: NO crunch ─────────
// Bauer §3.8.1 rule 7a gates the crunch on the FF being UNSET before the
// c15 clear. With the FF already set, the c15 clear does NOT latch the
// crunch (cycle 16 then runs the clean MCBASE := MC). The addendum's
// rule-7 wording reads as if this gate is gone, but the Coma Light 13
// sprite-stretch release proves it is real — see
// sprite-crunch-addendum-spec-test.js / sprite-crunch-rule-7a-spec-test.js.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;
  vic.clock(1);
  vic.write(0x17, 0x00);
  expect(vic._spriteCrunchPending[0] === 0,
    `rule 7a: clearing MxYE at cycle 15 with FF already set does NOT latch crunch, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer 7a: clearing MxYE at cycle 15 with FF already set does NOT latch crunch (FF gate)');
}

// ── 6: clear at cycle 14 (outside window) does NOT latch crunch ───────
// The crunch trigger window is exactly cycle 15 phi1.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.write(0x17, 0x00);              // write at cycle 14 — outside window
  expect(vic._spriteCrunchPending[0] === 0,
    `clear at cycle 14 (outside window): crunchPending must remain 0, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer §3.8.1 rule 7a: crunch window is exactly cycle 15 (cycle 14 ignored)');
}

// ── 7: cycle 16 applies crunch formula when crunchPending set ─────────
// Bauer §3.8.1 rule 7a: at cycle 16 with crunchPending,
//   MCBASE := (101010 & (MCBASE & MC)) | (010101 & (MCBASE | MC))
// This is the bit-interleave that produces the famous triple-height look.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 0;
  vic.spriteMCBase[0] = 0b011010;    // = 26
  vic.spriteMC[0]     = 0b101100;    // = 44
  vic.clock(1);                       // → cycle 15
  vic.write(0x17, 0x00);              // latch crunch
  vic.clock(1);                       // → cycle 16: crunch formula applies
  const mcb = 0b011010, mc = 0b101100;
  const expected = ((0b101010 & (mcb & mc)) | (0b010101 & (mcb | mc))) & 0x3F;
  expect(vic.spriteMCBase[0] === expected,
    `crunch MCBASE = ${expected.toString(2)}, got ${vic.spriteMCBase[0].toString(2)}`);
  ok('Bauer §3.8.1 rule 7a: cycle 16 applies bit-interleave crunch formula');
}

// ── 8: cycle 16 NORMAL update (MCBASE := MC) when crunchPending=0 ─────
// With FF=1 and no crunch pending, cycle 16 phi1 just loads MC into MCBASE.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;
  vic.spriteMCBase[0] = 9;
  vic.spriteMC[0]    = 12;
  vic.clock(2);                       // → cycle 16: MCBASE := MC
  expect(vic.spriteMCBase[0] === 12,
    `non-crunch cycle 16: MCBASE := MC (=12), got ${vic.spriteMCBase[0]}`);
  ok('Bauer §3.8.1 rule 7: cycle 16 phi1 loads MCBASE from MC when FF=1');
}

// ── 9: sprite p-access reads LIVE $D018 at the fetch cycle ────────────
// DEMO-NINE rule 3: a CPU `sta $d018` between cycles 57 and 58 must
// redirect sprite 0's pointer fetch to the new screen-base.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;             // disable to control DMA manually
  vic.regs[0x01] = 200;              // sprite 0 Y far from raster 0
  vic.spriteDmaOn[0] = 1;             // pre-arm DMA so p-access fires at c58
  // Two distinct RAM-backed screen-bases (avoid CHARROM mirror at $1000-$1FFF
  // in bank 0):
  //   $D018=$10 → bits[7..4]=1 → screen base $0400, ptr addr $07F8
  //   $D018=$30 → bits[7..4]=3 → screen base $0C00, ptr addr $0FF8
  vic.regs[0x18] = 0x10;
  vic.ram[0x07F8] = 0x11;            // ptr if OLD D018 was used
  vic.ram[0x0FF8] = 0x77;            // ptr if NEW D018 was used
  driveTo(vic, 0, 57);                // one before sprite 0's p-access
  vic.write(0x18, 0x30);              // CPU write between 57 and 58
  vic.clock(1);                       // run cycle 58 (sprite 0 p-access)
  expect(vic.spritePointerValue[0] === 0x77,
    `sprite 0 p-access must read NEW D018 ($30): expected ptr=$77, got $${vic.spritePointerValue[0].toString(16)}`);
  ok('DEMO-NINE rule 3: sprite p-access reads live $D018 at fetch cycle');
}

// ── 10: D017 / D018 CPU writes land in frame-trace buffers ────────────
// Verifies the new D017Writes / D018Writes traces capture {raster, cycle,
// value} entries. Used for diagnosing the demo's MxYE-crunch timing
// without per-cycle state dumps.
{
  const vic = makeVic();
  vic.frameTraceEnabled = true;
  driveTo(vic, 0, 10);
  vic.write(0x17, 0x0F);             // D017 write at raster 0 cycle 10
  driveTo(vic, 1, 30);
  vic.write(0x18, 0x42);             // D018 write at raster 1 cycle 30
  expect(vic._d017WritesCurrent.length === 1,
    `D017 trace must have 1 entry, got ${vic._d017WritesCurrent.length}`);
  expect(vic._d017WritesCurrent[0]?.raster === 0 &&
         vic._d017WritesCurrent[0]?.cycleInLine === 10 &&
         vic._d017WritesCurrent[0]?.value === 0x0F,
    `D017 entry: expected {0, 10, $0F}, got ${JSON.stringify(vic._d017WritesCurrent[0])}`);
  expect(vic._d018WritesCurrent.length === 1,
    `D018 trace must have 1 entry, got ${vic._d018WritesCurrent.length}`);
  expect(vic._d018WritesCurrent[0]?.raster === 1 &&
         vic._d018WritesCurrent[0]?.cycleInLine === 30 &&
         vic._d018WritesCurrent[0]?.value === 0x42,
    `D018 entry: expected {1, 30, $42}, got ${JSON.stringify(vic._d018WritesCurrent[0])}`);
  ok('frame-trace: D017/D018 CPU writes captured with {raster, cycle, value}');
}

// ── 11: phi2 reconcile — CPU SETS MxYE at c56-phi2 → NO inversion ─────
// Rule 3's inversion samples MxYE at cycle 56 PHI1, BEFORE the CPU's
// same-cycle $D017 write. A bit the CPU only SETS at phi2 is too late to
// participate in this cycle's inversion, so the FF must be left untouched.
//
// GROUND TRUTH: testprogs/VICII/spritecrunch — spritecrunch2 delays 38-41
// (-26..-29). The trick clears MxYE then re-sets it (`sty $d017`) at a cycle
// that drifts per 8-line block: cy55, cy56, cy57. A re-set landing at cy55 is
// MxYE=1 by phi1 → inverts (sprite held). A re-set at cy56 phi2 must NOT
// invert → the crunch releases (MCBASE starts advancing). Inverting on the
// phi2 SET held the crunch 8 rasterlines too long (released at the cy57 block
// instead of VICE's cy56 block), making the sprite 8 rows too tall. With this
// rule, ours == the VICE pepto reference byte-for-byte for all 8 spritecrunch2
// variants. nine.prg is unaffected (it issues no cy56-phi2 $D017 SET).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;             // MxYE=0 going into phi1
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;
  driveTo(vic, 0, 56);                // phi1 ran with MxYE=0 → no toggle
  expect(vic.spriteYExpandFF[0] === 1, `phi1 with MxYE=0: FF stays 1`);
  vic.write(0x17, 0x01);              // CPU c56-phi2: set MxYE (too late for rule 3)
  vic.phi2();
  expect(vic.spriteYExpandFF[0] === 1,
    `phi2: a SET landing at c56-phi2 is too late to invert → FF stays 1, got ${vic.spriteYExpandFF[0]}`);
  ok('phi2 reconcile: CPU SET of MxYE at c56-phi2 does NOT invert (rule 3 samples phi1)');
}

// ── 12: phi2 reconcile — CPU clears MxYE at c56-phi2 → toggle undone ──
// Inverse of test 11. phi1 toggled because MxYE=1; CPU clears it during
// phi2; post-reconcile, the FF must be back where it started.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;
  driveTo(vic, 0, 56);                // phi1 toggled FF: 1 → 0
  expect(vic.spriteYExpandFF[0] === 0, `phi1 toggle landed: FF=0`);
  vic.write(0x17, 0x00);              // CPU c56-phi2: clear MxYE
  vic.phi2();
  expect(vic.spriteYExpandFF[0] === 1,
    `phi2 reconcile: post-CPU MxYE=0 → rule-1 force holds FF=1, got ${vic.spriteYExpandFF[0]}`);
  ok('phi2 reconcile: CPU clears MxYE at c56-phi2 undoes the toggle');
}

// ── 13: phi2 reconcile — no CPU write → phi2 is a no-op at c56 ────────
// When the mask is stable across the cycle, snapshot matches live $D017
// and phi2 must not double-toggle.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;
  driveTo(vic, 0, 56);                // phi1 toggled FF: 1 → 0
  vic.phi2();                          // no $D017 change
  expect(vic.spriteYExpandFF[0] === 0,
    `phi2 with stable mask must not re-toggle, got FF=${vic.spriteYExpandFF[0]}`);
  ok('phi2 reconcile: stable mask leaves FF untouched');
}

console.log(`\n${testNo} MxYE-crunch / D018-p-access spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
