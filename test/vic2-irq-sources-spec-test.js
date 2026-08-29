// Bauer §3.12 — VIC interrupt sources spec audit.
//
// The VIC has 4 IRQ sources. Each source has a latch bit in $D019
// and a mask bit in $D01A:
//
//   bit 0 RST: raster-line compare match
//   bit 1 MBC: at least one sprite-vs-graphics-foreground collision
//   bit 2 MMC: two or more sprites overlap (any non-transparent pair)
//   bit 3 LP:  negative edge on the LP input (lightpen)
//
// The latch sets on a fresh trigger event. The CPU clears it by
// writing 1 to that latch bit ("write 1 to clear" / W1C). Writing
// 0 does NOT clear. While at least one (latch ∧ mask) bit is set
// the VIC pulls IRQ low and bit 7 of $D019 reads as 1.
//
// Per-source firing semantics (already detail-tested in raster-irq-
// chain / sprite-collision-irq / lightpen-spec); this audit is a
// uniformity check that all four sources observe the same
// latch/mask/W1C protocol.

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
    if (--safety <= 0) throw new Error(`drive timeout`);
  }
}

// ── 1: RST latches and fires CPU IRQ when enabled ──────────────────────
{
  let irqFired = false;
  const vic = makeVic();
  vic.irqHandler = (state) => { if (state) irqFired = true; };
  vic.write(0x12, 0x40);                  // raster compare = $40
  vic.write(0x11, 0x18);                  // RST8 = 0
  vic.write(0x1A, 0x01);                  // enable RST mask
  driveTo(vic, 0x40, 1);                  // raster compare fires at c1
  expect((vic.irqStatus & 0x01) !== 0,
    `RST latch must set on raster match, got irqStatus=$${vic.irqStatus.toString(16)}`);
  expect((vic.irqStatus & 0x80) !== 0, `IRQ-pending bit ($D019.7) set`);
  expect(irqFired, `CPU IRQ fired`);
  ok('§3.12 bit 0 RST: latches on raster match, fires IRQ when enabled');
}

// ── 2: MBC fires on sprite-vs-graphics collision ────────────────────────
{
  let irqFired = false;
  const vic = makeVic();
  vic.irqHandler = (state) => { if (state) irqFired = true; };
  vic.write(0x1A, 0x02);                  // enable MBC mask
  // Synthesise a collision via the internal latch helper (same path
  // the renderer hits when graphicsCollisionBuffer & sprite overlap).
  vic.graphicsCollisionBuffer[100] = 1;
  vic._processSpritePixelCollision(100, 0, 0);
  expect((vic.irqStatus & 0x02) !== 0,
    `MBC latch must set on sprite-fg overlap, got irqStatus=$${vic.irqStatus.toString(16)}`);
  expect(irqFired, `MBC fires CPU IRQ`);
  ok('§3.12 bit 1 MBC: latches on sprite-graphics collision, fires IRQ when enabled');
}

// ── 3: MMC fires on sprite-vs-sprite collision ──────────────────────────
{
  let irqFired = false;
  const vic = makeVic();
  vic.irqHandler = (state) => { if (state) irqFired = true; };
  vic.write(0x1A, 0x04);                  // enable MMC mask
  // Two sprites painted at the same pIdx → spriteCollisionBuffer
  // already has bit 0 → second call latches both bits in $D01E.
  vic.spriteCollisionBuffer[100] = 0x01;
  vic._latchSpriteSpriteCollision(100, 1);
  expect((vic.regs[0x1E] & 0x03) === 0x03,
    `$D01E latches both sp0+sp1 on overlap, got $${vic.regs[0x1E].toString(16)}`);
  expect((vic.irqStatus & 0x04) !== 0, `MMC latch must set`);
  expect(irqFired, `MMC fires CPU IRQ`);
  ok('§3.12 bit 2 MMC: latches on sprite-sprite collision, fires IRQ when enabled');
}

