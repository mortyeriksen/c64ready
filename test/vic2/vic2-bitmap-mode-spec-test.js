// VIC-II bitmap-mode rendering spec tests.
//
// Bauer §3.7.3.3 — Standard Bitmap Mode  (BMM=1, MCM=0, ECM=0)
// Bauer §3.7.3.4 — Multicolor Bitmap Mode (BMM=1, MCM=1, ECM=0)
//
// In standard BMM the screen-RAM byte for an 8×8 cell holds two 4-bit
// color nibbles instead of a character code (upper = fg, lower = bg).
// The bitmap byte is read from `bitmapBase + vc*8 + rc`, with bitmapBase
// = $D018 bit 3 scaled to $2000 within the current VIC bank. Pixel
// layout is 8 monochrome bits per byte, MSB-first across the cell.
//
// Multicolor BMM keeps the same source byte but groups pixels into
// 2-bit pairs, picking from $D021 / screen-upper / screen-lower /
// color-RAM (160-px doubled to 320). Only pairs 10 and 11 count as
// foreground for sprite priority / collision.
//
// Extracted from vic2-test.js (was tests BMP-1..6).

import { makeVic, paletteRgba, assert } from './_vic2-helpers.js';

// Stage a single source column for the renderer.
function makeBitmapSeg(vic, { rawCode, colorNib, vc = 0, rc = 0, d011, d016, d018 }) {
  const seg = {
    regs: vic.regs,
    bank: 0x0000,
    rowVcBase: vc,
    liveVcBase: vc,   // bitmap g-access uses the live VC base (= rowVcBase here)
    rowFetchedCols: new Uint8Array(40),
    rowCodes: new Uint8Array(40),
    rowColors: new Uint8Array(40),
    rowFetchD011: d011,
    rowFetchD016: d016,
    rowFetchD018: d018,
    displayColumnActive: true,
    rc,
  };
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = rawCode;
  seg.rowColors[0] = colorNib;
  return seg;
}

// Test BMP-1: standard bitmap pixels follow the bitmap byte's MSB-first
// bit pattern, picking foreground from screen-byte upper nibble and
// background from lower nibble.
{
  const vic = makeVic();
  const d011 = 0x20;          // BMM=1, ECM=0, MCM=0
  const d016 = 0x08;          // CSEL=1, MCM=0
  const d018 = 0x08;          // bitmapBase = $2000 (bit 3 set)
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;

  // Bitmap byte at $2000 + vc(0)*8 + rc(0) = $2000.
  // Pattern $5A = 0101 1010 → pixels: bg fg bg fg fg bg fg bg
  vic.ram[0x2000] = 0x5A;

  // Screen byte: fg=color 7 (yellow), bg=color 6 (blue) → rawCode=$76.
  const seg = makeBitmapSeg(vic, { rawCode: 0x76, colorNib: 0, d011, d016, d018 });
  const out = new Uint32Array(8);
  const fg = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fg);

  const yellow = paletteRgba(7), blue = paletteRgba(6);
  const expectedColors = [blue, yellow, blue, yellow, yellow, blue, yellow, blue];
  const expectedFg     = [0,    1,      0,    1,      1,      0,    1,      0];
  for (let i = 0; i < 8; i++) {
    assert(out[i] === expectedColors[i],
      `Bauer §3.7.3.3: bitmap bit ${i} of $5A → ${expectedFg[i] ? 'fg' : 'bg'} color`);
    assert(fg[i] === expectedFg[i],
      `Bauer §3.7.3.3: foreground map[${i}] tracks bitmap bit (=${expectedFg[i]})`);
  }
  console.log('ok  - standard bitmap mode: MSB-first bits select fg/bg per screen-byte nibbles');
}

