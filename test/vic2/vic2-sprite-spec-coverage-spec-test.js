// VIC-II: Sprite spec coverage (Bauer §3.8)
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

// ─────────────────────────────────────────────────────────────────────────────
// Sprite spec coverage (Bauer §3.8) — moved here from sprite-spec-test.js.
// Pins observable spec invariants for sprite rendering edge cases not
// covered elsewhere: multicolor transparency, sprite-vs-sprite priority,
// mid-line register changes (color, MCM palette, X-MSB, priority), the
// Y-expand FF lifecycle, regX=0 placement, and multicolor-vs-collision
// semantics. Each test asserts a Bauer-cited property; harness uses
// `_renderSpriteLine` directly with `setupSpriteForRender` / `lineCycleRegs`.
// ─────────────────────────────────────────────────────────────────────────────

// SP-1: Multicolor pattern 00 is transparent (Bauer §3.8). In MCM=1, every
// 2-bit pair decodes as {00=transparent, 01=MCM0, 10=color, 11=MCM1}.
// Pattern 00 must not draw anything.
{
  const vic = makeVic();
  const canvasY = 40;
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  setMulticolorRegs(vic, 1, 5);
  // shiftReg = 0x00FFFF: top byte $00 (4 transparent pairs), then $FF $FF
  // (8 pairs of pattern 11 = MCM1).
  setupSpriteForRender(vic, 0, 24, { multicolor: true, color: 2, shiftReg: 0x00FFFF });

  vic._renderSpriteLine(55, canvasY);

  for (let x = 32; x < 40; x++) {
    assert(vic.spriteCollisionBuffer[x] === 0,
      `multicolor 00 pattern is transparent at canvas X=${x}`);
  }
  let drawn = 0;
  for (let x = 40; x < 56; x++) if (vic.spriteCollisionBuffer[x]) drawn++;
  assert(drawn >= 14,
    `multicolor 11 pattern draws solid pixels (drew ${drawn}/16 in the lit region)`);
  console.log('ok  - SP-1: multicolor pattern 00 is transparent');
}

// SP-2: Sprite-vs-sprite priority — lower-numbered sprite wins on overlap.
// The renderer iterates s=7→0, so sprite 0's pixel is drawn last and
// overwrites whatever sprite 7 drew at the same coordinate. Both sprite
// bits must latch in $D01E.
{
  const vic = makeVic();
  const canvasY = 41;
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  setupSpriteForRender(vic, 7, 30, { color: 7, shiftReg: 0xFFFFFF });
  setupSpriteForRender(vic, 0, 30, { color: 2, shiftReg: 0xFFFFFF });

  vic._renderSpriteLine(56, canvasY);

  const pix = vic.fb32[off + 38];
  assert(pix === paletteRgba(2),
    `sprite 0 (color 2) overwrites sprite 7 (color 7) on overlap`);
  assert((vic.regs[0x1E] & 0x81) === 0x81,
    `sprite-sprite collision latches both sprite 0 and sprite 7 bits`);
  console.log('ok  - SP-2: sprite-vs-sprite priority — sprite 0 wins on overlap');
}

// SP-3: Sprite color register ($D027+s) is read PER SEGMENT. Sprite at
// regX=100 → canvas X 108..131 spans cycles 25..28. Flip $D027 from 2→7
// at cycle 27 → cycles 25-26 use color 2, cycles 27-28 use color 7.
{
  const vic = makeVic();
  const canvasY = 42;
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  setupSpriteForRender(vic, 0, 100, { color: 2, shiftReg: 0xFFFFFF });
  for (let cycle = 27; cycle <= 63; cycle++) vic.lineCycleRegs[cycle][0x27] = 7;

  vic._renderSpriteLine(57, canvasY);

  const c2 = paletteRgba(2), c7 = paletteRgba(7);
  let saw2 = 0, saw7 = 0;
  for (let x = 108; x < 132; x++) {
    const p = vic.fb32[off + x];
    if (p === c2) saw2++;
    if (p === c7) saw7++;
  }
  assert(saw2 > 0 && saw7 > 0,
    `mid-line $D027 produces both colors (got color 2: ${saw2}px, color 7: ${saw7}px)`);
  console.log('ok  - SP-3: sprite $D027 is read per-segment for mid-line color changes');
}

