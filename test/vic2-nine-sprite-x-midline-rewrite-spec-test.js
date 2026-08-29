// Sprite-X mid-line rewrite spec test.
//
// Bauer §3.8.2: each sprite has an 8-bit X-comparator (plus MSB bit in
// $D010). On each dot clock, if (X_counter == X_register), the sprite's
// 24-bit shift register is enabled and starts shifting out at 1
// bit/pixel (or 1 bit / 2 px with X-expand).
//
// Spec invariant — once the shift register has fired (X-match has
// happened on this line), it shifts out its loaded 24 bits and stops.
// The shifter is reloaded ONLY at the s-access cycles for the sprite's
// NEXT row. So on a given line:
//
//   * If CPU rewrites $D000+s*2 BEFORE the X comparator fires, the
//     shifter fires at the NEW X position.
//   * If CPU rewrites $D000+s*2 AFTER the X comparator fires, the
//     shifter continues emitting at its already-loaded X position; the
//     X-comparator does NOT re-fire mid-line.
//   * Two enabled sprites with the same X both fire at the same cycle
//     and both paint (subject to priority).
//
// Plus a few related invariants on $D015 mid-line:
//
//   * $D015 enable mid-line that wasn't set at cy55/56 doesn't latch
//     DMA → sprite doesn't display this line.
//   * $D015 disable mid-line of a sprite currently in DMA: paint
//     continues this line (already in-flight).
//
// This file pins these for spec compliance. Demos that animate Y values
// rapidly (like Nine) depend on the sprite-X being stable per-line; a
// regression that re-fires the shifter would multiply sprite pixels
// across a row — exactly the visible-garbage signature.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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
  // This test asserts MID-LINE render internals (per-cycle fb32/pipe/reg
  // state), which only the live incremental path exhibits — under the
  // Tier-3 line-batch mode pixels/commits land at line end or on a CPU
  // observer event, both byte-identical at every CPU-observable point.
  // Pin the live path so a LINE_BATCH=1 suite run still tests this contract.
  vic.lineBatchRender = false;
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;
  // Sprite 0 data: solid 24×21 sprite at $0800.
  for (let b = 0; b < 64; b++) vic.ram[0x0800 + b] = 0xFF;
  vic.ram[0x07F8] = 0x20;        // sprite 0 pointer → $0800
  return vic;
}

function paletteRGBA(idx) {
  const c = C64_PALETTE[idx & 0x0F];
  return (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety > 0 && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
  if (safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
}

function spriteSpan(vic, canvasY, sprite = 0) {
  const ro = canvasY * CANVAS_W;
  let first = -1, last = -1, count = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === sprite) {
      if (first < 0) first = x;
      last = x;
      count++;
    }
  }
  return { first, last, count };
}

// ─── 1: Post-fire X rewrite — shifter stays at original X ────────────────
//
// Sprite Y=50, X=80 initially. By raster 55, sprite has been displaying
// for 5 lines (display L51..L71). On raster 55, drive past cycle 22 (=
// the X-comparator fire cycle for X=80; X-comparator runs at cycle ≈
// (X+8)/8 +11 = c22). Then write new X=200. The shifter is already
// emitting at canvas X 88..111; the late X rewrite must NOT cause a
// second paint at canvas X 208..231.
{
  const vic = makeVic();
  vic.regs[0x27] = 0x02;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 80;

  // Drive to L55 c30 — past the X=80 firing cycle.
  driveTo(vic, 55, 30);
  // Write new X=200 mid-line.
  vic.write(0x00, 200);
  // Complete the line.
  driveTo(vic, 56, 0);   // cy0 of next line: line 55 rendered, not yet cleared (#1)

  const span = spriteSpan(vic, 55 - 15);
  expect(span.first === 88,
    `Post-fire X rewrite: shifter painted at original X=80 → canvas 88, got first=${span.first}`);
  expect(span.last === 111,
    `Post-fire X rewrite: span ends at 111 (88+23), got last=${span.last}`);
  expect(span.count === 24,
    `Post-fire X rewrite: exactly 24 px painted (no second fire at new X), got count=${span.count}`);
  ok('Bauer §3.8.2: post-fire X rewrite does NOT trigger second shifter emission on same line');
}

// ─── 2: Pre-fire X rewrite — shifter fires at NEW X (already in vic2-test) ─
//
// Sanity-check positive control: write new X BEFORE the comparator
// fires. Shifter fires at the new X position.
{
  const vic = makeVic();
  vic.regs[0x27] = 0x02;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 80;

  // Drive to L55 c11 — BEFORE the X=80 firing cycle (which is around c22).
  driveTo(vic, 55, 11);
  // Write new X=200.
  vic.write(0x00, 200);
  driveTo(vic, 56, 0);   // cy0 of next line: line 55 rendered, not yet cleared (#1)

  const span = spriteSpan(vic, 55 - 15);
  expect(span.first === 208,
    `Pre-fire X rewrite: shifter fires at NEW X=200 → canvas 208, got first=${span.first}`);
  expect(span.count === 24,
    `Pre-fire X rewrite: exactly 24 px at NEW X, got ${span.count}`);
  ok('Bauer §3.8.2: pre-fire X rewrite retargets the X-comparator fire to new X');
}