// ── 4: LP fires on negative edge of LP input (already-covered shape) ────
{
  let irqFired = false;
  const vic = makeVic();
  vic.irqHandler = (state) => { if (state) irqFired = true; };
  vic._lpInputLevel = 1;
  vic.write(0x1A, 0x08);                  // enable LP mask
  driveTo(vic, 0x30, 20);
  vic.setLightpenLevel(0);
  expect((vic.irqStatus & 0x08) !== 0, `LP latch must set on negative edge`);
  expect(irqFired, `LP fires CPU IRQ`);
  ok('§3.12 bit 3 LP: latches on negative edge, fires IRQ when enabled');
}

// ── 5: Mask gates IRQ but NOT the latch ─────────────────────────────────
//
// "If at least one latch bit and the corresponding bit in the enable
//  register is set, the VIC holds the IRQ line low" — implies the
// latch sets regardless of mask; mask only gates IRQ output.
{
  const vic = makeVic();
  vic.write(0x1A, 0x00);                  // ALL mask bits clear
  // Trigger raster IRQ
  vic.write(0x12, 0x40);
  vic.write(0x11, 0x18);
  driveTo(vic, 0x40, 1);
  expect((vic.irqStatus & 0x01) !== 0,
    `RST latch sets even when mask is 0, got irqStatus=$${vic.irqStatus.toString(16)}`);
  expect((vic.irqStatus & 0x80) === 0,
    `IRQ-pending bit ($D019.7) must NOT set when mask is 0`);
  ok('§3.12: mask gates IRQ output only — latch bits set independently');
}

// ── 6: Writing 1 to a latch bit clears it (W1C semantics) ───────────────
{
  const vic = makeVic();
  vic.write(0x1A, 0x0F);                  // enable all
  vic.write(0x12, 0x40); vic.write(0x11, 0x18);
  driveTo(vic, 0x40, 1);
  vic._lpInputLevel = 1;
  vic.setLightpenLevel(0);
  vic.spriteCollisionBuffer[100] = 0x01;
  vic._latchSpriteSpriteCollision(100, 1);
  vic.graphicsCollisionBuffer[120] = 1;
  vic._processSpritePixelCollision(120, 0, 2);
  expect((vic.irqStatus & 0x0F) === 0x0F,
    `all 4 latch bits set after triggering all sources, got $${(vic.irqStatus & 0x0F).toString(16)}`);
  // W1C ack: write 0x05 (bits 0+2). Should clear those, leave others.
  vic.write(0x19, 0x05);
  expect((vic.irqStatus & 0x0F) === 0x0A,
    `after writing 0x05 to $D019: bits 0+2 clear, 1+3 stay set, got $${(vic.irqStatus & 0x0F).toString(16)}`);
  ok('§3.12: writing 1 to $D019 bit clears that latch (W1C); writing 0 has no effect');
}

// ── 7: $D019 read returns latch | $70 (top bits forced) + bit 7 ─────────
{
  const vic = makeVic();
  vic.write(0x1A, 0x01);
  vic.write(0x12, 0x40); vic.write(0x11, 0x18);
  driveTo(vic, 0x40, 1);
  const r19 = vic.read(0x19);
  expect((r19 & 0x70) === 0x70,
    `$D019 read forces bits 4-6 to 1, got $${r19.toString(16)}`);
  expect((r19 & 0x01) !== 0, `$D019 read shows RST latch bit`);
  expect((r19 & 0x80) !== 0, `$D019 read shows IRQ-pending bit when (latch ∧ mask)`);
  ok('§3.12: $D019 read forces unused bits 4-6 high; reflects latches and IRQ-pending');
}

// ── 8: $D01A read returns mask | $F0 (top nibble forced) ────────────────
{
  const vic = makeVic();
  vic.write(0x1A, 0x05);
  const r1A = vic.read(0x1A);
  expect((r1A & 0xF0) === 0xF0,
    `$D01A read forces bits 4-7 to 1, got $${r1A.toString(16)}`);
  expect((r1A & 0x0F) === 0x05, `$D01A read returns mask in low nibble`);
  ok('§3.12: $D01A read forces unused bits 4-7 high');
}

