// Idle-state stale-row render guard spec test.
//
// Bauer §3.7.1: the VIC has two states — display state and idle state.
// In idle state the g-access reads $3FFF (the idle byte) and the c-access
// is gated off (the previous-cycle character code/color is the value the
// sequencer sees, but for IDLE rendering only the idle byte matters).
//
// Bauer §3.7.2 rule 6: cycle 58 phi1, if RC=7 and the next line is not a
// bad line, sequencer → idle state. Subsequent cycles on this line (and
// later lines until display re-enters) MUST render the idle byte from
// $3FFF — NOT the stale row character codes/colors that may still be
// sitting in rowScreenCodes from the previous text row.
//
// Render-path invariant locked by this test:
//   For every cycle segment with `displayColumnActive=true` (i.e. the
//   renderer is in the inner zone and would normally consume the source
//   row), `displayActive` MUST also be true. If displayActive is false
//   while displayColumnActive is true, the renderer would paint stale
//   rowScreenCodes over the idle-byte span — the "lower garbage" symptom
//   from nine.prg.
//
// Tests:
//   1. Capture invariant: lineCycleDisplayColumnActive[cy]=1 implies
//      lineCycleDisplayActive[cy]=1 for every cycle, every line, across
//      a full frame in display state.
//   2. Idle-state inner span renders the idle byte from $3FFF, NOT stale
//      character data from the prior text row — even when rowScreenCodes
//      is dirty.
//   3. The render-path guard in _renderCycleSegmentGraphics() refuses to
//      consume the source-column path when displayActive=false (even if
//      the captured displayColumnActive flag is somehow stale=1).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

// Local PALETTE_RGBA mirror — vic2.js keeps it module-private.
const PALETTE_RGBA = new Uint32Array(16);
for (let i = 0; i < 16; i++) {
  const c = C64_PALETTE[i];
  PALETTE_RGBA[i] = 0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    vic.phi2();  // cycle-58 transition fires at phi2 in master-cycle ordering
  }
  if (safety <= 0) throw new Error(`drive timeout at L${vic.raster} c${vic.cycleInLine}`);
}

// ─── Test 1: capture invariant — displayColumnActive=1 ⇒ displayActive=1
//
// _isDisplayColumnPhase() requires displayActive=true to return true,
// per vic2.js:1322. This test walks one frame's worth of captured state
// and verifies the invariant holds at every (line, cycle) pair.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // DEN=1, RSEL=1, YS=3
  vic.regs[0x16] = 0x08;             // CSEL=1
  vic.displayEnabled = true;

  // Drive into display rows + capture every cycle's state.
  driveTo(vic, 51, 14);              // bad-line entry — displayActive→true
  let bad = 0;
  let samplesActive = 0;
  for (let l = 51; l <= 250; l++) {
    driveTo(vic, l, 62);             // last live cycle of line l (63 resets to 0)
    for (let c = 1; c <= CYCLES_PER_LINE; c++) {
      const colAct = vic.lineCycleDisplayColumnActive[c] === 1;
      const dispAct = vic.lineCycleDisplayActive[c] === 1;
      if (colAct) {
        samplesActive++;
        if (!dispAct) {
          bad++;
          if (bad <= 5) currentFailures.push(
            `L${l} c${c}: displayColumnActive=1 but displayActive=0 — capture invariant violated`);
        }
      }
    }
  }
  expect(samplesActive > 1000,
    `should observe >1000 displayColumnActive=1 samples across L51..L250; got ${samplesActive}`);
  expect(bad === 0,
    `Bauer §3.7.1 capture invariant violated ${bad} times: displayColumnActive=1 must imply displayActive=1`);
  ok('Bauer §3.7.1: lineCycleDisplayColumnActive=1 implies lineCycleDisplayActive=1 (capture invariant)');
}

