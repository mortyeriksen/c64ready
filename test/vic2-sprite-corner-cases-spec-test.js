// sprite-corner-cases-spec-test.js
//
// Spec-derived corner-case coverage. Targets gaps identified during the
// Nine-bug-hunt that existing tests don't cover:
//
//   1. Sprite-X $1F8..$1FF invisibility (Bauer §3.8.1 last paragraph).
//   2. Sprite multiplexer RENDER output (existing tests verify DMA
//      latches but not pixels at each instance).
//   3. Multiplexer where the second instance lands in the TOP BORDER
//      (Nine-relevant — this IS the user's "9 sprites in top border"
//      scenario).
//   4. Sprite priority MxDP + the §3.8.2 inheritance effect.
//   5. Invalid mode $70 (ECM=1, BMM=1, MCM=0) — Bauer §3.7.3.7.
//   6. Sprite-X MSB ($D010) — bit 8 of the 9-bit sprite X.
//
// Does NOT load nine.prg or orbituntold.prg.
//
// Spec citations:
//
//   Bauer §3.8.1 (final paragraph): "on a 6569, sprites with an X
//   position in the range $1f8-$1ff become invisible because these
//   values are never reached by the X raster counter; to place a
//   sprite one pixel to the left of X position 0 it has to be at X
//   position $1f7."
//
//   Bauer §3.8.1 closing: "Sprites can be 'reused' vertically: If
//   you change the Y coordinate of a sprite to a later raster line
//   during or after its display has completed... the sprite is
//   displayed again at that Y coordinate."
//
//   Bauer §3.8.2: priority hierarchy (sprite 0 highest, sprite 7
//   lowest); MxDP controls sprite-vs-foreground; the inheritance
//   effect — foreground pixels overlapping a hidden MxDP=1 sprite
//   inherit the sprite's priority and stay visible against
//   lower-priority sprites.
//
//   Bauer §3.7.3.7: "ECM=1, BMM=1, MCM=0" — invalid bitmap mode 1.
//   Every pixel BLACK; foreground bits drive sprite-fg collision.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFails = [];

function expect(cond, msg) { if (!cond) currentFails.push(msg); }
function ok(label) {
  testNo++;
  if (currentFails.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFails) console.log(`     - ${m}`);
    currentFails = [];
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
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  v.regs[0x11] = 0x1B;          // DEN=1, RSEL=1
  v.regs[0x16] = 0x08;          // CSEL=1
  v.displayEnabled = true;
  return v;
}

function driveTo(vic, raster, cycle = 1) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

function paletteRGBA(idx) {
  const c = C64_PALETTE[idx & 0x0F];
  return (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
}

// Set up sprite 0 with an opaque solid-color pattern at sprite block 0x80
// → data at $2000. Returns the sprite color RGBA for assertions.
function loadSp0AllOpaque(vic, colorIdx = 0x07) {
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;
  vic.regs[0x18] = 0x14;        // screen base $0400
  vic.regs[0x27] = colorIdx;
  return paletteRGBA(colorIdx);
}

// Count sprite pixels (color-matching) on a given canvas row.
function countSpritePixelsOnRow(vic, canvasY, color) {
  const ro = canvasY * CANVAS_W;
  let count = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.fb32[ro + x] === color) count++;
  }
  return count;
}

