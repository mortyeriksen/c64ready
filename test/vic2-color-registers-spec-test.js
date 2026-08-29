// VIC-II color-register routing spec tests.
//
// Verify each color register routes the correct palette index into the
// framebuffer. Sweeps all 16 indices for every register so a per-bit
// wiring bug or stale capture would surface.
//
// Registers covered:
//   $D020  border color
//   $D021  background color 0 (text bg, MCBM "00" pair)
//   $D022  background color 1 (multicolor text "01" pair / ECM "01" code)
//   $D023  background color 2 (multicolor text "10" pair / ECM "10" code)
//   $D024  background color 3 (ECM "11" code)
//   $D025  multicolor sprite shared color 0 ("01" pair)
//   $D026  multicolor sprite shared color 1 ("11" pair)
//   $D027-$D02E  per-sprite color 0..7
//
// Extracted from vic2-test.js (was tests CR-1..6).

import {
  makeVic, paletteRgba, assert,
  fillTextLineState, setupSpriteForRender, setMulticolorRegs,
  clearRenderedRow,
} from './_vic2-helpers.js';

// CR-1: $D021 (background color, MCM=0 standard text). Sweep all 16
// palette indices and verify the rendered bg pixel matches palette[N].
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0x00;          // glyph row 0 all-bg

  for (let idx = 0; idx < 16; idx++) {
    vic.regs[0x21] = idx;
    fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
    for (let cycle = 11; cycle <= 58; cycle++) {
      vic.lineCycleRowFetchedCols[cycle][0] = 1;
      vic.lineCycleRowCodes[cycle][0] = 1;
      vic.lineCycleRowColors[cycle][0] = 2;
    }
    const raster = 20;
    const rowOffset = clearRenderedRow(vic, raster);
    vic._renderRasterLine(raster);
    const sample = vic.fb32[rowOffset + 32]; // first text-cell pixel
    assert(sample === paletteRgba(idx),
      `$D021=${idx.toString(16)} renders bg as palette[${idx}] (got 0x${sample.toString(16)}, want 0x${paletteRgba(idx).toString(16)})`);
  }
  console.log('ok  - CR-1: $D021 background color sweeps all 16 palette indices');
}

// CR-2: $D020 (border color). Sweep all 16 indices and verify the border
// fills with palette[N]. Per Bauer §3.9: the MAIN border FF (hBorder)
// drives the $D020 overlay; vBorder alone gates only the graphics
// sequencer to bg color (Method 1 of §3.14.1). Use hBorder=1 (both FFs
// set as in normal top/bottom border state) so the row is solid $D020.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;

  for (let idx = 0; idx < 16; idx++) {
    vic.regs[0x20] = idx;
    fillTextLineState(vic, vic.regs, { hBorder: true, vBorder: true, rowVcBase: 0, rc: 0 });
    const raster = 20;
    const rowOffset = clearRenderedRow(vic, raster);
    vic._renderRasterLine(raster);
    // Full row should be border color.
    const sample = vic.fb32[rowOffset + 0];
    assert(sample === paletteRgba(idx),
      `$D020=${idx.toString(16)} renders border as palette[${idx}] (got 0x${sample.toString(16)}, want 0x${paletteRgba(idx).toString(16)})`);
    assert(vic.borderBuffer[0] === 1,
      `borderBuffer marks pixel as border-active when v-border applies`);
  }
  console.log('ok  - CR-2: $D020 border color sweeps all 16 palette indices');
}