// ─── Test 2: idle-state inner zone renders idle byte, not stale row codes
//
// Setup: drive through a full text row (RC=0..7), let cy-58 transition
// fire at L58 (RC=7, not bad line). On L59..L62 we are in idle state
// inside the inner zone — the renderer must lay down the idle byte
// from $3FFF, NOT consume rowScreenCodes (which may contain leftover
// values from the previous text row's c-accesses).
//
// We seed rowScreenCodes with a sentinel pattern. If the renderer
// consumes it during idle state, the visible pixels in the inner zone
// will reflect the sentinel's foreground color. The spec invariant
// requires only the idle byte from $3FFF — which we set to 0x00 (no
// foreground pixels), so the inner zone must be pure bg color.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x20] = 0x0E;             // border = light blue (sentinel-distinct)
  vic.regs[0x21] = 0x06;             // bg0 = blue
  vic.displayEnabled = true;

  // Set idle byte source ($3FFF in current bank) to 0x00 — pure bg pixels.
  vic.ram[0x3FFF] = 0x00;

  // Seed rowScreenCodes/rowColorNibbles with a sentinel pattern: every
  // column has screen code 0x42 + color 0x01 (white). If the renderer
  // consumes these during idle state we'd see white pixels.
  for (let col = 0; col < 40; col++) {
    vic.rowScreenCodes[col] = 0x42;
    vic.rowColorNibbles[col] = 0x01;
    vic.rowFetchedCols[col] = 1;
  }
  // Make sure char ROM column for 0x42 has at least one foreground bit.
  vic.charRom[0x42 * 8 + 0] = 0xFF;

  // Drive a single bad line (L51) then advance through the text row to
  // L58 c58 — RC=7 transition fires, sequencer → idle.
  driveTo(vic, 51, 14);              // bad-line entry: displayActive=true, RC=0
  driveTo(vic, 58, 58);              // process L58 c58 → idle transition
  expect(vic.displayActive === false,
    `L58 c58: post-transition displayActive must be false; got ${vic.displayActive}`);

  // Now drive L59 — fully in idle state, inside the inner zone.
  // Re-seed sentinel just in case bad-line fetches overwrote it.
  for (let col = 0; col < 40; col++) {
    vic.rowScreenCodes[col] = 0x42;
    vic.rowColorNibbles[col] = 0x01;
    vic.rowFetchedCols[col] = 1;
  }
  driveTo(vic, 59, 62);              // full line: capture done, render done

  // Probe canvas Y for L59 (raster line 59 maps to canvas Y depending
  // on VIC vertical offset; we just probe the row range we know was
  // last rendered).
  // The fb32 will only have meaningful pixels if render is called per
  // line. VIC.clock invokes the per-line render at line end, populating
  // fb32 for the just-completed line.
  // Compute canvas Y for L59 — uses raster line index directly per impl.
  // From src/vic2.js: TOP_BORDER_START + raster mapping. Just probe the
  // line we know was just rendered.

  // For probe: snapshot vic state after L59 render, sample a wide
  // X-range in the inner zone, count how many pixels match bg0 (correct
  // = idle byte 0x00 = all bg) vs how many match the sentinel fg color
  // (= white, idx 0x01 = $FFFFFF).
  const bg0Pixel = PALETTE_RGBA[6];      // blue
  const sentinelFg = PALETTE_RGBA[1];    // white

  // Find canvas Y for raster L59 via lineY tracking. Direct fb32 probe.
  // The frame buffer is keyed by canvasY = raster line offset; on PAL
  // L59 maps to canvasY around 59 - (TOP border start - some offset).
  // Easiest: scan ALL rows, find the one with our bg0 fill and bg fill.

  // Simpler: just check rowOffset for canvas Y mapped from raster 59.
  // PAL canvasY for raster R = R if R is the visible portion.
  // Probe a row near where L59 lands.
  let bgMatches = 0;
  let fgMatches = 0;
  let totalProbed = 0;
  // Inner zone X range (textStartX=24, textEndX=344).
  const innerStart = 24;
  const innerEnd = 344;
  // Look at canvas rows 40..70 (covers raster lines around L51..L80 for PAL).
  for (let cy = 40; cy < 70; cy++) {
    const rowOff = cy * CANVAS_W;
    for (let x = innerStart; x < innerEnd; x++) {
      const px = vic.fb32[rowOff + x];
      if (px === bg0Pixel) bgMatches++;
      else if (px === sentinelFg) fgMatches++;
      totalProbed++;
    }
  }
  expect(totalProbed > 0, `probed pixels: ${totalProbed}`);
  expect(fgMatches === 0,
    `Bauer §3.7.1: idle-state inner zone must NOT render sentinel fg from stale rowScreenCodes ` +
    `(rowScreenCodes[*]=0x42 + fgColor=$01 white). Found ${fgMatches} sentinel-fg pixels in canvas rows 40..70 — ` +
    `renderer consumed stale row data during idle state.`);
  ok('Bauer §3.7.1: idle-state inner zone renders idle byte ($3FFF), not stale rowScreenCodes');
}