// ─── 1: Sprite-X = $1F8 — invisible (Bauer §3.8.1) ───────────────────────
//
// The 9-bit X counter wraps at $1F8 (= 504). X positions $1F8..$1FF map
// to canvas X 8..15 by modular arithmetic, but Bauer says these values
// are "never reached by the X raster counter" so the sprite never
// matches and never paints. (Our impl handles wrap at canvas X=504 in
// `_paintSpriteSameLineWrap`; the spec invisibility band at X=$1F8
// must not paint via either path.)
//
// However: looking at our impl's wrap support (vic2.js:2721-2765, "PAL
// sprite-X horizontal wrap SAME line"), we DO paint sprites at X >=
// $1F8 via the wrap path. Bauer's text describes 6569 hardware
// behavior that does NOT do this wrap — strict reading: X=$1F8 is
// invisible. The wrap path is FAIRLIGHT-validated but may diverge
// from the §3.8.1 closing paragraph for X in [$1F8, $1FF].
//
// This test asserts the strict-spec interpretation. If our impl
// paints the sprite, the test fails — that's the spec-violation
// signal.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0xF8;        // X low = $F8
  vic.regs[0x10] = 0x01;        // X MSB set → X = $1F8
  vic.regs[0x01] = 99;          // Y = 99 → display starts L100
  const yellowRGBA = loadSp0AllOpaque(vic, 0x07);
  vic.regs[0x21] = 0x06;        // bg = blue
  vic.regs[0x20] = 0x0E;        // border = lt blue

  // Drive to L100 c63 (display ON, full line rendered).
  driveTo(vic, 100, 1);
  for (let i = 0; i < 50; i++) vic.clock(1);   // get well past row-access

  const canvasY = 100 - 15;
  const yellowCount = countSpritePixelsOnRow(vic, canvasY, yellowRGBA);
  expect(yellowCount === 0,
    `Bauer §3.8.1 last paragraph: X=$1F8 must be invisible, got ${yellowCount} sprite pixels on row`);
  ok('Bauer §3.8.1: sprite-X = $1F8 is invisible (X counter never reaches there)');
}

// ─── 2: Sprite-X = $1FF — invisible (top of the dead-zone) ───────────────
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0xFF;
  vic.regs[0x10] = 0x01;        // X = $1FF
  vic.regs[0x01] = 99;
  const yellowRGBA = loadSp0AllOpaque(vic);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  driveTo(vic, 100, 1);
  for (let i = 0; i < 50; i++) vic.clock(1);

  const canvasY = 100 - 15;
  const yellowCount = countSpritePixelsOnRow(vic, canvasY, yellowRGBA);
  expect(yellowCount === 0,
    `Bauer §3.8.1: X=$1FF must be invisible, got ${yellowCount} sprite pixels`);
  ok('Bauer §3.8.1: sprite-X = $1FF is invisible (top of dead-zone)');
}

// ─── 3: Sprite-X = $0 — visible (positive control, no wrap involved) ─────
//
// Pure-positive control for the X=$1F8 invisibility band. X=$0 places
// the sprite at the leftmost active-display column. Sprite must paint.
// (X=$1F7 is also "visible" per spec but its pixels land in the LEFT
// BORDER zone — they're rendered by the wrap path but masked by the
// closed left border. Without hyperscreen the left-border block is
// expected; that's a different test concern from §3.8.1's
// dead-zone rule.)
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x00;
  vic.regs[0x10] = 0x00;        // X = 0
  vic.regs[0x01] = 99;
  const yellowRGBA = loadSp0AllOpaque(vic);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  driveTo(vic, 100, 1);
  for (let i = 0; i < 62; i++) vic.clock(1);

  const canvasY = 100 - 15;
  const yellowCount = countSpritePixelsOnRow(vic, canvasY, yellowRGBA);
  // Sprite at X=0 spans canvas X 8..31 — this lands in the LEFT BORDER
  // zone (canvas X < GRAPHICS_WINDOW_START=32), which is closed by
  // default → masked. So with default borders, count is 0. This is
  // the expected spec behavior. The control we want is "wrap math
  // produces a paintable sprite" — verified in test 4 with X=$40.
  expect(yellowCount === 0,
    `X=0 sprite spans canvas X 8..31 (left border zone, masked), got ${yellowCount}`);
  ok('Bauer §3.9: sprite at X=0 lands in left border zone, masked by closed main-FF');
}

// ─── 4: Sprite multiplexer — first instance renders ──────────────────────
//
// Setup: sp0 Y=51, displays L52..L72. Verify yellow pixels on a
// mid-display row (e.g., L60).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x40;        // X = 64
  vic.regs[0x01] = 51;
  const yellowRGBA = loadSp0AllOpaque(vic);
  vic.regs[0x21] = 0x06;

  driveTo(vic, 60, 1);
  for (let i = 0; i < 60; i++) vic.clock(1);

  const canvasY = 60 - 15;
  const yellowCount = countSpritePixelsOnRow(vic, canvasY, yellowRGBA);
  expect(yellowCount === 24,
    `1st instance L60: 24 yellow sprite px (no X-expand), got ${yellowCount}`);
  ok('multiplexer pre: sprite first instance renders 24 sprite pixels at mid-display');
}

