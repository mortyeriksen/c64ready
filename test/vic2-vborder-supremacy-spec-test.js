// vBorder supremacy / vertical-border-rendering spec audit. 10 tests
// targeting the rule that when vBorder is closed (top/bottom border
// zones), the entire scanline must render as border color $D020 —
// no idle pattern, no text, no graphics.
//
// Per Bauer §3.9: the vertical border-FF gates the rendering. When set,
// the H-FF is also forced set (border supremacy). The renderer must
// produce ONLY border-color pixels, regardless of any g-data, ghost-
// byte, or sprite shifter content.
//
// In particular:
//   - Top border zone (L0..L_topCompare-1): vBorder=1
//   - Display zone (L_topCompare..L_bottomCompare-1): vBorder=0
//   - Bottom border zone (L_bottomCompare..L311): vBorder=1
//
// Sprites display in vertical border ONLY when the demo opens the
// border via the DEN-disable trick (DEN=0 BEFORE L48 latch); otherwise
// the closed border-FF blocks sprite paint at the pixel level.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;        // DEN=1, RSEL=1, YS=3
  vic.regs[0x16] = 0x08;        // CSEL=1
  vic.displayEnabled = true;
  return vic;
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

function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

// ── 1: Top vertical border zone has vBorder=1 throughout ───────────────
// Bauer §3.9: vBorder is set at frame initialization (carried from
// previous frame's bottom-compare). Top zone L0..L50 must have
// vBorder=1 for the entire span until top-compare at L51.
{
  const vic = makeVic();
  // Force start state: vBorder closed (as it would be at L0 of a normal frame).
  vic.vBorderActive = true;
  for (let line = 0; line < 51; line++) {
    driveTo(vic, line, 30);
    expect(vic.vBorderActive === true,
      `top zone L${line}.c30: vBorder must be CLOSED (=true), got ${vic.vBorderActive}`);
  }
  ok('Bauer §3.9: top vertical border zone (L0..L50) has vBorder=1 throughout');
}

// ── 2: Bottom vertical border zone has vBorder=1 throughout ────────────
// After bottom-compare at L251 (RSEL=1), vBorder must remain set for
// L251..L311.
{
  const vic = makeVic();
  // Run from L0 — go past L51 (vBorder clears) then past L251 (vBorder sets).
  driveTo(vic, 252);
  expect(vic.vBorderActive === true, `pre L252: vBorder set after L251 compare`);
  for (let line = 252; line < 312; line++) {
    driveTo(vic, line, 30);
    expect(vic.vBorderActive === true,
      `bottom zone L${line}.c30: vBorder must be CLOSED, got ${vic.vBorderActive}`);
  }
  ok('Bauer §3.9: bottom vertical border zone (L252..L311) has vBorder=1 throughout');
}

// ── 3: vBorder=closed → renderRasterLine paints border color only ──────
// When vBorder is closed for a scanline, the entire canvas row should
// render as $D020 (border color). The borderBuffer tracks this:
// borderBuffer[x] = 1 means "this pixel is border".
{
  const vic = makeVic();
  vic.vBorderActive = true;
  vic.regs[0x20] = 0x0E;        // border = light blue
  vic.displayActive = false;
  // Set BOTH "before" and "current" border flags so segment-split path
  // doesn't fall through into the open-border branch on the boundary
  // sub-segment.
  for (let cycle = 0; cycle <= 63; cycle++) {
    vic.lineCycleVBorderBefore[cycle] = 1;
    vic.lineCycleVBorder[cycle] = 1;
    vic.lineCycleHBorderBefore[cycle] = 1;
    vic.lineCycleHBorder[cycle] = 1;
    vic.lineCycleRegs[cycle].set(vic.regs);
  }
  vic._renderRasterLine(50);
  const cy = 50 - 15;
  const ro = cy * CANVAS_W;
  let bordered = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.borderBuffer[x] === 1) bordered++;
  }
  expect(bordered === CANVAS_W,
    `vBorder closed: entire row must be borderBuffer=1, got ${bordered}/${CANVAS_W}`);
  ok('Bauer §3.9: closed vBorder → entire scanline borderBuffer=1');
}

// ── 4: vBorder=closed prevents the open-border idle ribbon ─────────────
// The renderer's idle-ribbon path is gated by `!seg.vBorder && !seg.hBorder`.
// When vBorder is closed, ribbon must NOT render — the segment stays as
// the border-color fill from line 1781.
{
  const vic = makeVic();
  vic.vBorderActive = true;
  vic.regs[0x20] = 0x06;
  vic.regs[0x21] = 0x0E;        // bg color (would show if ribbon rendered)
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleVBorder[cycle] = 1;
    vic.lineCycleHBorder[cycle] = 1;
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleIdleByte[cycle] = 0xFF;       // would produce ribbon if rendered
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Sample some pixels in the inner X range — they should be border, not idle.
  for (const x of [40, 100, 200, 300]) {
    expect(vic.borderBuffer[x] === 1,
      `closed vBorder + idle byte $FF: pixel x=${x} must NOT render idle ribbon`);
  }
  ok('Bauer §3.9: closed vBorder blocks open-border idle ribbon rendering');
}