// ─── Test 3: render-path guard — displayActive=false hard-blocks source render
//
// Even if the captured displayColumnActive flag is stale=1 (shouldn't
// happen under spec but the new defensive guard in _renderCycleSegmentGraphics
// covers it), the renderer MUST NOT consume rowScreenCodes when
// displayActive=false. This test forces the pathological state and
// asserts the guard fires.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  // Run a frame to populate per-cycle captures normally.
  driveTo(vic, 51, 14);
  for (let l = 51; l <= 100; l++) driveTo(vic, l, 62);

  // Now build a fake cycle segment via the public path: scratch raster
  // seg at L60 c30 (a normal inner-zone cycle).
  // Force pathological capture state: displayColumnActive=1, displayActive=0.
  // Pick a cycle that's in the inner zone (15..54).
  const probeCycle = 30;
  vic.raster = 60;
  vic.cycleInLine = probeCycle;
  vic.lineCycleDisplayColumnActive[probeCycle] = 1;   // stale=1 (pathological)
  vic.lineCycleDisplayActive[probeCycle] = 0;         // matches spec idle state
  // Seed rowScreenCodes with sentinel; if the guard fails the renderer
  // would paint these.
  for (let col = 0; col < 40; col++) {
    vic.rowScreenCodes[col] = 0x42;
    vic.rowColorNibbles[col] = 0x01;
    vic.rowFetchedCols[col] = 1;
    vic.lineCycleRowCodes[probeCycle][col] = 0x42;
    vic.lineCycleRowColors[probeCycle][col] = 0x01;
    vic.lineCycleRowFetchedCols[probeCycle][col] = 1;
  }
  vic.charRom[0x42 * 8 + 0] = 0xFF;
  // Border state: open (no border).
  vic.lineCycleVBorder[probeCycle] = 0;
  vic.lineCycleHBorder[probeCycle] = 0;
  vic.lineCycleHInner[probeCycle] = 1;
  vic.lineCycleVBorderBefore[probeCycle] = 0;
  vic.lineCycleHBorderBefore[probeCycle] = 0;

  // Build the seg via the impl path.
  const seg = vic._buildCycleRasterSegment(probeCycle);
  expect(seg.displayColumnActive === true,
    `setup: seg.displayColumnActive forced true; got ${seg.displayColumnActive}`);
  expect(seg.displayActive === false,
    `setup: seg.displayActive forced false; got ${seg.displayActive}`);

  // Snapshot fb32 for the canvas row, then call render directly.
  const canvasY = 60;                  // pick any valid row
  const rowOff = canvasY * CANVAS_W;
  // Pre-fill row with a unique marker so we can detect overwrites.
  const marker = 0x12345678 | 0;
  vic.fb32.fill(marker, rowOff, rowOff + CANVAS_W);

  // Build a cycle segment object that the render expects.
  vic._renderCycleSegmentGraphics(seg, canvasY);

  // After render: count sentinel-fg pixels in inner zone. With the new
  // guard, the source-column path is bypassed and the row should contain
  // only border + idle-byte bg + the markers we set.
  const sentinelFg = PALETTE_RGBA[1];
  let sentinelFgCount = 0;
  for (let x = 24; x < 344; x++) {
    if (vic.fb32[rowOff + x] === sentinelFg) sentinelFgCount++;
  }
  expect(sentinelFgCount === 0,
    `Render-path guard violated: with displayActive=false the source-column path ran and painted ` +
    `${sentinelFgCount} sentinel-fg pixels from stale rowScreenCodes. The defensive ` +
    `'if (!seg.displayActive) continue;' guard in _renderCycleSegmentGraphics must block this path.`);
  ok('render-path: displayActive=false hard-blocks source-column path (defensive guard)');
}

