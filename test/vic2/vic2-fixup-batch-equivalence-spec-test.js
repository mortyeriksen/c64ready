import { referencePaths } from './_vic2-reference-paths.js';
// Compare selective graphics fixups with a test-only whole-line reference.
// Dense mode/background writes exercise both text and bitmap output.
import { CANVAS_W, CANVAS_H } from '../../src/vic2.js';
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
  if (!(batch)) vic._fixupColumns = referencePaths._fixupColumns;
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
