// VIC-II: Sprite-crunch (Bauer §3.8.1 rule 7a)
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
// Sprite-crunch (Bauer §3.8.1 rule 7a).
//
// Trigger: the CPU clears an MxYE bit during cycle 15 *with the corresponding
// advance-line FF previously unset*. Rule 1 then force-sets the FF to 1, but
// because of the late timing the cycle-16 MCBASE update uses a bit-interleave
// formula instead of `MCBASE := MC`:
//
//   MCBASE = (0b101010 & (MCBASE & MC)) | (0b010101 & (MCBASE | MC))   [6-bit]
//
// This produces a "scrambled" MCBASE — exactly the kind of pseudo-random
// state that could turn a multiplexed sprite into garbage if our trigger
// window or formula is off-by-one.
// ============================================================================

// CRUNCH-1: clearing MxYE during cycle 15 with FF=0 sets the crunch-pending
// latch. The latch is consumed at the next cycle 16 and produces the
// bit-interleave MCBASE.
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;        // sp0 MxYE = 1
  vic.spriteYExpandFF[0] = 0;
  vic.spriteDmaOn[0] = 1;
  vic.spriteMC[0] = 0b101010;       // 42
  vic.spriteMCBase[0] = 0b010101;   // 21

  vic.cycleInLine = 15;
  vic.write(0x17, 0x00);            // clear MxYE during cycle 15 with FF=0

  assert(vic._spriteCrunchPending[0] === 1,
    'crunch-pending latch is set when MxYE clears in cycle 15 with FF=0');
  assert(vic.spriteYExpandFF[0] === 1,
    'rule 1: clearing MxYE forces FF to 1 immediately');

  vic._spriteSequencerCycle16();
  // (mcb & mc) = 0b101010 & 0b010101 = 0
  // (mcb | mc) = 0b101010 | 0b010101 = 0b111111 = 63
  // result    = (0b101010 & 0) | (0b010101 & 63) = 0b010101 = 21
  assert(vic.spriteMCBase[0] === 0b010101,
    `cycle 16 applies bit-interleave: MCBASE = 0b010101 (got ${vic.spriteMCBase[0].toString(2)})`);
  assert(vic._spriteCrunchPending[0] === 0,
    'crunch-pending latch is cleared after cycle 16 consumes it');
  console.log('ok  - CRUNCH-1: MxYE-clear-in-cycle-15-with-FF=0 triggers bit-interleave MCBASE');
}

// CRUNCH-2: clearing MxYE during cycle 15 with the FF ALREADY SET does
// NOT crunch. Bauer §3.8.1 rule 7a gates the special case on "the advance
// line flip-flop of the corresponding sprite was NOT set" — so a c15 clear
// only crunches when it is the write that first sets the FF. The VIC-
// Addendum's rule-7 rewrite reads as if the gate is gone (it tests the FF
// at cy16, by which point rule 1 has already forced FF=1), but Coma Light
// 13's sprite-stretch RELEASE proves the pre-clear gate is real: the
// release STX $D017 lands at c15 with the FF already 1 (from the previous
// line's rule-3 toggle); an ungated crunch scrambles MCBASE off the ×3
// grid (1 instead of MC), so the eight stretched sprites keep DMA-active
// ~22 lines too long and over-steal the FLI-plasma IRQ handler into a
// raster-78 overrun. With the gate, cycle 16 runs the clean MCBASE := MC
// and the sprites end on schedule. (VICE's sprite-crunch testprog only
// exercises FF=0 crunches, so it passes either way — see CRUNCH-1 and
// vic2-mxye-crunch-spec-test.js test 11.)
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;
  vic.spriteYExpandFF[0] = 1;       // FF already SET before the clear
  vic.spriteDmaOn[0] = 1;
  vic.spriteMC[0] = 30;
  vic.spriteMCBase[0] = 9;

  vic.cycleInLine = 15;
  vic.write(0x17, 0x00);

  assert(vic._spriteCrunchPending[0] === 0,
    'rule 7a FF gate: c15 clear with FF already set does NOT latch crunch');
  vic._spriteSequencerCycle16();
  assert(vic.spriteMCBase[0] === 30,
    `c16 clean MCBASE := MC when not crunched (got ${vic.spriteMCBase[0]})`);
  console.log('ok  - CRUNCH-2: MxYE-clear-in-cycle-15-with-FF=1 does NOT crunch (Bauer rule-7a FF gate)');
}

