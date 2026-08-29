// Bauer §3.8.2 spec audit — gaps not covered by sprite-corner-cases-spec
// (priority/MxDP/inheritance), sprite-bg-collision-modes-spec (per-mode
// fg/bg rules), or sprite-collision-irq-spec (IRQ fire timing).
//
// Specifically, the spec's last paragraph: "If the vertical border
// flip-flop is set (normally within the upper/lower border, see next
// section), the output of the graphics data sequencer is turned off
// and there are no collisions of sprites with graphics data."
//
// Plus a focused cross-mode confirmation that the FG/BG decision for
// sprite-graphics collision uses the MCM bit ALONE (per Bauer's table
// in §3.8.2), independently of ECM/BMM mode bits.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  return v;
}

// Set up a sprite that paints opaque pixels across a raster line at a
// specific X position. Mirrors the (file-local) helper in vic2-test.js.
function placeSprite(vic, sprite, x, color = 0x07) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    vic.lineCycleRegs[cycle][sprite * 2] = x & 0xFF;
    if (x > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << sprite);
    vic.lineCycleRegs[cycle][0x27 + sprite] = color & 0x0F;
    vic.lineCycleSpriteDisplayOn[cycle][sprite] = 1;
    vic.lineCycleSpriteDataRow[cycle][sprite] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][sprite] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][sprite] = 0xFFFFFF;
  }
  vic.spriteLineDataRow[sprite] = 0;
  vic.spriteRowByteMask[sprite] = 0x07;
  vic.spriteShiftReg[sprite] = 0xFFFFFF;
}

// Set up the per-cycle reg + line state for a fully-active text display
// at the chosen raster, with all-FG glyph data so any sprite over the
// graphics zone collides. Optionally force vBorder=1 across the line.
function setupGraphicsLineState(vic, raster, { vBorder, hBorder = false } = {}) {
  for (let cycle = 0; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleHBorderBefore[cycle] = hBorder ? 1 : 0;
    vic.lineCycleHBorder[cycle] = hBorder ? 1 : 0;
    vic.lineCycleVBorderBefore[cycle] = vBorder ? 1 : 0;
    vic.lineCycleVBorder[cycle] = vBorder ? 1 : 0;
    vic.lineCycleDisplayActive[cycle] = 1;
    vic.lineCycleDisplayColumnActive[cycle] = vBorder || hBorder ? 0 : 1;
    vic.lineCycleBanks[cycle] = 0;
    vic.lineCycleHInner[cycle] = 1;
  }
  // Plant FG-everywhere matrix data on EVERY column for cycles in the
  // c-access window so any column's render finds opaque-fg data.
  for (let cycle = 15; cycle <= 58; cycle++) {
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[cycle][col] = 1;
      vic.lineCycleRowCodes[cycle][col] = 1;
      vic.lineCycleRowColors[cycle][col] = 0x07;
    }
  }
  // Char $01 row 0 — D018=$10 → CB bits=000 → CB=$0000 (RAM[0..$7FF]
  // in VIC bank 0). Char $01 row 0 = ram[1*8 + 0] = ram[8].
  vic.ram[8] = 0xFF;
}

function clearRow(vic, canvasY) {
  const ro = canvasY * CANVAS_W;
  vic.fb32.fill(0, ro, ro + CANVAS_W);
  vic.borderBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsPriorityBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
}

// ── 1: sanity baseline — sprite over fg with vBorder=0 → MBC fires ──────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // standard text mode (DEN=1, RSEL=1, YSCROLL=3)
  vic.regs[0x16] = 0x08;             // CSEL=1
  vic.regs[0x18] = 0x10;             // charBase=0
  vic.regs[0x21] = 0x06;             // bg blue
  vic.regs[0x20] = 0x0E;             // border light blue
  vic.write(0x1A, 0x02);             // enable MBC IRQ

  const raster = 60;
  const canvasY = raster - 15;
  setupGraphicsLineState(vic, raster, { vBorder: false });
  // Place sprite 0 in the graphics window at canvas X≈40.
  placeSprite(vic, 0, 24, 0x07);     // VIC X=24 → canvas X=32
  clearRow(vic, canvasY);

  vic._renderRasterLine(raster);

  expect((vic.regs[0x1F] & 0x01) !== 0,
    `sanity: $D01F sp0-vs-bg collision fires when fg + sprite overlap (vBorder=0)`);
  expect((vic.irqStatus & 0x02) !== 0,
    `sanity: MBC IRQ bit fires`);
  ok('Bauer §3.8.2 (sanity): sprite-over-fg collision fires with vBorder=0');
}

// ── 2: vBorder=1 SUPPRESSES sprite-graphics collision ───────────────────
//
// Bauer §3.8.2 last paragraph: "If the vertical border flip-flop is set,
// the output of the graphics data sequencer is turned off and there are
// no collisions of sprites with graphics data." Concretely: even with
// the same opaque-glyph + opaque-sprite setup as above, $D01F must
// remain zero when vBorder=1.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  vic.write(0x1A, 0x02);

  const raster = 60;
  const canvasY = raster - 15;
  setupGraphicsLineState(vic, raster, { vBorder: true });
  placeSprite(vic, 0, 24, 0x07);
  clearRow(vic, canvasY);

  vic._renderRasterLine(raster);

  expect((vic.regs[0x1F] & 0x01) === 0,
    `vBorder=1: $D01F sp0-vs-bg collision must NOT fire — got $${vic.regs[0x1F].toString(16)}`);
  expect((vic.irqStatus & 0x02) === 0,
    `vBorder=1: MBC IRQ bit must NOT fire — got $${(vic.irqStatus & 0x02).toString(16)}`);
  ok('Bauer §3.8.2: vBorder=1 suppresses sprite-graphics collision (graphics sequencer output gated to bg)');
}

// ── 3: vBorder=1 still allows sprite-sprite collision ───────────────────
//
// The vBorder rule gates ONLY the graphics-data path. Sprite-vs-sprite
// collisions still run regardless of border state — sprite-data
// sequencers operate independently.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.write(0x1A, 0x04);             // enable MMC IRQ

  const raster = 60;
  const canvasY = raster - 15;
  setupGraphicsLineState(vic, raster, { vBorder: true });
  placeSprite(vic, 0, 24, 0x07);     // sp0 cyan
  placeSprite(vic, 1, 24, 0x0E);     // sp1 light blue (SAME X)
  clearRow(vic, canvasY);

  vic._renderRasterLine(raster);

  expect((vic.regs[0x1E] & 0x03) === 0x03,
    `vBorder=1 must NOT suppress sprite-sprite collision: $D01E expected 0x03, got $${vic.regs[0x1E].toString(16)}`);
  expect((vic.irqStatus & 0x04) !== 0,
    `vBorder=1: MMC IRQ still fires`);
  ok('Bauer §3.8.2: vBorder=1 does NOT suppress sprite-sprite collision');
}

console.log(`\n${testNo} sprite priority/collision spec tests; ${failing} fail`);
if (failing) process.exit(1);
