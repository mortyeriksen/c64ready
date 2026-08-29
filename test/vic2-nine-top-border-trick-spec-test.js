// nine.prg top-border trick — spec-primitive test.
//
// SCOPE / HONESTY: this is a SYNTHETIC test of the spec PRIMITIVES the trick is
// built from — NOT a faithful replay of VICE's full state in the scene, and NOT
// a pixel-equality check against VICE. The per-cycle mode-flip boundaries
// (cy15-23 / cy24-42) and the idle bytes here are hand-built to *resemble* the
// demo (taken partly from our own trace), so passing this does NOT prove our
// rendering matches VICE, nor that the still-open blocky-digit drift is fixed.
// It locks the individual primitives (each spec-grounded below), which already
// work. A faithful test would capture VICE's complete per-raster sprite state
// (positions, fetched pointers, 24 data bytes/sprite, $D018 sequence, ghost
// bytes) at the all-sprites-in-top-border pose, replay it, and compare to a
// VICE screenshot — that does not exist yet.
//
// Grounded in (a) Linus Åkesson's write-up
// (https://www.linusakesson.net/scene/nine/explanation.php) and (b) a FEW VIC
// registers measured from VICE in isolation (x64sc -VICIImodel 0) at the
// "numbers in the top border" phase — see "Measured VICE register state" below.
//
// The trick, as the demo builds it on every top-border raster:
//   * The top vertical border is opened (vBorder=0) with the side borders kept
//     CLOSED, so the inner zone (canvas X 32..351) shows graphics + sprites
//     while X 0..31 / 352..383 stay border colour.
//   * The line runs in INVALID mode $70 (ECM=1, BMM=1, MCM=0) for the left part
//     (covering the pre-ghostbyte gap) and flips to TEXT mode for the digit
//     band, then back. Linus: "$70 behaves like ECM as far as the ghost byte is
//     concerned." So the idle g-access reads $39FF while ECM=1, $3FFF while
//     ECM=0 (Bauer §3.7.3 / DEMO-NINE §7).
//   * Mode $70 outputs BLACK pixels (Bauer §3.7.3.7) but still clocks the real
//     ghost byte, so its foreground bits feed the sprite-vs-background
//     collision the demo samples at $99A0/$99A8 (DEMO-NINE §8).
//   * The digits are hardware sprites, ALWAYS in front (the demo keeps
//     $D01B=0); the ghost byte is the backdrop that shows between the digit
//     sprites. sp6/sp7 are multicolor + X-expanded ($D01C=$D01D=$C0).
//
// Measured VICE register state in this phase (for grounding):
//   $D015=$FF  $D01B=$00  $D01C=$C0  $D01D=$C0  $D017=$00
//   $D018 flips mid-frame ($40 -> $50 ...) = sprite-pointer banking (§3)
//   $39FF (ECM idle) = $FF
//
// Pure synthetic — no nine.prg load. Renders through the real caller path
// (_renderCycleSegmentGraphics) so the BMM-idle clobber gate is exercised.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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
const PAL_RGBA = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const c = C64_PALETTE[i];
    out[i] = (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
  }
  return out;
})();
const BLACK = 0xFF000000;

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

const cyX = (c) => (c - 12) * 8 + 8;   // cycle -> first canvas X of that cycle

// Clock a bare VIC to an exact (raster, cycle) — for the real-flow crunch path.
function driveTo(vic, raster, cycle) {
  let safety = 200000;
  while (--safety) { if (vic.raster === raster && vic.cycleInLine === cycle) return; vic.clock(1); }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
}