// CRUNCH-3: clearing MxYE OUTSIDE cycle 15 (e.g. cycle 10 or cycle 16)
// does NOT set the crunch latch. Rule 1 still force-sets FF=1, but rule 7
// runs normally on the next cycle 16.
{
  for (const cyc of [10, 14, 16, 17, 50]) {
    const vic = makeVic();
    vic.regs[0x17] = 0x01;
    vic.spriteYExpandFF[0] = 0;
    vic.spriteDmaOn[0] = 1;
    vic.spriteMC[0] = 18;
    vic.spriteMCBase[0] = 6;

    vic.cycleInLine = cyc;
    vic.write(0x17, 0x00);

    assert(vic._spriteCrunchPending[0] === 0,
      `cycle ${cyc} clear: crunch-pending NOT set (window is exactly cycle 15)`);
    assert(vic.spriteYExpandFF[0] === 1,
      `cycle ${cyc} clear: FF still force-set to 1 by rule 1`);

    vic._spriteSequencerCycle16();
    assert(vic.spriteMCBase[0] === 18,
      `cycle ${cyc} clear: rule 7 normal MCBASE := MC = 18 (got ${vic.spriteMCBase[0]})`);
  }
  console.log('ok  - CRUNCH-3: MxYE clear outside cycle 15 never triggers crunch (window is exact)');
}

// CRUNCH-4: SETTING MxYE during cycle 15 (bit 0→1) does NOT trigger crunch.
// Crunch fires only on the 1→0 transition.
{
  const vic = makeVic();
  vic.regs[0x17] = 0x00;
  vic.spriteYExpandFF[0] = 0;
  vic.spriteDmaOn[0] = 1;
  vic.spriteMC[0] = 24;
  vic.spriteMCBase[0] = 12;

  vic.cycleInLine = 15;
  vic.write(0x17, 0x01);            // SET MxYE (transition 0 → 1)

  assert(vic._spriteCrunchPending[0] === 0,
    'crunch-pending NOT set on MxYE 0→1 transition');
  // FF is set on bit-clear only — bit-set leaves FF unchanged (still 0 here).
  assert(vic.spriteYExpandFF[0] === 0,
    'setting MxYE does not force FF to 1');
  console.log('ok  - CRUNCH-4: MxYE 0→1 (set) during cycle 15 does NOT trigger crunch');
}

// CRUNCH-5: bit-interleave formula is correct for several MCBASE/MC pairings.
{
  const cases = [
    { mc: 0b111111, mcb: 0b111111, expected: 0b111111 }, // both 63 → 63
    { mc: 0b000000, mcb: 0b000000, expected: 0b000000 }, // both 0 → 0
    { mc: 0b101010, mcb: 0b010101, expected: 0b010101 }, // disjoint → odd-bits-only
    { mc: 0b110011, mcb: 0b001100, expected: 0b010101 }, // (mcb&mc=0, mcb|mc=63 → odd-bit mask 010101)
    { mc: 0b111000, mcb: 0b000111, expected: 0b010101 }, // disjoint halves
  ];
  for (const { mc, mcb, expected } of cases) {
    const vic = makeVic();
    vic.regs[0x17] = 0x01;
    vic.spriteYExpandFF[0] = 0;
    vic.spriteDmaOn[0] = 1;
    vic.spriteMC[0] = mc;
    vic.spriteMCBase[0] = mcb;

    vic.cycleInLine = 15;
    vic.write(0x17, 0x00);
    vic._spriteSequencerCycle16();

    assert(vic.spriteMCBase[0] === expected,
      `crunch formula: mc=${mc.toString(2)} mcb=${mcb.toString(2)} → expected ${expected.toString(2)}, got ${vic.spriteMCBase[0].toString(2)}`);
  }
  console.log('ok  - CRUNCH-5: bit-interleave formula matches Bauer §3.8.1 rule 7a across 5 MCBASE/MC pairings');
}

