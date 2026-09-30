// VIC-II: Sprite multiplexer behaviour (nine.prg patterns)
// Extracted from vic2-test.js.

import {
  VIC2,
  CANVAS_W,
  CANVAS_H,
  CYCLES_PER_FRAME,
  CYCLES_PER_LINE,
  C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE,
  ACCESS_REFRESH,
  ACCESS_C,
  ACCESS_G,
  assert,
  softAssert,
  makeVic,
  makeRenderSeg,
  fillSpriteLineState,
  fillOpaqueSpriteAcrossLine,
  clearLineBuffers,
  setupSpriteForRender,
  setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow,
  firstForegroundX,
  lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
} from './_vic2-helpers.js';

// ============================================================================
// Sprite multiplexer behavior — the patterns demos like nine.prg rely on:
//
//   (1) Y-restart timing: writing a new sprite Y mid-display does NOT abort
//       the in-flight DMA. The existing sprite keeps displaying until MCBASE
//       reaches 63 (cycle 16 turns DMA off). Only then can the next Y-match
//       fire a fresh DMA-start at cycle 55/56.
//
//   (2) MC progression across pointer rewrites: rewriting the screen-RAM
//       sprite-pointer slot mid-frame updates `spriteDataBase` on the next
//       line's p-access, but `spriteMC` continues advancing as it would
//       under the old pointer — the next s-access reads `new_base + old_mc`.
//
//   (3) Y-expand FF across multi-multiplex: clearing MxYE forces the FF to
//       1 (rule 1); re-enabling it lets cycle 56 phi2 invert the FF (rule
//       3). MCBASE only advances on lines where FF was 1 at cycle 16 (rule
//       7). This is what lets a Y-expanded sprite repeat each row twice.
// ============================================================================

// MUX-1: writing a new sprite Y while DMA is on does NOT abort the in-flight
// sprite. _tryStartSpriteDma early-returns when spriteDmaOn[s] is already 1.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;        // sp0 enabled
  vic.regs[0x17] = 0x00;        // no Y-expand → FF stays 1
  vic.regs[1] = 0x80;           // sp0 Y = 128
  vic.raster = 0x80;

  // Cycle 55 fires DMA-start because raster matches Y.
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 1, 'sp0 DMA started at raster 128');
  vic.spriteMCBase[0] = 21;     // pretend we are mid-display (line 7)
  vic.spriteMC[0] = 21;

  // CPU rewrites Y to 144. While DMA is still on, the new Y-match must NOT
  // restart DMA — the in-flight sprite owns the hardware until MCBASE=63.
  vic.regs[1] = 0x90;
  vic.raster = 0x90;
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 1,
    'mid-display Y-match does not restart DMA (in-flight sprite still owns it)');
  assert(vic.spriteMCBase[0] === 21,
    'in-flight MCBASE not reset by the new Y-match');

  console.log('ok  - MUX-1: writing a new Y while DMA is on does not abort the in-flight sprite');
}

// MUX-2: once the in-flight sprite ends (cycle 16 with MCBASE=63 turns DMA
// off), the next raster that matches the new Y starts a fresh DMA. This is
// the "back-to-back" multiplex window real demos depend on.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.regs[1] = 0x80;
  vic.raster = 0x80;
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 1, 'first sprite started');

  // Ride to MCBASE=63: simulate cycle 16 with FF=1 setting MCBASE := MC.
  // We pin MC=63 before cycle 16 to force the rule-7 termination.
  vic.spriteMC[0] = 63;
  vic.spriteYExpandFF[0] = 1;
  vic._spriteSequencerCycle16();
  assert(vic.spriteDmaOn[0] === 0, 'rule 7 turns DMA off when MCBASE reaches 63');

  // CPU now writes new Y. Next raster that matches starts a new DMA.
  vic.regs[1] = 0x90;
  vic.raster = 0x90;
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 1,
    'after old DMA ended, a new Y-match cleanly starts the next sprite');
  assert(vic.spriteMCBase[0] === 0, 'fresh sprite resets MCBASE to 0');
  assert(vic.spriteMC[0] === 0, 'fresh sprite resets MC to 0');

  console.log('ok  - MUX-2: new Y-match starts a fresh sprite DMA only after the previous one ends');
}