// ─── 3: X rewrite to EARLIER X after fire — does NOT re-fire ─────────────
//
// Different pre/post combination: write X to an EARLIER value after the
// comparator has fired. The shifter has already emitted; rewriting X to
// something past won't re-fire because the X counter has moved beyond.
// (Bauer §3.8.2: X counter is monotonic; comparator fires once per line
// when counter==register at some point in the line.)
{
  const vic = makeVic();
  vic.regs[0x27] = 0x02;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 200;

  // Drive to L55 c50 — well past X=200 fire cycle.
  driveTo(vic, 55, 50);
  // Write new X=80 (earlier than current X counter).
  vic.write(0x00, 80);
  driveTo(vic, 56, 0);   // cy0 of next line: line 55 rendered, not yet cleared (#1)

  const span = spriteSpan(vic, 55 - 15);
  expect(span.first === 208,
    `X rewrite to earlier value post-fire: original X=200 → canvas 208 still painted, got first=${span.first}`);
  expect(span.count === 24,
    `X rewrite to earlier post-fire: still exactly 24 px, got ${span.count}`);
  ok('Bauer §3.8.2: post-fire X rewrite to earlier value does NOT trigger re-emission');
}

// ─── 4: Two sprites same X — both fire at same cycle ─────────────────────
//
// Standard spec: sprites are evaluated independently per-pixel by each
// X-comparator. Same-X sprites both paint. Lower-index wins overlap.
{
  const vic = makeVic();
  vic.regs[0x27] = 0x02;            // sp0 red
  vic.regs[0x28] = 0x07;            // sp1 yellow
  vic.regs[0x15] = 0x03;            // sp0 + sp1
  vic.regs[0x01] = 50;              // Y=50
  vic.regs[0x03] = 50;
  vic.regs[0x00] = 100;             // both at X=100
  vic.regs[0x02] = 100;
  // sp1 data at $0840 (pointer $0801 = 33 hex × 64 = $0840 = 33).
  vic.ram[0x07F9] = 33;
  for (let b = 0; b < 64; b++) vic.ram[0x0840 + b] = 0xFF;

  driveTo(vic, 56, 0);   // cy0 of next line: line 55 rendered, not yet cleared (#1)
  // Both shifters fire at X=100 → canvas 108. Sp0 wins overlap (lower idx).
  const span0 = spriteSpan(vic, 55 - 15, 0);
  const span1 = spriteSpan(vic, 55 - 15, 1);
  expect(span0.count === 24,
    `Two same-X sprites: sp0 paints 24 px (winner), got ${span0.count}`);
  // sp1 is fully overlapped by sp0 in spriteOwnerBuffer, so its owner count
  // is 0. Verify by checking that sp1 SHIFTER actually fired (collision flag).
  expect((vic.regs[0x1E] & 0x03) === 0x03,
    `Two same-X sprites: collision flag $D01E bits 0+1 must be set (both shifters fired)`);
  ok('Bauer §3.8.2: two sprites at same X both fire shifter; lower-idx wins owner-buffer');
}

// ─── 5: $D015 enable mid-line — no display this line ─────────────────────
//
// Bauer §3.8.1 rule 2: DMA latches at cy55/56 phi1. A $D015 write at cy
// 30 mid-line does NOT retroactively latch DMA for that line. The
// sprite displays only starting NEXT-frame (or next match-line if Y
// matches a future raster).
{
  const vic = makeVic();
  vic.regs[0x27] = 0x02;
  vic.regs[0x15] = 0x00;            // sprite 0 disabled at start
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 100;

  // Drive past L50 c56 with sprite disabled.
  driveTo(vic, 50, 56);
  expect(vic.spriteDmaOn[0] === 0,
    `pre L50.c56 + disabled: DMA off (no Y match latch)`);
  // Now enable sp0 mid-line on L51 (between Y match check).
  driveTo(vic, 51, 30);
  vic.write(0x15, 0x01);
  // Drive through end of L51 — no DMA latch since we missed cy55/56 of L50.
  driveTo(vic, 52, 1);
  expect(vic.spriteDmaOn[0] === 0,
    `L51 mid-line enable: DMA still off (no latch this line)`);
  // Drive to L_next_Y_match (= L50 + 256 wrap match doesn't happen since 50+256 > 311; next Y match in NEXT frame).
  // Drive past 312 lines to next frame's L50.
  driveTo(vic, 50, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `Next frame L50 c56: DMA latches now (sp0 enabled at cy55/56 phi1)`);
  ok('Bauer §3.8.1 rule 2: $D015 enable mid-line does NOT latch DMA; next Y match required');
}

// ─── 6: $D015 disable mid-line — current display continues ───────────────
//
// Bauer §3.8.1: $D015 only gates the cy55/56 START check. A sprite
// currently in DMA finishes its 21-line run regardless. Already in
// sprite-lifecycle-spec — re-verifying at the pixel level here.
{
  const vic = makeVic();
  vic.regs[0x27] = 0x02;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 100;

  driveTo(vic, 55, 30);
  // Disable sprite mid-line.
  vic.write(0x15, 0x00);
  driveTo(vic, 56, 0);   // cy0 of next line: line 55 rendered, not yet cleared (#1)

  const span = spriteSpan(vic, 55 - 15);
  expect(span.count === 24,
    `Mid-line $D015 disable: current line's paint continues (DMA already latched), got ${span.count}`);

  // Drive 5 lines more — sprite still displays (DMA latched, MCBASE
  // advances). MxE clear only affects future-frame match.
  driveTo(vic, 60, 1);
  driveTo(vic, 60, 50);
  const spanLater = spriteSpan(vic, 60 - 15);
  expect(spanLater.count === 24,
    `5 lines after $D015 disable: still painting (in-flight DMA), got ${spanLater.count}`);
  ok('Bauer §3.8.1: $D015 disable mid-line preserves in-flight 21-line display');
}

console.log(`\n${testNo} sprite-X mid-line rewrite spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