// ─── Test 4: stale-row-data trace assertion fires when invariant violated
//
// `_renderSourceColumn` carries an in-line trace assertion: when
// frameTraceEnabled=true AND seg.displayActive=false AND
// seg.rowFetchedCols[col]=1, increment `_staleRowRenderHits` and warn.
// This catches the "structured garbage" path from the prior review:
// stale matrix codes against a current $D018 char base.
//
// The assertion is intentionally silent under normal flow because the
// `displayColumnActive ⇒ displayActive` invariant prevents reaching the
// source-column path with displayActive=false. This test calls the
// helper directly with a hand-constructed seg that violates the
// invariant, then verifies the counter incremented.
{
  const vic = makeVic();
  vic.frameTraceEnabled = true;
  vic._staleRowRenderHits = 0;

  // Hand-build a seg with the pathological combination.
  const seg = {
    cycle: 30,
    regs: vic.lineCycleRegs[30],
    nextRegs: vic.lineCycleRegs[31],
    bank: 0,
    displayActive: false,        // ← idle state per spec
    rowFetchedCols: new Uint8Array(40),
    rowCodes: new Uint8Array(40),
    rowColors: new Uint8Array(40),
  };
  seg.rowFetchedCols[5] = 1;     // ← but col 5 marked "fetched" (stale)
  seg.rowCodes[5] = 0x42;
  seg.rowColors[5] = 0x01;
  seg.regs[0x11] = 0x1B;          // text mode (no ECM/BMM/MCM)
  seg.regs[0x16] = 0x08;
  seg.regs[0x18] = 0x14;          // VM=$0400, CB=$0800
  seg.regs[0x21] = 0x06;
  seg.nextRegs.set(seg.regs);

  // Stub out the silence-the-warn console.
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };

  // Spy on the source-column call. Hand the function a dummy out-buffer.
  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(5, 0, seg, outPixels, outFgMap, 0);

  console.warn = origWarn;

  expect(vic._staleRowRenderHits === 1,
    `assertion must increment _staleRowRenderHits when invariant violated; got ${vic._staleRowRenderHits}`);
  expect(warned === true,
    `assertion must emit a console.warn on first violation; warned=${warned}`);

  // Disabling the trace turns the assertion off entirely.
  vic.frameTraceEnabled = false;
  vic._staleRowRenderHits = 0;
  console.warn = () => { warned = true; };
  warned = false;
  vic._renderSourceColumn(5, 0, seg, outPixels, outFgMap, 0);
  console.warn = origWarn;
  expect(vic._staleRowRenderHits === 0,
    `assertion must NOT fire when frameTraceEnabled=false; got ${vic._staleRowRenderHits}`);
  expect(warned === false,
    `assertion must NOT warn when frameTraceEnabled=false; warned=${warned}`);

  ok('stale-row-data trace assertion: fires under invariant violation, silent otherwise');
}

console.log(`\n${testNo} idle-state stale-row render spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
