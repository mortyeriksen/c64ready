// Bauer §3.11 / §3.12 lightpen spec audit.
//
//   §3.11: A negative edge on the LP input latches the current 9-bit
//          raster X into LPX ($D013) and the lower 8 bits of raster Y
//          into LPY ($D014). The reference point is the END of the
//          cycle in which LP was triggered. Calibration: trigger in
//          cycle 20 → LPX = $1E (= 9-bit X $03C, upper 8 bits).
//          Only ONE negative edge per frame is recognised; subsequent
//          edges are ignored until raster wraps to 0.
//   §3.12 bit 3 LP: latch sets $D019 bit 3 on the same negative edge.
//          IRQ fires only if $D01A bit 3 is set, and the latch is
//          cleared by writing 1 to bit 3 of $D019 ("write 1 to clear").

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
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// ── 1: Bauer's §3.11 calibration: cycle 20 → LPX=$1E, LPY=raster ─────────
{
  const vic = makeVic();
  vic._lpInputLevel = 1;                  // start high (idle)
  driveTo(vic, 0x40, 20);
  vic.setLightpenLevel(0);                // negative edge at L$40 c20
  expect(vic.regs[0x13] === 0x1E,
    `LPX must latch to $1E at cycle 20 (Bauer §3.11 calibration), got $${vic.regs[0x13].toString(16)}`);
  expect(vic.regs[0x14] === 0x40,
    `LPY must latch to raster $40, got $${vic.regs[0x14].toString(16)}`);
  ok('Bauer §3.11: trigger at cycle 20 → LPX=$1E ($03C >> 1), LPY=raster');
}

// ── 2: Different cycle gives different LPX (formula: end of cycle N ─────
//      → 9-bit X = ($194 + N*8) mod 504; LPX = (9-bit X) >> 1)
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  driveTo(vic, 0x80, 30);
  vic.setLightpenLevel(0);
  // end-of-c30 9-bit X = ($194 + 30*8) mod 504 = (404 + 240) mod 504 = 140 = $8C
  // LPX = $8C >> 1 = $46
  expect(vic.regs[0x13] === 0x46,
    `LPX at cycle 30 must be $46, got $${vic.regs[0x13].toString(16)}`);
  expect(vic.regs[0x14] === 0x80,
    `LPY at raster $80 must be $80, got $${vic.regs[0x14].toString(16)}`);
  ok('Bauer §3.11: end-of-cycle-N formula scales LPX correctly');
}

// ── 3: Only ONE trigger per frame — second edge is ignored ──────────────
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  driveTo(vic, 0x30, 20);
  vic.setLightpenLevel(0);                // first negative edge: latches
  expect(vic.regs[0x13] === 0x1E,
    `first edge latches LPX, got $${vic.regs[0x13].toString(16)}`);
  // Re-arm by going high then low again, on a DIFFERENT cycle
  vic.setLightpenLevel(1);
  driveTo(vic, 0x60, 30);
  vic.setLightpenLevel(0);                // second edge: must NOT update
  expect(vic.regs[0x13] === 0x1E,
    `second edge in same frame must NOT update LPX, got $${vic.regs[0x13].toString(16)}`);
  expect(vic.regs[0x14] === 0x30,
    `second edge must NOT update LPY either, got $${vic.regs[0x14].toString(16)}`);
  ok('Bauer §3.11: only first negative edge per frame is recognised');
}

// ── 4: Frame boundary re-arms the trigger ────────────────────────────────
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  driveTo(vic, 0x30, 20);
  vic.setLightpenLevel(0);
  vic.setLightpenLevel(1);                // re-arm
  // drive past frame boundary (raster wrap to 0)
  driveTo(vic, 0, 1);
  driveTo(vic, 0x10, 25);
  vic.setLightpenLevel(0);                // first edge of new frame: latches
  // end-of-c25 X = ($194 + 25*8) mod 504 = (404 + 200) mod 504 = 100 = $64
  // LPX = $64 >> 1 = $32
  expect(vic.regs[0x13] === 0x32,
    `frame-boundary re-arm: new edge updates LPX to $32, got $${vic.regs[0x13].toString(16)}`);
  expect(vic.regs[0x14] === 0x10,
    `LPY = new raster $10, got $${vic.regs[0x14].toString(16)}`);
  ok('Bauer §3.11: frame boundary (raster=0) re-arms LP trigger');
}

// ── 5: Positive edge alone does NOT latch ───────────────────────────────
//
// Note: the LP input must stay HIGH across the L0 boundary so the
// addendum's "held-low retrigger at frame start" path doesn't fire
// (that's a different scenario, exercised below in test 11). Then we
// silently drop _lpInputLevel to 0 mid-frame so setLightpenLevel(1) is
// a clean positive edge with no preceding negative-edge latch.
{
  const vic = makeVic();
  driveTo(vic, 0x30, 20);                 // LP stays high across raster=0
  vic._lpInputLevel = 0;                  // silent low (no edge through API)
  vic.setLightpenLevel(1);                // positive edge — must NOT latch
  expect(vic.regs[0x13] === 0,
    `positive edge alone must NOT latch LPX, got $${vic.regs[0x13].toString(16)}`);
  expect(vic.regs[0x14] === 0,
    `positive edge alone must NOT latch LPY`);
  ok('Bauer §3.11: positive edge does not latch (only negative edge latches)');
}

// ── 6: Same-level call is a no-op ───────────────────────────────────────
{
  const vic = makeVic();
  vic._lpInputLevel = 0;
  vic.setLightpenLevel(0);                // already low — no edge
  expect(vic.regs[0x13] === 0,
    `holding LP low must NOT latch (no edge)`);
  ok('Bauer §3.11: holding LP at the same level is a no-op');
}

