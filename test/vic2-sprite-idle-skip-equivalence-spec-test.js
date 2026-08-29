// Sprite idle-cycle skip equivalence spec test.
//
// vic2.spriteSkipIdle makes _renderSpriteSegmentForSprite return early on cycles
// where a started sprite is steady (no reseed, no X-rewrite) and paints nothing
// (no segment overlap, not the end-of-line wrap), plus a never-started loop-level
// skip at the clock() call site. It is meant to be a pure performance win —
// BYTE-IDENTICAL framebuffer AND identical $D01E/$D01F collision behaviour.
//
// This drives a full frame with 8 enabled sprites (varied X incl. the right/
// wrap edge, varied Y so they DMA/display/end on different lines, mixed
// multicolor + X-expand + priority), bad-line character display, and mid-line
// $D021/$D011/$D016 writes. It renders once with spriteSkipIdle=false and once
// with =true and asserts (a) the whole framebuffer is bit-for-bit equal and
// (b) the per-line $D01E (sprite-sprite) and $D01F (sprite-bg) collision history
// — sampled via clearing reads, exercising the 2-cycle commit pipeline — is
// identical.

import { CYCLES_PER_LINE, CANVAS_W, CANVAS_H } from '../src/vic2.js';
import { newVic, placeSprites, distinctColors } from './_vic2-equivalence.js';

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
  const vic = newVic();
  // Varied X incl. overlap (sprites 2 and 3) and the right/wrap edge (sprite 7).
  placeSprites(vic, [40, 70, 100, 100, 180, 250, 330, 492]);
  for (let s = 0; s < 8; s++) vic.regs[0x01 + s * 2] = 60 + s * 22;
  vic.regs[0x17] = 0x55;     // Y-expand 0,2,4,6
  vic.regs[0x1B] = 0x33;     // sprite-bg priority for some
  vic.regs[0x1C] = 0x0F;     // multicolor 0-3
  vic.regs[0x1D] = 0xAA;     // X-expand 1,3,5,7
  return vic;
}

function renderFrame(skip) {
  const vic = makeVic();
  vic.spriteSkipIdle = skip;
  const coll = [];
  const maxSteps = 314 * CYCLES_PER_LINE;
  let lastRaster = -1;
  for (let step = 0; step < maxSteps; step++) {
    const r = vic.raster, c = vic.cycleInLine;
    if (r !== lastRaster && c === 1) {
      // Clearing reads at each line start — samples collision deltas and
      // exercises the read-clear ($D01E/$D01F) + 2-cycle commit pipeline.
      coll.push(vic.read(0x1E), vic.read(0x1F));
      lastRaster = r;
    }
    if (r >= 50 && r <= 250) {
      if (c === 12 + (r % 46)) vic.write(0x21, (r * 7) & 0x0F);
      if (c === 18 && (r % 3) === 0) vic.write(0x11, vic.regs[0x11] ^ 0x20);
      if (c === 44 && (r % 5) === 0) vic.write(0x16, vic.regs[0x16] ^ 0x10);
    }
    vic.clock(1);
    if (r === 311 && vic.raster === 0) break;
  }
  return { fb: Uint32Array.from(vic.fb32), coll };
}

// ── 1: framebuffer byte-identical ────────────────────────────────────────
{
  const off = renderFrame(false);
  const on  = renderFrame(true);
  expect(distinctColors(off.fb) > 3, `frame should be non-trivial (got ${distinctColors(off.fb)} colours)`);
  let diffs = 0, fX = -1, fY = -1;
  for (let i = 0; i < off.fb.length; i++) if (off.fb[i] !== on.fb[i]) { if (!diffs) { fX = i % CANVAS_W; fY = (i / CANVAS_W) | 0; } diffs++; }
  expect(diffs === 0, `${diffs} px differ; first x=${fX} y=${fY}`);
  ok('spriteSkipIdle: framebuffer byte-identical (8 sprites, bad lines, wrap edge)');
}

// ── 2: collision-register history identical ($D01E/$D01F) ────────────────
{
  const off = renderFrame(false);
  const on  = renderFrame(true);
  expect(off.coll.length === on.coll.length, `collision sample count ${off.coll.length} vs ${on.coll.length}`);
  let cdiffs = 0, firstIdx = -1;
  for (let i = 0; i < off.coll.length; i++) if (off.coll[i] !== on.coll[i]) { if (cdiffs === 0) firstIdx = i; cdiffs++; }
  const anyColl = off.coll.some(v => v !== 0);
  expect(anyColl, `test should produce some collisions (else vacuous)`);
  expect(cdiffs === 0, `${cdiffs} collision sample(s) differ; first at sample ${firstIdx} (reg ${firstIdx & 1 ? '$D01F' : '$D01E'})`);
  ok('spriteSkipIdle: $D01E/$D01F collision history identical');
}

// ── 3: dimensions sanity ─────────────────────────────────────────────────
{
  const off = renderFrame(false);
  expect(off.fb.length === CANVAS_W * CANVAS_H, `frame length ${off.fb.length} != ${CANVAS_W * CANVAS_H}`);
  ok('framebuffer dimensions (CANVAS_W × CANVAS_H)');
}

if (testsFailing > 0) { console.log(`\n${testsFailing} test(s) FAILED`); process.exit(1); }
