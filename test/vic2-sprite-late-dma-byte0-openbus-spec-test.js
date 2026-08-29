// Late-DMA-start open-bus first sprite byte (testprogs/VICII/spriteenable core2).
//
// The sprite-DMA-start check (Bauer §3.8.1 rule 2) runs at cy55 AND cy56. If a
// sprite is enabled so late that only the cy56 check turns DMA on (e.g. core2's
// `dec $d015` $08->$07 landing at cy55, which the cy55 check still reads as $08),
// BA goes low one cycle too late. The 3-cycle BA->AEC lead-in hasn't completed
// by the time the VIC fetches byte 0 (PHI2 of the p-access cycle), so that first
// data byte reads the floating data bus ($FF) instead of RAM. The pointer (PHI1)
// and bytes 1-2 fetch normally.
//
// Only sprite 0 can hit this: its p-access (cy58) is just 2 cycles after a cy56
// start. Sprite 1's p-access is cy60 (4 cy lead) and sprites 3-7 fetch on the
// next line — all have >=3 cycles of BA-low lead before their first byte. A
// normal cy55 start (sprite 0) likewise gets the full 3-cycle lead, so it does
// NOT float. The effect is one-shot: only the first DMA row of that sprite.

import { VIC2 } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

const BASE = 0x0c00;          // sprite-data base in plain RAM (no char-ROM overlay)
const B0 = 0x12, B1 = 0xAA, B2 = 0x55;   // distinctive row bytes; B0 != $FF

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  vic.ram[BASE] = B0; vic.ram[BASE + 1] = B1; vic.ram[BASE + 2] = B2;
  return vic;
}

// Arm sprite `s` for a fresh DMA row fetch (MC at row start, base/bank set).
function armSprite(vic, s) {
  vic.spriteDataBase[s] = BASE;
  vic.spriteDataBank[s] = 0x0000;
  vic.spriteMC[s] = 0;
  vic.spritePointerFresh[s] = 1;
  vic.spriteDmaOn[s] = 0;
  vic._spriteByte0Floats[s] = 0;
}

// ── Test 1: sprite 0, DMA starts at cy56 (late) → byte 0 = $FF ────────
{
  const vic = makeVic();
  armSprite(vic, 0);
  vic.regs[0x01] = 50; vic.regs[0x15] = 0x01;   // sprite0 Y=50, enabled
  vic.cycleInLine = 56;
  vic._tryStartSpriteDma(0, 0x01, 50, 0x00);
  expect(vic.spriteDmaOn[0] === 1, 'sprite0 DMA must turn on at cy56');
  expect(vic._spriteByte0Floats[0] === 1, 'cy56 start must flag byte0 as floating');
  vic._performSpriteRowSAccesses(0);
  const sr = vic.spriteShiftReg[0];
  expect(sr === ((0xFF << 16) | (B1 << 8) | B2),
    `late start: byte0 must be open-bus $FF (shiftReg=ff${B1.toString(16)}${B2.toString(16)}); got ${sr.toString(16)}`);
  ok('sprite 0 DMA started at cy56 → byte 0 floats to $FF, bytes 1-2 from RAM');
}

// ── Test 2: sprite 0, DMA starts at cy55 (normal) → byte 0 from RAM ───
{
  const vic = makeVic();
  armSprite(vic, 0);
  vic.regs[0x01] = 50; vic.regs[0x15] = 0x01;
  vic.cycleInLine = 55;
  vic._tryStartSpriteDma(0, 0x01, 50, 0x00);
  expect(vic.spriteDmaOn[0] === 1, 'sprite0 DMA must turn on at cy55');
  expect(vic._spriteByte0Floats[0] === 0, 'cy55 start has full BA lead → no float flag');
  vic._performSpriteRowSAccesses(0);
  const sr = vic.spriteShiftReg[0];
  expect(sr === ((B0 << 16) | (B1 << 8) | B2),
    `normal start: byte0 must be RAM $${B0.toString(16)}; got ${sr.toString(16)}`);
  ok('sprite 0 DMA started at cy55 (normal) → byte 0 from RAM, not floated');
}

// ── Test 3: sprite 1, DMA starts at cy56 → NOT floated (p-access cy60) ─
{
  const vic = makeVic();
  armSprite(vic, 1);
  vic.regs[0x03] = 50; vic.regs[0x15] = 0x02;
  vic.cycleInLine = 56;
  vic._tryStartSpriteDma(1, 0x02, 50, 0x00);
  expect(vic.spriteDmaOn[1] === 1, 'sprite1 DMA must turn on at cy56');
  expect(vic._spriteByte0Floats[1] === 0, 'sprite1 has >=3cy lead before cy60 p-access → no float');
  vic._performSpriteRowSAccesses(1);
  const sr = vic.spriteShiftReg[1];
  expect(sr === ((B0 << 16) | (B1 << 8) | B2),
    `sprite1 cy56: byte0 must be RAM $${B0.toString(16)}; got ${sr.toString(16)}`);
  ok('sprite 1 DMA started at cy56 → byte 0 NOT floated (its access has 3-cy lead)');
}

// ── Test 4: one-shot — the next row of a floated sprite fetches RAM ───
{
  const vic = makeVic();
  armSprite(vic, 0);
  vic.regs[0x01] = 50; vic.regs[0x15] = 0x01;
  vic.cycleInLine = 56;
  vic._tryStartSpriteDma(0, 0x01, 50, 0x00);
  vic._performSpriteRowSAccesses(0);                 // first row: floats
  expect(vic._spriteByte0Floats[0] === 0, 'float flag must be cleared after one consumption');
  // Simulate the next display line's row fetch (MC back to a row start).
  vic.spriteMC[0] = 0;
  vic._performSpriteRowSAccesses(0);                 // second row: RAM
  const sr = vic.spriteShiftReg[0];
  expect(sr === ((B0 << 16) | (B1 << 8) | B2),
    `second row must read RAM byte0 $${B0.toString(16)}; got ${sr.toString(16)}`);
  ok('open-bus byte 0 is one-shot — only the first DMA row floats');
}

if (testsFailing > 0) {
  console.log(`\n${testsFailing} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${testNo} tests passed`);
