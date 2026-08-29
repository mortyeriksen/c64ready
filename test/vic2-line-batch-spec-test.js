// Tier-3 line-batch render (lineBatchRender) — CPU-observable equivalence.
//
// Contract: with lineBatchRender ON, a raster line's pixel emission is
// deferred and replayed through the SAME incremental machinery — at line
// end, or immediately when the CPU observes render-derived state mid-line
// ($D019/$D01E/$D01F reads, $D01A collision-IRQ arming writes). At every
// CPU-observable point (register read VALUES, IRQ status at line ends,
// final framebuffer rows) the deferred mode must be byte-identical to the
// live path. Mid-line fb32/pipe internals are deliberately NOT part of the
// contract (no C64 program can observe them) — tests that assert those pin
// lineBatchRender=false instead.
//
// Method: drive a LIVE vic and a DEFERRED vic in lockstep; apply identical
// scripted writes/reads at identical cycles; assert equal read returns,
// equal just-finished fb rows at each line end, and equal registers/IRQ
// state at frame end.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, CANVAS_H } from '../src/vic2.js';

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

function makeVic(deferred) {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  v.lineBatchRender = deferred;
  return v;
}

// Two colliding sprites + one on a text row, reusable base setup.
function setupSprites(v) {
  v.regs[0x11] = 0x1B; v.regs[0x16] = 0x08;
  v.displayEnabled = true;
  v.regs[0x15] = 0x03;              // sp0+sp1
  v.regs[0x27] = 0x07; v.regs[0x28] = 0x02;
  v.regs[0x00] = 100; v.regs[0x01] = 60;   // sp0 X=100 Y=60
  v.regs[0x02] = 104; v.regs[0x03] = 60;   // sp1 X=104 Y=60 → overlap
  v.regs[0x21] = 0x06; v.regs[0x20] = 0x0E;
  for (let i = 0; i < 63; i++) { v.ram[0x2000 + i] = 0xFF; v.ram[0x2040 + i] = 0xFF; }
  v.ram[0x07F8] = 0x80; v.ram[0x07F9] = 0x81;
}

// Lockstep runner: clocks A (live) and B (deferred) together for nCycles.
// ops = { [absoluteCycleIndex]: (vic) => value } applied to BOTH machines;
// non-undefined returns are compared. Rows are compared at every line end.
function lockstep(a, b, nCycles, ops = {}, label = '') {
  let rowMismatchAt = -1, opMismatchAt = -1;
  for (let i = 0; i < nCycles; i++) {
    a.clock(1); b.clock(1);
    const op = ops[i];
    if (op) {
      const ra = op(a), rb = op(b);
      if (ra !== rb && opMismatchAt < 0) opMismatchAt = i;
    }
    if (a.cycleInLine === 0 && a.raster > 15 && a.raster <= 15 + CANVAS_H) {
      const row = (a.raster - 1) - 15;
      if (row >= 0 && row < CANVAS_H) {
        const off = row * CANVAS_W;
        for (let x = 0; x < CANVAS_W; x++) {
          if (a.fb32[off + x] !== b.fb32[off + x]) { if (rowMismatchAt < 0) rowMismatchAt = a.raster - 1; break; }
        }
      }
    }
  }
  expect(opMismatchAt < 0, `${label}: scripted read/write op values diverge at cycle ${opMismatchAt}`);
  expect(rowMismatchAt < 0, `${label}: line-end fb row diverges at raster ${rowMismatchAt}`);
}

const detectCycleOf = (canvasX) => Math.floor((canvasX) / 8) + 12; // seg + defer-by-1

// ── 1: colliding sprites, no CPU observers — every line-end row identical ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  lockstep(a, b, 100 * 63, {}, 'plain collision frame');
  expect(a.regs[0x1E] === b.regs[0x1E], `end $D01E equal (live ${a.regs[0x1E]} vs deferred ${b.regs[0x1E]})`);
  expect(a.irqStatus === b.irqStatus, 'end irqStatus equal');
  ok('collision frame with no mid-line observers is line-end identical');
}