// ── 5: Bottom-compare at L251 sets vBorder regardless of DEN ───────────
// Bauer §3.9: bottom-compare ALWAYS sets vBorder. DEN only gates the
// TOP-compare reset. Verified earlier in border-edge-spec; reinforce.
{
  const vic = makeVic();
  vic.vBorderActive = false;
  driveTo(vic, 250);
  vic.write(0x11, 0x0B);          // DEN=0
  driveTo(vic, 252);
  expect(vic.vBorderActive === true,
    `bottom-compare at L251 with DEN=0: vBorder must still set`);
  ok('Bauer §3.9: bottom-compare sets vBorder regardless of DEN');
}

// ── 6: Frame-wrap preserves vBorder from previous frame ────────────────
// Bauer §3.9: vBorder is NOT reset at frame boundary. Whatever state
// the previous frame's L251 bottom-compare left it in carries over.
{
  const vic = makeVic();
  // Start frame, force vBorder closed (post-bottom-compare state).
  vic.vBorderActive = true;
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  // Now at L0 of next frame.
  expect(vic.vBorderActive === true,
    `frame wrap: vBorder must NOT auto-reset (carries over from prev frame)`);
  ok('Bauer §3.9: vBorder persists across frame wrap (no auto-reset)');
}

// ── 7: bottom-compare SET fires at cycle 63 of bottomCompare line ─────
// Bauer §3.9 rule 2: "When the Y coordinate reaches the bottom
// comparison value in cycle 63, the vertical border flip-flop is set."
// With RSEL=1, bottomCompare=251 — SET fires at cycle 63 of L251.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;     // RSEL=1, DEN=1, bottomCompare=251
  vic.regs[0x16] = 0x08;
  vic.vBorderActive = false;
  driveTo(vic, 248);
  expect(vic.vBorderActive === false, `L248 entry: no SET fire (bottomCompare=251 with RSEL=1)`);
  // Drive past L251 c63 (= L252 entry) to observe the latched SET.
  driveTo(vic, 252);
  expect(vic.vBorderActive === true,
    `after L251 c63: bottom-compare fires (RSEL=1 → bottomCompare=251)`);
  ok('Bauer §3.9 rule 2: bottom-compare SET fires at cycle 63 of bottomCompare line');
}

// ── 8: hBorder is FORCED closed when vBorder is closed ─────────────────
// Bauer §3.9: vertical-FF supremacy. When vertical-FF set, horizontal-
// FF is also forced set. Clearing the H-FF requires both vertical=0
// AND the left-H compare at the right cycle.
{
  const vic = makeVic();
  // Drive into top vertical border zone L20 (vBorder closed).
  vic.vBorderActive = true;
  driveTo(vic, 20, 30);
  expect(vic.vBorderActive === true, `pre L20.c30: vBorder closed`);
  expect(vic.hBorderActive === true,
    `vBorder closed at L20.c30: hBorder must also be closed`);
  ok('Bauer §3.9: vBorder closed forces hBorder closed (border supremacy)');
}

// ── 9: Sprite paints blocked when border-FF is closed ──────────────────
// Bauer §3.8 + §3.9: sprite render's pixel-level visibility depends on
// borderBuffer[pix] === 0. Closed border at a pixel blocks the sprite
// from painting there. The "sprites in vertical border" trick requires
// opening the border first (DEN-disable to prevent top-compare reset).
{
  const vic = makeVic();
  // Set up sprite at canvas Y=20 (top border zone) with borderBuffer
  // filled to 1 (closed) for the row.
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= 1;
    vic.lineCycleRegs[cycle][0] = 100;
    vic.lineCycleRegs[cycle][0x27] = 0x02;
    vic.lineCycleSpriteDisplayOn[cycle][0] = 1;
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = 0xFFFFFF;
  }
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteLineDataRow[0] = 0;
  const ro = 20 * CANVAS_W;
  vic.borderBuffer.fill(1, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  vic._renderSpriteLine(20, 20);
  let claimed = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.spriteOwnerBuffer[x] === 0) claimed++;
  expect(claimed === 0,
    `closed border-FF: sprite paint blocked, got ${claimed} pixels claimed`);
  ok('Bauer §3.8 + §3.9: closed border-FF blocks sprite pixel paint');
}

// ── 10: Top-border garbage is impossible if vBorder is correctly set ───
// Spec contract: any pixel in the top vertical border zone (raster <
// L_topCompare) must have borderBuffer=1, fb32 = $D020 (after the
// segment fill at line 1781). The user's snapshot shows borderBuffer=0
// in the inner X range of top-zone scanlines — that's a state-machine
// bug where vBorderActive was 0 when it should have been 1.
{
  const vic = makeVic();
  vic.vBorderActive = true;
  vic.regs[0x20] = 0x00;          // border = black
  for (let cycle = 0; cycle <= 63; cycle++) {
    vic.lineCycleVBorderBefore[cycle] = 1;
    vic.lineCycleVBorder[cycle] = 1;
    vic.lineCycleHBorderBefore[cycle] = 1;
    vic.lineCycleHBorder[cycle] = 1;
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleIdleByte[cycle] = 0xFF;       // worst-case ghost-byte
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  let nonBorder = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.borderBuffer[x] !== 1) nonBorder++;
  }
  expect(nonBorder === 0,
    `top-border zone with closed vBorder: ALL pixels must be border, got ${nonBorder} non-border`);
  ok('Bauer §3.9: top-border zone with vBorder=1 paints entirely border (no garbage possible)');
}

console.log(`\n${testNo} vBorder supremacy spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
