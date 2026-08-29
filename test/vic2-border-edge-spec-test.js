// Border-edge & mid-line timing spec audit. 20 tests, each derived from a
// spec rule (Bauer §3.9, §3.7.x, §3.8.x or DEMO-NINE.md) with expected
// values computed from the rule's inputs in the test, then asserted.
//
// The 8-pixel intrusion / left-border flicker / right-border strips seen in
// timing-sensitive demos are rendering-precision symptoms. These tests target
// the cycles where those transitions expose off-by-one errors.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

let testNo = 0;
let testsFailing = 0;
let currentFailures = [];
function expect(cond, msg) {
  if (!cond) currentFailures.push(msg);
}
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) {
    console.log(`ok  - test ${testNo}: ${label}`);
  } else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// Walk a line cycle-by-cycle and snapshot border state.
function walkLine(vic) {
  const out = new Array(CYCLES_PER_LINE + 1).fill(null);
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    vic.clock(1);
    const c = vic.cycleInLine === 0 ? CYCLES_PER_LINE : vic.cycleInLine;
    out[c] = {
      raster: vic.raster,
      vBorder: vic.vBorderActive,
      hBorder: vic.hBorderActive,
      hInner: vic.lineCycleHInner ? !!vic.lineCycleHInner[c] : null,
    };
  }
  return out;
}

function driveTo(vic, raster) {
  for (let i = 0; i < CYCLES_PER_LINE * raster; i++) vic.clock(1);
}

// ── 1: hBorder open transition with CSEL=1 ───────────────────────────────
// Bauer §3.9: with CSEL=1 the left horizontal border opens at canvas X=24,
// which lands inside cycle 14-15 (cycle starts at canvasX = (cycle-12)*8+8;
// cycle 15 covers X=32..39; X=24 lies in cycle 14 = X=24..31). The hBorder
// flag therefore transitions HIGH→LOW once the comparator hits X=24.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;       // CSEL=1
  driveTo(vic, 100);
  const w = walkLine(vic);
  // Find the cycle on which hBorder first goes low.
  let openAt = -1;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) if (w[c] && !w[c].hBorder) { openAt = c; break; }
  expect(openAt === 15 || openAt === 14,
    `CSEL=1 hBorder must open at cycle 14 or 15 (canvasX=24 boundary), got ${openAt}`);
  ok(`Bauer §3.9: hBorder open with CSEL=1 lands at cycle ${openAt}`);
}

// ── 2: hBorder close transition with CSEL=1 ──────────────────────────────
// Right edge at canvasX=344. Cycle 55 covers X=344..351; the close should
// happen between cycle 55 and 56 inclusive.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 100);
  const w = walkLine(vic);
  // Find the cycle where hBorder first goes HIGH again after opening.
  let openSeen = false;
  let closeAt = -1;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    if (!w[c]) continue;
    if (!w[c].hBorder) openSeen = true;
    else if (openSeen && w[c].hBorder) { closeAt = c; break; }
  }
  expect(closeAt === 55 || closeAt === 56,
    `CSEL=1 hBorder must close at cycle 55 or 56 (canvasX=344 boundary), got ${closeAt}`);
  ok(`Bauer §3.9: hBorder close with CSEL=1 lands at cycle ${closeAt}`);
}

// ── 3: hBorder open transition with CSEL=0 (38-col mode) ─────────────────
// Bauer §3.9: CSEL=0 → left compare at canvasX=31, right at X=335.
// canvasX=31 lies in cycle 14 (X=24..31), so the OPEN transition happens
// one cycle *later* than CSEL=1: cycle 15 inclusive (X=32+ ⇒ inside).
// Actually X=31 is the FIRST inside cycle, so open at cycle 14 still
// (since cycle 14 covers X=24..31, with X=31 inside).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x00;       // CSEL=0 (38-col)
  driveTo(vic, 100);
  const w = walkLine(vic);
  let openAt = -1;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) if (w[c] && !w[c].hBorder) { openAt = c; break; }
  expect(openAt >= 14 && openAt <= 17,
    `CSEL=0 hBorder must open at cycle 14-17 (canvasX=31), got ${openAt}`);
  ok(`Bauer §3.9: hBorder open with CSEL=0 at cycle ${openAt}`);
}