// Render one nine-style top-border line: open vBorder, sides closed, invalid
// $70 in c15..23 and c43..54, TEXT mode in c24..42. ghost70/ghostTxt are the
// idle bytes the demo would have fed via $39FF / $3FFF.
function renderNineTopLine({ ghost70 = 0xFF, ghostTxt = 0x81 } = {}) {
  const vic = makeVic();
  const D011_70 = 0x7B;   // ECM=1, BMM=1, DEN=1, RSEL=1, YS=3
  const D011_TX = 0x1B;   // text (ECM=0, BMM=0)
  vic.regs[0x16] = 0x08;  // CSEL=1, MCM=0, XSCROLL=0
  vic.regs[0x20] = 0x0E;  // border light blue
  vic.regs[0x21] = 0x06;  // bg0 blue
  vic._lineStartD011 = D011_70;
  vic._lineStartD021 = vic.regs[0x21];
  vic._prevLineStartD011 = D011_70;
  const isText = (c) => (c >= 24 && c <= 42);
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.regs[0x11] = isText(c) ? D011_TX : D011_70;
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 55) ? 1 : 0;   // sides CLOSED
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleDisplayActive[c] = 0;       // open-border idle
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleBanks[c] = 0x0000;
    vic.lineCycleVc[c] = 0; vic.lineCycleRc[c] = 0; vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = isText(c) ? ghostTxt : ghost70;
  }
  vic.regs[0x11] = D011_70;
  vic.displayActive = false; vic.lineDisplayActive = false;
  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }
  return { vic, ro: canvasY * CANVAS_W };
}

// ── 1: opened top border — sides = border colour, inner zone = graphics ──
{
  const { vic, ro } = renderNineTopLine({ ghost70: 0xFF, ghostTxt: 0x81 });
  const borderRGBA = PAL_RGBA[0x0E];
  let sideBorder = 0;
  for (let x = 0; x < 32; x++) if (vic.fb32[ro + x] === borderRGBA) sideBorder++;
  for (let x = 352; x < 384; x++) if (vic.fb32[ro + x] === borderRGBA) sideBorder++;
  expect(sideBorder === 64, `closed side zones (X 0..31, 352..383) = border colour (got ${sideBorder}/64)`);
  // inner zone is NOT border colour everywhere (it shows graphics: black/bg)
  let innerBorder = 0;
  for (let x = 32; x < 352; x++) if (vic.fb32[ro + x] === borderRGBA) innerBorder++;
  expect(innerBorder === 0, `opened inner zone shows graphics, not border (got ${innerBorder} border px)`);
  ok('opened top border: sides closed (border), inner zone open (graphics)');
}

// ── 2: invalid-$70 left-edge span covers the pre-ghostbyte gap with BLACK ─
{
  const { vic, ro } = renderNineTopLine({ ghost70: 0xFF, ghostTxt: 0x81 });
  let blk = 0; for (let x = cyX(15); x < cyX(24); x++) if (vic.fb32[ro + x] === BLACK) blk++;
  expect(blk === cyX(24) - cyX(15), `$70 left span (X ${cyX(15)}..${cyX(24)-1}) all BLACK (got ${blk})`);
  ok('invalid $70 left-edge span renders BLACK (covers the pre-ghostbyte gap)');
}

// ── 3: ECM-aware ghost-byte source — $39FF when ECM=1, $3FFF when ECM=0 ──
//
// DEMO-NINE §7 / Bauer §3.7.3: ECM holds address lines 9,10 low so the idle
// g-access reads $39FF instead of $3FFF.
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x5A;
  vic.ram[0x39FF] = 0xC3;
  const ecmRegs = new Uint8Array(0x40); ecmRegs[0x11] = 0x7B;   // ECM=1
  const txtRegs = new Uint8Array(0x40); txtRegs[0x11] = 0x1B;   // ECM=0
  expect(vic._readIdleGByte(ecmRegs, 0x0000) === 0xC3, `ECM=1 idle reads $39FF (got $${vic._readIdleGByte(ecmRegs,0).toString(16)})`);
  expect(vic._readIdleGByte(txtRegs, 0x0000) === 0x5A, `ECM=0 idle reads $3FFF (got $${vic._readIdleGByte(txtRegs,0).toString(16)})`);
  ok('ghost-byte idle source honours ECM ($39FF vs $3FFF) — DEMO-NINE §7');
}

