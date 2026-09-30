// VIC-II: ECM g-access address masking (Bauer §3.7.3 intro + §3.7.3.5)
//
// §3.7.3 (intro): "If the ECM bit is set, the address lines 9 and 10 of the
// g-access are pulled low independently of the selected mode." For text
// modes this reduces the character generator to the first 64 glyphs, so a
// character code with bit 6 and/or bit 7 set fetches the glyph of the code
// masked to its low 6 bits.
//
// §3.7.3.5 (ECM text mode): the foreground colour comes from the lower 4
// bits of the c-data (colour RAM), while bits 6 and 7 of the c-data (the
// FULL, unmasked screen code) select one of the four background colours
// $D021 (BG0) .. $D024 (BG3). So bits 6/7 still matter for the colour even
// though they are masked OUT of the charset address.
//
// The existing test 5j (vic2-text-mode-rendering) uses a small code ($81)
// whose low 6 bits already equal a low char index, so it cannot DISTINGUISH
// "bits 9/10 forced low" from "the code happened to be small". This test
// uses codes with bits 6/7 set ($C1, $FF) and places a DECOY glyph at the
// unmasked address, so only an implementation that actually masks the
// g-access address passes.

import {
  assert,
  makeVic, makeRenderSeg,
  paletteRgba,
} from './_vic2-helpers.js';

// Common register setup for ECM text mode.
//   $D011 = $40  -> ECM=1, BMM=0, (DEN/RSEL/YSCROLL irrelevant to the renderer)
//   $D016 = $00  -> MCM=0
//   $D018 = $14  -> CB=2 => charBase = ((0x14>>1)&7)*0x800 = $1000  (char ROM)
// In VIC bank 0 the g-access address $1000-$1FFF reads the character ROM,
// so charRom[addr-0x1000] is the byte the renderer fetches.
const BG0 = 0x06, BG1 = 0x03, BG2 = 0x05, BG3 = 0x07, FG = 0x0A;

function makeEcmVic() {
  const vic = makeVic();
  vic.regs[0x11] = 0x40; // ECM=1, BMM=0
  vic.regs[0x16] = 0x00; // MCM=0
  vic.regs[0x18] = 0x14; // charBase $1000
  vic.regs[0x21] = BG0;
  vic.regs[0x22] = BG1;
  vic.regs[0x23] = BG2;
  vic.regs[0x24] = BG3;
  return vic;
}

function ecmSeg(vic, code) {
  const seg = makeRenderSeg(vic, {
    rowFetchD011: 0x40,
    rowFetchD016: 0x00,
    rowFetchD018: 0x14,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = code;
  seg.rowColors[0] = FG;
  return seg;
}

// Test 1: code $C1 (bits 7+0 set) must fetch the glyph of char $01
// ($C1 & $3F = $01), NOT the unmasked code $C1.
{
  const vic = makeEcmVic();
  // Masked address: $1000 + $01*8 + 0 = $1008 -> charRom[8]
  vic.charRom[8] = 0x80;   // glyph of char $01: single fg pixel at bit 7
  // DECOY at the UNMASKED address: $1000 + $C1*8 + 0 = $1608 -> charRom[0x608]
  vic.charRom[0x608] = 0xFF; // if masking is wrong, every pixel would be fg

  const seg = ecmSeg(vic, 0xC1);
  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outFgMap.join('') === '10000000',
    '§3.7.3: ECM forces g-access addr bits 9/10 low — code $C1 aliases to char $01 (masked glyph), not the unmasked $C1 decoy');
  assert(outPixels[0] === paletteRgba(FG),
    '§3.7.3.5: ECM foreground pixel uses colour RAM (lower 4 bits of c-data)');
  assert(outPixels[1] === paletteRgba(BG3),
    '§3.7.3.5: ECM background uses bits 6/7 of the FULL screen code ($C1 -> BG3/$D024), even though they are masked out of the charset address');
  console.log('ok  - ECM aliases code $C1 to char $01 and selects BG3 from bits 6/7');
}

// Test 2: alias holds at the top of the range — code $FF must fetch the
// glyph of char $3F (63), the highest of the 64 ECM glyphs.
{
  const vic = makeEcmVic();
  // Masked address: $1000 + $3F*8 + 0 = $11F8 -> charRom[0x1F8] (504)
  vic.charRom[0x1F8] = 0x01; // glyph of char $3F: single fg pixel at bit 0
  // DECOY at unmasked address: $1000 + $FF*8 + 0 = $17F8 -> charRom[0x7F8] (2040)
  vic.charRom[0x7F8] = 0xFF;

  const seg = ecmSeg(vic, 0xFF);
  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outFgMap.join('') === '00000001',
    '§3.7.3: ECM char-index mask holds at the top — code $FF aliases to char $3F (63), not the unmasked $FF decoy');
  console.log('ok  - ECM aliases code $FF to char $3F (highest of 64 glyphs)');
}

// Test 3: bits 6/7 of the c-data select BG0..BG3 ($D021..$D024). All four
// codes share char index 0 (low 6 bits = 0), whose glyph is all-zero, so
// every output pixel is the selected background — isolating the bg-select.
{
  const vic = makeEcmVic();
  vic.charRom[0] = 0x00; // char $00, line 0: all background pixels
  const cases = [
    { code: 0x00, bg: BG0, name: 'BG0/$D021' },
    { code: 0x40, bg: BG1, name: 'BG1/$D022' },
    { code: 0x80, bg: BG2, name: 'BG2/$D023' },
    { code: 0xC0, bg: BG3, name: 'BG3/$D024' },
  ];
  for (const { code, bg, name } of cases) {
    const seg = ecmSeg(vic, code);
    const outPixels = new Uint32Array(8);
    const outFgMap = new Uint8Array(8);
    vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);
    assert(outPixels.every((px) => px === paletteRgba(bg)),
      `§3.7.3.5: c-data bits 6/7 select ${name} (code $${code.toString(16).padStart(2, '0').toUpperCase()})`);
    assert(outFgMap.every((f) => f === 0),
      `§3.7.3.5: char $00 glyph is all background under ECM (code $${code.toString(16).padStart(2, '0').toUpperCase()})`);
  }
  console.log('ok  - ECM bits 6/7 select all four background colours BG0..BG3');
}

console.log('\nAll ECM g-access address masking (§3.7.3/§3.7.3.5) tests passed.');
