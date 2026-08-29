// Capture-state snapshot dedup equivalence spec test.
//
// vic2.captureDedup aliases the previous cycle's row + sprite snapshot buffers
// when the source is unchanged (tracked by _rowSnapVersion / _sprSnapVersion)
// instead of re-copying 9 typed arrays every visible cycle in _captureCycleState.
// It is meant to be a pure performance optimisation — BYTE-IDENTICAL to copying.
//
// This drives a full frame with 8 enabled sprites (spread in Y so the sprite
// state machine runs DMA / s-access / end-of-display across the visible band),
// bad-line character display, and dense mid-line $D021/$D011/$D016 writes. It
// renders once with captureDedup=false and once with =true and asserts the whole
// framebuffer is bit-for-bit equal. A third pass runs with captureDedupVerify=true,
// which asserts every aliased snapshot still equals the live source — so a missed
// version-counter bump (stale alias) would throw rather than silently diverge.

import { CANVAS_W, CANVAS_H } from '../src/vic2.js';
import { newVic, placeSprites, runFrame, standardWrites, compareFrames, distinctColors } from './_vic2-equivalence.js';

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
  // Spread sprite Y across the visible band so each sprite DMAs / displays /
  // ends on different lines.
  placeSprites(vic, [24, 54, 84, 114, 144, 174, 204, 234]);
  for (let s = 0; s < 8; s++) vic.regs[0x01 + s * 2] = 60 + s * 24;   // Y 60..228
  vic.regs[0x17] = 0x55;     // Y-expand some
  vic.regs[0x1C] = 0x0F;     // multicolor some
  vic.regs[0x1D] = 0xAA;     // X-expand some
  return vic;
}

function renderFrame(dedup, verify) {
  const vic = makeVic();
  vic.captureDedup = dedup;
  vic.captureDedupVerify = !!verify;
  return runFrame(vic, standardWrites);
}

// ── 1: full frame (sprites + bad lines + mid-line writes) byte-identical ──
{
  const off = renderFrame(false, false);
  const on  = renderFrame(true,  false);
  expect(distinctColors(off) > 3, `frame should be non-trivial (got ${distinctColors(off)} colours)`);
  compareFrames(expect, 'capture-dedup frame', off, on);
  ok('captureDedup byte-identical to per-cycle copy (full frame, sprites + bad lines)');
}

// ── 2: verify mode raises no assertion (every writer bumps its version) ──
{
  let threw = null;
  try { renderFrame(true, true); } catch (e) { threw = e; }
  expect(threw === null, `captureDedupVerify threw: ${threw && threw.message}`);
  ok('captureDedupVerify: no stale alias — all row/sprite writers bump the version counter');
}

// ── 3: dimensions sanity ─────────────────────────────────────────────────
{
  const off = renderFrame(false, false);
  expect(off.length === CANVAS_W * CANVAS_H, `frame length ${off.length} != ${CANVAS_W * CANVAS_H}`);
  ok('framebuffer dimensions (CANVAS_W × CANVAS_H)');
}

if (testsFailing > 0) { console.log(`\n${testsFailing} test(s) FAILED`); process.exit(1); }