// ── 7: §3.12 LP IRQ — bit 3 of $D019 latches on negative edge ───────────
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  driveTo(vic, 0x40, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) !== 0,
    `LP IRQ bit 3 must set in irqStatus on negative edge, got $${vic.irqStatus.toString(16)}`);
  // The latched value should be readable via $D019 (with high bits forced)
  const r19 = vic.read(0x19);
  expect((r19 & 0x08) !== 0,
    `$D019 read must show LP bit set, got $${r19.toString(16)}`);
  ok('Bauer §3.12 bit 3: LP IRQ latches on negative edge');
}

// ── 8: LP IRQ fires processor IRQ only if $D01A bit 3 enabled ───────────
{
  let irqAsserted = false;
  const vic = makeVic();
  vic.irqHandler = (state) => { if (state) irqAsserted = true; };
  vic._lpInputLevel = 1;
  // Mask DISABLED — write $D01A with bit 3 = 0
  vic.write(0x1A, 0x00);
  driveTo(vic, 0x40, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) !== 0,
    `latch sets even with mask off`);
  expect((vic.irqStatus & 0x80) === 0,
    `IRQ-pending bit (\$D019.7) must NOT set when mask off`);
  expect(!irqAsserted, `irqHandler must NOT fire when mask off`);
  ok('Bauer §3.12: LP IRQ does not fire CPU IRQ when $D01A bit 3 cleared');
}

// ── 9: LP IRQ fires CPU IRQ when $D01A bit 3 enabled ────────────────────
{
  let irqAsserted = false;
  const vic = makeVic();
  vic.irqHandler = (state) => { if (state) irqAsserted = true; };
  vic._lpInputLevel = 1;
  vic.write(0x1A, 0x08);                  // enable LP IRQ
  driveTo(vic, 0x40, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) !== 0, `LP latch set`);
  expect((vic.irqStatus & 0x80) !== 0, `IRQ-pending bit ($D019.7) must set`);
  expect(irqAsserted, `irqHandler must fire CPU IRQ when LP mask enabled`);
  ok('Bauer §3.12: LP IRQ fires CPU IRQ when $D01A bit 3 enabled');
}

// ── 10: Writing 1 to $D019 bit 3 clears the LP latch ────────────────────
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  vic.write(0x1A, 0x08);
  driveTo(vic, 0x40, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) !== 0, `pre: LP latch set`);
  vic.write(0x19, 0x08);                  // ack LP via W1C
  expect((vic.irqStatus & 0x08) === 0,
    `LP bit cleared after ack write, got $${(vic.irqStatus & 0x08).toString(16)}`);
  expect((vic.irqStatus & 0x80) === 0,
    `IRQ-pending bit cleared since no other latches active`);
  ok('Bauer §3.12: writing 1 to $D019 bit 3 clears LP latch');
}

// ── 11: VICE addendum — line 311 exclusion ──────────────────────────────
// "Light pen doesn't trigger in line 311."
// A negative edge on the LP input during raster 311 must be silently
// ignored. The latch must not fire and LPX/LPY/$D019 bit 3 must remain
// unchanged.
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  vic.write(0x1A, 0x08);
  driveTo(vic, 311, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) === 0,
    `LP edge in line 311 must NOT latch, got irqStatus=$${vic.irqStatus.toString(16)}`);
  expect(vic.regs[0x13] === 0 && vic.regs[0x14] === 0,
    `LPX/LPY untouched: got $${vic.regs[0x13].toString(16)}/$${vic.regs[0x14].toString(16)}`);
  ok('VICE addendum: light pen does not trigger in line 311');
}

// ── 12: VICE addendum — held-low retriggers at frame start ──────────────
// "Light pen retriggers on the start of the frame if the line is held
// low." If LP is held LOW across the L311→L0 boundary, the latch must
// fire at the new frame's start without requiring a fresh negative
// edge. LPX/LPY reflect the start-of-frame sample (cycle 1 of L0).
{
  const vic = makeVic();
  vic._lpInputLevel = 1;
  vic.write(0x1A, 0x08);
  // Drive into mid-frame and assert LP low → latches normally.
  driveTo(vic, 0x80, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) !== 0, `pre-condition: mid-frame negative edge latched`);
  // Ack the latch so the next event is observable.
  vic.write(0x19, 0x08);
  expect((vic.irqStatus & 0x08) === 0, `latch acknowledged`);
  // LP stays held low. Drive across L311 → L0. The new-frame start
  // re-arms _lpLatchedThisFrame and the held-low retrigger fires.
  driveTo(vic, 0, 1);
  expect((vic.irqStatus & 0x08) !== 0,
    `held-low retrigger at frame start must set LP latch, got irqStatus=$${vic.irqStatus.toString(16)}`);
  // End-of-cycle-1 X = ($194 + 1*8) % 504 = $19C → LPX = $19C >> 1 = $CE
  expect(vic.regs[0x13] === 0xCE,
    `held-low retrigger LPX = $CE, got $${vic.regs[0x13].toString(16)}`);
  expect(vic.regs[0x14] === 0,
    `held-low retrigger LPY = 0 (current raster), got $${vic.regs[0x14].toString(16)}`);
  ok('VICE addendum: held-low LP retriggers at start of frame');
}

console.log(`\n${testNo} lightpen / LP-IRQ spec tests; ${failing} fail`);
if (failing) process.exit(1);