// ─── 5: Sprite multiplexer — SECOND instance renders after Y rewrite ─────
//
// Demo-style multiplexer: sp0 finishes display at L72; CPU rewrites Y
// to 100 between L72 and L100 → DMA restarts at L100, display L101..L121.
// Verify second instance also renders.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x40;
  vic.regs[0x01] = 51;
  const yellowRGBA = loadSp0AllOpaque(vic);
  vic.regs[0x21] = 0x06;

  // Run first display window.
  driveTo(vic, 73, 1);
  expect(vic.spriteDmaOn[0] === 0, 'pre: first display ended');

  // Rewrite Y for second instance.
  vic.regs[0x01] = 100;
  driveTo(vic, 105, 1);
  for (let i = 0; i < 60; i++) vic.clock(1);

  const canvasY = 105 - 15;
  const yellowCount = countSpritePixelsOnRow(vic, canvasY, yellowRGBA);
  expect(yellowCount === 24,
    `2nd instance L105: 24 yellow sprite px after Y rewrite, got ${yellowCount}`);
  ok('Bauer §3.8.1 closing: multiplexer 2nd-instance renders 24 sprite pixels');
}

// ─── 6: Multiplexer SECOND instance lands in TOP BORDER (Nine-relevant) ─
//
// User-visible scenario: rewrite sp0 Y to a value in the TOP-BORDER
// zone (raster 0..50 with RSEL=1). Display starts there. With vBorder=1
// (top border closed), main border FF stays SET (rule 6 needs vBorder=0
// to reset). borderBuffer[canvas Y in 0..35] = 1 → sprites NOT visible.
//
// Per spec the SPRITE STATE is correct (display on, MC counter cycling),
// but the renderer's borderBuffer gate hides them. To make sprites
// visible in the top border, the demo uses §3.14.1 Method 2 (open both
// vBorder and side borders).
//
// Test what we CAN assert without the hyperscreen trick:
//   - DMA restarts when Y matches a top-border raster.
//   - displayOn turns on at cycle 58 phi1 of that line.
//   - With vBorder=1, sprites do NOT paint to canvas (border gates).
//
// And separately, with vBorder forced to 0 (simulating Method 2):
//   - Sprites DO paint in the top border.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x40;
  vic.regs[0x01] = 51;          // first instance
  const yellowRGBA = loadSp0AllOpaque(vic);
  vic.regs[0x21] = 0x06;

  driveTo(vic, 73, 1);
  vic.regs[0x01] = 30;          // second instance Y in top border (RSEL=1 top-compare=51)

  // Drive past the wrap to ensure new frame's L30 sees Y=30 match.
  driveTo(vic, 30, 1);
  driveTo(vic, 30, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `2nd instance Y=30: DMA latches at L30.c55 even in top border zone`);
  expect(vic.vBorderActive === true,
    `pre: vBorderActive = true (we're in top border, no hyperscreen trick)`);

  // Drive to L31 c58 — display ON (rule 4 fires regardless of vBorder).
  driveTo(vic, 31, 58);
  expect(vic.spriteDisplayOn[0] === 1,
    `Bauer §3.8: display flag set in top border (sprite logic doesn't gate on vBorder)`);
  ok('Bauer §3.8: 2nd-instance multiplexer sets DMA + display in top border zone');
}

// (Method 2 hyperscreen render is already covered by
// `side-border-open-spec-test.js` — no duplicate here.)

// Helper for priority tests — synthesizes per-cycle state directly so
// the live-clock state machine doesn't have to be driven through the
// bad-line activation path. Pattern matches sprite-render-spec-test.js.
//
// Setup: standard text mode, char $00 = solid (8 ones), color RAM
// all white. Sprite 0 enabled, opaque, at canvas X 108..131. The
// canvas X 108..127 corresponds to char columns 9..11 (canvas X
// 32+col*8). All those cols are char $00 → white foreground.

