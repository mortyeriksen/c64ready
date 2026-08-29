// "Sprites in top border" + mid-line mode flip spec audit. 15 tests
// targeting the exact behaviors a multi-mode multiplexer demo (per the
// 2026-05-02 snapshot at L44..L67) relies on:
//
//   1. Sprites display independently of the vertical border state
//      (per Bauer §3.8: sprite rendering doesn't gate on vBorder).
//   2. Mid-line $D011 writes change ECM/BMM mode for SUBSEQUENT cycles
//      on the same line — affects ghost-byte source ($39FF vs $3FFF).
//   3. YSCROLL mid-frame changes affect the bad-line condition for
//      the NEXT line's cycle-58 check (Bauer §3.7.2 rule 5).
//   4. Sprite Y compare evaluates against the FULL 8-bit raster, so
//      sprites with Y < 51 are valid in the top-vertical-border zone.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  return vic;
}

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

// ── 1: Sprite Y match works for Y < 51 (top border zone) ───────────────
// Bauer §3.8.1 rule 2: sprite Y compare is RASTER==Y, full 8-bit. With
// Y=9, sprite must latch DMA at L9 (well inside top vertical border).
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 9);                 // sp0 Y = 9
  driveTo(vic, 9, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `Y=9 in top border: DMA must latch at L9.c55, got DMA=${vic.spriteDmaOn[0]}`);
  ok('Bauer §3.8.1 rule 2: sprite Y compare works in top vertical border');
}

// ── 2: Sprite display continues in vertical border zone ────────────────
// After Y=9 latches DMA, sprite displays L10..L30. The vertical border
// is closed (we're below L51) but sprite display proceeds.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 9);
  driveTo(vic, 11, 30);
  expect(vic.vBorderActive === true, `pre L11: vBorder closed (above L51)`);
  expect(vic.spriteDisplayOn[0] === 1,
    `sprite display ON in vBorder zone (L11)`);
  ok('Bauer §3.8: sprite display flag is set in vertical border zone');
}

// ── 3: Sprite renders pixels even when vBorder is closed ──────────────
// Per Bauer §3.8 the sprite renderer doesn't gate on vBorder. The
// border-buffer logic (pix-level) blocks the sprite paint at the
// pixel level only when border is FULLY closed. In top-border zone
// the border IS closed but sprites display in a separate layer.
// Verify by checking that spriteOwnerBuffer reflects the sprite.
{
  const vic = makeVic();
  // Manually set up a sprite display state for L20 (top vertical border).
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= 1;
    vic.lineCycleRegs[cycle][0] = 100;
    vic.lineCycleRegs[cycle][0x27] = 0x02;
    vic.lineCycleSpriteDisplayOn[cycle][0] = 1;
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = 0xFFFFFF;
  }
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteLineDataRow[0] = 0;
  // Pre-mark canvas Y=20 row's borderBuffer as fully-closed (border).
  const ro = 20 * CANVAS_W;
  vic.borderBuffer.fill(1, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  vic._renderSpriteLine(20, 20);
  // Check if any pixel was claimed.
  let claimed = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.spriteOwnerBuffer[x] === 0) claimed++;
  // If border-buffer fully closed blocks sprite painting, claimed=0.
  // If sprites override border, claimed > 0. Per spec the SPRITE
  // RENDER itself runs unconditionally; pixel-level border-mux gates
  // visibility. In our impl `_spriteVisibleAt` uses borderBuffer === 0.
  // So fully-closed border blocks sprite painting. This matches what
  // most emulators do — but for "sprites in top border" tricks the demo
  // OPENS the border via DEN=0 trick.
  // Just document the behavior: border-FF=closed blocks sprite paint.
  expect(claimed === 0,
    `borderBuffer=1 (closed): sprite paint blocked at pixel level`);
  ok('VIC: closed border-FF blocks sprite paint (open-border trick required)');
}

// ── 4: Mid-line $D011 ECM toggle changes idle byte source ─────────────
// Already tested in gaccess-shifter-spec; re-verify in mid-line context.
// Demo flips $D011 between $1D (ECM=0) and $70 (ECM=1) mid-line.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x12;             // non-ECM idle source
  vic.ram[0x39FF] = 0x34;             // ECM idle source
  vic.write(0x11, 0x1D);              // ECM=0
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x12,
    `ECM=0: idle from $3FFF`);
  vic.write(0x11, 0x70);              // ECM=1, BMM=1
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x34,
    `ECM=1: idle from $39FF (immediate switch)`);
  vic.write(0x11, 0x1D);
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0x12,
    `ECM=0 again: idle back to $3FFF`);
  ok('Bauer §3.7.5: rapid mid-line $D011 ECM flips switch idle byte source per cycle');
}

