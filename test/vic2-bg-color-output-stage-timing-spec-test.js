// Background-colour registers ($D021-$D024) are OUTPUT-STAGE timing spec.
//
// Bauer §3.6.1: only the graphics DATA is delayed 12px before display. The
// COLOUR registers — border $D020 AND the backgrounds $D021-$D024 — are
// applied at the output stage with the value live at the beam position, i.e.
// NO graphics delay. So a mid-line bg write changes the screen at the SAME
// pixel a $D020 (border) write at the same cycle would: pixel x ←
// lineCycleRegs[(x+111)>>3] (the _recolorBorderRow map). The cycle-incremental
// renderer can't read that +3 snapshot at paint time, so the end-of-line
// _fixupColumns pass re-renders the line with the border-timed bg snapshot.
//
// Validated against VICE/6569 (testprogs/VICII/spriteenable "stable line from
// X to Y": INC $D015 at cy55 plus two INC/DEC $D021 markers — the markers land
// at the border position, not the 12px-delayed graphics position).
//
// This file pins the FEATURE-level properties that vic2-color-bar-pixel-spec-
// test.js (single $D021 boundary) does not:
//   1. magnitude+direction — the boundary is ~3 cycles (23px) EARLIER
//      than the old graphics-delayed position, and equals the $D020 map.
//   2. multi-register — $D022 (MCM "01" pair) is output-stage too.
//   3. static bg → the _fixupColumns pass is a no-op (incremental path
//      unchanged for the common case).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout at raster=${vic.raster} cy=${vic.cycleInLine}`);
  }
}

// Output-stage boundary: the first canvas X showing the value that landed in
// lineCycleRegs[R]. Inverse of _recolorBorderRow's pixel↦cycle map (x+111)>>3.
// A CPU write at cy N PHI2 lands in lcr[N+1].
const bgBoundaryX = (R) => 8 * R - 111;
// Old (WRONG) graphics-delayed boundary: cycle C's segment starts here.
const cycleCanvasX = (c) => (c - 12) * 8 + 8;