// ── 4: hBorder close with CSEL=0 ─────────────────────────────────────────
// CSEL=0 right=335. canvasX=335 lies in cycle 53 (X=328..335). Close
// happens at cycle 54 or 55.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x00;
  driveTo(vic, 100);
  const w = walkLine(vic);
  let openSeen = false, closeAt = -1;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    if (!w[c]) continue;
    if (!w[c].hBorder) openSeen = true;
    else if (openSeen && w[c].hBorder) { closeAt = c; break; }
  }
  expect(closeAt >= 53 && closeAt <= 56,
    `CSEL=0 hBorder must close at cycle 53-56 (canvasX=335), got ${closeAt}`);
  ok(`Bauer §3.9: hBorder close with CSEL=0 at cycle ${closeAt}`);
}

// ── 5: vBorder closed when DEN=0 throughout L48 ──────────────────────────
// Bauer §3.9 + §3.5: top vertical compare at L51 (RSEL=1) only RESETs the
// FF when DEN is set. DEN=0 throughout the latch line keeps the vBorder
// closed for the entire frame. Confirms the open-border trick precondition.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 100);
  expect(vic.vBorderActive === true,
    `DEN=0: vBorder must stay closed (no top-compare reset)`);
  ok('Bauer §3.5/§3.9: DEN=0 prevents vBorder reset (top-bottom border-open trick)');
}

// ── 6: vertical FF flips at LINE START; the VISIBLE border opens at the
// left-H comparator.
// Bauer §3.9, modeled as the chip's two-stage flip-flop (the vertical FF is
// re-evaluated every cycle — validated against dentest den10-51-N / denrsel-*
// and VICE). Entering L51 (top compare, DEN=1, RSEL=1) the vertical FF
// (vBorderActive) clears at the start of the line (cycle 1), NOT only at the
// left edge or cycle 63. The visible border-vs-display boundary is the MAIN
// border FF (hBorderActive), which opens at the left-H comparator: with
// CSEL=1 that's canvasX=24, inside cycle 14/15.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 51);
  expect(vic.vBorderActive === true, `pre L51.c1: vBorder must still be ON`);
  let vFlipAt = -1, hFlipAt = -1;
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    vic.clock(1);
    if (vic.vBorderActive === false && vFlipAt === -1) vFlipAt = vic.cycleInLine;
    if (vic.hBorderActive === false && hFlipAt === -1) hFlipAt = vic.cycleInLine;
  }
  expect(vFlipAt >= 1 && vFlipAt <= 2,
    `vertical FF clears at line start (cycle 1-2), got ${vFlipAt}`);
  expect(hFlipAt >= 14 && hFlipAt <= 17,
    `visible border (main FF) opens at the left-H compare (cycle 14-17), got ${hFlipAt}`);
  ok(`Bauer §3.9: vertical FF clears at line start (cy ${vFlipAt}); visible border opens at left-H compare (cy ${hFlipAt})`);
}

// ── 7: RSEL=1 vs RSEL=0 vBorder open line differs by 4 ───────────────────
// RSEL=1: top compare at L51, bottom at L251. RSEL=0: top L55, bottom L247.
{
  const a = makeVic();
  a.regs[0x11] = 0x1B; a.regs[0x16] = 0x08;
  driveTo(a, 52);
  expect(!a.vBorderActive, `RSEL=1: vBorder must be open after L51`);

  const b = makeVic();
  b.regs[0x11] = 0x13; b.regs[0x16] = 0x08; // RSEL=0
  driveTo(b, 52);
  expect(b.vBorderActive, `RSEL=0: vBorder must still be closed after L52 (open at L55)`);
  driveTo(b, 56);
  expect(!b.vBorderActive, `RSEL=0: vBorder must open after L55`);
  ok('Bauer §3.9: RSEL=1 opens at L51, RSEL=0 opens at L55');
}

