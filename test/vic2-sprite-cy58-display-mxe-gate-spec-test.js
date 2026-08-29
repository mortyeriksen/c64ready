// Sprite display turn-on is gated on the MxE enable bit at cycle 58.
//
// Bauer §3.8.1: the sprite DMA-start check (cycles 55/56) and the sprite
// display turn-on (cycle 58) read register $D015 INDEPENDENTLY. They can
// therefore disagree when the CPU rewrites $D015 in the window between
// them: the DMA flip-flop is already set (so the sprite keeps fetching
// data and stealing CPU/bus cycles for all 21 of its lines), yet the
// display flip-flop never turns on because MxE was cleared by cycle 58.
//
// This is exactly what testprogs/VICII/spriteenable demonstrates on a
// real 6569:
//   • spriteenable1 (core1): INC $D015 $07->$08 at cy55. Sprites 0-2 see
//     MxE=1 at the cy55 DMA check → DMA on. By cy58 MxE=0 → they never
//     display. Only sprite 3 (enabled by the cy56 check) is shown.
//   • spriteenable4 (core4): DEC $D015 ->$07 just before cy58. Sprite 3
//     had DMA from cy55/56 but MxE=0 at cy58 → NO sprite displays.
//
// The bug shape this guards against: turning the display on at cy58 from
// (DMA on AND Y match) WITHOUT re-checking MxE — which would wrongly show
// sprites 0-2 in core1 and sprite 3 in core4. The complementary wrong fix
// (reverting the DMA when MxE clears) is also caught: this test asserts
// the DMA flip-flop STAYS ON (the sprite must keep stealing cycles).

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
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

const TARGET = 0x40;   // sprite Y and raster — well inside the display area

// ── 1: control — MxE stays set → display turns on at cy58 ──────────────
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;            // sprite 0 enabled
  vic.regs[0x01] = TARGET & 0xFF;   // sprite 0 Y matches this raster
  driveTo(vic, TARGET, 58);
  expect(vic.spriteDmaOn[0] === 1, `c58: sprite 0 DMA on (started at cy55/56)`);
  expect(vic.spriteDisplayOn[0] === 1,
    `c58: display ON when MxE still set at cy58 + Y match`);
  ok('cy58 display turns ON when MxE stays set (control)');
}

// ── 2: MxE cleared after the DMA check, before cy58 → display gated OFF ─
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = TARGET & 0xFF;
  // After the cy55/56 DMA-start checks have run, the DMA flip-flop is set.
  driveTo(vic, TARGET, 56);
  expect(vic.spriteDmaOn[0] === 1, `c56: DMA latched on by the cy55/56 check`);
  // CPU clears the enable bit in the window before the cy58 display check.
  vic.regs[0x15] = 0x00;
  driveTo(vic, TARGET, 58);
  // DMA is NOT reverted — only turned off at cycle 16 when MCBASE==63.
  // The sprite keeps fetching/stealing cycles for its full height.
  expect(vic.spriteDmaOn[0] === 1,
    `c58: DMA flip-flop STAYS on after MxE clear (sprite still steals cycles)`);
  // …but the display flip-flop never turns on: cy58 re-reads MxE=0.
  expect(vic.spriteDisplayOn[0] === 0,
    `c58: display NOT turned on — MxE cleared before the cy58 check (core1/core4)`);
  ok('cy58 display gated OFF when MxE cleared before cy58 (DMA persists)');
}

// ── 3: MxE re-enabled before cy58 → display still turns on ─────────────
// Establishes the gate reads the LIVE $D015 at cy58, not a latched copy.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = TARGET & 0xFF;
  driveTo(vic, TARGET, 56);
  vic.regs[0x15] = 0x00;            // clear …
  driveTo(vic, TARGET, 57);
  vic.regs[0x15] = 0x01;            // … then set again before cy58
  driveTo(vic, TARGET, 58);
  expect(vic.spriteDmaOn[0] === 1, `c58: DMA on`);
  expect(vic.spriteDisplayOn[0] === 1,
    `c58: display ON — gate reads live $D015 (set again) at cy58`);
  ok('cy58 display gate reads live $D015 (re-enable before cy58 shows sprite)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