// SP-4: Multicolor palette ($D025) per-segment. Sprite at regX=192 →
// canvas X 200..223 spans cycles 36..38. Flip $D025 from 4→7 at cycle 37
// → cycles 36 (canvas 200..207) use color 4, 37+ (canvas 208..223) use 7.
{
  const vic = makeVic();
  const canvasY = 43;
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  // shiftReg = 0x555555 → every 2-bit pair = 01 (= MCM0 in multicolor),
  // so every drawn pixel reads its color from the segment's $D025.
  setupSpriteForRender(vic, 0, 192, { multicolor: true, color: 1, shiftReg: 0x555555 });
  for (let cycle = 1; cycle <= 36; cycle++) vic.lineCycleRegs[cycle][0x25] = 4;
  for (let cycle = 37; cycle <= 63; cycle++) vic.lineCycleRegs[cycle][0x25] = 7;
  vic.regs[0x25] = 7;

  vic._renderSpriteLine(58, canvasY);

  const c4 = paletteRgba(4), c7 = paletteRgba(7);
  for (let x = 200; x < 208; x++) {
    assert(vic.fb32[off + x] === c4,
      `mid-line $D025: cycle-36 segment uses old MCM0=4 at X=${x}`);
  }
  for (let x = 208; x < 224; x++) {
    assert(vic.fb32[off + x] === c7,
      `mid-line $D025: cycle-37+ segment uses new MCM0=7 at X=${x}`);
  }
  console.log('ok  - SP-4: $D025 per-segment latching (mid-line MCM0 change)');
}

// SP-5: X-MSB ($D010) PRE-START rewrite. The renderer's "pre-start X
// rewrite" path honors mid-line X changes only while the beam hasn't
// hit the original X yet. Set X low=50 with no MSB at line start, then
// set MSB at cycle 15 (canvas X=32, before the sprite's nominal X=58).
// Sprite must render at the relocated canvas X=314.
{
  const vic = makeVic();
  const canvasY = 44;
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= 0x01;
    vic.lineCycleRegs[cycle][0x00] = 50;
    vic.lineCycleRegs[cycle][0x27] = 2;
    vic.lineCycleSpriteDisplayOn[cycle][0] = 1;
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = 0xFFFFFF;
    if (cycle >= 15) vic.lineCycleRegs[cycle][0x10] |= 0x01;
  }
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0xFFFFFF;

  vic._renderSpriteLine(59, canvasY);

  let lowDrawn = 0, highDrawn = 0;
  for (let x = 50; x < 90; x++)   if (vic.spriteCollisionBuffer[x]) lowDrawn++;
  for (let x = 305; x < 340; x++) if (vic.spriteCollisionBuffer[x]) highDrawn++;
  assert(lowDrawn === 0,
    `pre-start X-MSB rewrite: sprite does NOT render at original low X (got ${lowDrawn})`);
  assert(highDrawn > 0,
    `pre-start X-MSB rewrite: sprite renders at relocated high X (got ${highDrawn})`);
  console.log('ok  - SP-5: $D010 X-MSB pre-start rewrite relocates sprite to high X');
}

// SP-6: Sprite priority ($D01B) per-segment. Sprite at regX=100 spans
// canvas 108..131 across cycles 25..28. Flip priority=1 at cycle 27 →
// cycles 25-26 priority=0 (sprite ON TOP of foreground), 27-28 priority=1
// (sprite BEHIND foreground). Foreground at canvas X=110 (cycle 25)
// gets overwritten; foreground at canvas X=128 (cycle 28) survives.
{
  const vic = makeVic();
  const canvasY = 0;   // line buffers (#1): fb32 row & side-buffer columns share index space
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  setupSpriteForRender(vic, 0, 100, { color: 2, shiftReg: 0xFFFFFF });
  for (let cycle = 27; cycle <= 63; cycle++) vic.lineCycleRegs[cycle][0x1B] |= 0x01;

  const foreEarly = 110, foreLate = 128;  // canvas columns (side buffers line-sized #1)
  vic.fb32[foreEarly] = 0xDEADBEEF;
  vic.graphicsPriorityBuffer[foreEarly] = 1;
  vic.fb32[foreLate]  = 0xCAFEBABE;
  vic.graphicsPriorityBuffer[foreLate]  = 1;

  vic._renderSpriteLine(60, canvasY);

  const earlyKept = (vic.fb32[foreEarly] === 0xDEADBEEF);
  const lateKept  = (vic.fb32[foreLate]  === 0xCAFEBABE);
  assert(earlyKept !== lateKept,
    `mid-line $D01B: one foreground kept, one overwritten (early=${earlyKept}, late=${lateKept})`);
  console.log('ok  - SP-6: $D01B sprite priority is read per-segment');
}