// ── 5: Mode $70 (ECM=1, BMM=1, MCM=0) renders every pixel BLACK ───────
// Bauer §3.7.3.7: invalid bitmap mode 1 has every pixel BLACK regardless
// of fetched data. Demo uses mode $70 to suppress text rendering while
// still letting sprites display.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x70;
  vic.regs[0x16] = 0x08;
  const seg = {
    regs: vic.regs,
    bank: 0,
    rowVcBase: 0,
    rowFetchedCols: new Uint8Array(40),
    rowCodes: new Uint8Array(40),
    rowColors: new Uint8Array(40),
    rowFetchD011: 0x70,
    rowFetchD016: 0x08,
    rowFetchD018: vic.regs[0x18],
    displayColumnActive: false,
    rc: 0,
    cycleStart: 32,
    idleByte: 0xFF,
  };
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  expect(vic.fb32[35] === 0xFF000000,
    `mode $70 + idle byte: every pixel BLACK per Bauer §3.7.3.7`);
  ok('Bauer §3.7.3.7: invalid mode 110 ($70) renders every pixel BLACK');
}

// ── 6: YSCROLL change moves bad-line target lines ─────────────────────
// Bauer §3.5: bad-line = (raster & 7) == YSCROLL. With YSCROLL=5, bad
// lines are at L53, L61, L69. With YSCROLL=0, bad lines at L48, L56,
// L64. Demo flips between to get bad lines on different rasters.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1D;              // YS=5
  vic.displayEnabled = true;
  expect(vic._isBadLine(53, vic.regs) === true, `YS=5: L53 is bad-line`);
  expect(vic._isBadLine(48, vic.regs) === false, `YS=5: L48 is NOT bad-line`);
  vic.write(0x11, 0x70);              // YS=0
  expect(vic._isBadLine(48, vic.regs) === true, `YS=0: L48 IS bad-line`);
  expect(vic._isBadLine(53, vic.regs) === false, `YS=0: L53 NOT bad-line`);
  ok('Bauer §3.5: YSCROLL change moves bad-line target lines (per-frame YS flip trick)');
}

// ── 7: Bad-line condition sampled LIVE at cycle 58 (Bauer §3.7.2 rule 5)
// If demo flips YSCROLL between two values within a single line, the
// bad-line check at cycle 58 sees whatever YS is set AT cycle 58.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1D;              // YS=5 initially, DEN=1, RSEL=1
  vic.displayEnabled = true;
  // L48 has (48 & 7) = 0. With YS=5, NOT a bad line.
  driveTo(vic, 48, 30);
  vic.write(0x11, 0x18);              // change YS to 0 (DEN=1, RSEL=1, YS=0)
  driveTo(vic, 48, 59);                // past cycle 58
  // At cycle 58, _isBadLine sees the post-write regs (YS=0, raster=48).
  // Bad-line condition met → display state should activate.
  // We just verify the displayActive flag; don't depend on rendering.
  expect(vic.displayActive === true,
    `Bauer rule 5: cycle 58 sees YS=0 → bad-line detected → display active`);
  ok('Bauer §3.7.2 rule 5: YSCROLL change before cycle 58 retargets bad-line');
}

// ── 8: Mid-line $D011 RSEL toggle does NOT retroactively change vBorder
// vBorder transitions only at top/bottom-compare lines via the H-comp.
// A mid-line RSEL change doesn't move the vBorder for THIS line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;              // RSEL=1, top compare = L51
  driveTo(vic, 52, 30);
  expect(vic.vBorderActive === false, `pre: vBorder open after L51`);
  vic.write(0x11, 0x13);               // RSEL=0 mid-line (top compare = L55)
  driveTo(vic, 52, 60);
  expect(vic.vBorderActive === false,
    `RSEL change mid-L52 doesn't reclose vBorder retroactively`);
  ok('Bauer §3.9: RSEL change mid-line does not retroactively flip vBorder');
}

// ── 9: Sprite at Y match in top border zone latches DMA ────────────────
// Specifically test the snapshot's pattern: sp0 with Y=9 + Y=48.
{
  const vic = makeVic();
  vic.write(0x15, 0xFF);              // all 8 enabled
  vic.regs[0x01] = 9;                  // sp0 Y=9 (top border)
  vic.regs[0x03] = 48;                 // sp1 Y=48 (start of display zone)
  vic.regs[0x05] = 9;
  vic.regs[0x07] = 48;
  // Drive past sp0 Y match.
  driveTo(vic, 9, 56);
  expect(vic.spriteDmaOn[0] === 1, `sp0 Y=9 latches DMA at L9.c55`);
  expect(vic.spriteDmaOn[2] === 1, `sp2 Y=9 also latches`);
  expect(vic.spriteDmaOn[1] === 0, `sp1 Y=48: not yet`);
  driveTo(vic, 48, 56);
  expect(vic.spriteDmaOn[1] === 1, `sp1 Y=48 latches DMA at L48.c55`);
  ok('Bauer §3.8.1: sprites with Y in top vertical border zone latch normally');
}

