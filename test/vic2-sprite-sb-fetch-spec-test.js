// Sprite "side-border fetch" behaviours — testprogs/VICII/sb_sprite_fetch.
//
// Two spec properties (derived from Bauer §3.7.1/§3.8 + the sb_sprite_fetch
// readme, NOT from observing the implementation):
//
//  1. DMA-start preserves the shift register for an X>=$164 same-line display.
//     Bauer §3.8.1 rule 2/3: a DMA-start switches DMA on, clears MCBASE, and
//     sets the advance-line FF — it does NOT clear the sprite shift register.
//     sb_sprite_fetch exploits this: a sprite parked at rawX >= $164 turns its
//     display ON the SAME line (§3.7.1 / rule 4 @cy58) and shows the idle-fetch
//     "ghost"/bus bytes it loaded at its own p+s cycle EARLIER this line (sprites
//     3-7 fetch before the cy55/56 DMA-start). Those bytes MUST survive the
//     DMA-start — that is the "dotty" bogus line above an X=$164 sprite.
//     (For normal sprites the emulator still clears at DMA-start as a
//     bleed-avoidance shortcut — pinned separately in the nine-demo-deps test;
//     here we only assert the spec-required SURVIVAL for the same-line case.)
//
//  2. A sprite shifting on its FINAL display line emits its full width. Bauer
//     §3.8: once the shifter is active (display FF was on when the beam reached
//     the sprite's X), it shifts out all 24 px on that line; the display FF
//     dropping at cy58 does NOT truncate an in-flight sprite. So a sprite at
//     rawX < $164 whose display ends this line still renders its tail columns
//     (canvas ~376..383), which the cy58 dataRow→-1 must not clip.

import { VIC2, CANVAS_W } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`); currentFailures = []; }
}

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  vic._regOffset = 0;
  vic._deferCollisionCommit = false;
  return vic;
}

// ── 1: X>=$164 idle-fetched sprite — DMA-start PRESERVES the shift register ──
{
  const vic = makeVic();
  const s = 0;
  // Sprite 0 at rawX = $164 (X low $64 + MSB), Y = 50, enabled.
  vic.regs[0x15] = 1 << s;
  vic.regs[s * 2] = 0x64;
  vic.regs[0x10] = 1 << s;            // MSB → rawX = $164
  vic.regs[s * 2 + 1] = 50;           // Y match
  vic.raster = 50;

  // The sprite was IDLE-fetched this line (DMA off during its p+s cycle):
  // ghost bytes are already in the buffer/shifter.
  vic._spriteIdleFetchedThisLine[s] = 1;
  vic.spriteShiftReg[s] = 0xAC4D26;            // = BYTE_S0/S1/S2 ($AC,$4D,$26)
  vic.spriteRowByteMask[s] = 0x07;
  vic.spriteRowData[s][0] = 0xAC;
  vic.spriteRowData[s][1] = 0x4D;
  vic.spriteRowData[s][2] = 0x26;

  vic._tryStartSpriteDma(s, vic.regs[0x15], 50, vic.regs[0x17]);

  expect(vic.spriteDmaOn[s] === 1, 'DMA turned on');
  expect(vic.spriteMCBase[s] === 0, 'MCBASE cleared (rule 2/3)');
  expect(vic.spriteShiftReg[s] === 0xAC4D26,
    `ghost bytes survive DMA-start (got 0x${vic.spriteShiftReg[s].toString(16)})`);
  expect(vic.spriteRowByteMask[s] === 0x07, 'row-byte mask preserved');
  expect(vic.spriteRowData[s][0] === 0xAC && vic.spriteRowData[s][1] === 0x4D &&
         vic.spriteRowData[s][2] === 0x26, 'row data buffer preserved');
  ok('X>=$164 idle-fetched: DMA-start preserves the shift register (Bauer rule 2/3 → bogus line)');
}

// ── 2: X<$164 sprite emits its FULL final line (no cy58 tail clip) ──────────
{
  const vic = makeVic();
  const s = 0;
  const CANVAS_Y = 60;
  // rawX = $163 (sx = 363): the sprite's 24 px span canvas 363..386, so its
  // tail (canvas 376..383) lands in the cy58 segment.
  const SX = 363;
  // Per-cycle reg snapshot for the tail segment cycles (canvas 376..383 →
  // cycle (cx>>3)+11 = 58/59). The dataRow<0 path reads seg.regs.
  const seg = {
    regs: new Uint8Array(0x40),
    spriteDisplayOn: new Uint8Array(8),
    spriteDataRow: new Int8Array(8).fill(-1),     // display ENDED this line (cy58)
    spriteShiftReg: new Uint32Array(8),
    spriteRowByteMask: new Uint8Array(8),
    start: 376,
    end: CANVAS_W,                                 // 384 → triggers the cy58 path
  };
  seg.regs[s * 2] = 0x63;
  seg.regs[0x10] = 1 << s;                          // rawX = $163 (< $164)
  seg.regs[0x27 + s] = 0x01;                        // white
  seg.spriteShiftReg[s] = 0xFFFFFF;
  seg.spriteRowByteMask[s] = 0x07;

  // The sprite was started and rendered a valid row earlier this line; its
  // shifter is mid-flight with the tail (cols 376..386) still to emit.
  vic._spriteLineStarted[s] = 1;
  vic._spriteLineLastDataRow[s] = 20;
  vic._spriteLineRenderState[s] =
    vic._createSpriteRenderState(0xFFFFFF, 0x07, SX, 376, false, false);

  // Spy collision (called for every emitted opaque pixel, regardless of border
  // visibility) — proves the shifter continued past cy58 rather than clipping.
  const painted = [];
  vic._processSpritePixelCollision = (cx) => painted.push(cx);

  vic._renderSpriteSegmentForSprite(seg, s, CANVAS_Y);

  expect(painted.length === 8,
    `full tail emitted: cols 376..383 (got ${painted.length}: [${painted.join(',')}])`);
  expect(painted[0] === 376 && painted[painted.length - 1] === 383,
    `tail spans canvas 376..383 (got ${painted[0]}..${painted[painted.length - 1]})`);
  ok('X<$164 sprite emits its full final line — cy58 display-off does not clip the tail');
}

console.log(`\n${testNo - failing}/${testNo} passed`);
if (failing) process.exit(1);