// MUX-3: Y-match seen ONLY on a single raster. Bauer §3.8.1 rule 2 only
// triggers DMA when raster Y exactly matches the sprite Y register that
// cycle. If the demo writes a Y value the raster has already passed, DMA
// won't start until the raster next reaches that Y (next frame).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.spriteDmaOn[0] = 0;
  vic.regs[1] = 0x40;            // future Y (raster will reach 64 later)
  vic.raster = 0x80;
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 0,
    'no DMA start when current raster does not match sprite Y (already passed)');

  vic.raster = 0x40;
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 1, 'DMA fires once raster reaches the programmed Y');

  console.log('ok  - MUX-3: DMA-start only fires on the exact raster matching sprite Y');
}

// PTR-1: mid-frame screen-RAM pointer rewrite is picked up at the next
// line's p-access. spriteDataBase = newPtr × 64.
{
  const vic = makeVic();
  vic.noteBankChange(0x4000);
  vic.regs[0x18] = 0x30;             // screen $0C00 → $4C00
  vic.ram[0x4FF8] = 0x10;            // initial sp0 ptr → base $400

  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0x10, 'initial p-access fetch');
  assert(vic.spriteDataBase[0] === 0x10 * 64,
    'spriteDataBase = ptr × 64 after p-access');

  // CPU rewrites the slot. Next line's p-access uses the new value.
  vic.ram[0x4FF8] = 0xC4;            // wizard head pointer
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0xC4, 'next-line p-access reads new ptr');
  assert(vic.spriteDataBase[0] === 0xC4 * 64,
    'spriteDataBase tracks the live pointer × 64');

  console.log('ok  - PTR-1: per-line ptr rewrites update spriteDataBase via next-line p-access');
}

// PTR-2: MC keeps advancing across a pointer rewrite. Within one sprite
// display run, MC is reloaded from MCBASE at cycle 58 each line, then
// incremented 3× by the s-accesses. A pointer rewrite does NOT reset MC
// to 0 — the new s-access reads from `newBase + oldMc..oldMc+2`.
{
  const vic = makeVic();
  vic.noteBankChange(0x4000);
  vic.regs[0x18] = 0x30;
  vic.ram[0x4FF8] = 0x10;            // initial ptr → base $400

  // Plant marker bytes at base $400 + offsets, AND at base $C4*64 = $3100.
  vic.ram[0x4400 + 9]  = 0xA1;       // base $400 + 9
  vic.ram[0x4400 + 10] = 0xA2;
  vic.ram[0x4400 + 11] = 0xA3;
  vic.ram[0x4000 + 0xC4 * 64 + 9]  = 0xB1;  // base for ptr $C4
  vic.ram[0x4000 + 0xC4 * 64 + 10] = 0xB2;
  vic.ram[0x4000 + 0xC4 * 64 + 11] = 0xB3;

  // Pretend we ran 3 s-accesses already on a previous line (MC = 9).
  vic.spriteMC[0] = 9;
  vic.spriteMCBase[0] = 9;

  // p-access at cycle 58 with old ptr. The s-accesses (cycle 59) would read
  // base $400 + MC..MC+2 → $A1, $A2, $A3.
  vic._spriteSequencerPointerAccess(58);
  vic.spriteDataBase[0] = 0x10 * 64;
  vic.spriteDataBank[0] = 0x4000;
  vic._performSpriteRowSAccesses(0);
  assert(vic.spriteRowData[0][0] === 0xA1, 's-access reads marker A1 from old base');
  assert(vic.spriteRowData[0][1] === 0xA2);
  assert(vic.spriteRowData[0][2] === 0xA3);
  assert(vic.spriteMC[0] === 12, 'MC advanced 3 across the s-accesses');

  // CPU rewrites ptr → $C4. cycle 58 of next line: MC reloads from MCBASE
  // (= 9 still), then s-access reads new base + 9..11 → $B1, $B2, $B3.
  vic.ram[0x4FF8] = 0xC4;
  vic.spriteMC[0] = vic.spriteMCBase[0];     // _spriteSequencerCycle58 does this
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spriteDataBase[0] === 0xC4 * 64,
    'new line: spriteDataBase reflects the freshly-fetched ptr ($C4 × 64)');
  vic._performSpriteRowSAccesses(0);
  assert(vic.spriteRowData[0][0] === 0xB1,
    's-access on new line reads from the NEW base + MC ($B1)');
  assert(vic.spriteRowData[0][1] === 0xB2);
  assert(vic.spriteRowData[0][2] === 0xB3);
  assert(vic.spriteMC[0] === 12, 'MC advances correctly after ptr rewrite');

  console.log('ok  - PTR-2: MC progresses normally across mid-frame pointer rewrites');
}

