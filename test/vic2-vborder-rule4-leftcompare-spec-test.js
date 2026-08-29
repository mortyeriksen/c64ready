// Vertical-border SET at the LEFT compare (Bauer §3.9 rule 4): on the line
// whose Y reaches the bottom comparison value, the vertical border FF is set
// when the left compare is reached — closing the bottom border on THIS line,
// as opposed to rule 2's cycle-63 set (modeled by the latch + cy1-copy) which
// closes on the NEXT line. Our phi-model samples this at cy17 — the cycle by
// which a CPU RSEL write landing at the left-compare dot is visible to the
// register read. This is the sole discriminator for the VICII/border
// testprog vborder2-35 (RSEL=0 from cy17 closes at raster 247) versus -36
// (RSEL=0 from cy18 falls through to rule 2 and closes at 248).
//
// Because the horizontal left compare (rule 6) opened the main border FF two
// cycles earlier at cy15 (before it could see RSEL=0), rule 4 must also
// re-close hBorder and re-border the two display columns it opened — the
// captured per-cycle hBorder for render-segs 15 and 16.

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  // Keep the test on the pure FF logic — skip the cycle-incremental
  // re-render path (it needs a populated line/RAM; not what we're pinning).
  vic._cycleRenderActiveCanvasY = -1;
  return vic;
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// Set up a line as if the left compare (rule 6) opened the display at cy15 and
// we are now at cy17 with the given $D011.
function atCy17(vic, raster, d011) {
  vic.regs[0x11] = d011;
  vic.raster = raster;
  vic.cycleInLine = 17;
  vic.vBorderActive = false;
  vic._vBorderLatch = false;
  vic.hBorderActive = false;          // display opened at cy15
  vic.lineCycleHBorder[15] = 0;
  vic.lineCycleHBorder[16] = 0;
  vic.lineCycleHBorderBefore[15] = 0;
  vic.lineCycleHBorderBefore[16] = 0;
}

// ── 1: rule 4 fires at the bottom compare (RSEL=0 ⇒ 247) ──────────────
{
  const vic = makeVic();
  atCy17(vic, 247, 0x10);            // RSEL=0, DEN=1 ⇒ bottomCompare = 247
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === true, 'vBorderActive set this line');
  expect(vic._vBorderLatch === true, 'latch set so the next line stays closed');
  expect(vic.hBorderActive === true, 'main border re-closed (rule-6 open undone)');
  expect(vic.lineCycleHBorder[15] === 1, 'render-seg 15 captured as border');
  expect(vic.lineCycleHBorder[16] === 1, 'render-seg 16 captured as border');
  ok('rule 4: left-compare bottom set closes the border on the compare line');
}

// ── 2: one raster early (246) does NOT trigger rule 4 ─────────────────
{
  const vic = makeVic();
  atCy17(vic, 246, 0x10);            // RSEL=0 ⇒ bottomCompare 247 ≠ 246
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === false, 'no set off the compare line');
  expect(vic.hBorderActive === false, 'main border stays open');
  expect(vic.lineCycleHBorder[15] === 0 && vic.lineCycleHBorder[16] === 0,
    'no border captures rewritten');
  ok('rule 4 does not fire one raster before the bottom compare');
}

// ── 3: RSEL=1 at cy17 moves the compare to 251 (the -36 fall-through) ──
{
  const vic = makeVic();
  atCy17(vic, 247, 0x18);            // RSEL=1 ⇒ bottomCompare 251 ≠ 247
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === false,
    'RSEL=1 at cy17 ⇒ rule 4 misses raster 247 (falls through to rule 2)');
  expect(vic.hBorderActive === false, 'main border stays open');
  ok('rule 4 keys off the live RSEL bottom compare (vborder2-36 boundary)');
}

// ── 4: only fires at cy17, not cy18 (the phi discriminator) ───────────
{
  const vic = makeVic();
  atCy17(vic, 247, 0x10);
  vic.cycleInLine = 18;              // one cycle late
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === false, 'no left-compare set at cy18');
  // The cycle-63/cy1 (rule 2) latch still arms for the next-line close.
  expect(vic._vBorderLatch === true, 'rule-2 latch still set by the bottom compare');
  ok('rule-4 left-compare set is cy17-specific');
}

// ── 5: guard — an already-closed vBorder is left untouched ────────────
{
  const vic = makeVic();
  atCy17(vic, 247, 0x10);
  vic.vBorderActive = true;          // already closed (e.g. normal 24-row r247)
  vic.hBorderActive = false;
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.lineCycleHBorder[15] === 0 && vic.lineCycleHBorder[16] === 0,
    'no redundant re-border when already closed');
  ok('rule 4 guarded on !vBorderActive (no work on already-closed lines)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
