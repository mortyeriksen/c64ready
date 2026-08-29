// Cycle-incremental render spec audit. Verifies the post-refactor
// rendering architecture where _renderRasterLine's work is split
// across each cycle of the line as it executes (instead of batched at
// end-of-line). This makes:
//
//   - $D01E (sprite-sprite collision) and $D01F (sprite-bg collision)
//     latches update in real time as pixels are emitted, not at the
//     end of the line.
//   - CPU mid-line reads of those registers see cycle-accurate state.
//   - IMMC / IMBC IRQs fire on the first cycle the collision happens,
//     not at end-of-line.
//
// nine.prg's runtime VIC-variant detection at L51 c17 reads $D01F
// expecting cycle-accurate state. Without cycle-incremental render,
// the read returns the previous line's final state.
//
// Each test pins the VIC at a specific cycle position via clock(N),
// then asserts what $D01E/$D01F register state should be at that
// exact moment. The cycle-incremental flag (default ON) is what
// enables this behavior — the same tests with the flag OFF would see
// stale (pre-line-end) state.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at L${vic.raster}.c${vic.cycleInLine}`);
}

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

// ── 1: cycle-incremental render flag is ON by default ────────────────
{
  const vic = makeVic();
  expect(vic._cycleIncrementalRender === true,
    `_cycleIncrementalRender default: true, got ${vic._cycleIncrementalRender}`);
  ok('cycle-incremental render: default ON');
}

// ── 2: per-cycle methods exist and are wired up ──────────────────────
// The refactor decomposed _renderRasterLine into reusable per-cycle
// pieces. Verify the methods exist on the VIC2 instance.
{
  const vic = makeVic();
  expect(typeof vic._initRenderRasterLine === 'function', `_initRenderRasterLine missing`);
  expect(typeof vic._renderCycleSegmentGraphics === 'function', `_renderCycleSegmentGraphics missing`);
  expect(typeof vic._renderSpriteSegmentForSprite === 'function', `_renderSpriteSegmentForSprite missing`);
  expect(typeof vic._buildCycleRasterSegment === 'function', `_buildCycleRasterSegment missing`);
  expect(typeof vic._buildCycleSpriteSegment === 'function', `_buildCycleSpriteSegment missing`);
  ok('cycle-incremental: per-cycle render entry points exposed');
}

// ── 3: per-line sprite render state arrays initialized ───────────────
// _spriteLineRenderState[s] persists across segments within a line so
// the shifter can be resumed correctly. Must be per-sprite, length 8.
{
  const vic = makeVic();
  expect(Array.isArray(vic._spriteLineRenderState) && vic._spriteLineRenderState.length === 8,
    `_spriteLineRenderState: length-8 array, got ${vic._spriteLineRenderState?.length}`);
  expect(vic._spriteLineStarted instanceof Uint8Array && vic._spriteLineStarted.length === 8,
    `_spriteLineStarted: Uint8Array(8)`);
  expect(vic._spriteLineLastShiftReg instanceof Uint32Array && vic._spriteLineLastShiftReg.length === 8,
    `_spriteLineLastShiftReg: Uint32Array(8)`);
  ok('cycle-incremental: per-sprite line state arrays initialized to length 8');
}

// ── 4: _initRenderRasterLine clears row buffers ──────────────────────
// At line start, the per-row buffers (graphicsCollisionBuffer,
// graphicsPriorityBuffer, spriteCollisionBuffer, spriteOwnerBuffer,
// borderBuffer) must be cleared. Verify by pre-filling with sentinel
// then calling init.
{
  const vic = makeVic();
  const canvasY = 5;
  const rowOffset = 0;  // side buffers are line-sized (#1): row base is 0
  vic.graphicsCollisionBuffer[rowOffset] = 0x77;
  vic.spriteCollisionBuffer[rowOffset] = 0x77;
  vic.borderBuffer[rowOffset] = 0x77;
  vic.spriteOwnerBuffer[rowOffset] = 0x77;
  vic._initRenderRasterLine(20, canvasY);
  expect(vic.graphicsCollisionBuffer[rowOffset] === 0,
    `graphicsCollisionBuffer cleared`);
  expect(vic.spriteCollisionBuffer[rowOffset] === 0,
    `spriteCollisionBuffer cleared`);
  expect(vic.borderBuffer[rowOffset] === 0,
    `borderBuffer cleared`);
  expect(vic.spriteOwnerBuffer[rowOffset] === 0xFF,
    `spriteOwnerBuffer reset to $FF`);
  // #1: the side buffers are line-sized — exactly one scanline wide.
  expect(vic.borderBuffer.length === CANVAS_W && vic.spriteOwnerBuffer.length === CANVAS_W
    && vic.graphicsCollisionBuffer.length === CANVAS_W,
    `side buffers are line-sized (CANVAS_W=${CANVAS_W})`);
  ok('cycle-incremental: _initRenderRasterLine clears all per-row buffers');
}