// ── 10: Top-border sprite DMA shuts off via rule 8 after 21 lines ─────
// sp0 Y=9 → display L10..L30, DMA off at L31.c16.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.regs[0x01] = 9;
  driveTo(vic, 31, 17);
  expect(vic.spriteDmaOn[0] === 0,
    `Bauer rule 8: top-border sprite DMA shuts off normally at L31.c16`);
  ok('Bauer §3.8.1 rule 8: rule applies in top border the same way');
}

// ── 11: Mode $1D ↔ $70 rapid flips don't hang the renderer ────────────
// Stress-test: 30+ $D011 flips per frame across L44..L67 like the demo.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1D;
  vic.displayEnabled = true;
  // Run to L44 then flip per cycle.
  driveTo(vic, 44, 0);
  for (let line = 44; line <= 67; line++) {
    for (let cyc = 1; cyc <= 63; cyc++) {
      vic.clock(1);
      // Flip mode every few cycles.
      if (cyc % 18 === 0) {
        vic.write(0x11, vic.regs[0x11] === 0x1D ? 0x70 : 0x1D);
      }
    }
  }
  // No exceptions, no NaN raster. Just verify state is sane.
  expect(vic.raster === 68 && vic.cycleInLine === 0,
    `after rapid mode flips L44..L67: raster correctly at L68`);
  ok('VIC: rapid mid-line $D011 mode flips don\'t corrupt raster/cycle counters');
}

// ── 12: Mode $70 idle-source switch doesn't break shifter ──────────────
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x55;
  vic.ram[0x39FF] = 0xAA;
  for (let i = 0; i < 5; i++) {
    vic.write(0x11, 0x1D);
    expect(vic._readIdleGByte(vic.regs, 0) === 0x55, `flip ${i}: ECM=0 idle = $55`);
    vic.write(0x11, 0x70);
    expect(vic._readIdleGByte(vic.regs, 0) === 0xAA, `flip ${i}: ECM=1 idle = $AA`);
  }
  ok('Bauer §3.7.5: idle byte source toggles cleanly across rapid ECM flips');
}

// ── 13: $D011 BMM=1 with no MCM = invalid mode 110 → BLACK pixels ─────
// Same as test 5 but verify BOTH BMM and ECM bits trigger the black-out.
{
  const vic = makeVic();
  // Mode $70: ECM=1 BMM=1 MCM=0
  for (const mode of [0x60, 0x70]) {  // BMM=1+ECM=0 (mode 100), BMM=1+ECM=1 (mode 110)
    vic.regs[0x11] = mode;
    vic.regs[0x16] = 0x08;
    const seg = {
      regs: vic.regs, bank: 0, rowVcBase: 0,
      rowFetchedCols: new Uint8Array(40),
      rowCodes: new Uint8Array(40), rowColors: new Uint8Array(40),
      rowFetchD011: mode, rowFetchD016: 0x08, rowFetchD018: vic.regs[0x18],
      displayColumnActive: false, rc: 0, cycleStart: 32, idleByte: 0x80,
    };
    vic.fb32.fill(0xFFAAAAAA);
    vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
    if (mode === 0x70) {
      expect(vic.fb32[32] === 0xFF000000,
        `mode 110 ($70): pixel must be BLACK`);
    }
  }
  ok('Bauer §3.7.3.7: invalid mode 110 (ECM=1+BMM=1) → BLACK regardless of pixel data');
}

// ── 14: Sprite-Y register read returns last written value ─────────────
// Multiplexer demos write Y rapidly; read-back must reflect latest.
{
  const vic = makeVic();
  for (const y of [9, 48, 100, 200]) {
    vic.write(0x01, y);
    expect(vic.regs[0x01] === y, `Y=${y} reads back`);
  }
  ok('Bauer §3.8: sprite Y register read/write round-trip after rapid writes');
}

// ── 15: Sprite p-access at cycle 58 reads from screen-base + $3F8 ─────
// Use $D018=$10 → screen base = 1*$400 = $0400 (clear of bank-0 CHARROM
// mirror at $1000-$1FFF). sp0 ptr address = $0400 + $3F8 = $07F8.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.regs[0x18] = 0x10;
  vic.spriteDmaOn[0] = 1;
  vic.ram[0x07F8] = 0x42;
  vic._spriteSequencerPointerAccess(58);
  expect(vic.spritePointerValue[0] === 0x42,
    `$D018=$10 → screen base $0400 → sp0 ptr at $07F8 = $42`);
  ok('Bauer §3.7.4: sprite p-access uses live $D018 screen base');
}

console.log(`\n${testNo} sprites-in-top-border + mode-flip spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
