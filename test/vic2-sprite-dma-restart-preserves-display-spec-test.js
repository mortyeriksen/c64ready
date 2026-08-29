// Sprite DMA-restart (cy 55/56 Y-match) must NOT clear the display FF.
//
// Bauer §3.8.1 rule 3 (first phases of cy 55/56): when MxE is set and the
// sprite Y matches RASTER and the DMA is still off, "the DMA is switched
// on, MCBASE is cleared, and ... the expansion flip flop is reset." Rule 3
// says NOTHING about the display flip-flop — it is owned exclusively by
// rule 4 at cy 58 (DMA on + Y match → display ON; DMA off → display OFF).
//
// This matters on the LAST line of a sprite's display run. By the VIC-II
// Addendum's replacement for rules 7+8, the cy-16 MCBASE==63 check turns
// off only the DMA, not the display — the display stays on until cy 58.
// So a sprite can be RESTARTED on that line: cy 16 turns DMA off (display
// still on), then cy 55 Y-matches again and re-arms DMA. If the CPU then
// moves $D001 (between the cy-55 phi1 check and cy 58) so the sprite no
// longer Y-matches at cy 58, rule 4 neither re-arms (no Y match) nor
// disables (DMA is on) the display — so it must REMAIN on, displaying a
// fresh row 0 (MCBASE was just cleared).
//
// This is testprogs/VICII/spriterestart (David Horrocks): the restarted
// sprite collides with a reference sprite on the restart line, and the
// test border goes green only if the collision fires. It also underlies
// nine.prg's continuously-displaying side-border masker sprites.
//
// The bug shape guarded against: _tryStartSpriteDma clearing
// spriteDisplayOn at DMA-start. That made the restart line drop the sprite
// (display 0 at cy 55, never re-armed at cy 58 once Y moved) → no collision
// → spriterestart resolves RED.

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

const Y0 = 0x40;            // sprite 0 first display line
const LAST = Y0 + 21;       // line where cy-16 MCBASE==63 turns DMA off

// ── 1: precondition — the "last display line" state ─────────────────────
// After a full 21-row run, on line LAST the cy-16 MCBASE==63 check turns
// DMA off while the display flip-flop is still on (Addendum rule 7).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;          // sprite 0 enabled
  vic.regs[0x17] = 0x00;          // no Y-expand
  vic.regs[0x01] = Y0 & 0xFF;     // sprite 0 Y
  driveTo(vic, LAST, 54);
  expect(vic.spriteDisplayOn[0] === 1,
    `LAST cy54: display still ON (disable is deferred to cy58)`);
  expect(vic.spriteDmaOn[0] === 0,
    `LAST cy54: DMA already OFF (cy16 MCBASE==63 turned it off)`);
  ok('last display line: display ON, DMA OFF at cy54 (Addendum rule 7)');
}

// ── 2: cy 55 DMA-restart preserves the display flip-flop ────────────────
// Re-arm the Y match before cy55 so rule 3 fires: DMA goes back on, MCBASE
// clears. The display flip-flop must be UNTOUCHED (still on).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.regs[0x01] = Y0 & 0xFF;
  driveTo(vic, LAST, 54);
  // CPU writes $D001 so the sprite Y-matches the current (LAST) line again,
  // visible to the cy55 phi1 DMA-start check.
  vic.regs[0x01] = LAST & 0xFF;
  driveTo(vic, LAST, 55);
  expect(vic.spriteDmaOn[0] === 1,
    `cy55: DMA re-armed by the Y-match restart (rule 3)`);
  expect(vic.spriteMCBase[0] === 0,
    `cy55: MCBASE cleared by the restart (rule 3)`);
  expect(vic.spriteDisplayOn[0] === 1,
    `cy55: display flip-flop PRESERVED — rule 3 must not clear it`);
  ok('cy55 DMA-restart re-arms DMA + clears MCBASE without clearing display');
}

// ── 3: cy 58 keeps display on after Y moves off the restart line ────────
// The CPU moves $D001 off the current line after the cy55 check. At cy58
// rule 4: DMA is on (no "DMA off → display off"), but Y no longer matches
// (no re-arm). The display flip-flop must REMAIN on (preserved), and a
// fresh row 0 is staged (MCBASE was cleared at cy55).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.regs[0x01] = Y0 & 0xFF;
  driveTo(vic, LAST, 54);
  vic.regs[0x01] = LAST & 0xFF;   // Y-match for the cy55 restart
  driveTo(vic, LAST, 55);
  vic.regs[0x01] = Y0 & 0xFF;     // …then move Y off this line before cy58
  driveTo(vic, LAST, 58);
  expect(vic.spriteDmaOn[0] === 1,
    `cy58: DMA still on (restarted at cy55)`);
  expect(vic.spriteDisplayOn[0] === 1,
    `cy58: display REMAINS on — rule 4 neither disables (DMA on) nor needs a Y match to keep it`);
  expect(vic.spriteMC[0] === 0,
    `cy58: MC := MCBASE = 0 → fresh row 0 on the restart line`);
  ok('cy58 preserves display + stages fresh row 0 after a cy55 restart with Y moved');
}

// ── 4: control — without a cy55 restart, display ends at cy58 ───────────
// Same last line, but no Y re-arm. DMA stays off through cy58 → rule 4's
// "DMA off → display off" disables the sprite. Confirms the restart in
// tests 2/3 is what keeps it alive (not a blanket "never disable").
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.regs[0x01] = Y0 & 0xFF;
  driveTo(vic, LAST, 58);
  expect(vic.spriteDmaOn[0] === 0, `control cy58: DMA stayed off (no restart)`);
  expect(vic.spriteDisplayOn[0] === 0,
    `control cy58: display turned OFF by rule 4 (DMA off → display off)`);
  ok('control: last line with no restart → display disabled at cy58');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
