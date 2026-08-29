// Sprite Y / enable mid-line write-vs-rule-2 race spec audit. 10 tests
// targeting the cycles 53..56 window where multiplexer demos write
// sprite Y and $D015 enable. The exact race between CPU writes (phi2)
// and the VIC's cycle-55 DMA-start check (phi1) determines whether a
// sprite latches DMA on this line or the next.
//
// Sources: Bauer §3.8.1 rules 2/3 (cycle 55/56 DMA-start check), the
// CPU/VIC clock-order semantics (machine.js), DEMO-NINE.md.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;
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

// ── 1: $D015 enable + Y match — both written before cycle 55 ───────────
// Both writes BEFORE the rule-2 check fire → DMA latches at cycle 55.
{
  const vic = makeVic();
  driveTo(vic, 51, 30);
  vic.write(0x15, 0x01);             // enable sp0
  vic.write(0x01, 51);               // Y match
  driveTo(vic, 51, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `enable+Y written by L51.c30: DMA latches at cycle 55`);
  ok('Bauer §3.8.1 rule 2: enable+Y written before cycle 55 → DMA latches this line');
}

// ── 2: Y written AT cycle 54 — race with cycle 55 check ────────────────
// CPU writes at phi2 of cycle 54; VIC reads at phi1 of cycle 55. The
// new Y is visible to the rule-2 check.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  driveTo(vic, 51, 54);
  vic.write(0x01, 51);               // Y written at cycle 54
  driveTo(vic, 51, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `Y written at L51.c54 must be visible to cycle-55 check, got DMA=${vic.spriteDmaOn[0]}`);
  ok('Bauer §3.8.1 rule 2: Y write at cycle 54 lands in time for cycle 55');
}

// ── 3: Y written AT cycle 56 — too late, no DMA on this line ──────────
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 200);              // Y mismatch initially
  driveTo(vic, 51, 56);
  expect(vic.spriteDmaOn[0] === 0,
    `pre L51.c56: DMA off (Y=200, no match)`);
  vic.write(0x01, 51);               // too late
  for (let i = 0; i < CYCLES_PER_LINE - 56; i++) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 0,
    `Y written at cycle 56 (after rule-2 fires): no DMA this line`);
  ok('Bauer §3.8.1 rule 2: Y written after cycle 55/56 misses this line\'s match');
}

// ── 4: Multiple sprites latching DMA on same line ─────────────────────
{
  const vic = makeVic();
  vic.write(0x15, 0xFF);             // all 8 enabled
  for (let s = 0; s < 8; s++) vic.regs[1 + 2*s] = 51;
  driveTo(vic, 51, 56);
  for (let s = 0; s < 8; s++) {
    expect(vic.spriteDmaOn[s] === 1,
      `sp${s} DMA must latch at L51.c55 (all Y=51)`);
  }
  ok('Bauer §3.8.1 rule 2: 8 sprites all latch DMA on the same Y-match line');
}

// ── 5: Y change for already-DMA-on sprite has no immediate effect ──────
// Bauer §3.8.1: rule 2 (cycle 55 DMA-start) only fires if DMA is OFF
// AND Y matches. For already-on DMA, changing Y has no effect this
// frame; DMA continues until rule 8 (MCBASE=63 at cycle 16).
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 51, 60);
  expect(vic.spriteDmaOn[0] === 1, `pre: DMA on after Y match`);
  vic.write(0x01, 100);              // change Y while DMA on
  driveTo(vic, 60);
  expect(vic.spriteDmaOn[0] === 1,
    `Y change for active DMA: must NOT interrupt active display`);
  ok('Bauer §3.8.1: Y register change does not abort active DMA');
}

// ── 6: Sprite enable bit write IS read at cycle 55 ─────────────────────
// $D015 is sampled at cycle 55 (rule 2). Late enable (after cycle 55)
// misses this line.
{
  const vic = makeVic();
  vic.write(0x01, 51);               // Y always matches
  driveTo(vic, 51, 56);
  expect(vic.spriteDmaOn[0] === 0, `pre: DMA off (sp0 disabled)`);
  vic.write(0x15, 0x01);             // enable AFTER cycle 55
  driveTo(vic, 52, 56);
  // Now we're past the NEXT cycle 55 (L52.c55) — sp0 enabled, Y=51 still
  // there but we're at L52, so Y(51) != raster(52). No match. Hmm.
  // Actually with Y=51, only line 51 matches. After missing it on L51,
  // sp0 doesn't latch until next frame.
  expect(vic.spriteDmaOn[0] === 0,
    `Y=51 + late enable: missed L51, no further match this frame`);
  ok('Bauer §3.8.1 rule 2: $D015 enable sampled at cycle 55');
}

// ── 7: Sprite ptr (screenRAM + $3F8) write mid-line — visible at next p-access
// Bauer §3.7.4: p-access at cycle 58 (sp0). Write to ptr ($07F8) before
// cycle 58 → new value used. After → next line.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 52, 0);                // L52, sp0 in DMA
  // Set screen base to $0400 ($D018 = $14 default-ish).
  vic.regs[0x18] = 0x14;
  vic.ram[0x07F8] = 0xAA;             // initial ptr
  driveTo(vic, 52, 57);
  vic.ram[0x07F8] = 0xBB;             // change ptr at cycle 57
  vic.clock(1);                        // cycle 58: p-access
  expect(vic.spritePointerValue[0] === 0xBB,
    `ptr write at cycle 57 visible to p-access at cycle 58`);
  ok('Bauer §3.7.4: sprite pointer write before cycle 58 visible to same-line p-access');
}

// ── 8: Cycle 16 DMA-off check fires on MCBASE=63 ──────────────────────
// Bauer §3.8.1 rule 8: at cycle 16, if MCBASE = 63, clear DMA flag.
// 21 lines after Y match → MCBASE wraps from 60 to 63 to 0 (counter
// rolls over).
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  // Run through 21 sprite lines. At line 72.c16, DMA shuts off.
  driveTo(vic, 72, 17);
  expect(vic.spriteDmaOn[0] === 0,
    `Bauer rule 8: DMA must clear at L72.c16 (MCBASE=63)`);
  ok('Bauer §3.8.1 rule 8: cycle-16 MCBASE check shuts off DMA after 21 lines');
}

// ── 9: $D015 disable + cycle 16 = DMA shuts off via natural rule 8 ────
// Disable bit gates rule 2 (no new DMA-start) but doesn't cancel active
// DMA. So disable + waiting for natural shutdown via rule 8 still works.
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 60, 0);                // mid-display
  vic.write(0x15, 0x00);             // disable
  driveTo(vic, 72, 17);
  expect(vic.spriteDmaOn[0] === 0,
    `disable + wait: DMA shuts off at the natural rule-8 line`);
  ok('Bauer §3.8.1: disable mid-display + wait → DMA shuts off via rule 8');
}

// ── 10: After 21 lines + DMA off, sprite can re-trigger next Y-match ───
{
  const vic = makeVic();
  vic.write(0x15, 0x01);
  vic.write(0x01, 51);
  driveTo(vic, 72, 17);
  expect(vic.spriteDmaOn[0] === 0, `pre: DMA cleared after 21 lines`);
  // Move Y to next match line.
  vic.write(0x01, 100);
  driveTo(vic, 100, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `re-trigger: new Y match at L100 latches DMA again`);
  ok('Bauer §3.8.1: sprite can re-trigger at next Y-match after rule-8 shutdown');
}

console.log(`\n${testNo} sprite mid-line race spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