// Test BMP-2: $D018 bit 3 selects the bitmap base ($0000 vs $2000)
// within the current VIC bank. Verify reading from $0000 when bit 3
// is clear.
{
  const vic = makeVic();
  const d011 = 0x20;
  const d016 = 0x08;
  const d018 = 0x00;          // bit 3 clear → bitmapBase = $0000
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;

  vic.ram[0x0000] = 0xFF;     // all foreground
  vic.ram[0x2000] = 0x00;     // would-be alternate base — must be ignored

  const seg = makeBitmapSeg(vic, { rawCode: 0x10, colorNib: 0, d011, d016, d018 });
  const out = new Uint32Array(8);
  const fg = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fg);

  const fgColor = paletteRgba(1);   // upper nibble of $10 = color 1 (white)
  for (let i = 0; i < 8; i++) {
    assert(out[i] === fgColor,
      `bitmap base $0000 (D018 bit 3=0): all pixels are foreground color (i=${i})`);
  }
  console.log('ok  - standard bitmap mode: $D018 bit 3 selects bitmap base $0000 vs $2000');
}

// Test BMP-3: bitmap byte address is `bitmapBase + vc*8 + rc` — `rc`
// (0..7) selects the row within the 8-pixel cell, and `vc` strides
// through 8-byte cells horizontally. Validate by reading row 3 of cell 5.
{
  const vic = makeVic();
  const d011 = 0x20, d016 = 0x08, d018 = 0x08;       // bitmapBase = $2000
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;

  // Cell 5, row 3 → $2000 + 5*8 + 3 = $2000 + 0x2B = $202B.
  vic.ram[0x202B] = 0x80;     // only bit 7 set → first pixel only
  vic.ram[0x2028] = 0xFF;     // row 0 of cell 5 — must NOT be read for rc=3

  const seg = makeBitmapSeg(vic, { rawCode: 0x21, colorNib: 0, vc: 5, rc: 3, d011, d016, d018 });
  const out = new Uint32Array(8);
  const fg = new Uint8Array(8);
  // _renderSourceColumn(col, line, seg, ...) — `line` is the row within
  // the 8-pixel cell. Pass rc=3 here to fetch the row-3 bitmap byte at
  // $202B.
  vic._renderSourceColumn(0, 3, seg, out, fg);

  const fgColor = paletteRgba(2);   // (0x21 >> 4) = 2
  const bgColor = paletteRgba(1);   // 0x21 & 0x0F = 1
  assert(out[0] === fgColor, 'cell 5 row 3 byte $80: bit 7 → foreground');
  assert(fg[0] === 1, 'foreground map[0] = 1 for set bit');
  for (let i = 1; i < 8; i++) {
    assert(out[i] === bgColor, `cell 5 row 3 byte $80: bit ${i} clear → background`);
    assert(fg[i] === 0, `foreground map[${i}] = 0 for cleared bit`);
  }
  console.log('ok  - standard bitmap mode: address = bitmapBase + vc*8 + rc');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bauer §3.7.3.4 — Multicolor Bitmap Mode (BMM=1, MCM=1, ECM=0)
// ─────────────────────────────────────────────────────────────────────────────
// Bitmap byte sourced exactly as in §3.7.3.3, but each pair of bits
// selects one of four colors and produces TWO pixels of that color
// (160-pixel horizontal resolution, doubled):
//   00 → $D021 (background color 0)
//   01 → screen-byte upper nibble (foreground 1)
//   10 → screen-byte lower nibble (foreground 2)
//   11 → color RAM low nibble       (foreground 3)
// The foreground map is set ONLY for pairs 10 and 11 — pair 01 reads
// from the screen byte's upper nibble but counts as background for
// sprite-priority / collision.

// Test BMP-4: each pixel pair (00/01/10/11) selects the right palette
// slot and emits 2 pixels of that color.
{
  const vic = makeVic();
  const d011 = 0x20;          // BMM=1
  const d016 = 0x18;          // MCM=1, CSEL=1
  const d018 = 0x08;
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;
  vic.regs[0x21] = 0x00;      // BG = black

  // Bitmap byte $1B = 00 01 10 11 → pairs left-to-right:
  //   00 (bg=$D021), 01 (screen upper), 10 (screen lower), 11 (color RAM)
  vic.ram[0x2000] = 0x1B;

  // Screen byte: upper nibble = color 7, lower = color 6. Color RAM = 5.
  const seg = makeBitmapSeg(vic, { rawCode: 0x76, colorNib: 0x05, d011, d016, d018 });
  const out = new Uint32Array(8);
  const fg = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fg);

  const expected = [
    paletteRgba(0), paletteRgba(0),   // 00 → BG
    paletteRgba(7), paletteRgba(7),   // 01 → upper nibble
    paletteRgba(6), paletteRgba(6),   // 10 → lower nibble
    paletteRgba(5), paletteRgba(5),   // 11 → color RAM
  ];
  // Bauer §3.7.3.4 + §3.11.2: in MCM bitmap, pairs 00 AND 01 are
  // BACKGROUND for sprite priority + collision. Only pairs 10 and 11
  // are foreground. A previous impl bug treated pair 01 as fg — caught
  // when expectedFg was corrected to match spec (2026-05-02), exposing
  // a real sprite-bg collision bug affecting Commando and similar games.
  const expectedFg = [0, 0, 0, 0, 1, 1, 1, 1];
  for (let i = 0; i < 8; i++) {
    assert(out[i] === expected[i],
      `Bauer §3.7.3.4: pair ${(i / 2) | 0} pixel ${i % 2} → expected color slot`);
    assert(fg[i] === expectedFg[i],
      `Bauer §3.7.3.4: foreground map[${i}] = ${expectedFg[i]} (pairs 00,01 background; 10,11 foreground)`);
  }
  console.log('ok  - multicolor bitmap mode: 2-bit pairs → BG/screen-upper/screen-lower/colorRAM');
}