// SP-7: advance line FF (Y-expand) — Bauer §3.8.1 (2024) rules:
//   rule 1: MxYE bit clear at $D017 write time forces FF=1 immediately
//   rule 2: DMA start sets FF=1 unconditionally (no MxYE gating)
//   rule 3: cycle 56 phi2 inverts FF when MxYE=1 AND DMA on
//   rule 7a: MxYE clear in cycle 15 with FF=0 latches a sprite-crunch
//            request consumed at the next cycle 16 (covered by Test 20)
{
  // (a) rule 1: MxYE=0 forces FF=1 at register-write time.
  const vic = makeVic();
  vic.spriteYExpandFF[0] = 0;
  vic.write(0xD017, 0x00);
  assert(vic.spriteYExpandFF[0] === 1,
    `Bauer §3.8.1 (2024) rule 1: writing $D017 with the sprite bit clear forces FF=1`);

  vic.spriteYExpandFF.fill(0);
  vic.write(0xD017, 0xAA);
  for (let s = 0; s < 8; s++) {
    if (((0xAA >> s) & 1) === 0) {
      assert(vic.spriteYExpandFF[s] === 1, `sprite ${s} (MxYE=0) FF forced to 1`);
    } else {
      assert(vic.spriteYExpandFF[s] === 0, `sprite ${s} (MxYE=1) FF unchanged by the write`);
    }
  }

  // Setting the bit does not retroactively force anything.
  {
    const v = makeVic();
    v.regs[0x17] = 0xFF;
    v.spriteYExpandFF.fill(0);
    v.write(0xD017, 0xED);
    assert(v.spriteYExpandFF[1] === 1, 'sprite 1 (MxYE just cleared) forced high');
    v.spriteYExpandFF[1] = 0;
    v.write(0xD017, 0xFF);
    assert(v.spriteYExpandFF[1] === 0,
      `rule 1: re-setting MxYE does NOT retroactively force the FF`);
  }

  // (b) rule 3: cycle 56 phi2 inverts FF when MxYE=1 AND DMA on.
  // Sprite 0 has DMA pre-set on, but Y-match disabled so no rule-2 reset.
  {
    const v = makeVic();
    v.spriteDmaOn[0] = 1;
    v.spriteYExpandFF[0] = 0;
    v.regs[0x17] = 0x01;
    v.regs[0x15] = 0x00;          // not enabled → cycle 56 DMA-start no-op
    v.regs[1] = 0xFE;
    v.raster = 0;                  // no Y-match
    v._spriteSequencerCycle56();
    assert(v.spriteYExpandFF[0] === 1,
      `Bauer §3.8.1 (2024) rule 3: cycle 56 phi2 inverts FF (0→1) when MxYE=1 and DMA on`);
    v._spriteSequencerCycle56();
    assert(v.spriteYExpandFF[0] === 0,
      `rule 3: successive cycle 56 phi2 toggles continue (1→0)`);
  }

  // (b2) rule 3 gating: cycle 56 phi2 does NOT toggle FF when DMA off.
  {
    const v = makeVic();
    v.spriteDmaOn[0] = 0;
    v.spriteYExpandFF[0] = 0;
    v.regs[0x17] = 0x01;
    v.regs[0x15] = 0x00;
    v.regs[1] = 0xFE;
    v.raster = 0;
    v._spriteSequencerCycle56();
    assert(v.spriteYExpandFF[0] === 0,
      `rule 3 is gated on DMA on — DMA-off sprites do not toggle`);
  }

  // (b3) rule 3 gating: cycle 56 phi2 does NOT toggle FF when MxYE=0.
  // It runs the rule-1 force-to-1 path instead (paired with rule 3 at the
  // same cycle), so FF lands at 1 — but via rule 1, not rule 3 toggling.
  {
    const v = makeVic();
    v.spriteDmaOn[0] = 1;
    v.spriteYExpandFF[0] = 0;
    v.regs[0x17] = 0x00;
    v.regs[0x15] = 0x00;
    v.regs[1] = 0xFE;
    v.raster = 0;
    v._spriteSequencerCycle56();
    assert(v.spriteYExpandFF[0] === 1,
      `rule 1 fires at cycle 56 phi1 (MxYE=0 → FF:=1) instead of the rule-3 toggle`);
    // Re-running cycle 56 with MxYE=0 keeps FF at 1 (level force, not toggle).
    v._spriteSequencerCycle56();
    assert(v.spriteYExpandFF[0] === 1,
      `rule 1 is a level set, not a toggle: re-fire keeps FF=1`);
  }

  // (c) rule 2: DMA start sets FF=1 regardless of MxYE.
  // (c1) MxYE=1, FF=0 before DMA start → FF=1 after DMA start.
  {
    const v = makeVic();
    v.regs[0x15] = 0x01;
    v.regs[0x17] = 0x01;
    v.regs[1] = 0x40;
    v.raster = 0x40;
    v.spriteYExpandFF[0] = 0;
    v._spriteSequencerCycle55();
    assert(v.spriteYExpandFF[0] === 1,
      `Bauer §3.8.1 (2024) rule 2: DMA start with MxYE=1 sets FF=1 (was 0)`);
  }
  // (c2) MxYE=0, FF=0 before DMA start → FF=1 after DMA start.
  {
    const v = makeVic();
    v.regs[0x15] = 0x01;
    v.regs[0x17] = 0x00;
    v.regs[1] = 0x40;
    v.raster = 0x40;
    v.spriteYExpandFF[0] = 0;
    v._spriteSequencerCycle55();
    assert(v.spriteYExpandFF[0] === 1,
      `rule 2: DMA start with MxYE=0 sets FF=1 (no MxYE gating in 2024 spec)`);
  }
  console.log('ok  - SP-7: advance line FF — Bauer §3.8.1 (2024) rules 1, 2, 3');
}

