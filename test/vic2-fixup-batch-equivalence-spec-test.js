// Batch-render equivalence spec test.
//
// vic2.batchRender gates a fast path in _fixupColumns: instead of re-rendering
// all 48 cycles of a line twice and merging, it re-renders ONLY the cycles
// whose +1/+2 mode (ECM/BMM/MCM) or c-2..c+3 background-colour lookahead window
// actually changed. It is meant to be a pure performance optimisation —
// BYTE-IDENTICAL to the default whole-line path.
//
// This test drives a full frame with a dense, deterministic schedule of mid-
// line register writes that triggers _fixupColumns on (almost) every line —
// $D021/$D022 bg changes swept across cycles 12..57 (covering the window edges),
// plus $D011 BMM/ECM and $D016 MCM toggles — over a band of rasters that
// includes both displayed (bad-line/character) rows and idle rows. It renders
// the frame once with batchRender=false and once with =true and asserts the
// ENTIRE framebuffer is bit-for-bit equal. The writes guarantee the `needed`
// gate fires, so the scoped path is genuinely exercised, not skipped.

import { CANVAS_W, CANVAS_H } from '../src/vic2.js';
import { newVic, runFrame, standardWrites, compareFrames, distinctColors } from './_vic2-equivalence.js';

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

function makeVic(startBmm) {
  const vic = newVic();
  for (let i = 0; i < 0x2000; i++) vic.ram[i] = (i * 5) & 0xFF;   // bitmap source for BMM spans
  if (startBmm) vic.regs[0x11] |= 0x20;
  return vic;
}

// One full frame with the standard write schedule plus an ECM toggle, so the
// mode-fixup path sees every combination.
function renderFrame(batch, startBmm) {
  const vic = makeVic(startBmm);
  vic.batchRender = batch;
  return runFrame(vic, (v, r, c) => {
    standardWrites(v, r, c);
    if (r >= 50 && r <= 250 && c === 30 && (r % 7) === 0) v.write(0x11, v.regs[0x11] ^ 0x40); // toggle ECM
  });
}

// ── 1: text-mode start — full-frame batch vs whole-line, byte-identical ──
{
  const off = renderFrame(false, false);
  const on  = renderFrame(true,  false);
  expect(distinctColors(off) > 2, `frame should be non-trivial (got ${distinctColors(off)} colours)`);
  compareFrames(expect, 'text-start frame', off, on);
  ok('batchRender byte-identical to whole-line fixup (text-mode start, full frame)');
}

// ── 2: bitmap-mode start — exercises BMM/MCM bitmap fixup paths ──────────
{
  const off = renderFrame(false, true);
  const on  = renderFrame(true,  true);
  expect(distinctColors(off) > 2, `bitmap frame should be non-trivial (got ${distinctColors(off)} colours)`);
  compareFrames(expect, 'bitmap-start frame', off, on);
  ok('batchRender byte-identical to whole-line fixup (bitmap-mode start, full frame)');
}

// ── 3: CANVAS sanity — frames have expected dimensions ──────────────────
{
  const off = renderFrame(false, false);
  expect(off.length === CANVAS_W * CANVAS_H, `frame length ${off.length} != ${CANVAS_W * CANVAS_H}`);
  ok('framebuffer dimensions (CANVAS_W × CANVAS_H)');
}

if (testsFailing > 0) {
  console.log(`\n${testsFailing} test(s) FAILED`);
  process.exit(1);
}
