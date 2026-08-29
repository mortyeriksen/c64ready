// CSEL hyperscreen-veto + sprite-collision idempotency integration test.
//
// `_vetoFFTransition()` rolls back the right-SET decision and re-renders
// cycles [detectCycle..upToCycle] with the now-open border. Sprite pixels
// that were gated by the closed border in the first pass paint in the
// re-render — and that re-render also walks `_processSpritePixelCollision`,
// which OR's into `spriteCollisionBuffer` / `$D01F` / `$D01E`.
//
// The risk this test guards against:
//   • A naïve `existingSpr !== 0` test inside `_latchSpriteSpriteCollision`
//     would see the sprite's OWN previously-written bit in the buffer
//     and latch a phantom self-collision in $D01E during replay.
//   • IMMC could fire twice across the two passes (one per 0→non-zero
//     edge).
//   • $D01F's IMBC could fire twice similarly.
//
// The fix is already in place (vic2.js:3329-3352 + 3316-3327) — this test
// pins the behavior end-to-end through the actual veto path rather than
// at the unit-call level.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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

function makeVic() {
  const v = new VIC2();
  // This test asserts MID-LINE render internals (per-cycle fb32/pipe/reg
  // state), which only the live incremental path exhibits — under the
  // Tier-3 line-batch mode pixels/commits land at line end or on a CPU
  // observer event, both byte-identical at every CPU-observable point.
  // Pin the live path so a LINE_BATCH=1 suite run still tests this contract.
  v.lineBatchRender = false;
  v.currentVicBank = 0;
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout (at r=${vic.raster} c=${vic.cycleInLine})`);
  }
}

// Build the standard hyperscreen-veto scenario from
// csel-veto-sprite-rollback-spec-test.js: sprite 0 at right edge of
// raster 100, CSEL=1 fires right-SET at c55, CPU writes $D016=$00 at
// c56 phi2, c57 phi1 vetoes the SET → sprite re-renders.
function makeScenario({ irqHandler } = {}) {
  const vic = makeVic();
  vic.irqHandler = irqHandler || (() => {});
  vic.regs[0x11] = 0x1B;         // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;         // CSEL=1
  vic.displayEnabled = true;
  vic.regs[0x15] = 0x01;         // sp0 enabled
  vic.regs[0x27] = 0x07;         // sp0 color
  vic.regs[0x00] = 84;
  vic.regs[0x10] = 0x01;         // sp0 X MSB set → X=340
  vic.regs[0x01] = 99;           // Y=99 so DMA starts at L99 c55, display latches at L100
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;        // sp0 pointer → data at $2000
  return vic;
}

// Drive the scenario through the veto and return the post-veto state.
function runVeto(vic) {
  driveTo(vic, 100, 55);
  vic.clock(1);                  // c56
  vic.write(0x16, 0x00);         // CSEL=1→0 trick write
  vic.clock(1);                  // c57 — veto fires here
  vic.clock(1);                  // c58
  return {
    d01E: vic.regs[0x1E],
    d01F: vic.regs[0x1F],
    irqStatus: vic.irqStatus,
    sprColBuf: vic.spriteCollisionBuffer.slice(),
    gfxColBuf: vic.graphicsCollisionBuffer.slice(),
  };
}

// ── 1: lone sprite under veto-replay leaves $D01E at 0 ─────────────────
//      No other sprite → no legitimate sprite-sprite collision. The
//      replay must NOT latch the writing sprite's own bit as a phantom
//      "other sprite" via the buffer's previous write.
{
  const vic = makeScenario();
  const post = runVeto(vic);
  expect(post.d01E === 0,
    `lone sprite + veto-replay: $D01E stays 0 (got $${post.d01E.toString(16)})`);
  // No collision-sourced IRQ may have asserted.
  expect((post.irqStatus & 0x04) === 0,
    `IMMC latch (bit 2) stays clear under lone-sprite veto`);
  ok('Veto-replay does not self-collide a lone sprite into $D01E');
}

// ── 2: IMMC raises at most once across the veto-replay ─────────────────
//      Even if a real 2-sprite collision existed in the open-border
//      zone, the 0→non-zero edge of $D01E must fire IMMC exactly once,
//      not once per render pass.
{
  const vic = makeScenario();
  // Enable a second sprite (sprite 1) overlapping sprite 0's X range so
  // a real sprite-sprite collision occurs in the replayed pixels.
  vic.regs[0x15] = 0x03;          // sp0 + sp1 enabled
  vic.regs[0x02] = 84;            // sp1 X low matches sp0
  vic.regs[0x10] = 0x03;          // both X MSBs set → both X=340
  vic.regs[0x03] = 99;            // sp1 Y matches
  vic.regs[0x07F9] = 0x80;        // sp1 pointer → same data
  vic.regs[0x28] = 0x05;          // sp1 color (irrelevant for collision)

  let immcRaises = 0;
  vic.irqMask = 0x04;             // enable IMMC
  vic.irqHandler = (level) => { if (level) immcRaises++; };
  // Replay the scenario from a clean vic with the modifications above.
  const post = runVeto(vic);
  // IMMC may or may not raise depending on whether sp0+sp1 actually
  // overlap in the post-veto canvas region; what we pin here is that
  // it raises AT MOST ONCE.
  expect(immcRaises <= 1,
    `IMMC raises at most once across the veto-replay (got ${immcRaises})`);
  // If a real collision happened, $D01E must reflect both bits — not
  // either bit alone, which would be a corruption signal.
  if (post.d01E !== 0) {
    expect((post.d01E & 0x03) === 0x03,
      `if any sprite-sprite collision latched, both sp0+sp1 bits are set together (got $${post.d01E.toString(16)})`);
  }
  ok('IMMC raises ≤ once and $D01E stays consistent under veto-replay');
}

// ── 3: spriteCollisionBuffer accumulates monotonically — no clobbering ─
//      After the veto-replay, every painted pixel that has a sprite bit
//      set must STILL have it set (the replay only OR's, never clears).
{
  const vic = makeScenario();
  const post = runVeto(vic);
  // Find pixels owned by sp0 in the post-veto buffer; verify the
  // corresponding spriteCollisionBuffer bit is sticky.
  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  let anySet = false;
  for (let x = 348; x < 372; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) {
      anySet = true;
      expect((post.sprColBuf[x] & 0x01) !== 0,   // snapshot is line-sized (#1)
        `sp0-owned px @canvas X=${x}: spriteCollisionBuffer bit 0 set`);
    }
  }
  expect(anySet, `at least one sp0-owned pixel exists in the right edge`);
  ok('spriteCollisionBuffer is monotonic — replay does not clobber bits');
}

// ── 4: $D01F sprite-bg latch fires at most once across veto-replay ────
{
  const vic = makeScenario();
  // Plant foreground graphics under the sprite by hand: write 1s into
  // graphicsCollisionBuffer for the right-edge canvas X range so the
  // sprite-replay's _processSpritePixelCollision sees fg pixels there.
  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  for (let x = 348; x < 372; x++) {
    vic.graphicsCollisionBuffer[x] = 1;
  }
  let imbcRaises = 0;
  vic.irqMask = 0x02;             // enable IMBC
  vic.irqHandler = (level) => { if (level) imbcRaises++; };
  const post = runVeto(vic);
  expect(imbcRaises <= 1,
    `IMBC raises at most once across the veto-replay (got ${imbcRaises})`);
  // If $D01F has bit 0 set, the latch is correct one-shot per sprite.
  if ((post.d01F & 0x01) !== 0) {
    expect(post.d01F === 0x01,
      `$D01F has only sp0's bit (no neighbour bits stuck on) — got $${post.d01F.toString(16)}`);
  }
  ok('IMBC raises ≤ once and $D01F sp0 latch is one-shot under veto-replay');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