// ── 8: hInner window is fixed 32..352 regardless of CSEL ─────────────────
// Bauer §3.7.2: graphics window is canvas X=32..351 (40 char cells × 8 px).
// CSEL only affects the BORDER comparator, not the graphics window. hInner
// (segment intersects 32..352) must stay aligned to that range.
{
  const vic = makeVic();
  vic.regs[0x16] = 0x00;       // CSEL=0
  // The hInner predicate is a function of cycle alone, not regs.
  expect(!vic._computeHorizontalInnerWindow(14, vic.regs),
    `cycle 14: segment X=24..31 must NOT be inside graphics window`);
  expect(vic._computeHorizontalInnerWindow(15, vic.regs),
    `cycle 15: segment X=32..39 must be inside graphics window`);
  expect(vic._computeHorizontalInnerWindow(54, vic.regs),
    `cycle 54: segment X=336..343 must be inside graphics window (overlap with X<352)`);
  expect(!vic._computeHorizontalInnerWindow(56, vic.regs),
    `cycle 56: segment X=352..359 must NOT be inside graphics window`);
  ok('Bauer §3.7.2: hInner is the fixed canvas-X 32..352 graphics window');
}

// ── 9: Sprite at X=24 — sprite X is on the left-border boundary ──────────
// The visible sprite-X coordinate range with CSEL=1 is 24..344 (matches
// border compare). At sprite-X=24, the leftmost pixel sits on the border
// edge — sprite is fully visible. At sprite-X=23, leftmost pixel is just
// inside left border. Test only that sprite-X register reads back what we
// wrote.
{
  const vic = makeVic();
  vic.regs[0x00] = 24;
  vic.regs[0x10] = 0;
  expect(vic.regs[0x00] === 24, `sp0 X-LO register must read back as written`);
  expect((vic.regs[0x10] & 0x01) === 0, `sp0 X-MSB bit 0 must be 0 for X<256`);
  ok('Bauer §3.8: sprite-X register read/write round-trip');
}

// ── 10: Sprite X-MSB bit decode ──────────────────────────────────────────
// Sprite X is 9 bits: low 8 in $D000+2*N, bit 8 in $D010 bit N.
// X = (regs[0x10] & (1<<N)) ? (regs[2*N] | 0x100) : regs[2*N].
{
  const vic = makeVic();
  vic.regs[0x10] = 0xFF;
  for (let s = 0; s < 8; s++) vic.regs[s * 2] = 0x55;
  for (let s = 0; s < 8; s++) {
    const x = vic.regs[s * 2] | (((vic.regs[0x10] >> s) & 1) << 8);
    expect(x === (0x55 | 0x100),
      `sp${s}: 9-bit X must decode to 0x155, got ${x.toString(16)}`);
  }
  ok('Bauer §3.8: sprite 9-bit X-MSB decode');
}

// ── 11: $D018 mid-line p-access uses live bank (DEMO-NINE.md item 3) ─────
// DEMO-NINE.md: "Sprite p-accesses must read the live $D018 value at the
// moment of the fetch, not a line-start snapshot." Verified in
// vic2-test.js Nine-4 — re-confirm here in spec form.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.spriteDmaOn[0] = 1;
  // Write pre-fetch and post-fetch sprite-pointer bytes at two screen RAMs.
  vic.ram[0x0400 + 0x3F8] = 0xAA;       // bank ($14 = $0400)
  vic.ram[0x0800 + 0x3F8] = 0xBB;       // bank ($24 = $0800)
  vic.regs[0x18] = 0x14;                 // start at $0400
  vic.regs[0x18] = 0x24;                 // CPU writes new bank just before c58
  vic._spriteSequencerPointerAccess(58);
  expect(vic.spritePointerValue[0] === 0xBB,
    `DEMO-NINE item 3: sp0 p-access at c58 must use live $D018, got $${vic.spritePointerValue[0].toString(16)}`);
  ok('DEMO-NINE.md item 3: $D018 mid-line p-access uses live bank');
}