// ── 2: real $D01E read AT the detection cycle — in-flight contract ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  // Sprites at Y=60 display from raster 61; canvas X 108 (overlap) is in
  // the phi2 half of its segment. Read $D01E on raster 62 at the segment's
  // render cycle (in-flight: live returns 0), then again 4 cycles later
  // (the retained phi2 half must resurface identically in both modes).
  const line = 62, dc = detectCycleOf(108);
  const base = line * 63;   // cycle index where raster===line, cycleInLine===0
  const ops = {};
  ops[base + dc] = (v) => v.read(0x1E);
  ops[base + dc + 4] = (v) => v.read(0x1E);
  ops[base + 40] = (v) => v.read(0x1F);
  const A = makeVic(false), B = makeVic(true);
  setupSprites(A); setupSprites(B);
  lockstep(A, B, 100 * 63, ops, 'in-flight $D01E read');
  ok('mid-line $D01E/$D01F reads (incl. detection cycle) return identical values');
}

// ── 3: $D019 mid-line read with collisions pending ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  const ops = {};
  for (const line of [61, 62, 63, 64]) {
    ops[line * 63 + 30] = (v) => v.read(0x19);
  }
  lockstep(a, b, 100 * 63, ops, '$D019 mid-line reads');
  ok('mid-line $D019 reads see identical collision-IRQ flags');
}

// ── 4: same-cycle sprite-X write ($D010 at the phi2-half match cycle) ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  // On a display line, rewrite sprite 0's X MSB at cycle 14 (the classic
  // phi2-half catch from the samecycle spec test), then restore next line.
  const ops = {};
  ops[63 * 63 + 14] = (v) => { v.write(0x10, 0x01); return 0; };
  ops[64 * 63 + 5] = (v) => { v.write(0x10, 0x00); return 0; };
  lockstep(a, b, 100 * 63, ops, 'same-cycle $D010 write');
  ok('same-cycle sprite-X MSB write renders identically (capture patched for replay)');
}

// ── 5: mid-line background writes (rasterbar) — fixup path under replay ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  const ops = {};
  for (let line = 40; line < 90; line++) {
    ops[line * 63 + 20] = (v) => { v.write(0x21, line & 0x0F); return 0; };
    ops[line * 63 + 45] = (v) => { v.write(0x21, (line + 3) & 0x0F); return 0; };
  }
  lockstep(a, b, 100 * 63, ops, 'mid-line $D021 rasterbar');
  ok('mid-line $D021 writes render identically (line-end fixup after replay)');
}

// ── 6: collision IRQ armed — deferral disabled, IRQ timing identical ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  a.write(0x1A, 0x06); b.write(0x1A, 0x06);   // arm IMMC+IMBC
  let irqSeenA = -1, irqSeenB = -1;
  for (let i = 0; i < 100 * 63; i++) {
    a.clock(1); b.clock(1);
    if (irqSeenA < 0 && (a.irqStatus & 0x80)) irqSeenA = i;
    if (irqSeenB < 0 && (b.irqStatus & 0x80)) irqSeenB = i;
  }
  expect(irqSeenA === irqSeenB && irqSeenA > 0,
    `collision IRQ asserts at the same cycle (live ${irqSeenA} vs batch ${irqSeenB})`);
  ok('armed collision IRQ (IMMC/IMBC) keeps cycle-exact assert timing (lines render live)');
}

// ── 7: mid-line serialize on a deferred line is canonical ──
{
  const a = makeVic(false), b = makeVic(true);
  setupSprites(a); setupSprites(b);
  for (let i = 0; i < 62 * 63 + 30; i++) { a.clock(1); b.clock(1); }   // mid display line
  const sa = a.serialize(), sb = b.serialize();
  let diff = 0;
  for (let i = 0; i < sa.fb32.length; i++) if (sa.fb32[i] !== sb.fb32[i]) diff++;
  expect(diff === 0, `serialized fb32 differs in ${diff} px (deferred serialize must replay first)`);
  expect(b._lineDeferred === false, 'serialize() cleared the deferral (canonical state)');
  ok('mid-line serialize replays the deferred line (canonical save-states)');
}

console.log(`\n${testNo} line-batch equivalence spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