// ── 1: $D021 — output-stage timing + magnitude/direction guard ─────────
// Idle text bg fill at raster 100. Write $D021=red at cy30 PHI2 (→ lcr[31]).
// The boundary must be at bgBoundaryX(31), which is ~3 cycles (23px)
// LEFT of the old graphics-delayed position cycleCanvasX(31).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;   // DEN=1, RSEL=1, text, YSCROLL=0
  vic.regs[0x16] = 0x08;   // CSEL=1
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x00;   // border black
  vic.regs[0x21] = 0x06;   // bg blue
  vic.displayEnabled = true;
  driveTo(vic, 100, 30);
  vic.write(0x21, 0x02);   // red @ cy30 phi2
  driveTo(vic, 101, 1);

  const ro = (100 - 15) * CANVAS_W;
  const bx = bgBoundaryX(31);            // 137
  const oldX = cycleCanvasX(31);         // 160
  expect(bx === 137 && oldX === 160, `sanity: bx=${bx} oldX=${oldX}`);
  expect(oldX - bx === 23, `magnitude: boundary is 23px earlier (border map 8R-111 vs graphics 8R-88)`);
  // Exact boundary.
  expect(vic.fb32[ro + bx - 1] === PAL(0x06), `x${bx - 1} = last blue (pre-boundary)`);
  expect(vic.fb32[ro + bx] === PAL(0x02), `x${bx} = first red (post-boundary)`);
  // Direction guard: the WHOLE band between the new and old boundaries is now
  // RED. With the old graphics-delayed timing every one of these was BLUE.
  for (let x = bx; x < oldX; x++) {
    expect(vic.fb32[ro + x] === PAL(0x02),
      `x${x} (between new & old boundary): expected red, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('$D021 mid-line write changes bg at the output-stage (border) boundary, 23px before the graphics-delayed position');
}

// ── 2: $D022 (MCM "01" pair) is output-stage too ───────────────────────
// Multicolor text, a uniform glyph of all "01" pairs → the entire inner
// display is $D022. Write $D022 mid-line; the colour bar boundary must be at
// the same border-timed position as $D021's.
{
  const vic = makeVic();
  const CODE = 0x20;                 // screen code (glyph at CB + $20*8 = $0100)
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = CODE;   // VM=$0400
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x08;        // bit3 set → multicolor
  for (let b = 0; b < 8; b++) vic.ram[CODE * 8 + b] = 0x55;       // 0b01010101 → all "01"
  vic.regs[0x11] = 0x18;   // text, YSCROLL=0 → bad line at raster&7==0
  vic.regs[0x16] = 0x18;   // CSEL=1 + MCM
  vic.regs[0x18] = 0x10;   // VM=$0400, CB=$0000
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x06;   // bg0 (the "00" pair — unused here)
  vic.regs[0x22] = 0x02;   // $D022 = red (the "01" pair colour)
  vic.displayEnabled = true;

  driveTo(vic, 0x38, 30);  // 0x38=56, a bad line (56&7==0) → matrix fetched
  vic.write(0x22, 0x05);   // $D022 → green @ cy30 phi2
  driveTo(vic, 0x39, 1);

  const ro = (0x38 - 15) * CANVAS_W;
  // $D022 has no orchestrator first-pixel override, so its bar steps cleanly
  // at the segment boundary for lcr[31] = cycleCanvasX(28) = 136. Sample
  // clear of it: a column before (red/old) and after (green/new), and assert
  // the post pixel sits LEFT of the old graphics-delayed boundary (160).
  expect(vic.fb32[ro + 120] === PAL(0x02), `MCM x120 (pre): $D022 red, got 0x${vic.fb32[ro + 120].toString(16)}`);
  expect(vic.fb32[ro + 152] === PAL(0x05), `MCM x152 (post, < old 160): $D022 green, got 0x${vic.fb32[ro + 152].toString(16)}`);
  ok('$D022 (MCM "01" pair) mid-line write is output-stage — bar shifts to the border-timed position');
}

// ── 3: static bg → _fixupColumns is a no-op (incremental path unchanged) ─
// No mid-line bg/mode change: the whole inner display stays one colour, and
// the end-of-line fixup must not perturb a single pixel.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x06;   // blue, never changed
  vic.displayEnabled = true;
  driveTo(vic, 100, 1);
  driveTo(vic, 101, 1);

  const ro = (100 - 15) * CANVAS_W;
  let nonBlue = 0;
  for (let x = cycleCanvasX(16); x < cycleCanvasX(55); x++) {
    if (vic.fb32[ro + x] !== PAL(0x06)) nonBlue++;
  }
  expect(nonBlue === 0, `static bg: inner display all blue, found ${nonBlue} non-blue pixels`);
  ok('static bg → end-of-line fixup is a no-op (uniform inner display)');
}

// ── 4: opened idle inner-zone $D021 IS output-stage retimed (matches VICE) ──
// The $D021 background colour mux is the SAME output-stage hardware in idle and
// display state — only the graphics DATA differs (idle byte vs matrix). So a
// mid-line $D021 write in an opened idle inner zone (side-border / FLD demos)
// changes the bg at the SAME beam-position / +3 border-timed boundary as in a
// display column, NOT at the 12px-delayed graphics position.
//
// Decisive VICE evidence — The Hat (FLT&GP) raster wall (disk A, frame 155.5M):
// the wall is DEN=0 idle + side-border-open with $D021 colour bars and sprite
// "mortar" columns. Across the visible wall, EVERY row whose bg colour changes
// mid-row places the colour boundary cleanly on a mortar column (178 rows
// measured; 0 rows split a brick face). Un-retimed idle bg would split brick
// faces 24px / 3 cycles right of the mortar.
//
// (Earlier this case was deliberately left un-retimed on the belief it broke
// the orbit_untold FAIRLIGHT rasterbars; that was a confounded mis-diagnosis —
// the FAIRLIGHT issue is a separate, pre-existing VERTICAL 1-line skew. The
// brick-face evidence above settles it: VICE retimes opened-idle bg.)
// Run the identical idle-inner-zone scenario through BOTH _fixupColumns code
// paths — the default batchRender=true fast path AND the whole-line non-batch
// path — since the retiming fix touches both and the wall hits the batch path.
function idleRetimeCheck(batchRender) {
  const vic = makeVic();
  vic.batchRender = batchRender;
  const raster = 100;
  const canvasY = raster - 15;
  const ro = canvasY * CANVAS_W;
  const oldBg = 0x01;
  const nextBg = 0x0D;

  vic._initRenderRasterLine(raster, canvasY);
  vic.fb32.fill(PAL(oldBg), ro, ro + CANVAS_W);
  vic._lineStartD011 = 0x08;
  vic._lineStartD021 = oldBg;

  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    const regs = vic.lineCycleRegs[c];
    regs.fill(0);
    regs[0x11] = 0x08;       // stable text/idle mode bits
    regs[0x16] = 0xBF;       // CSEL=1, MCM=1, XSCROLL=7
    regs[0x18] = 0x1D;
    regs[0x20] = 0x00;
    regs[0x21] = c >= 46 ? nextBg : oldBg;   // bg changes at lcr[46]

    vic.lineCycleDisplayActive[c] = 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleMatrixFetchActive[c] = 0;
    vic.lineCycleHInner[c] = 1;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x00;
  }

  vic._fixupColumns(canvasY);

  // Output-stage boundary for the value that landed in lcr[46] = bgBoundaryX(46)
  // = 257 — the SAME border-timed map a display column uses (tests 1/2), 3
  // cycles LEFT of the old graphics-delayed position cycleCanvasX(46)=280.
  const bx = bgBoundaryX(46);              // 257
  const oldX = cycleCanvasX(46);           // 280
  expect(bx === 257 && oldX === 280, `sanity: bx=${bx} oldX=${oldX}`);
  // 6569 takes the 1-pixel first-pixel step to the previous value at the
  // segment boundary, so x256 is still oldBg and x257 is the first nextBg.
  expect(vic.fb32[ro + bx - 1] === PAL(oldBg), `x${bx - 1} = last oldBg (pre-boundary)`);
  expect(vic.fb32[ro + bx] === PAL(nextBg), `x${bx} = first nextBg (output-stage boundary)`);
  // The whole band between the new (border-timed) and old (graphics-delayed)
  // boundaries is now nextBg — proving the idle bg was pulled to the output stage.
  let split = -1;
  for (let x = bx; x < oldX; x++) {
    if (vic.fb32[ro + x] !== PAL(nextBg)) { split = x; break; }
  }
  expect(split < 0, `idle inner-zone retimed to output stage; band [${bx},${oldX}) all nextBg (first non-nextBg x=${split})`);
}

idleRetimeCheck(true);
ok('opened idle inner-zone $D021 IS output-stage retimed — batchRender path (matches VICE — The Hat brick-wall)');
idleRetimeCheck(false);
ok('opened idle inner-zone $D021 IS output-stage retimed — non-batch whole-line path');

// ── 5: opened display side-zone $D021 uses normal output-stage timing ─────
// Lunatico's Workbench header opens the side border while display state is
// active. The opened side-zones are outside the normal display-column area,
// but Bauer §3.7.3 says the current background colour is displayed there when
// the border FF is open. The bg colour still uses the normal output-stage
// timing: a cycle-14 pull-up reaches the framebuffer at x9, not x0 or x32.
function displaySideZoneRetimeCheck(batchRender) {
  const vic = makeVic();
  vic.batchRender = batchRender;
  const raster = 100;
  const canvasY = raster - 15;
  const ro = canvasY * CANVAS_W;
  const oldBg = 0x0C;
  const nextBg = 0x01;

  vic._initRenderRasterLine(raster, canvasY);
  vic.fb32.fill(PAL(oldBg), ro, ro + CANVAS_W);
  vic._lineStartD011 = 0x18;
  vic._lineStartD021 = oldBg;

  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    const regs = vic.lineCycleRegs[c];
    regs.fill(0);
    regs[0x11] = 0x18;       // display state, text mode
    regs[0x16] = 0x08;       // CSEL=1, XSCROLL=0
    regs[0x18] = 0x10;
    regs[0x20] = 0x00;
    regs[0x21] = (c >= 15 && c < 61) ? nextBg : oldBg;

    vic.lineCycleDisplayActive[c] = 1;
    vic.lineCycleDisplayColumnActive[c] = c >= 15 && c <= 54 ? 1 : 0;
    vic.lineCycleMatrixFetchActive[c] = 0;
    vic.lineCycleHInner[c] = c >= 15 && c <= 54 ? 1 : 0;
    vic.lineCycleHBorder[c] = 0;          // side border is opened
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x00;
  }

  for (let c = 11; c <= 58; c++) {
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(c), canvasY);
  }
  vic._fixupColumns(canvasY);

  for (let x = 0; x < 9; x++) {
    expect(vic.fb32[ro + x] === PAL(oldBg),
      `opened display left side-zone x${x}: expected pre-boundary old bg, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  expect(vic.fb32[ro + 9] === PAL(nextBg), `opened display side-zone x9 uses pulled-up bg`);
  expect(vic.fb32[ro + 32] === PAL(nextBg), `display column start x32 remains pulled-up bg`);
  expect(vic.fb32[ro + 376] === PAL(nextBg), `right-side icon edge x376 still uses pulled-up bg`);
  expect(vic.fb32[ro + 377] === PAL(oldBg), `opened display right side-zone x377 retimes back to old bg`);
}

displaySideZoneRetimeCheck(true);
ok('opened display side-zone $D021 uses normal output-stage timing — batchRender path');
displaySideZoneRetimeCheck(false);
ok('opened display side-zone $D021 uses normal output-stage timing — non-batch whole-line path');

// ── 6: opened idle side-zone $D021 uses normal output-stage timing ────────
// The bottom-border Workbench entry is display-state idle, not active display.
// Bauer §3.14.1 says opened upper/lower border can expose idle-state graphics;
// the pre-inner side-zone still displays current background colour, with the
// same normal output-stage timing as the active-display side-zone above.
function idleSideZoneRetimeCheck(batchRender) {
  const vic = makeVic();
  vic.batchRender = batchRender;
  const raster = 100;
  const canvasY = raster - 15;
  const ro = canvasY * CANVAS_W;
  const oldBg = 0x0C;
  const nextBg = 0x01;

  vic._initRenderRasterLine(raster, canvasY);
  vic.fb32.fill(PAL(oldBg), ro, ro + CANVAS_W);
  vic._lineStartD011 = 0x18;
  vic._lineStartD021 = oldBg;

  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    const regs = vic.lineCycleRegs[c];
    regs.fill(0);
    regs[0x11] = 0x18;
    regs[0x16] = 0x08;
    regs[0x18] = 0x10;
    regs[0x20] = 0x00;
    regs[0x21] = (c >= 15 && c < 61) ? nextBg : oldBg;

    vic.lineCycleDisplayActive[c] = 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleMatrixFetchActive[c] = 0;
    vic.lineCycleHInner[c] = c >= 15 && c <= 54 ? 1 : 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x00;
  }

  for (let c = 11; c <= 58; c++) {
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(c), canvasY);
  }
  vic._fixupColumns(canvasY);

  for (let x = 0; x < 9; x++) {
    expect(vic.fb32[ro + x] === PAL(oldBg),
      `opened idle left side-zone x${x}: expected pre-boundary old bg, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  expect(vic.fb32[ro + 9] === PAL(nextBg), `opened idle side-zone x9 uses pulled-up bg`);
  expect(vic.fb32[ro + 32] === PAL(nextBg), `idle inner start x32 remains pulled-up bg`);
  expect(vic.fb32[ro + 376] === PAL(nextBg), `idle right-side icon edge x376 still uses pulled-up bg`);
  expect(vic.fb32[ro + 377] === PAL(oldBg), `opened idle right side-zone x377 retimes back to old bg`);
}

idleSideZoneRetimeCheck(true);
ok('opened idle side-zone $D021 uses normal output-stage timing — batchRender path');
idleSideZoneRetimeCheck(false);
ok('opened idle side-zone $D021 uses normal output-stage timing — non-batch whole-line path');

// ── 7: opened-idle retime starts after the left-edge startup window ────────
// An opened idle inner zone can change $D021 just after the left edge. The
// first two opened-idle cycles keep their segment-local colour; cycle 18 and
// later still use output-stage timing, which keeps the raster-wall behavior
// above.
function idleStartupCheck(batchRender) {
  const vic = makeVic();
  vic.batchRender = batchRender;
  const raster = 100;
  const canvasY = raster - 15;
  const ro = canvasY * CANVAS_W;
  const oldBg = 0x00;
  const nextBg = 0x06;

  vic._initRenderRasterLine(raster, canvasY);
  vic._lineStartD011 = 0x08;
  vic._lineStartD021 = oldBg;

  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    const regs = vic.lineCycleRegs[c];
    regs.fill(0);
    regs[0x11] = 0x08;       // stable text/idle mode bits
    regs[0x16] = 0x08;       // CSEL=1, XSCROLL=0
    regs[0x18] = 0x14;
    regs[0x20] = 0x00;
    regs[0x21] = c >= 18 ? nextBg : oldBg;

    vic.lineCycleDisplayActive[c] = 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleMatrixFetchActive[c] = 0;
    vic.lineCycleHInner[c] = c >= 15 && c <= 54 ? 1 : 0;
    vic.lineCycleHBorder[c] = vic.lineCycleHInner[c] ? 0 : 1;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x00;       // all background pixels
  }

  // Reproduce the incremental row first, then let _fixupColumns apply the
  // output-stage corrections. This matches the runtime merge path.
  for (let c = 11; c <= 58; c++) {
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(c), canvasY);
  }
  vic._fixupColumns(canvasY);

  expect(vic.fb32[ro + 41] === PAL(oldBg), `cycle 16 startup x41 stays old bg`);
  expect(vic.fb32[ro + 49] === PAL(oldBg), `cycle 17 startup x49 stays old bg`);
  expect(vic.fb32[ro + 56] === PAL(nextBg), `cycle 18 first pixel uses retimed bg`);
  expect(vic.fb32[ro + 57] === PAL(nextBg), `cycle 18 x57 uses retimed bg`);
}

idleStartupCheck(true);
ok('opened idle left-edge startup is not retimed — batchRender path');
idleStartupCheck(false);
ok('opened idle left-edge startup is not retimed — non-batch whole-line path');

// ── 8: visible sprite pixels survive the bg retime merge ─────────────────
// _fixupColumns re-renders graphics twice and merges only graphics-owned
// pixels. A visible sprite pixel can be the SAME colour as the incremental
// graphics underneath it; colour equality alone must not make it eligible for
// bg retiming. OrbitUntold's moving FAIRLIGHT rasterbar hits this: sprites 4/5
// paint the current line's $D026 colour over a $D021 bar, and the retimed
// graphics pass would otherwise pull the next $D021 colour through the sprite.
function visibleSpriteMergeCheck(batchRender) {
  const vic = makeVic();
  vic.batchRender = batchRender;
  const raster = 100;
  const canvasY = raster - 15;
  const ro = canvasY * CANVAS_W;
  const oldBg = 0x09;
  const nextBg = 0x0B;
  const bx = bgBoundaryX(46);       // 257
  const oldX = cycleCanvasX(46);    // 280
  const hiddenX = bx;

  vic._initRenderRasterLine(raster, canvasY);
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    const regs = vic.lineCycleRegs[c];
    regs.fill(0);
    regs[0x11] = 0x18;
    regs[0x16] = 0x08;
    regs[0x18] = 0x10;
    regs[0x20] = 0x00;
    regs[0x21] = c >= 46 ? nextBg : oldBg;

    vic.lineCycleDisplayActive[c] = 1;
    vic.lineCycleDisplayColumnActive[c] = c >= 15 && c <= 54 ? 1 : 0;
    vic.lineCycleMatrixFetchActive[c] = 0;
    vic.lineCycleHInner[c] = 1;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x00;       // background-only graphics
  }

  for (let c = 11; c <= 58; c++) {
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(c), canvasY);
  }
  // Visible sprite over the retime band, with the same colour as the old
  // incremental graphics. This is the ambiguous case the merge must resolve
  // using visible-sprite state, not RGBA equality.
  for (let x = bx + 1; x < oldX; x++) {
    vic.spriteOwnerBuffer[x] = 5;
    vic.spriteVisibleBuffer[x] = 1;
    vic.fb32[ro + x] = PAL(oldBg);
  }
  // Hidden priority sprite: owner is claimed, but no visible overwrite
  // occurred, so the graphics retime must still apply.
  vic.spriteOwnerBuffer[hiddenX] = 4;
  vic.spriteVisibleBuffer[hiddenX] = 0;
  vic.fb32[ro + hiddenX] = PAL(oldBg);

  vic._fixupColumns(canvasY);

  for (let x = bx + 1; x < oldX; x++) {
    expect(vic.fb32[ro + x] === PAL(oldBg),
      `visible sprite x${x}: preserved old sprite colour across bg retime`);
  }
  expect(vic.fb32[ro + hiddenX] === PAL(nextBg),
    `hidden priority sprite owner does not block graphics retime at x${hiddenX}`);
}

visibleSpriteMergeCheck(true);
ok('visible sprite pixels survive _fixupColumns bg retime — batchRender path');
visibleSpriteMergeCheck(false);
ok('visible sprite pixels survive _fixupColumns bg retime — non-batch whole-line path');

console.log(`\n${testNo - testsFailing}/${testNo} passed${testsFailing ? `, ${testsFailing} FAILED` : ''}`);
if (testsFailing) process.exit(1);
