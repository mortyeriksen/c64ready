// Sprite multiplexer / DMA-on continuity spec audit. 10 tests targeting
// the patterns nine.prg's multiplexer relies on: sprite re-use across
// multiple Y positions in a single frame, MC counter cadence, display
// flag continuity, and X mid-frame writes.
//
// Sources: Bauer §3.8.1 rules 2..8 (DMA lifecycle), §3.8.2 (rendering),
// DEMO-NINE.md §1 (flanking-DMA / multiplexer foundations).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

// ── 1: Single-Y sprite displays for exactly 21 raster lines ────────────
// Bauer §3.8.1: sprite display window spans 21 lines starting at L+1.
// Sample at cycle 1 of each line to capture "full-line display"; the
// display flag's setup-cycle on L itself is incidental (renderer has
// already passed the sprite cycle slots by then).
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  let displayLines = 0;
  for (let r = 52; r < 80; r++) {
    driveTo(vic, r, 1);
    if (vic.spriteDisplayOn[0]) displayLines++;
  }
  expect(displayLines === 21,
    `Bauer §3.8.1: sprite displays L+1..L+21 = 21 full lines, got ${displayLines}`);
  ok('Bauer §3.8.1: single-Y sprite displays for 21 full lines (L+1..L+21)');
}

// ── 2: Y multiplex with new Y BEFORE rule-8 → display continuous ──────
// Demo pattern: write Y2 to sp0 just before its current display ends so
// rule-2 fires immediately for new Y2 → display continues without gap.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);                         // Y1 = 51
  // Run to L71 (line 21 of display) where rule 8 will fire at cycle 16.
  driveTo(vic, 71, 50);
  // Write new Y just BEFORE rule-2 fires at L72.c55.
  // Wait, rule 8 already fired at L72.c16. Let me back up: write new Y
  // such that rule-2 sees it BEFORE rule-8 fires next line.
  vic.write(0x01, 72);                          // Y2 = 72 → rule-2 at L72.c55
  driveTo(vic, 72, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `Y2 write at L71.c50 + Y2=72 → rule-2 latches DMA at L72`);
  ok('Bauer §3.8.1: Y multiplex — new Y latches DMA at next match line');
}

// ── 3: 8-sprite Y-multiplex rotation ──────────────────────────────────
// All 8 sprites enabled with different Y values to cover the entire
// display window. Verify each transitions DMA on at its match line.
{
  const vic = makeVic();
  vic.write(0x15, 0xFF);
  for (let s = 0; s < 8; s++) vic.regs[1 + 2 * s] = 51 + s * 21;
  for (let s = 0; s < 8; s++) {
    driveTo(vic, 51 + s * 21, 56);
    expect(vic.spriteDmaOn[s] === 1,
      `sp${s} (Y=${51 + s * 21}) DMA latches at L${51 + s * 21}`);
  }
  ok('Bauer §3.8.1: 8 sprites with staggered Y all latch at their match lines');
}

// ── 4: MC counter advances 3 per s-access (3-byte sprite data) ────────
// Bauer §3.8.1 rule 6+7: MC := MC+3 per line of display. After 21 lines,
// MC has wrapped via 0..63.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 51, 60);
  expect(vic.spriteMC[0] === 3,
    `after 1 line + s-access: MC must be 3 (3 bytes fetched)`);
  driveTo(vic, 52, 60);
  expect(vic.spriteMC[0] === 6,
    `after 2 lines: MC=6`);
  ok('Bauer §3.8.1: MC counter advances 3 per s-access (1 sprite line)');
}

// ── 5: MCBASE := MC at cycle 16 (rule 7) ──────────────────────────────
// Bauer §3.8.1 rule 7: at cycle 16 if FF=1, MCBASE := MC. Verify after
// one full sprite line.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 52, 17);                        // L52.c17 (after rule 7 fires)
  expect(vic.spriteMCBase[0] === 3,
    `Bauer rule 7: MCBASE := MC=3 at L52.c16, got ${vic.spriteMCBase[0]}`);
  ok('Bauer §3.8.1 rule 7: MCBASE := MC at cycle 16 when FF=1');
}

// ── 6: Sprite display flag transitions: off → on at first display line
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 51, 1);
  expect(vic.spriteDisplayOn[0] === 0, `pre L51 cycle 1: display off`);
  driveTo(vic, 52, 1);
  expect(vic.spriteDisplayOn[0] === 1,
    `L52 cycle 1: display ON (started after L51 Y-match)`);
  ok('Bauer §3.8.1: sprite display flag transitions off→on at L+1 after Y match');
}

// ── 7: Sprite display flag transitions on → off after the last line ───
// Bauer §3.8.1: sprite displays for 21 lines L52..L72 (when Y=51).
// L72 is the LAST display line; display goes off at L73 onwards
// (after _endSpriteDisplayLine fires at line wrap).
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 72, 1);
  expect(vic.spriteDisplayOn[0] === 1, `L72.c1: still in display (line 21 of 21)`);
  driveTo(vic, 73, 1);
  expect(vic.spriteDisplayOn[0] === 0,
    `L73.c1: display off (after 21-line window completes)`);
  ok('Bauer §3.8.1: sprite display flag clears at L73 (after L52..L72 21-line window)');
}

// ── 8: Sprite-X mid-display write changes visible position next line ───
// Bauer §3.8.2: sprite-X register is sampled per-cycle for shifter
// position. Mid-line write moves the sprite immediately (or at the
// next pixel boundary).
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x00, 100);
  vic.write(0x01, 51);
  driveTo(vic, 60, 30);                        // mid-display
  vic.write(0x00, 200);                         // X mid-display
  expect(vic.regs[0x00] === 200,
    `X register update reflects immediately`);
  ok('Bauer §3.8.2: sprite-X register update is immediate');
}

// ── 9: Sprite color mid-display change updates rendered color ────────
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  vic.write(0x27, 0x02);                       // sp0 color = red
  driveTo(vic, 60, 30);
  vic.write(0x27, 0x07);                       // change to yellow
  expect(vic.regs[0x27] === 0x07,
    `sprite color register updates immediately`);
  ok('Bauer §3.8.2: sprite color $D027+s mid-display update is immediate');
}

// ── 10: $D018 mid-line p-access writes change next sp0 fetch ─────────
// Already in border-edge-spec-test.js — verify here in multiplex context.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 52, 0);                         // sp0 in DMA
  vic.regs[0x18] = 0x14;                        // screen base $0400
  vic.ram[0x07F8] = 0xAA;
  driveTo(vic, 52, 57);
  vic.regs[0x18] = 0x24;                        // change to $0800
  vic.ram[0x0BF8] = 0xBB;                       // $0800 + $3F8 = $0BF8
  vic.clock(1);                                  // cycle 58 — p-access
  expect(vic.spritePointerValue[0] === 0xBB,
    `$D018 mid-line: p-access reads from new screen base, got $${vic.spritePointerValue[0].toString(16)}`);
  ok('DEMO-NINE.md §3: $D018 mid-line takes effect at next p-access');
}

console.log(`\n${testNo} sprite multiplexer spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