// YE-1: clearing the MxYE bit forces the advance-line FF to 1 immediately
// (Bauer §3.8.1 rule 1). Pin this in the multiplex context: the FF is
// force-set even when DMA is mid-flight.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;            // sp0 Y-expand ON
  vic.regs[1] = 0x80;
  vic.raster = 0x80;
  vic._spriteSequencerCycle55();
  vic._spriteSequencerCycle56();    // rule 3 inverts: 1 → 0
  assert(vic.spriteYExpandFF[0] === 0,
    'rule 3: YE on + DMA → cycle 56 phi2 toggles FF to 0');

  // CPU writes $D017 = 0 mid-frame: rule 1 says FF goes to 1.
  vic.write(0x17, 0x00);
  assert(vic.spriteYExpandFF[0] === 1,
    'rule 1: clearing MxYE forces FF to 1 immediately, even mid-display');
  console.log('ok  - YE-1: clearing MxYE mid-display forces the advance-line FF to 1');
}

// YE-2: Y-expanded sprite advances MCBASE every other line. Two consecutive
// cycle-16 calls with rule-3 FF toggling produce: MCBASE only updates on the
// line where cycle 16 sees FF=1, then cycle 56 phi2 toggles FF to 0; next
// line cycle 16 sees FF=0 → MCBASE NOT updated; cycle 56 phi2 toggles back.
// That row-doubling cadence is what Y-expand visually produces.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;            // YE=1
  vic.regs[1] = 0x80;
  vic.raster = 0x80;
  vic._spriteSequencerCycle55();
  vic._spriteSequencerCycle56();    // FF: 1 → 0 (cycle 56 phi2 toggle)
  assert(vic.spriteMCBase[0] === 0, 'MCBASE starts at 0');

  // Line 1 (raster 129): MC=3 (ran 1 line of s-accesses). Cycle 16 sees FF=0,
  // so MCBASE stays at 0. Cycle 56 toggles FF to 1.
  vic.spriteMC[0] = 3;
  vic._spriteSequencerCycle16();
  assert(vic.spriteMCBase[0] === 0,
    'YE line 1: cycle 16 FF=0 → MCBASE stays 0 (sprite repeats row 0)');
  vic._spriteSequencerCycle55();
  vic._spriteSequencerCycle56();
  assert(vic.spriteYExpandFF[0] === 1,
    'cycle 56 phi2 toggle 0 → 1');

  // Line 2 (raster 130): MC=3 still (from cycle 58 reload of MCBASE=0 + 3
  // s-accesses → 3). Cycle 16 sees FF=1 → MCBASE := MC = 3. Sprite advances.
  vic.spriteMC[0] = 3;
  vic._spriteSequencerCycle16();
  assert(vic.spriteMCBase[0] === 3,
    'YE line 2: cycle 16 FF=1 → MCBASE := MC = 3 (sprite advances 1 row)');
  vic._spriteSequencerCycle55();
  vic._spriteSequencerCycle56();
  assert(vic.spriteYExpandFF[0] === 0, 'FF toggles 1 → 0 ready for next row repeat');

  console.log('ok  - YE-2: Y-expand row-doubling cadence — MCBASE advances every other line');
}


console.log('\nAll Sprite multiplexer behaviour (nine.prg patterns) tests passed.');
