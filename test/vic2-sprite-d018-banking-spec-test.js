// Sprite $D018 mid-line banking spec test. Bauer §3.6.1 + DEMO-NINE §3:
// each sprite p-access reads $D018 LIVE at the moment of the fetch, not
// from a line-start snapshot. So a CPU write to $D018 mid-line redirects
// every subsequent p-access (across all 8 sprites) to the new bank.
//
// Sprite p-access cycles (PAL):
//   sp0=58, sp1=60, sp2=62 (current line)
//   sp3=1, sp4=3, sp5=5, sp6=7, sp7=9 (next line)
//
// All four tests run with all 8 sprites enabled (DMA on) — the demo
// (nine.prg) anchors sprites 0,2,4,6 always-on and uses 1,3,5 as
// "free riders" for stable cycle accounting, so the 8-sprite path is
// the one the demo actually walks.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

// Two pointer tables, distinct values per sprite so we can verify which
// bank each fetch came from.
//   Bank A: screen base $0400 → $D018 high nibble = $10. Pointers at
//           $07F8..$07FF = 0xA0..0xA7.
//   Bank B: screen base $0800 → $D018 high nibble = $20. Pointers at
//           $0BF8..$0BFF = 0xB0..0xB7.
const D018_A = 0x14; // screen=$0400, char=$1000 (low nibble preserved)
const D018_B = 0x24; // screen=$0800, char=$1000

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  // Plant distinct pointers per bank.
  for (let s = 0; s < 8; s++) {
    vic.ram[0x07F8 + s] = 0xA0 + s; // bank A
    vic.ram[0x0BF8 + s] = 0xB0 + s; // bank B
  }
  // Enable all 8 sprites and force DMA on so p-accesses actually fetch.
  vic.regs[0x15] = 0xFF;
  for (let s = 0; s < 8; s++) {
    vic.spriteDmaOn[s] = 1;
    vic.spritePointerFresh[s] = 0;
    vic.spritePointerValue[s] = 0;
  }
  vic.regs[0x18] = D018_A;
  return vic;
}

// Drive VIC to (raster, cycleInLine). Stops when cycleInLine === target.
// `vic.cycleInLine++` runs at the start of each clock tick, so we count
// in raw clock(1) calls.
function driveToCycle(vic, raster, cycle) {
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
}

// Snapshot the 8 sprite-pointer values currently latched in the VIC.
function ptrs(vic) {
  return Array.from(vic.spritePointerValue.slice(0, 8));
}

// ── 1: All 8 sprites with stable $D018 — every pointer comes from bank A
{
  const vic = makeVic();
  // sp0..sp2 fetch at c58/60/62 of L0; sp3..sp7 at c1/3/5/7/9 of L1.
  // Drive to L1 c10 (past sp7).
  driveToCycle(vic, 1, 10);
  const got = ptrs(vic);
  for (let s = 0; s < 8; s++) {
    expect(got[s] === 0xA0 + s,
      `sp${s} pointer with stable $D018=${D018_A.toString(16)}: got 0x${got[s].toString(16)}, want 0x${(0xA0 + s).toString(16)}`);
  }
  ok('All 8 sprites fetch from bank A with stable $D018');
}

// ── 2: $D018 flip between sp0 (c58) and sp1 (c60) — sp0 from A, sp1..sp7 from B
{
  const vic = makeVic();
  // Drive to L0 c58: about to do sp0 p-access at next phi1.
  // Actually drive to AFTER c58 fires (so cycleInLine=58 means c58 has
  // already happened in this clock(1) call).
  driveToCycle(vic, 0, 58);
  expect(vic.spritePointerValue[0] === 0xA0,
    `after c58: sp0 p-access used bank A, got 0x${vic.spritePointerValue[0].toString(16)}`);
  // CPU writes $D018 at c58 phi2 (between sp0 and sp1 p-accesses).
  // The next VIC tick (c59 phi1) sees the new value.
  vic.write(0x18, D018_B);
  // Drive past sp1 (c60), sp2 (c62), sp3 (c1 of L1), … sp7 (c9 of L1).
  driveToCycle(vic, 1, 10);
  const got = ptrs(vic);
  expect(got[0] === 0xA0, `sp0 stays bank A, got 0x${got[0].toString(16)}`);
  for (let s = 1; s < 8; s++) {
    expect(got[s] === 0xB0 + s,
      `sp${s} pointer after $D018 flip: got 0x${got[s].toString(16)}, want 0x${(0xB0 + s).toString(16)}`);
  }
  ok('$D018 flip between sp0 and sp1 redirects sp1..sp7 to bank B');
}

// ── 3: $D018 flip between sp2 (c62) and sp3 (c1 next line) — cross-line
{
  const vic = makeVic();
  driveToCycle(vic, 0, 62);
  for (let s = 0; s <= 2; s++) {
    expect(vic.spritePointerValue[s] === 0xA0 + s,
      `after c62: sp${s} p-access used bank A, got 0x${vic.spritePointerValue[s].toString(16)}`);
  }
  // Write $D018 at c62 phi2. Next VIC phi1 (c63) is not a p-access cycle;
  // sp3's p-access fires at c1 of the NEXT line, well after the write
  // has propagated. Crosses the line transition.
  vic.write(0x18, D018_B);
  driveToCycle(vic, 1, 10);
  const got = ptrs(vic);
  for (let s = 0; s <= 2; s++) {
    expect(got[s] === 0xA0 + s,
      `sp${s} stays bank A, got 0x${got[s].toString(16)}`);
  }
  for (let s = 3; s < 8; s++) {
    expect(got[s] === 0xB0 + s,
      `sp${s} after cross-line $D018 flip: got 0x${got[s].toString(16)}, want 0x${(0xB0 + s).toString(16)}`);
  }
  ok('$D018 flip between sp2 and sp3 redirects sp3..sp7 (across line boundary)');
}

// ── 4: $D018 flip between sp5 (c5) and sp6 (c7) on the SECOND p-access line
{
  const vic = makeVic();
  driveToCycle(vic, 1, 5);
  // sp0..sp5 should already have fetched from bank A.
  for (let s = 0; s <= 5; s++) {
    expect(vic.spritePointerValue[s] === 0xA0 + s,
      `after c5 of L1: sp${s} from bank A, got 0x${vic.spritePointerValue[s].toString(16)}`);
  }
  vic.write(0x18, D018_B);
  driveToCycle(vic, 1, 10);
  const got = ptrs(vic);
  for (let s = 0; s <= 5; s++) {
    expect(got[s] === 0xA0 + s, `sp${s} stays bank A, got 0x${got[s].toString(16)}`);
  }
  for (let s = 6; s < 8; s++) {
    expect(got[s] === 0xB0 + s,
      `sp${s} after late-line $D018 flip: got 0x${got[s].toString(16)}, want 0x${(0xB0 + s).toString(16)}`);
  }
  ok('$D018 flip between sp5 and sp6 redirects sp6 and sp7 only');
}

console.log(`\n${testNo} sprite $D018 banking tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
