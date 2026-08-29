// VIC-II 6569 g-fetch address latch glitch (VIC-Addendum.txt "Fetch")
//
// Bauer §3.7.3 describes the normal text/bitmap g-access address schemes.
// The VICE addendum supplements it with the 6569-only modesplit/movesplit
// quirk: when a mid-line BMM change changes the fetch source from RAM to
// character ROM, the low byte of the g-fetch address is latched from the
// previous-cycle mode while the upper bits come from the current mode. The
// 8565 does not exhibit this glitch.

import {
  assert,
  makeVic,
  makeRenderSeg,
  paletteRgba,
} from './_vic2-helpers.js';

const BG = 0x06;
const FG = 0x0E;
const D011_TEXT = 0x1B;
const D011_BITMAP = 0x3B;
const D016_TEXT_HIRES = 0x08;
const D018_CHAR_ROM_BITMAP_RAM = 0x14; // CB=$1000 char ROM, bitmap base=$0000
const RAW_CODE = 0x20;
const VC = 0x0005;
const LINE = 0;
const NORMAL_TEXT_OFF = 0x100; // $1000 + $20*8
const GLITCH_TEXT_OFF = 0x128; // high($1100) | low(bitmap $0028)

function regs({ d011, d016 = D016_TEXT_HIRES, d018 = D018_CHAR_ROM_BITMAP_RAM } = {}) {
  const r = new Uint8Array(0x40);
  r[0x11] = d011;
  r[0x16] = d016;
  r[0x18] = d018;
  r[0x21] = BG;
  return r;
}

function renderColumn({ variant = '6569', currentD011, previousD011, normalByte = 0x00, glitchByte = 0x00 }) {
  const vic = makeVic();
  vic.vicVariant = variant;
  vic.charRom[NORMAL_TEXT_OFF] = normalByte;
  vic.charRom[GLITCH_TEXT_OFF] = glitchByte;

  const current = regs({ d011: currentD011 });
  const previous = regs({ d011: previousD011 });
  const seg = makeRenderSeg(vic, {
    regs: previous,
    nextRegs: current,
    modeRegs: current,
    bank: 0x0000,
    rowVcBase: VC,
    rc: LINE,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = RAW_CODE;
  seg.rowColors[0] = FG;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, LINE, seg, outPixels, outFgMap, 0);
  return { outPixels, outFgMap };
}

// Test 1: 6569 RAM bitmap -> char ROM text transition uses the split address.
{
  const { outPixels, outFgMap } = renderColumn({
    currentD011: D011_TEXT,
    previousD011: D011_BITMAP,
    normalByte: 0x00,
    glitchByte: 0x80,
  });

  assert(outFgMap.join('') === '10000000',
    'VIC-Addendum "Fetch": 6569 RAM->charROM BMM transition fetches from high(current text $1100) + low(previous bitmap $0028) = $1128');
  assert(outPixels[0] === paletteRgba(FG),
    'VIC-Addendum "Fetch": split-address byte drives the visible text foreground pixel');
  assert(outPixels[1] === paletteRgba(BG),
    'VIC-Addendum "Fetch": pixels not set in the split-address byte remain background');
  console.log('ok  - 6569 RAM->charROM BMM transition uses split g-fetch address');
}

// Test 2: 8565 does not apply the 6569 split-address glitch.
{
  const { outFgMap } = renderColumn({
    variant: '8565',
    currentD011: D011_TEXT,
    previousD011: D011_BITMAP,
    normalByte: 0x80,
    glitchByte: 0x00,
  });

  assert(outFgMap.join('') === '10000000',
    'VIC-Addendum "Fetch": 8565 fetches the normal current-mode charROM byte, not the 6569 split address');
  console.log('ok  - 8565 keeps the normal current-mode g-fetch address');
}

// Test 3: with no BMM change, 6569 uses the ordinary current-mode text address.
{
  const { outFgMap } = renderColumn({
    currentD011: D011_TEXT,
    previousD011: D011_TEXT,
    normalByte: 0x80,
    glitchByte: 0x00,
  });

  assert(outFgMap.join('') === '10000000',
    'VIC-Addendum "Fetch": unchanged BMM does not synthesize the split RAM->charROM address');
  console.log('ok  - unchanged 6569 text mode uses normal g-fetch address');
}

console.log('\nAll VIC-II fetch-address glitch tests passed.');