// Test BMP-5: in multicolor bitmap mode, pixels come in pairs — both
// pixels of a pair must be identical and both rendered, never split.
{
  const vic = makeVic();
  const d011 = 0x20, d016 = 0x18, d018 = 0x08;
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;
  vic.regs[0x21] = 0x00;

  vic.ram[0x2000] = 0xE4;     // 11 10 01 00 — all four codes, distinct order

  const seg = makeBitmapSeg(vic, { rawCode: 0x32, colorNib: 0x09, d011, d016, d018 });
  const out = new Uint32Array(8);
  const fg = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, out, fg);

  for (let pair = 0; pair < 4; pair++) {
    const a = pair * 2, b = pair * 2 + 1;
    assert(out[a] === out[b],
      `Bauer §3.7.3.4: pair ${pair} pixels are identical (${out[a].toString(16)} === ${out[b].toString(16)})`);
    assert(fg[a] === fg[b],
      `Bauer §3.7.3.4: pair ${pair} foreground bits match`);
  }
  console.log('ok  - multicolor bitmap mode: pixels render in identical pairs (160-px doubled to 320)');
}

// Test BMP-6: $D021 (BG color 0) drives the "00" pair in MCBM. Changing
// $D021 mid-rendering must change which color the 00 pair displays.
{
  const vic = makeVic();
  const d011 = 0x20, d016 = 0x18, d018 = 0x08;
  vic.regs[0x11] = d011;
  vic.regs[0x16] = d016;
  vic.regs[0x18] = d018;

  vic.ram[0x2000] = 0x00;     // all 4 pairs = 00 → all from $D021

  for (const bgIdx of [0x00, 0x06, 0x0B]) {
    vic.regs[0x21] = bgIdx;
    const seg = makeBitmapSeg(vic, { rawCode: 0xFF, colorNib: 0x0F, d011, d016, d018 });
    const out = new Uint32Array(8);
    const fg = new Uint8Array(8);
    vic._renderSourceColumn(0, 0, seg, out, fg);

    const want = paletteRgba(bgIdx);
    for (let i = 0; i < 8; i++) {
      assert(out[i] === want,
        `MCBM 00-pair pulls live $D021 = $${bgIdx.toString(16)} (pixel ${i})`);
      assert(fg[i] === 0,
        `MCBM 00-pair never sets foreground map (pixel ${i})`);
    }
  }
  console.log('ok  - multicolor bitmap mode: 00 pair tracks live $D021 background color');
}

console.log('\nAll VIC-II bitmap-mode tests passed.');
