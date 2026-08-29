// Sprite idle fetch / VIC internal-bus leak (VIC-Addendum.txt +
// VICE testprogs/VICII/sb_sprite_fetch).
//
// "Whatever appears on the VIC-II internal bus during the fetch cycles
//  is displayed. That is both loads and stores to the VIC-II, or $ff if
//  no access occurs."
//
// The sprite idle fetch pulls THREE distinct bytes from the three
// halfcycles of the p+s fetch pair when DMA is off:
//   byte 0 = p-cycle phi2 bus (CPU phase of p-cycle)
//   byte 1 = $3FFF ghost-byte idle access (VIC s-cycle phi1)
//   byte 2 = s-cycle phi2 bus (CPU phase of s-cycle)
//
// Architecture in this codebase:
//   • `vicInternalBus` resets to $FF at the START of every vic.clock(1)
//     iteration. Only chip-bus actors drive it.
//   • The p-cycle phi2 snapshot is taken in vic.phi2() when the just-
//     completed cycle is a sprite's p-cycle and DMA is off; stored in
//     _spritePCyclePhi2Bus[s] with _spritePCyclePhi2BusValid[s].
//   • The s-cycle idle fetch (also in phi2()) consumes that snapshot
//     for byte 0, peeks $3FFF via _vicMemRead for byte 1 (does NOT drive
//     the bus latch), and samples current vicInternalBus for byte 2.
//
// This test pins:
//   1. Default ($FF bus + $FF ghost) → all $FF.
//   2. CPU write to $D0xx at s-cycle phi2 lands in byte 2.
//   3. CPU read of $D0xx at s-cycle phi2 lands in byte 2.
//   4. VIC RAM fetch at s-cycle phi2 lands in byte 2.
//   5. With DMA on, the real fetch path runs and dominates.
//   6. Display off + DMA off: idle fetch STILL fills the buffer
//      (X>=$164 trick: display can turn on later in the line, c58).
//   7. Renderer reads do NOT drive the bus.
//   8. Bus resets to $FF at the start of each clock() — no inter-cycle
//      stickiness from many cycles ago.
//   9. Aborted write to read-only $D01E still drives bus → lands in byte 2.
//  10. phi2() integration — same-cycle CPU write feeds byte 2.
//  11. Ghost byte ($3FFF) lands in byte 1.
//  12. Pre-recorded p-cycle phi2 bus lands in byte 0.

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  return vic;
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// Per-sprite s-access cycle.
const S_CYCLE = { 0: 59, 1: 61, 2: 63, 3: 2, 4: 4, 5: 6, 6: 8, 7: 10 };

function setIdle(vic, s) {
  vic.spriteDmaOn[s] = 0;
  vic.spriteDisplayOn[s] = 1;
  vic.spritePointerFresh[s] = 0;
  vic.spriteRowData[s][0] = 0x00;
  vic.spriteRowData[s][1] = 0x00;
  vic.spriteRowData[s][2] = 0x00;
  vic.spriteShiftReg[s] = 0;
  vic.spriteRowByteMask[s] = 0;
  vic._spritePCyclePhi2Bus[s] = 0xFF;
  vic._spritePCyclePhi2BusValid[s] = 0;
}

function expectBytes(vic, s, b0, b1, b2, label) {
  expect(vic.spriteRowData[s][0] === b0, `${label}: byte0 expected $${b0.toString(16)}, got $${vic.spriteRowData[s][0].toString(16)}`);
  expect(vic.spriteRowData[s][1] === b1, `${label}: byte1 expected $${b1.toString(16)}, got $${vic.spriteRowData[s][1].toString(16)}`);
  expect(vic.spriteRowData[s][2] === b2, `${label}: byte2 expected $${b2.toString(16)}, got $${vic.spriteRowData[s][2].toString(16)}`);
  const sh = (((b0 & 0xFF) << 16) | ((b1 & 0xFF) << 8) | (b2 & 0xFF)) >>> 0;
  expect(vic.spriteShiftReg[s] === sh, `${label}: shiftReg expected $${sh.toString(16)}, got $${vic.spriteShiftReg[s].toString(16)}`);
  expect(vic.spriteRowByteMask[s] === 0x07, `${label}: rowByteMask expected 0x07, got 0x${vic.spriteRowByteMask[s].toString(16)}`);
}

// ── 1: Default ($FF bus + $FF ghost) → all $FF ───────────────────────
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0xFF;  // ghost byte
  expect(vic.vicInternalBus === 0xFF, `default vicInternalBus = $FF`);
  setIdle(vic, 0);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[0]);
  expectBytes(vic, 0, 0xFF, 0xFF, 0xFF, 'all-$FF baseline');
  ok('default bus $FF + ghost $FF → all $FF in shifter');
}