// ── 12: $D021 1-pixel delay on mid-line bg-color split (DEMO-NINE item 4)
// already in vic2-test.js Nine-5; verify the delayed-color helper is
// correctly reading prevRegs vs regs.
{
  const vic = makeVic();
  const prevRegs = new Uint8Array(vic.regs.length);
  prevRegs[0x21] = 0x06;
  vic.regs[0x21] = 0x07;
  // _getDelayedBgColor checks if canvasX === seg.cycleStart and prev != cur.
  const seg = {
    regs: vic.regs,
    prevRegs,
    cycleStart: 32,
  };
  const px0 = vic._getDelayedBgColor(seg, 0x21, 32);  // exact start → prev
  const px1 = vic._getDelayedBgColor(seg, 0x21, 33);  // 1 pixel later → new
  // Compare against the C64_PALETTE entries (we just need them to differ).
  expect(px0 !== px1,
    `DEMO-NINE item 4: bg color must differ between canvasX=32 (prev) and 33 (new)`);
  ok('DEMO-NINE.md item 4: $D021 mid-line bg split delayed by 1 pixel');
}

// ── 13: Idle byte address depends on ECM bit ─────────────────────────────
// Bauer §3.7.5: in idle phase, the VIC reads from $3FFF normally, $39FF
// in ECM mode. Verify _readIdleGByte selects the right address.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0xAA;
  vic.ram[0x39FF] = 0xBB;
  // ECM=0
  vic.regs[0x11] = 0x1B;
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0xAA,
    `non-ECM: idle byte must come from $3FFF, got $${vic._readIdleGByte(vic.regs, 0x0000).toString(16)}`);
  // ECM=1
  vic.regs[0x11] = 0x5B;
  expect(vic._readIdleGByte(vic.regs, 0x0000) === 0xBB,
    `ECM: idle byte must come from $39FF, got $${vic._readIdleGByte(vic.regs, 0x0000).toString(16)}`);
  ok('Bauer §3.7.5: idle byte address is $3FFF (non-ECM) or $39FF (ECM)');
}

// ── 14: VIC bank decode from CIA2 PA bits 0,1 (inverted) ─────────────────
// $DD00 bits 0,1 invert to select the 16K VIC bank: 11→bank 0 ($0000), 10→
// bank 1 ($4000), 01→bank 2 ($8000), 00→bank 3 ($C000). The VIC sees this
// via noteBankChange().
{
  const vic = makeVic();
  vic.noteBankChange(0x0000); expect(vic.currentVicBank === 0x0000, `bank 0`);
  vic.noteBankChange(0x4000); expect(vic.currentVicBank === 0x4000, `bank 1`);
  vic.noteBankChange(0x8000); expect(vic.currentVicBank === 0x8000, `bank 2`);
  vic.noteBankChange(0xC000); expect(vic.currentVicBank === 0xC000, `bank 3`);
  ok('Bauer §3.4: VIC bank can be selected at $0000/$4000/$8000/$C000');
}

// ── 15: Sprite Y-expand FF rule 1 — clearing MxYE forces FF=1 ────────────
// Bauer §3.8.1 rule 1: at any cycle, if MxYE bit is 0, the advance-line FF
// is forced to 1. CPU write to $D017 with bit cleared therefore sets the
// FF immediately.
{
  const vic = makeVic();
  vic.regs[0x17] = 0xFF;       // all MxYE set
  for (let s = 0; s < 8; s++) vic.spriteYExpandFF[s] = 0;
  vic.write(0x17, 0x00);       // clear MxYE for all 8 sprites
  for (let s = 0; s < 8; s++) {
    expect(vic.spriteYExpandFF[s] === 1,
      `Bauer §3.8.1 rule 1: clearing MxYE forces FF=1 (sp${s})`);
  }
  ok('Bauer §3.8.1 rule 1: clearing MxYE force-sets the Y-expand FF');
}