// CRUNCH-6: crunch trigger fires per-sprite AND per Bauer 7a's FF gate. A
// multi-sprite write to D017 crunches only those sprites whose bit goes
// 1→0 AND whose advance-line FF was UNSET before the clear. Sprites whose
// FF was already set take the clean MCBASE := MC at cycle 16.
{
  const vic = makeVic();
  vic.regs[0x17] = 0xFF;            // all 8 sprites have MxYE=1
  // Mix of FF states: sprites 1 and 3 start SET (gated → no crunch),
  // the rest start UNSET (crunch). Sprites 5..7 default to FF=0.
  const ffBefore = [0, 1, 0, 1, 0, 0, 0, 0];
  for (let s = 0; s < 8; s++) {
    vic.spriteYExpandFF[s] = ffBefore[s];
    vic.spriteDmaOn[s] = 1;
    vic.spriteMC[s] = 30;
    vic.spriteMCBase[s] = 9;
  }

  vic.cycleInLine = 15;
  // Clear all MxYE bits — every sprite whose bit goes 1→0 with FF unset crunches.
  vic.write(0x17, 0x00);

  for (let s = 0; s < 8; s++) {
    const expected = ffBefore[s] ? 0 : 1;   // FF-set sprites are gated out
    assert(vic._spriteCrunchPending[s] === expected,
      `sp${s}: FF-gate — crunch latch ${expected} (FF was ${ffBefore[s]}), got ${vic._spriteCrunchPending[s]}`);
  }
  console.log('ok  - CRUNCH-6: crunch is per-sprite and Bauer-7a FF-gated (only FF-unset sprites latch)');
}

// CRUNCH-7: sprites whose D017 bit STAYS SET (1→1) do not crunch — only
// those whose new bit is 0. Verifies the per-sprite gating across a partial
// D017 update.
//
// Note: the impl uses the new-value bit (val & 1<<s == 0) plus FF=0 as the
// trigger, not a strict 1→0 transition. In real-hardware-reachable states
// that's equivalent — once MxYE is cleared, rule 1 forces FF=1, so a
// subsequent 0→0 hold can't see FF=0 anyway.
{
  const vic = makeVic();
  vic.regs[0x17] = 0b00000101;      // sp0=1, sp2=1; rest 0
  vic.spriteYExpandFF[0] = 0;
  vic.spriteYExpandFF[2] = 0;
  for (let s = 0; s < 8; s++) {
    vic.spriteDmaOn[s] = 1;
    vic.spriteMC[s] = 30;
    vic.spriteMCBase[s] = 9;
  }

  vic.cycleInLine = 15;
  // Clear sp0's bit (1→0); sp2's bit STAYS at 1 (1→1, no clear).
  vic.write(0x17, 0b00000100);

  assert(vic._spriteCrunchPending[0] === 1, 'sp0 1→0 with FF=0 → crunch');
  assert(vic._spriteCrunchPending[2] === 0,
    'sp2 1→1 (still set) → no crunch (val bit is 1)');
  console.log('ok  - CRUNCH-7: bits that stay set (1→1) do NOT crunch — only those cleared (val bit = 0)');
}

// CRUNCH-8: if the post-crunch MCBASE equals 63, cycle 16's rule-7 stop check
// turns DMA off — same termination path as a normal sprite end. This is what
// could make a Y-expand toggle CUT the sprite short mid-display.
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;
  vic.spriteYExpandFF[0] = 0;
  vic.spriteDmaOn[0] = 1;
  vic.spriteDisplayOn[0] = 1;
  // mc = 63, mcb = 63 → crunch result also 63 → DMA off.
  vic.spriteMC[0] = 63;
  vic.spriteMCBase[0] = 63;

  vic.cycleInLine = 15;
  vic.write(0x17, 0x00);
  vic._spriteSequencerCycle16();

  assert(vic.spriteMCBase[0] === 63,
    'crunch result happens to land on 63 → triggers stop check');
  assert(vic.spriteDmaOn[0] === 0,
    'DMA stops when post-crunch MCBASE === 63');
  console.log('ok  - CRUNCH-8: post-crunch MCBASE=63 terminates DMA via rule 7 stop check');
}


console.log('\nAll Sprite-crunch (Bauer §3.8.1 rule 7a) tests passed.');