// ── 2: CPU write to $D0xx at s-cycle phi2 lands in byte 2 ─────────────
for (let s = 0; s < 8; s++) {
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x11;       // distinguishable byte-1 ghost
  setIdle(vic, s);
  // simulate "p-cycle phi2 saw $77 on bus"
  vic._spritePCyclePhi2Bus[s] = 0x77;
  vic._spritePCyclePhi2BusValid[s] = 1;
  vic.write(0x20, 0x42);        // CPU's s-cycle phi2 write
  expect(vic.vicInternalBus === 0x42, `bus = $42 after write (sprite ${s})`);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[s]);
  expectBytes(vic, s, 0x77, 0x11, 0x42, `sprite ${s} idle: p-bus $77, ghost $11, s-bus $42`);
  ok(`sprite ${s} idle fetch — byte0=p-cycle phi2 ($77), byte1=ghost ($11), byte2=s-cycle phi2 ($42)`);
}

// ── 3: CPU read of $D016 at s-cycle phi2 lands in byte 2 ──────────────
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0xAA;
  setIdle(vic, 1);
  vic.regs[0x16] = 0x08;
  const v = vic.read(0x16);
  expect(v === 0xC8, `read($D016) returns 0xC8`);
  expect(vic.vicInternalBus === 0xC8, `bus latches $C8`);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[1]);
  expectBytes(vic, 1, 0xFF, 0xAA, 0xC8, 'sprite 1: default p-bus, ghost $AA, s-bus $C8');
  ok('CPU read $D016 at s-cycle phi2 → byte2; ghost-byte $3FFF → byte1');
}

// ── 4: VIC RAM fetch at s-cycle phi2 lands in byte 2 ──────────────────
{
  const vic = makeVic();
  vic.ram[0x2345] = 0x77;
  vic.ram[0x3FFF] = 0x33;
  setIdle(vic, 5);
  vic._vicReadWithBank(0x2345, 0x0000);
  expect(vic.vicInternalBus === 0x77, `RAM fetch sets bus to $77`);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[5]);
  expectBytes(vic, 5, 0xFF, 0x33, 0x77, 'sprite 5: default p-bus, ghost $33, s-bus $77');
  ok('VIC RAM fetch at s-cycle phi2 → byte2 ($77); ghost-byte → byte1 ($33)');
}

// ── 5: DMA-on s-access still runs real fetch (no leak override) ───────
{
  const vic = makeVic();
  vic.write(0x20, 0xAA);                       // would corrupt if leak path ran
  vic.ram[0x0100] = 0x10;
  vic.ram[0x0101] = 0x20;
  vic.ram[0x0102] = 0x30;
  vic.spriteDmaOn[0] = 1;
  vic.spriteDisplayOn[0] = 1;
  vic.spritePointerFresh[0] = 1;
  vic.spriteMC[0] = 0;
  vic.spriteDataBase[0] = 0x0100;
  vic.spriteDataBank[0] = 0x0000;
  vic.spriteRowData[0].fill(0);
  vic.spriteShiftReg[0] = 0;
  vic._spriteSequencerRowAccess(59);
  expect(vic.spriteRowData[0][0] === 0x10, `DMA-on path: byte0 from RAM`);
  expect(vic.spriteRowData[0][1] === 0x20, `DMA-on path: byte1 from RAM`);
  expect(vic.spriteRowData[0][2] === 0x30, `DMA-on path: byte2 from RAM`);
  ok('DMA-on s-access still runs real fetch (no bus-leak override)');
}

// ── 6: Display off + DMA off: idle fetch STILL fills buffer ──────────
// Required for sb_sprite_fetch X>=$164: display turns on at c58 of the
// SAME line, AFTER c7-c8 fetches. The buffer must already hold the
// idle-fetch data when display fires.
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x55;
  vic.write(0x20, 0xAB);              // bus = $AB
  vic.spriteDmaOn[3] = 0;
  vic.spriteDisplayOn[3] = 0;         // display OFF — but still capture
  vic.spritePointerFresh[3] = 0;
  vic._spritePCyclePhi2Bus[3] = 0x12;
  vic._spritePCyclePhi2BusValid[3] = 1;
  vic.spriteRowData[3].fill(0);
  vic.spriteShiftReg[3] = 0;
  vic._spriteSequencerRowAccessIdle(S_CYCLE[3]);
  expectBytes(vic, 3, 0x12, 0x55, 0xAB, 'sprite 3: idle fetch fires even when display off');
  ok('Display off + DMA off: idle fetch STILL fills buffer (sb_sprite_fetch X>=$164 trick)');
}