function synthPriorityLine(vic, raster, mxdp, sprX) {
  vic.regs[0x15] = 0x01;
  vic.regs[0x1B] = mxdp;
  vic.regs[0x21] = 0x06;            // bg = blue
  vic.regs[0x20] = 0x0E;
  vic.regs[0x18] = 0x14;            // screen $0400, char base $1000 (CHAR ROM)
  vic.regs[0x27] = 0x07;            // sp0 = yellow
  // Synthesize per-cycle state (display ON + char-fetch active).
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRegs[c][0x15] = 0x01;
    vic.lineCycleRegs[c][0x1B] = mxdp;
    vic.lineCycleRegs[c][sprX < 256 ? 0x00 : 0x10] = sprX < 256 ? sprX : 0x01;
    vic.lineCycleRegs[c][0x00] = sprX & 0xFF;
    vic.lineCycleRegs[c][0x21] = 0x06;
    vic.lineCycleRegs[c][0x27] = 0x07;
    vic.lineCycleRegs[c][0x18] = 0x14;
    vic.lineCycleVBorder[c] = 0;     // not in vertical border
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c < 15 || c > 55) ? 1 : 0; // open in display range
    vic.lineCycleHBorderBefore[c] = (c < 15 || c > 55) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayActive[c] = 1;
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleIdleByte[c] = 0;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    // Sprite display state — opaque all-1s shifter.
    vic.lineCycleSpriteDisplayOn[c][0] = 1;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
  }
  // Char $00 in CHAR ROM = solid 0xFF.
  for (let i = 0; i < 8; i++) vic.charRom[i] = 0xFF;
  // Screen all char $00, color RAM all white.
  for (let c = 0; c < 40; c++) {
    vic.ram[0x0400 + c] = 0x00;
    vic.colorRam[c] = 0x01;
    vic.lineCycleRowFetchedCols[15 + c]?.fill?.(0); // dont care
  }
  // Force the row-fetch state so renderer reads chars.
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[c][col] = 1;
      vic.lineCycleRowCodes[c][col] = 0x00;
      vic.lineCycleRowColors[c][col] = 0x01;
    }
  }
  // Sprite render state — opaque shifter.
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteLineDataRow[0] = 0;
  vic.spriteDisplayOn[0] = 1;
  // Render the synthesized line.
  vic._renderRasterLine(raster);
}

// ─── 8: Sprite priority MxDP=0 — sprite over foreground (default) ────────
//
// Bauer §3.8.2: MxDP=0 → sprite displayed in front of foreground.
// At sprite/fg overlap pixels, sprite color (yellow) wins.
{
  const vic = makeVic();
  synthPriorityLine(vic, 100, 0x00, 100);  // sp0 X=100 → canvas X 108..131
  const yellowRGBA = paletteRGBA(0x07);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  let yellowAtSprite = 0;
  for (let x = 108; x < 132; x++) if (vic.fb32[ro + x] === yellowRGBA) yellowAtSprite++;
  expect(yellowAtSprite === 24,
    `MxDP=0: sprite over fg — 24 yellow at sprite zone, got ${yellowAtSprite}`);
  ok('Bauer §3.8.2: MxDP=0 — sprite displays in front of foreground');
}

// ─── 9: Sprite priority MxDP=1 — foreground over sprite ──────────────────
{
  const vic = makeVic();
  synthPriorityLine(vic, 100, 0x01, 100);
  const whiteRGBA = paletteRGBA(0x01);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  let whiteAtSprite = 0;
  for (let x = 108; x < 132; x++) if (vic.fb32[ro + x] === whiteRGBA) whiteAtSprite++;
  expect(whiteAtSprite === 24,
    `MxDP=1: fg over sprite — 24 white at sprite zone, got ${whiteAtSprite}`);
  ok('Bauer §3.8.2: MxDP=1 — foreground displays in front of sprite');
}