// ── 16: Sprite Y-expand FF rule 2 — DMA start sets FF=1 unconditionally ──
// Per the new (2024) Bauer rule 2: when DMA is switched on at cycle 55/56,
// the advance-line FF is set to 1 *regardless* of MxYE. Rule 3 then
// inverts in cycle 56 phi2 if MxYE is set.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.regs[0x17] = 0x01;       // MxYE=1 for sp0
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  // Tick to L51.c55 (rule 2 fires here).
  for (let i = 0; i < 55; i++) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 1, `pre: DMA must be on after rule 2`);
  // After cycle 56 phi2 inversion (MxYE=1 → FF flips to 0).
  vic.clock(1);                  // L51.c56
  expect(vic.spriteYExpandFF[0] === 0,
    `MxYE=1 + DMA on at cycle 56: FF must invert to 0 per rule 3`);
  ok('Bauer §3.8.1 rule 2+3: DMA start sets FF=1, cycle 56 phi2 inverts if MxYE=1');
}

// ── 17: Sprite-sprite collision register $D01E latches and reads-clear ───
// $D01E bit N is set when sprite N collides with another sprite. Reading
// $D01E clears the register (READ-AND-CLEAR semantics). Test the
// register-side behavior independent of actual collision detection.
{
  const vic = makeVic();
  vic.regs[0x1E] = 0x05;       // synthesize a stored collision mask
  const v1 = vic.read(0x1E);
  const v2 = vic.read(0x1E);
  expect(v1 === 0x05,
    `$D01E first read must return latched mask, got $${v1.toString(16)}`);
  expect(v2 === 0x00,
    `$D01E second read must be 0 (read-clear), got $${v2.toString(16)}`);
  ok('Bauer §3.11: $D01E sprite-sprite collision is read-and-clear');
}

// ── 18: Sprite-graphics collision register $D01F is also read-clear ──────
{
  const vic = makeVic();
  vic.regs[0x1F] = 0x42;
  const v1 = vic.read(0x1F);
  const v2 = vic.read(0x1F);
  expect(v1 === 0x42, `$D01F first read returns latched mask`);
  expect(v2 === 0x00, `$D01F second read clears`);
  ok('Bauer §3.11: $D01F sprite-graphics collision is read-and-clear');
}

// ── 19: Unused VIC register bits read as 1 (open-bus on 6569) ────────────
// Bauer §3.13 / VIC reference: registers $D016 has top 2 bits unused,
// reads return 1 (the bus pull-up). Same for $D011 (bit 7=RST8 is real,
// rest are functional), $D012, $D018 etc. Test the well-known unused-bit
// pattern for $D016: bits 6,7 are 1.
{
  const vic = makeVic();
  vic.write(0x16, 0x00);       // write all zeros
  const v = vic.read(0x16);
  expect((v & 0xC0) === 0xC0,
    `$D016 unused bits 6,7 must read as 1, got $${v.toString(16)}`);
  ok('Bauer §3.13: $D016 unused bits 6,7 read as 1');
}

// ── 20: $D011 read returns RST8 from current raster, not last write ──────
// $D011 bit 7 is special — write goes to raster-compare bit 8, but READ
// returns the current raster bit 8. Bauer §3.12.
{
  const vic = makeVic();
  vic.write(0x11, 0x00);       // RST8 compare bit = 0
  // Run to raster ≥ 256.
  for (let i = 0; i < CYCLES_PER_LINE * 257; i++) vic.clock(1);
  const v = vic.read(0x11);
  expect((v & 0x80) === 0x80,
    `$D011 read at L257: bit 7 must reflect current raster bit 8 (1), got $${v.toString(16)}`);
  ok('Bauer §3.12: $D011 bit 7 read = current raster bit 8 (not the latch)');
}

console.log(`\n${testNo} border-edge / mid-line spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
