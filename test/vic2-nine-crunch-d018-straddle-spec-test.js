// VIC-II "Nine" upper-border mechanism: sprite-crunch + $D018 pointer-bank straddle.
//
// Reference: https://www.linusakesson.net/scene/nine/explanation.php (§5).
//
// The smooth top-border digits are NOT ghost-byte shine-through — they are
// CRUNCHED sprites whose pointers are BANK-SWITCHED mid-display via $D018, so a
// single sprite fetches pixel data from three different buffers as the beam
// descends:
//
//   "The sprites are crunched once, just after they appear ... to upset the
//    internal address counters to an unaligned value." (triple-height sprite)
//   "...sprite pointers are stored in a part of the video memory normally used
//    for character graphics ... prepare different pointer sets in different
//    memory banks ... all four pointers update simultaneously with a single
//    $D018 write."
//
// This is the COMBINATION the individual crunch tests (rule-7a, timing,
// addendum) and the $D018-bank tests don't cover together. The two invariants
// it depends on:
//   (A) Crunch keeps the sprite in DMA past its normal 21-line stop (the
//       scrambled MCBASE != 63, so cycle-16 does not turn DMA off), so it is
//       still displaying when later $D018 straddles arrive.
//   (B) Every line's p-access re-reads the sprite pointer from VM+$3F8 of the
//       CURRENT $D018 bank, so changing $D018 mid-frame re-sources the sprite's
//       data — feeding the 3 buffers.
//
// MEASURED in the real demo (our headless trace, post-detection-fix, bank
// $4000): sprite 0 is crunched, holds DMA across raster 9..50 (MCBASE wraps
// 62->1, i.e. >21 lines), and its pointer banks $90 -> $91 -> $92 as the
// rastercode writes $D018 $40 -> $50 -> $60 (the 3-buffer straddle), matching
// VICE.

import { VIC2, assert, makeVic } from './_vic2-helpers.js';

// Drive one sprite p-access exactly as the VIC does: derive the screen base
// from $D018 (high nibble * $400) and fetch the pointer from VM+$3F8 of the
// current VIC bank.
function pAccess(vic, s, d018) {
  vic.regs[0x18] = d018;
  const screenBase = ((d018 >> 4) & 0x0F) * 0x0400;
  vic._fetchSpritePointer(s, screenBase, vic.currentVicBank);
  return vic.spritePointerValue[s];
}

// Write a sprite-0 pointer byte into VM+$3F8 of the given VIC bank. Bank $4000
// avoids the charROM shadow that _vicMemRead maps over $1000-$1FFF in bank 0.
function writePtr(vic, bank, vm, val) {
  vic.ram[bank + ((vm + 0x3F8) & 0x3FFF)] = val & 0xFF;
}

console.log('nine upper-border: sprite-crunch + $D018 pointer-bank straddle:');

// ---------------------------------------------------------------------------
// STRADDLE-A: crunch holds the sprite in DMA past its normal stop.
// A sprite reaching MC=63 with the advance FF set normally does MCBASE:=MC=63
// at cycle 16 -> DMA off (the 21-line stop). A crunch (MxYE cleared in cycle 15
// with FF=0) replaces that with the bit-interleave formula, yielding a non-63
// MCBASE -> DMA stays on -> the sprite extends.
{
  // Un-crunched control: stops.
  const vn = makeVic();
  vn.regs[0x17] = 0x01; vn.spriteYExpandFF[0] = 1; vn.spriteDmaOn[0] = 1;
  vn.spriteMC[0] = 63; vn.spriteMCBase[0] = 60;
  vn._spriteSequencerCycle16();
  assert(vn.spriteDmaOn[0] === 0,
    'control: un-crunched sprite with MC=63 stops at cycle 16 (MCBASE:=63 -> DMA off)');

  // Crunched: extends.
  const vc = makeVic();
  vc.regs[0x17] = 0x01; vc.spriteYExpandFF[0] = 0; vc.spriteDmaOn[0] = 1;
  vc.spriteMC[0] = 63; vc.spriteMCBase[0] = 60;
  vc.cycleInLine = 15;
  vc.write(0x17, 0x00);                 // clear MxYE in cycle 15 with FF=0 -> crunch
  assert(vc._spriteCrunchPending[0] === 1, 'crunch latched at cycle 15');
  vc._spriteSequencerCycle16();
  // MCBASE = (0b101010 & (60 & 63)) | (0b010101 & (60 | 63))
  //        = (0b101010 & 60) | (0b010101 & 63) = 40 | 21 = 61
  assert(vc.spriteMCBase[0] === 61,
    `crunch scrambles MCBASE to 61 (got ${vc.spriteMCBase[0]})`);
  assert(vc.spriteDmaOn[0] === 1,
    'crunched sprite keeps DMA on (MCBASE != 63) -> extends past line 21');
  console.log('  ok  - STRADDLE-A: crunch holds the sprite in DMA past the 21-line stop');
}