// ─── 10: Sprite-sprite priority — sprite 0 over sprite 1 (overlap) ───────
//
// Bauer §3.8.2: sprite 0 has highest priority; sprite 1 only paints
// where sprite 0 has transparent pixels. Setup: both sprites at SAME X
// position, both opaque → all pixels show sprite 0's color.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x03;         // sp0 + sp1 enabled
  vic.regs[0x00] = 100;          // sp0 X
  vic.regs[0x02] = 100;          // sp1 X (SAME)
  vic.regs[0x01] = 51;           // sp0 Y
  vic.regs[0x03] = 51;           // sp1 Y
  // sp0 yellow, sp1 red.
  const yellowRGBA = paletteRGBA(0x07);
  const redRGBA = paletteRGBA(0x02);
  vic.regs[0x27] = 0x07; vic.regs[0x28] = 0x02;
  // Sprite data (both opaque).
  for (let i = 0; i < 63; i++) {
    vic.ram[0x2000 + i] = 0xFF;
    vic.ram[0x2040 + i] = 0xFF;
  }
  vic.ram[0x07F8] = 0x80;        // sp0 → $2000
  vic.ram[0x07F9] = 0x81;        // sp1 → $2040
  vic.regs[0x18] = 0x14;
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  driveTo(vic, 60, 1);
  for (let i = 0; i < 62; i++) vic.clock(1);

  const canvasY = 60 - 15;
  const ro = canvasY * CANVAS_W;
  let yellow = 0, red = 0;
  for (let x = 108; x < 132; x++) {
    if (vic.fb32[ro + x] === yellowRGBA) yellow++;
    if (vic.fb32[ro + x] === redRGBA) red++;
  }
  expect(yellow === 24, `sp0 over sp1: 24 yellow at overlap, got ${yellow}`);
  expect(red === 0, `sp0 over sp1: 0 red (sp1 fully hidden), got ${red}`);
  ok('Bauer §3.8.2: sprite 0 has highest priority — fully covers sp1 at same X');
}

// ─── 10: Inheritance — MxDP=1 sp0 hidden by fg "blocks" sp1 ──────────────
//
// Bauer §3.8.2: "if sprite 0 is set to appear behind the foreground
// (M0DP=1) then the foreground pixels which overlap the image of
// sprite always stay visible, even if sprite 0 overlaps with
// lower-priority sprites which are configured to appear in front of
// the foreground (MxDP=0)."
//
// Synthesized line: foreground char (white) at all cols + sp0 (MxDP=1,
// yellow, opaque) + sp1 (MxDP=0, red, opaque). Both sprites at same
// canvas X. Spec: at fg-foreground pixels, fg covers sp0 (MxDP=1) →
// sp0's inheritance blocks sp1 → white visible (NOT red).
{
  const vic = makeVic();
  // Build synthesized state via the same per-cycle pattern.
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x18] = 0x14;
  vic.regs[0x27] = 0x07;          // sp0 yellow
  vic.regs[0x28] = 0x02;          // sp1 red
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRegs[c][0x15] = 0x03;
    vic.lineCycleRegs[c][0x1B] = 0x01;     // sp0 MxDP=1, sp1 MxDP=0
    vic.lineCycleRegs[c][0x00] = 100;       // sp0 X
    vic.lineCycleRegs[c][0x02] = 100;       // sp1 X
    vic.lineCycleRegs[c][0x21] = 0x06;
    vic.lineCycleRegs[c][0x27] = 0x07;
    vic.lineCycleRegs[c][0x28] = 0x02;
    vic.lineCycleRegs[c][0x18] = 0x14;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c < 15 || c > 55) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = (c < 15 || c > 55) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayActive[c] = 1;
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleIdleByte[c] = 0;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    // Both sprites display ON, opaque shifter.
    vic.lineCycleSpriteDisplayOn[c][0] = 1;
    vic.lineCycleSpriteDisplayOn[c][1] = 1;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteDataRow[c][1] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteRowByteMask[c][1] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
    vic.lineCycleSpriteShiftReg[c][1] = 0xFFFFFF;
  }
  // Char $00 = solid white (all bits set). Color RAM all white.
  for (let i = 0; i < 8; i++) vic.charRom[i] = 0xFF;
  for (let c = 0; c < 40; c++) {
    vic.ram[0x0400 + c] = 0x00;
    vic.colorRam[c] = 0x01;
  }
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[c][col] = 1;
      vic.lineCycleRowCodes[c][col] = 0x00;
      vic.lineCycleRowColors[c][col] = 0x01;
    }
  }
  // Live state mirrors per-cycle.
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic.spriteShiftReg[1] = 0xFFFFFF;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteRowByteMask[1] = 0x07;
  vic.spriteLineDataRow[0] = 0;
  vic.spriteLineDataRow[1] = 0;
  vic.spriteDisplayOn[0] = 1;
  vic.spriteDisplayOn[1] = 1;

  vic._renderRasterLine(100);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  const yellowRGBA = paletteRGBA(0x07);
  const redRGBA = paletteRGBA(0x02);
  const whiteRGBA = paletteRGBA(0x01);

  // Sprite at canvas X 108..131. Cols 9..12 (canvas X 104..135). All
  // chars are $00 (solid white). All overlap pixels are fg → white must
  // dominate (sp0 hidden + sp1 blocked by inheritance).
  let white = 0, red = 0, yellow = 0;
  for (let x = 108; x < 132; x++) {
    if (vic.fb32[ro + x] === whiteRGBA) white++;
    if (vic.fb32[ro + x] === redRGBA) red++;
    if (vic.fb32[ro + x] === yellowRGBA) yellow++;
  }
  expect(white === 24,
    `inheritance: 24 white at sp0+sp1 overlap with fg, got white=${white}`);
  expect(red === 0,
    `inheritance: sp1 (red) must NOT show through inherited sp0 priority, got ${red}`);
  expect(yellow === 0,
    `inheritance: sp0 (yellow) hidden by fg (MxDP=1), got ${yellow}`);
  ok('Bauer §3.8.2: inheritance — MxDP=1 sp0 hidden by fg blocks sp1 from showing through');
}