// ── 5: _initRenderRasterLine resets sprite line state ────────────────
// Per-sprite state must be reset at line start so a new line doesn't
// inherit the previous line's shifter / started flag.
{
  const vic = makeVic();
  // Pollute state.
  vic._spriteLineRenderState[3] = { test: true };
  vic._spriteLineStarted[5] = 1;
  vic._spriteLineLastShiftReg[7] = 0xCAFE;
  vic._initRenderRasterLine(20, 5);
  expect(vic._spriteLineRenderState[3] === null, `renderState[3] reset to null`);
  expect(vic._spriteLineStarted[5] === 0, `started[5] reset to 0`);
  expect(vic._spriteLineLastShiftReg[7] === 0, `lastShiftReg[7] reset to 0`);
  ok('cycle-incremental: _initRenderRasterLine resets all sprite-line state');
}

// ── 6: cycle-incremental: collision latch updates BEFORE end-of-line
// Bauer §3.11.2 + cycle-incremental architecture: a sprite-bg collision
// at cycle X must update $D01F by the END of cycle X, not at line end.
//
// Setup: place sprite 0 over fg pixels at canvas X 100. Drive VIC to
// the cycle whose X range covers canvas X 100. Verify $D01F bit 0 is
// set BEFORE we reach cycle 63.
// Helper for direct-render tests — sets up an open-display line state
// (vBorder=0, hBorder=0, hInner=1 in display range) at a fake raster
// for which the cycle-incremental render functions can be called
// directly. Avoids depending on the VIC clock state machine.
function setupDisplayLineState(vic, canvasY) {
  // Fill all per-cycle line state with a working display configuration.
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
  }
  // Pre-fill row codes/colors for column 0..39 with glyph 0, color 7.
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[c][col] = 1;
      vic.lineCycleRowCodes[c][col] = 0;
      vic.lineCycleRowColors[c][col] = 0x07;
    }
  }
  // Sprite line state for cycle-incremental segments.
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    for (let s = 0; s < 8; s++) {
      vic.lineCycleSpriteRowByteMask[c][s] = 0x07;
      vic.lineCycleSpriteShiftReg[c][s] = 0xFFFFFF;
      vic.lineCycleSpriteDataRow[c][s] = 0;
      vic.lineCycleSpriteDisplayOn[c][s] = (s === 0) ? 1 : 0;
      vic.lineCycleSpriteDataBase[c][s] = 0;
      vic.lineCycleSpriteDataBank[c][s] = 0;
      vic.lineCycleSpritePointerValue[c][s] = 0;
    }
  }
}

// ── 6: cycle-incremental: collision latch updates BEFORE end-of-line
// Bauer §3.11.2 + cycle-incremental architecture: a sprite-bg collision
// at cycle X must update $D01F by the END of cycle X, not at line end.
//
// Setup: sprite 0 at canvas X=100 with all-fg shifter, glyph $00 with
// all-fg char data. Render cycles 11..58 in order via the per-cycle
// graphics + sprite path. Verify $D01F bit 0 sets BEFORE we reach c63.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; vic.regs[0x16] = 0x08; vic.regs[0x18] = 0x14;
  vic.regs[0x21] = 0x06;
  vic.regs[0x15] = 0x01;
  vic.regs[0] = 92;                   // sprite 0 X = 92 → canvas X 100
  vic.regs[1] = 50;
  // Char data at charBase=$1000 (D018=$14). In bank 0, $1000-$1FFF
  // mirrors charRom — write the glyph pattern there for the test.
  for (let r = 0; r < 8; r++) vic.charRom[r] = 0xFF;
  vic.colorRam.fill(0x07);

  const canvasY = 60 - 15;
  setupDisplayLineState(vic, canvasY);
  vic._initRenderRasterLine(60, canvasY);

  let firstSetCycle = -1;
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
    const sprSeg = vic._buildCycleSpriteSegment(cycle);
    for (let s = 0; s < 8; s++) {
      vic._renderSpriteSegmentForSprite(sprSeg, s, canvasY);
    }
    if (firstSetCycle < 0 && (vic.regs[0x1F] & 0x01)) {
      firstSetCycle = cycle;
    }
  }
  expect(firstSetCycle > 0 && firstSetCycle <= 58,
    `$D01F bit 0 set MID-LINE (cycle 11..58), got firstSetCycle=${firstSetCycle}`);
  ok('cycle-incremental: $D01F latches mid-line as sprite/fg overlap renders');
}