// ── 9: After clearing all latches, IRQ-pending ($D019.7) drops ──────────
{
  const vic = makeVic();
  vic.write(0x1A, 0x0F);
  vic.write(0x12, 0x40); vic.write(0x11, 0x18);
  driveTo(vic, 0x40, 1);
  expect((vic.irqStatus & 0x80) !== 0, `pre: IRQ-pending up`);
  vic.write(0x19, 0x0F);                  // ack all
  expect((vic.irqStatus & 0x0F) === 0,
    `all latches cleared, got $${(vic.irqStatus & 0x0F).toString(16)}`);
  expect((vic.irqStatus & 0x80) === 0,
    `IRQ-pending drops once no (latch ∧ mask) is active`);
  ok('§3.12: IRQ-pending bit drops when all enabled latches are acked');
}

// ── 10: Raster compare is edge-triggered (VICE addendum) ────────────────
//
// "Raster comparison is edge triggered. If $d012 is changed to always
//  follow the raster counter it will never trigger an IRQ condition."
//   — VICE VIC-II Addendum, "Raster IRQ".
//
// Concretely: once the comparator output is HIGH, it must transition LOW
// before a fresh HIGH can latch a new IRQ. If a handler retargets $D012
// to the just-fired raster, the comparator stays continuously HIGH for
// the remainder of that line. After the line ends, raster increments and
// the comparator drops LOW — but if the handler keeps writing $D012 to
// follow the raster, it never goes HIGH again at a sample point with a
// preceding LOW. So no further IRQs fire.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);                   // enable RST mask
  vic.write(0x11, vic.regs[0x11] & 0x7F);  // RST8 = 0
  vic.write(0x12, 100);                    // target raster 100
  driveTo(vic, 100, 2);                    // initial fire at L100 cycle 1
  expect(irqCalls === 1, `initial fire at L100 c1 expected, got irqCalls=${irqCalls}`);

  // Inside the handler: ack and re-write $D012 = current raster.
  // The comparator stays HIGH (raster=100, target=100). No edge.
  vic.write(0x19, 0x01);
  vic.write(0x12, 100);

  // Run forward two full lines. The comparator goes HIGH→LOW at the
  // L100→L101 wrap, but never returns HIGH because target is stuck at
  // 100. No further fires.
  driveTo(vic, 102, 1);
  expect(irqCalls === 1,
    `re-arming target=current raster must NOT refire (edge-triggered); got irqCalls=${irqCalls}`);
  ok('VICE addendum: raster compare is edge-triggered — sustained HIGH does not refire');
}

// ── 11: A retargeted compare to a future raster fires once that raster ──
//        is reached (edge-triggered re-arm path).
//
// Mid-line write to a NEW raster causes the comparator to dip LOW (target
// changes away from current raster). The next line whose raster matches
// the new target produces a fresh LOW→HIGH rising edge → IRQ.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.write(0x1A, 0x01);
  vic.write(0x11, vic.regs[0x11] & 0x7F);
  vic.write(0x12, 100);
  driveTo(vic, 100, 2);
  expect(irqCalls === 1, `initial fire`);

  vic.write(0x19, 0x01);
  vic.write(0x12, 105);                    // dip: target ≠ current raster

  driveTo(vic, 105, 1);
  expect(irqCalls === 2,
    `re-arm to a future raster must fire on that raster (fresh rising edge); got irqCalls=${irqCalls}`);
  ok('VICE addendum: re-arming to a different raster produces a fresh rising edge');
}

// ── $D019 ack at PHI2 lands after the same-cycle phi1 latch ─────────────
// VIC-first ordering: the raster compare latches at cy 1 phi1; a CPU write
// of $D019 at phi2 of a later cycle on the same line clears that latch.
{
  const vic = makeVic();
  vic.regs[0x12] = 0x50;
  vic.regs[0x11] = 0x1B;
  vic.irqMask = 0x01;
  vic.irqStatus = 0;
  driveTo(vic, 0x50, 1);
  vic.clock(1);
  expect((vic.irqStatus & 0x01) === 0x01,
    `precondition: raster compare fired at cy 1 of raster $50; irqStatus=0x${vic.irqStatus.toString(16)}`);
  vic.write(0x19, 0x01);
  expect((vic.irqStatus & 0x01) === 0,
    `same-line ack at cy 2 phi2 clears the just-latched raster IRQ; irqStatus=0x${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.13: a $D019 write at PHI2 acks the raster IRQ latched at cy 1 of the same line');
}

console.log(`\n${testNo} VIC IRQ-source spec tests; ${failing} fail`);
if (failing) process.exit(1);