// ─── 12: Mode $70 — $D011=$70 with MCM=0 (ECM=1, BMM=1, MCM=0) all BLACK
//
// Bauer §3.7.3.7: "ECM=1, BMM=1, MCM=0" — invalid bitmap mode 1.
// Every output pixel is BLACK regardless of bitmap data.
//
// Setup: $D011=$70 (DEN=0 high bit set, ECM=1, BMM=1, MCM=0,
// YSCROLL=0). Wait — $70 = 0111_0000 in binary. Bit 4 (DEN) = 1, bit
// 5 (ECM) = 1, bit 6 (BMM) = 1, YSCROLL=0. So ECM=1 BMM=1 MCM=0
// (since $D016 bit 4 is MCM).
//
// Render a scanline; verify all canvas pixels in display zone are
// BLACK (palette index 0).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x70;         // mode 110 (invalid bitmap 1)
  vic.regs[0x16] = 0x08;         // CSEL=1, MCM=0
  vic.regs[0x21] = 0x06;         // bg = blue (must be ignored — all BLACK)
  vic.regs[0x20] = 0x0E;
  vic.displayEnabled = true;

  // Set up bitmap data with non-zero pattern to verify it doesn't
  // bleed through.
  for (let i = 0; i < 0x800; i++) vic.ram[0x2000 + i] = 0xAA;
  for (let c = 0; c < 40; c++) vic.ram[0x0400 + c] = 0xFF;

  driveTo(vic, 60, 1);
  for (let i = 0; i < 62; i++) vic.clock(1);

  const canvasY = 60 - 15;
  const ro = canvasY * CANVAS_W;
  const blackRGBA = paletteRGBA(0x00);

  // Display zone canvas X = 32..351. All pixels BLACK per Bauer §3.7.3.7.
  let nonBlack = 0;
  for (let x = 32; x < 352; x++) {
    if (vic.fb32[ro + x] !== blackRGBA) nonBlack++;
  }
  expect(nonBlack === 0,
    `Bauer §3.7.3.7: invalid mode $70 must render all BLACK, got ${nonBlack} non-black pixels`);
  ok('Bauer §3.7.3.7: $D011=$70 (invalid mode 110) — every display pixel BLACK');
}

// ─── 13: Mode $70 — sprites still visible (only graphics is BLACK) ───────
//
// Bauer §3.8.2 closing: "If you choose one of the invalid video modes
// only the sprites will be visible (fore- and background graphics will
// all become black)..." Verify sprite still paints over the BLACK
// invalid-mode background.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x70;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x40;
  vic.regs[0x01] = 51;
  const yellowRGBA = loadSp0AllOpaque(vic);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  vic.displayEnabled = true;

  driveTo(vic, 60, 1);
  for (let i = 0; i < 62; i++) vic.clock(1);

  const canvasY = 60 - 15;
  const yellowCount = countSpritePixelsOnRow(vic, canvasY, yellowRGBA);
  expect(yellowCount === 24,
    `Bauer §3.8.2: sprite visible over invalid-mode BLACK background, got ${yellowCount}`);
  ok('Bauer §3.8.2: invalid mode $70 — sprite visible over BLACK background');
}

console.log(`\n${testNo} sprite corner-case spec tests; ${failing} fail`);
if (failing) process.exit(1);