// ---------------------------------------------------------------------------
// STRADDLE-B: a mid-frame $D018 write re-banks the sprite pointer. Each line's
// p-access reads VM+$3F8 of the CURRENT $D018 bank, so straddling $D018 changes
// which buffer the sprite sources — the mechanism that feeds the 3 buffers.
{
  const vic = makeVic();
  vic.currentVicBank = 0x4000;
  vic.spriteDmaOn[0] = 1;
  writePtr(vic, 0x4000, 0x1000, 0x40);  // $D018=$40 -> VM $1000 -> ptr $40 -> data $1000
  writePtr(vic, 0x4000, 0x1400, 0x50);  // $D018=$50 -> VM $1400 -> ptr $50 -> data $1400
  writePtr(vic, 0x4000, 0x1800, 0x60);  // $D018=$60 -> VM $1800 -> ptr $60 -> data $1800

  assert(pAccess(vic, 0, 0x40) === 0x40 && vic.spriteDataBase[0] === 0x40 * 64,
    'bank A ($D018=$40): pointer $40, data base $1000');
  assert(pAccess(vic, 0, 0x50) === 0x50 && vic.spriteDataBase[0] === 0x50 * 64,
    '$D018 straddle $40->$50: pointer re-banked to $50, data base $1400');
  assert(pAccess(vic, 0, 0x60) === 0x60 && vic.spriteDataBase[0] === 0x60 * 64,
    '$D018 straddle $50->$60: pointer re-banked to $60, data base $1800');
  console.log('  ok  - STRADDLE-B: each p-access re-banks the pointer from the current $D018 bank');
}

// ---------------------------------------------------------------------------
// STRADDLE-C (combination): a crunched, still-displaying sprite is re-sourced
// across its extended lines by the $D018 straddle -> three distinct buffers.
// This is exactly nine's top-border digit construction.
{
  const vic = makeVic();
  vic.currentVicBank = 0x4000;
  // Three pointer sets (like the demo's $90/$91/$92), one per bank.
  writePtr(vic, 0x4000, 0x1000, 0x90);
  writePtr(vic, 0x4000, 0x1400, 0x91);
  writePtr(vic, 0x4000, 0x1800, 0x92);

  // Crunch the sprite so it stays in DMA for the whole straddle window.
  vic.regs[0x17] = 0x01; vic.spriteYExpandFF[0] = 0; vic.spriteDmaOn[0] = 1;
  vic.spriteMC[0] = 63; vic.spriteMCBase[0] = 60;
  vic.cycleInLine = 15;
  vic.write(0x17, 0x00);
  vic._spriteSequencerCycle16();
  assert(vic.spriteDmaOn[0] === 1, 'crunched sprite alive for the straddle');

  // Across three lines the rastercode straddles $D018 $40->$50->$60; the
  // extended sprite sources data buffers $90*64, $91*64, $92*64 in turn.
  const bufs = [];
  for (const d018 of [0x40, 0x50, 0x60]) {
    pAccess(vic, 0, d018);
    bufs.push(vic.spriteDataBase[0]);
  }
  assert(bufs[0] === 0x90 * 64 && bufs[1] === 0x91 * 64 && bufs[2] === 0x92 * 64,
    `crunched sprite fetches 3 buffers via $D018 straddle: `
    + `[${bufs.map(b => '$' + b.toString(16)).join(', ')}] (expect $2400,$2440,$2480)`);
  console.log('  ok  - STRADDLE-C: crunched sprite sources 3 buffers via the $D018 straddle (nine top-border)');
}