// SP-8: Sprite at regX=0 places its first pixel at canvas X=8. The vic2
// mapping is `canvas_x = reg_x + 8` (border offset). Nothing must draw
// at canvas X<8.
{
  const vic = makeVic();
  const canvasY = 46;
  fillSpriteLineState(vic);
  const off = clearLineBuffers(vic, canvasY);
  setupSpriteForRender(vic, 0, 0, { color: 2, shiftReg: 0xFFFFFF });

  vic._renderSpriteLine(61, canvasY);

  for (let x = 0; x < 8; x++) {
    assert(vic.spriteCollisionBuffer[x] === 0,
      `sprite at regX=0 does not draw left of canvas X=8 (canvas X=${x})`);
  }
  let bodyDrawn = 0;
  for (let x = 8; x < 32; x++) if (vic.spriteCollisionBuffer[x]) bodyDrawn++;
  assert(bodyDrawn > 0,
    `sprite at regX=0 draws some pixels in canvas X=8..31 (drew ${bodyDrawn})`);
  console.log('ok  - SP-8: sprite at regX=0 starts at canvas X=8 (border offset)');
}

// SP-9: Multicolor pattern 00 does NOT trigger sprite-sprite collision.
// Two overlapping sprites where ONE has only pattern 00 in the overlap
// region must NOT latch a sprite-sprite collision.
{
  const vic = makeVic();
  const canvasY = 47;
  fillSpriteLineState(vic);
  clearLineBuffers(vic, canvasY);
  setMulticolorRegs(vic, 1, 5);
  // Sprite 0 multicolor with pattern 00 in top byte (transparent).
  setupSpriteForRender(vic, 0, 50, { multicolor: true, color: 2, shiftReg: 0x00FFFF });
  // Sprite 1 hi-res overlapping the transparent strip.
  setupSpriteForRender(vic, 1, 50, { multicolor: false, color: 7, shiftReg: 0xFF0000 });

  vic._renderSpriteLine(62, canvasY);

  assert((vic.regs[0x1E] & 0x03) === 0x00,
    `multicolor 00 pixels do not collide with overlapping hi-res sprite (got $D01E=$${vic.regs[0x1E].toString(16)})`);
  console.log('ok  - SP-9: multicolor 00 pattern is exempt from sprite-sprite collisions');
}