// ── 4: invalid-$70 ghost byte feeds the sprite-vs-bg collision map ───────
//
// $70 = BLACK pixels, but the ghost byte still drives the foreground map, so a
// sprite over it latches $D01F. (This is what the demo reads at $99A0/$99A8.)
{
  const { vic, ro } = renderNineTopLine({ ghost70: 0xFF, ghostTxt: 0x00 });
  expect(vic.graphicsCollisionBuffer[cyX(18)] === 1,
    'precondition: $70 ghost byte $FF set the collision map (clobber would zero it)');
  for (let x = cyX(16); x < cyX(23); x++) vic._processSpritePixelCollision(x, 20, 4);
  expect((vic.regs[0x1F] & (1 << 4)) === (1 << 4),
    `sprite over $70 ghost byte latches $D01F bit 4 (got $${vic.regs[0x1F].toString(16)})`);
  ok('invalid $70 ghost byte feeds sprite-bg collision ($D01F) — DEMO-NINE §8');
}

// ── 5: TEXT-mode ghost byte (no mode-flip) renders its bit pattern ───────
//
// In a steady text-mode open border (the §3.7.5 bottom-scroll case), the idle
// byte's "0" bits show bg0 and "1" bits show black — the visible ghost-byte
// pattern. (Constant mode here so it is independent of the mid-line $D021
// latch the flipping top-border path applies.)
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; vic.regs[0x16] = 0x08; vic.regs[0x20] = 0x0E; vic.regs[0x21] = 0x06;
  vic._lineStartD011 = 0x1B; vic._lineStartD021 = 0x06; vic._prevLineStartD011 = 0x1B;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0; vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 55) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0; vic.lineCycleDisplayActive[c] = 0;
    vic.lineCycleDisplayEnabled[c] = 1; vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0; vic.lineCycleRc[c] = 0; vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x81;   // 1000_0001 -> 2 fg (black) + 6 bg
  }
  vic.displayActive = false; vic.lineDisplayActive = false;
  const canvasY = 20, ro = canvasY * CANVAS_W;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++)
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(cycle), canvasY);
  let bg = 0, fgBlack = 0;
  for (let x = 32; x < 344; x++) {
    if (vic.fb32[ro + x] === PAL_RGBA[0x06]) bg++;
    else if (vic.fb32[ro + x] === BLACK) fgBlack++;
  }
  expect(bg > 0 && fgBlack > 0, `text-mode ghost byte $81 shows pattern (bg=${bg}, fg-black=${fgBlack})`);
  // $81 has 6 zero bits / 8 -> bg should dominate the inner zone
  expect(bg > fgBlack, `text-mode $81 ghost byte: bg ($06) dominates fg (bg=${bg} > black=${fgBlack})`);
  ok('text-mode open-border ghost byte renders its bit pattern (DEMO-NINE §8 / §3.7.5)');
}

// ── 6: anchor sprite crunch keeps the timing sprites "constantly on" ─────
//
// DEMO-NINE §1/§2: the anchor sprites are kept on EVERY line (constant CPU
// cycle budget) by crunching them once at the top. Measured in the trace at
// the digit scene: $D017=$35 (Y-expand sp0,2,4,5) then cleared to $00 at
// cycle 15; sprite 0 had MCBASE=6, MC=9, so rule 7a's bit-interleave gives
// MCBASE = (101010 & (6&9)) | (010101 & (6|9)) = 0 | 5 = 5. Because the
// corrupted MCBASE never reaches 63, the sprite's DMA does NOT turn off — it
// stays displaying, which is the whole point of the anchor.
{
  const vic = makeVic();
  driveTo(vic, 0x40, 14);
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 0;
  vic.spriteMC[0] = 9;
  vic.spriteMCBase[0] = 6;
  vic.regs[0x17] = 0x01;            // MxYE bit 0 set
  driveTo(vic, 0x40, 15);
  vic.write(0x17, 0x00);            // clear MxYE at cycle 15 → rule 7a trigger
  driveTo(vic, 0x40, 17);
  expect(vic.spriteMCBase[0] === 5,
    `nine anchor crunch: MCBASE 6&9 → 5 via rule-7a interleave (got ${vic.spriteMCBase[0]})`);
  expect(vic.spriteMCBase[0] !== 63 && vic.spriteDmaOn[0] === 1,
    `crunched MCBASE (${vic.spriteMCBase[0]}) ≠ 63 → anchor DMA stays on (constantly-on timing sprite)`);
  ok('anchor crunch (MxYE-clear@cy15 → rule-7a) keeps the timing sprite constantly on (§1/§2)');
}

console.log(`\n${testNo} nine top-border trick spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