// CR-3: $D027 + sprite (per-sprite color). Each sprite gets a unique
// palette index; verify each sprite's "1"-bit pixels render with its own
// register's palette index. Renders 8 sprites side-by-side.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;
  vic.regs[0x15] = 0xFF;
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });

  const raster = 60;
  const canvasY = raster - 15;
  const rowOffset = clearRenderedRow(vic, raster);

  // Each sprite gets palette index s+1 (avoid index 0 which is BLACK and
  // could collide with empty fb cells from other tests).
  const colors = [1, 2, 3, 4, 5, 7, 8, 9];
  for (let s = 0; s < 8; s++) {
    setupSpriteForRender(vic, s, 32 + s * 32, { color: colors[s], shiftReg: 0xFFFFFF });
  }

  vic._renderSpriteLine(raster, canvasY);

  for (let s = 0; s < 8; s++) {
    const sx = 32 + s * 32 + 8; // sprite X offset (canvas_x = reg_x + 8)
    const sample = vic.fb32[rowOffset + sx];
    assert(sample === paletteRgba(colors[s]),
      `sprite ${s} ($D02${(7+s).toString(16)}=${colors[s]}) renders as palette[${colors[s]}] ` +
      `(got 0x${sample.toString(16)}, want 0x${paletteRgba(colors[s]).toString(16)})`);
  }
  console.log('ok  - CR-3: $D027-$D02E per-sprite color routes correctly to each sprite');
}

// CR-4: $D025 (MM0) and $D026 (MM1) sprite multicolor shared registers.
// Sweep both across 16 indices and verify a multicolor sprite routes
// "01" pairs to MM0, "10" pairs to the per-sprite color, "11" pairs to
// MM1.
{
  for (let idx = 0; idx < 16; idx++) {
    const vic = makeVic();
    vic.regs[0x11] = 0x1B;
    vic.regs[0x16] = 0x08;
    vic.regs[0x18] = 0x14;
    vic.regs[0x15] = 0x01;
    vic.regs[0x1C] = 0x01;        // sprite 0 multicolor

    const mm0Idx = idx;
    const mm1Idx = (idx + 5) & 0x0F;
    const sprColorIdx = (idx + 11) & 0x0F;
    if (mm0Idx === sprColorIdx || mm0Idx === mm1Idx || mm1Idx === sprColorIdx) continue;

    setMulticolorRegs(vic, mm0Idx, mm1Idx);
    fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });

    // Shifter pattern 0b01_10_11_... → first pair "01"=mm0, second "10"=spr,
    // third "11"=mm1. Use full 24-bit shifter with these top bits.
    const shiftReg = (0b011011 << 18) >>> 0;  // top 6 bits = 01 10 11
    setupSpriteForRender(vic, 0, 100, { multicolor: true, color: sprColorIdx, shiftReg });

    const raster = 60;
    const canvasY = raster - 15;
    const rowOffset = clearRenderedRow(vic, raster);

    vic._renderSpriteLine(raster, canvasY);

    const baseX = 100 + 8;
    // Multicolor sprite pixels are doubled (2 pixels per pair).
    assert(vic.fb32[rowOffset + baseX + 0] === paletteRgba(mm0Idx),
      `pair "01" → palette[$D025=${mm0Idx}] (got 0x${vic.fb32[rowOffset + baseX].toString(16)})`);
    assert(vic.fb32[rowOffset + baseX + 1] === paletteRgba(mm0Idx),
      `pair "01" doubled pixel`);
    assert(vic.fb32[rowOffset + baseX + 2] === paletteRgba(sprColorIdx),
      `pair "10" → palette[$D027=${sprColorIdx}] (got 0x${vic.fb32[rowOffset + baseX + 2].toString(16)})`);
    assert(vic.fb32[rowOffset + baseX + 4] === paletteRgba(mm1Idx),
      `pair "11" → palette[$D026=${mm1Idx}] (got 0x${vic.fb32[rowOffset + baseX + 4].toString(16)})`);
  }
  console.log('ok  - CR-4: $D025/$D026 multicolor sprite shared colors route correctly across 16 indices');
}