// SP-10: Bauer §3.8.2 (2024) sprite priority inheritance. When a higher-
// priority sprite is hidden by foreground (MxDP=1), the foreground pixel
// "inherits" that sprite's priority — a lower-priority sprite (MxDP=0)
// overlapping the same pixel must NOT overwrite the foreground.
// The simple per-pixel ownership rule (highest-priority sprite at each
// pixel decides outcome) is what produces this effect on real hardware.
{
  const vic = makeVic();
  const cy = 0;   // line buffers (#1): fb32 row & side-buffer columns share index space
  const pIdx = 0;  // canvas column 0 (side buffers line-sized #1)
  const FG_COLOR = 0xDEADBEEF;
  const SPR0_COLOR = 0x11111111;
  const SPR1_COLOR = 0x22222222;

  // (a) Inheritance: sprite 0 behind fg + sprite 1 in front of fg →
  // foreground stays visible against sprite 1 too.
  vic.fb32[pIdx] = FG_COLOR;
  vic.graphicsPriorityBuffer[pIdx] = 1;             // foreground present
  vic.spriteOwnerBuffer[pIdx] = 0xFF;               // unowned
  vic._drawSpritePixel(0, cy, SPR0_COLOR, 0, 1);    // sprite 0, MxDP=1
  assert(vic.fb32[pIdx] === FG_COLOR,
    `sprite 0 (MxDP=1) hidden by foreground; fb retained fg color`);
  assert(vic.spriteOwnerBuffer[pIdx] === 0,
    `sprite 0 still claims ownership of the pixel even when hidden by fg`);

  vic._drawSpritePixel(0, cy, SPR1_COLOR, 1, 0);    // sprite 1, MxDP=0
  assert(vic.fb32[pIdx] === FG_COLOR,
    `Bauer §3.8.2: sprite 1 (MxDP=0) is masked at a pixel already owned by ` +
    `the higher-priority sprite 0 — fg "inherited" sprite 0's priority`);

  // (b) Control: with NO foreground, sprite 0 draws normally and sprite 1
  // is masked by sprite-vs-sprite priority (sprite 0 has higher priority).
  vic.fb32[pIdx + 1] = 0;
  vic.graphicsPriorityBuffer[pIdx + 1] = 0;
  vic.spriteOwnerBuffer[pIdx + 1] = 0xFF;
  vic._drawSpritePixel(1, cy, SPR0_COLOR, 0, 0);
  vic._drawSpritePixel(1, cy, SPR1_COLOR, 1, 0);
  assert(vic.fb32[pIdx + 1] === SPR0_COLOR,
    `sprite-vs-sprite: sprite 0 wins over sprite 1 (no fg); got 0x${vic.fb32[pIdx + 1].toString(16)}`);

  // (c) Control: sprite 0 in front of fg overwrites fg; sprite 1 is then
  // masked by ownership.
  vic.fb32[pIdx + 2] = FG_COLOR;
  vic.graphicsPriorityBuffer[pIdx + 2] = 1;
  vic.spriteOwnerBuffer[pIdx + 2] = 0xFF;
  vic._drawSpritePixel(2, cy, SPR0_COLOR, 0, 0);    // sprite 0, MxDP=0
  assert(vic.fb32[pIdx + 2] === SPR0_COLOR,
    `sprite 0 (MxDP=0) draws over fg; got 0x${vic.fb32[pIdx + 2].toString(16)}`);
  vic._drawSpritePixel(2, cy, SPR1_COLOR, 1, 0);
  assert(vic.fb32[pIdx + 2] === SPR0_COLOR,
    `sprite 1 still masked by sprite 0 ownership`);

  // (d) Reverse: sprite 1 owns first (e.g. sprite 0 is transparent at this
  // pixel). Then sprite 0 IS NOT able to claim later because the renderer
  // walks sprites 0..7 in order — but if it could, sprite 0 would win.
  // Here we just verify the ownership-first-claim semantics directly.
  vic.fb32[pIdx + 3] = 0;
  vic.graphicsPriorityBuffer[pIdx + 3] = 0;
  vic.spriteOwnerBuffer[pIdx + 3] = 0xFF;
  vic._drawSpritePixel(3, cy, SPR1_COLOR, 1, 0);
  assert(vic.spriteOwnerBuffer[pIdx + 3] === 1, 'sprite 1 claimed the pixel');
  vic._drawSpritePixel(3, cy, SPR0_COLOR, 0, 0);
  assert(vic.fb32[pIdx + 3] === SPR1_COLOR,
    `ownership is first-claim; later sprite (regardless of priority number) cannot overwrite`);

  console.log('ok  - SP-10: Bauer §3.8.2 sprite priority inheritance — fg overlapping a hidden sprite blocks lower-priority sprites');
}



console.log('\nAll Sprite spec coverage (Bauer §3.8) tests passed.');