// ── 7: Renderer reads via _vicMemRead do NOT drive the bus ────────────
{
  const vic = makeVic();
  vic.write(0x20, 0xAB);                       // bus = $AB
  expect(vic.vicInternalBus === 0xAB, `pre: bus = $AB`);
  vic.ram[0x2345] = 0x99;                       // outside CHAR-ROM shadow
  const v = vic._vicMemRead(0x2345, 0x0000);
  expect(v === 0x99, `_vicMemRead returns RAM byte`);
  expect(vic.vicInternalBus === 0xAB, `bus UNCHANGED by _vicMemRead (got $${vic.vicInternalBus.toString(16)})`);
  ok('Renderer-side _vicMemRead does not pollute the bus latch');
}

// ── 8: Bus resets at the start of each clock() — no cross-cycle leak ──
{
  const vic = makeVic();
  vic.write(0x20, 0x33);
  expect(vic.vicInternalBus === 0x33, `write set bus to $33`);
  vic.clock(1);
  expect(vic.vicInternalBus !== 0x33,
    `bus latch reset at start of cycle (no inter-cycle stickiness from $33)`);
  ok('vic.clock() resets bus latch at start of each master cycle');
}

// ── 9: Aborted write to read-only $D01E still leaks into byte 2 ──────
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x66;
  setIdle(vic, 7);
  vic.write(0x1E, 0xA5);                        // ignored register, but bus is driven
  expect(vic.vicInternalBus === 0xA5, `write to read-only $D01E sets bus latch ($A5)`);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[7]);
  expectBytes(vic, 7, 0xFF, 0x66, 0xA5, 'sprite 7: $D01E aborted write → byte2');
  ok('Write to read-only $D01E still drives bus latch → byte2');
}

// ── 10: phi2() integration — same-cycle CPU write feeds byte 2 ────────
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x22;
  // Drive to cycle 59 (sprite 0 s-access).
  let safety = 200;
  while (vic.cycleInLine !== 59 && --safety) vic.clock(1);
  expect(vic.cycleInLine === 59, `at cycle 59 (sp0 s-access)`);
  vic.spriteDmaOn[0] = 0;
  vic.spriteDisplayOn[0] = 1;
  vic.spriteRowData[0].fill(0);
  vic.spriteShiftReg[0] = 0;
  vic._spritePCyclePhi2Bus[0] = 0x44;
  vic._spritePCyclePhi2BusValid[0] = 1;
  vic.write(0x20, 0x7B);
  expect(vic.vicInternalBus === 0x7B, `bus = $7B after CPU write`);
  vic.phi2();
  expectBytes(vic, 0, 0x44, 0x22, 0x7B, 'phi2 integration: byte0=p-cycle $44, byte1=ghost $22, byte2=s-cycle $7B');
  ok('phi2() integration: same-cycle CPU $D0xx write at s-cycle phi2 lands in byte2');
}

// ── 11: Ghost byte ($3FFF) lands in byte 1 across banks ───────────────
{
  const vic = makeVic();
  // bank 0: $3FFF
  vic.ram[0x3FFF] = 0xC3;
  vic.currentVicBank = 0x0000;
  setIdle(vic, 2);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[2]);
  expect(vic.spriteRowData[2][1] === 0xC3, `bank 0: byte1 = ram[$3FFF] = $C3`);

  // bank 1: $3FFF in bank 1 = $7FFF in physical RAM
  vic.ram[0x7FFF] = 0x4A;
  vic.currentVicBank = 0x4000;
  setIdle(vic, 4);
  vic._spriteSequencerRowAccessIdle(S_CYCLE[4]);
  expect(vic.spriteRowData[4][1] === 0x4A, `bank 1: byte1 = ram[$7FFF] = $4A`);
  ok('byte1 = $3FFF in current VIC bank (ghost byte / idle access)');
}

// ── 12: Pre-recorded p-cycle phi2 bus lands in byte 0 ─────────────────
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x99;
  setIdle(vic, 6);
  vic._spritePCyclePhi2Bus[6] = 0xE7;
  vic._spritePCyclePhi2BusValid[6] = 1;
  vic.write(0x20, 0x88);                  // s-cycle phi2 write → byte 2
  vic._spriteSequencerRowAccessIdle(S_CYCLE[6]);
  expectBytes(vic, 6, 0xE7, 0x99, 0x88, 'all three halfcycles distinguished');
  // After the fetch, the p-cycle snapshot's valid flag clears so the
  // next line's idle fetch sees default $FF until a fresh p-cycle.
  expect(vic._spritePCyclePhi2BusValid[6] === 0, `p-cycle valid flag clears after consumption`);
  ok('all three halfcycles distinguished: byte0=$E7 (p phi2), byte1=$99 (ghost), byte2=$88 (s phi2)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