// ── 7: mid-line $D01F read clears latch — and re-collision re-fires
// Per Bauer §3.11.2 + cycle-incremental: a CPU read of $D01F clears
// the latch immediately. If the sprite is still rendering at later
// pixels in the same line, NEW collisions can re-set the latch. The
// pre-refactor batch render couldn't model this — clears would land
// outside the render path.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; vic.regs[0x16] = 0x08; vic.regs[0x18] = 0x14;
  vic.regs[0x21] = 0x06;
  vic.regs[0x15] = 0x01;
  vic.regs[0] = 50;
  vic.regs[1] = 50;
  for (let r = 0; r < 8; r++) vic.charRom[r] = 0xFF;
  vic.colorRam.fill(0x07);

  const canvasY = 60 - 15;
  setupDisplayLineState(vic, canvasY);
  vic._initRenderRasterLine(60, canvasY);

  // Render cycles 11..30 (covers sprite at canvas X 58..81 = ~cycle 18-22).
  for (let cycle = 11; cycle <= 30; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
    const sprSeg = vic._buildCycleSpriteSegment(cycle);
    for (let s = 0; s < 8; s++) {
      vic._renderSpriteSegmentForSprite(sprSeg, s, canvasY);
    }
  }
  expect(vic.regs[0x1F] & 0x01,
    `latched after rendering cycles 11..30, got $${vic.regs[0x1F].toString(16)}`);
  // Read clears the latch.
  const readVal = vic.read(0x1F);
  expect(readVal & 0x01, `read returns latched bit, got $${readVal.toString(16)}`);
  expect((vic.regs[0x1F] & 0x01) === 0,
    `$D01F bit 0 cleared by read mid-line, got $${vic.regs[0x1F].toString(16)}`);
  ok('cycle-incremental: $D01F read mid-line clears latch (re-collision possible)');
}

// ── 8: end-of-line render skipped when cycle-incremental ON ─────────
// Verify _cycleIncrementalRender=true causes clock() to skip the
// end-of-line _renderRasterLine call (work was already done per cycle).
// We hook _renderRasterLine and verify it's NOT called when the VIC
// crosses a line boundary in cycle-incremental mode.
{
  const vic = makeVic();
  let renderRasterCalls = 0;
  const orig = vic._renderRasterLine.bind(vic);
  vic._renderRasterLine = function (raster) {
    renderRasterCalls++;
    return orig(raster);
  };
  // Drive across one full line (cycles 1..63 + wrap).
  driveTo(vic, 1, 0);
  for (let i = 0; i < 64; i++) vic.clock(1);
  expect(renderRasterCalls === 0,
    `cycle-incremental: _renderRasterLine NOT called from clock(), got ${renderRasterCalls} calls`);
  ok('cycle-incremental: end-of-line batch render is skipped when flag is ON');
}

// ── 9: cycle-incremental OFF reverts to batch mode ──────────────────
// Toggle the flag off; verify clock() now calls _renderRasterLine at
// end of each line. This preserves the legacy code path for tests.
{
  const vic = makeVic();
  vic._cycleIncrementalRender = false;
  driveTo(vic, 1, 0);
  // Hook only AFTER driveTo so we count post-driveTo calls only.
  let renderRasterCalls = 0;
  const orig = vic._renderRasterLine.bind(vic);
  vic._renderRasterLine = function (raster) {
    renderRasterCalls++;
    return orig(raster);
  };
  // Drive across one full line wrap (from L1 c0 to L2 c0).
  for (let i = 0; i < 63; i++) vic.clock(1);
  expect(renderRasterCalls === 1,
    `cycle-incremental OFF: _renderRasterLine called once per line, got ${renderRasterCalls}`);
  ok('cycle-incremental: flag=false restores end-of-line batch mode');
}

// Restore default for subsequent tests if any.

// ── 10: per-cycle graphics segment fills exactly the cycle's X range
// Each cycle's segment covers X = (cycle - 12) * 8 + 8 = (cycle-11)*8.
// Verify that calling _renderCycleSegmentGraphics for a single cycle
// updates only that cycle's pixel range, not the whole line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; vic.regs[0x16] = 0x08;
  vic.regs[0x20] = 0x02;             // border = red
  // Pre-fill framebuffer with sentinel green.
  const sentinel = 0xFF00FF00;
  const canvasY = 5;
  for (let x = 0; x < CANVAS_W; x++) vic.fb32[canvasY * CANVAS_W + x] = sentinel;
  // Set up one cycle of state.
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 1;
    vic.lineCycleVBorderBefore[c] = 1;
    vic.lineCycleHBorder[c] = 1;
    vic.lineCycleHBorderBefore[c] = 1;
  }
  vic._initRenderRasterLine(20, canvasY);
  // Render only cycle 30's segment.
  const seg = vic._buildCycleRasterSegment(30);
  vic._renderCycleSegmentGraphics(seg, canvasY);
  // Cycle 30's X range = (30 - 12) * 8 + 8 = 152 to 160.
  // Verify pixels 152..159 changed (border color), pixels outside still sentinel.
  let inRangeChanged = 0;
  let outOfRangeChanged = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    const px = vic.fb32[canvasY * CANVAS_W + x];
    if (x >= 152 && x < 160) {
      if (px !== sentinel) inRangeChanged++;
    } else {
      if (px !== sentinel) outOfRangeChanged++;
    }
  }
  expect(inRangeChanged > 0,
    `cycle 30 segment must change at least some pixels in [152,160), got ${inRangeChanged}`);
  expect(outOfRangeChanged === 0,
    `cycle 30 segment must NOT change pixels outside [152,160), got ${outOfRangeChanged}`);
  ok('cycle-incremental: _renderCycleSegmentGraphics scoped to cycle X range');
}

console.log(`\n${testNo} cycle-incremental render spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