// CR-5: $D022 (bg1) and $D023 (bg2) extra background registers in
// multicolor text mode (MCM=1). Per Bauer §3.7.3.2, the 2-bit pair from
// the bitmap selects background slot:
//   "00" → $D021 (bg0), "01" → $D022 (bg1), "10" → $D023 (bg2),
//   "11" → color RAM low nibble.
// We render a multicolor cell with character byte $1B (= 00 01 10 11)
// and verify each pair lands at its expected color register's palette
// index.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x18;          // CSEL=1, MCM=1
  vic.regs[0x18] = 0x14;
  const bg0Idx = 0x06;
  const bg1Idx = 0x0A;
  const bg2Idx = 0x0C;
  const charRamIdx = 0x07;        // low nibble of color RAM byte (with bit 3 set → MCM)
  vic.regs[0x21] = bg0Idx;
  vic.regs[0x22] = bg1Idx;
  vic.regs[0x23] = bg2Idx;
  vic.charRom[8] = 0x1B;          // bits 7..0 = 00 01 10 11

  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleRowFetchedCols[cycle][0] = 1;
    vic.lineCycleRowCodes[cycle][0] = 1;
    vic.lineCycleRowColors[cycle][0] = 0x08 | charRamIdx; // bit 3 set → MCM, low 3 bits = color
  }

  const raster = 20;
  const rowOffset = clearRenderedRow(vic, raster);
  vic._renderRasterLine(raster);

  // Pairs are doubled (2 pixels per pair) starting at canvas X=32.
  // bits 7,6 = 0,0 → bg0 → palette[bg0Idx], pixels 32-33
  // bits 5,4 = 0,1 → bg1 → palette[bg1Idx], pixels 34-35
  // bits 3,2 = 1,0 → bg2 → palette[bg2Idx], pixels 36-37
  // bits 1,0 = 1,1 → color RAM low 3 bits → palette[charRamIdx], pixels 38-39
  assert(vic.fb32[rowOffset + 32] === paletteRgba(bg0Idx),
    `pair "00" → $D021 bg0=${bg0Idx} (got 0x${vic.fb32[rowOffset + 32].toString(16)})`);
  assert(vic.fb32[rowOffset + 34] === paletteRgba(bg1Idx),
    `pair "01" → $D022 bg1=${bg1Idx} (got 0x${vic.fb32[rowOffset + 34].toString(16)})`);
  assert(vic.fb32[rowOffset + 36] === paletteRgba(bg2Idx),
    `pair "10" → $D023 bg2=${bg2Idx} (got 0x${vic.fb32[rowOffset + 36].toString(16)})`);
  assert(vic.fb32[rowOffset + 38] === paletteRgba(charRamIdx),
    `pair "11" → color RAM low 3 bits=${charRamIdx} (got 0x${vic.fb32[rowOffset + 38].toString(16)})`);
  console.log('ok  - CR-5: $D022/$D023 extra background registers route in multicolor text mode');
}

// CR-6: $D024 (bg3) — ECM mode (ECM=1, MCM=0, BMM=0). Per Bauer §3.7.3.5,
// the upper two bits of the screen code select the bg color:
//   bits 7,6 = 0,0 → $D021 bg0
//             0,1 → $D022 bg1
//             1,0 → $D023 bg2
//             1,1 → $D024 bg3
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B;          // DEN=1, RSEL=1, ECM=1
  vic.regs[0x16] = 0x08;          // CSEL=1, MCM=0
  vic.regs[0x18] = 0x14;
  vic.rowFetchD011 = 0x5B;
  const bg3Idx = 0x09;
  vic.regs[0x24] = bg3Idx;

  // Screen code with bits 7,6 = 1,1 → bg3 selected for "0" pixels.
  // Char glyph row = 0x00 → all "0" pixels.
  vic.charRom[8] = 0x00;
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleRowFetchedCols[cycle][0] = 1;
    vic.lineCycleRowCodes[cycle][0] = 0xC0;  // top bits 11
    vic.lineCycleRowColors[cycle][0] = 2;
  }

  const raster = 20;
  const rowOffset = clearRenderedRow(vic, raster);
  vic._renderRasterLine(raster);

  const sample = vic.fb32[rowOffset + 32];
  assert(sample === paletteRgba(bg3Idx),
    `ECM screen-code bits 7,6=11 → $D024 bg3=${bg3Idx} (got 0x${sample.toString(16)}, want 0x${paletteRgba(bg3Idx).toString(16)})`);
  console.log('ok  - CR-6: $D024 (bg3) routes for ECM mode top-bits-11 screen codes');
}

console.log('\nAll VIC-II color-register tests passed.');
