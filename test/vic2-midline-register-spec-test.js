// Mid-line register-write timing spec audit. 20 tests focused on the
// register write/sample order rules — Bauer §3.7.x, §3.8.x, §3.12 plus
// DEMO-NINE.md items 3-5 — where 1-cycle slips show up as the kind of
// border/text intrusion symptoms the demo still has.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';
import { CIA } from '../src/cia.js';

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

function driveTo(vic, raster) {
  for (let i = 0; i < CYCLES_PER_LINE * raster; i++) vic.clock(1);
}
function driveCycles(vic, n) {
  for (let i = 0; i < n; i++) vic.clock(1);
}

// ── 1: CSEL selects Bauer §3.9 horizontal compare values ─────────────────
// Bauer's table is the invariant: CSEL=1 selects left/right 24/344, and
// CSEL=0 selects 31/335. The hyperscreen trick below is about the exact
// write cycle, not a broad comparator-latch window.
{
  const vic = makeVic();
  vic.regs[0x16] = 0x00;
  let cmp = vic._getHorizontalBorderCompareX(vic.regs);
  expect(cmp.left === 31 && cmp.right === 335,
    `CSEL=0 compare values must be 31/335, got ${cmp.left}/${cmp.right}`);
  vic.regs[0x16] = 0x08;
  cmp = vic._getHorizontalBorderCompareX(vic.regs);
  expect(cmp.left === 24 && cmp.right === 344,
    `CSEL=1 compare values must be 24/344, got ${cmp.left}/${cmp.right}`);
  ok('Bauer §3.9: CSEL selects the horizontal border compare table');
}

// ── 4: XSCROLL change mid-line splits rendering at next cycle boundary ───
// Bauer §3.7: XSCROLL ($D016 bits 0-2) sets the horizontal pixel offset.
// A mid-line write changes the value used by the renderer at the cycle
// boundary AFTER the write. We just verify the register reflects the
// new value immediately (no latch), as XSCROLL is sampled per-cycle.
{
  const vic = makeVic();
  vic.write(0x16, 0x00);       // XSCROLL=0
  expect((vic.regs[0x16] & 0x07) === 0, `pre: XSCROLL=0`);
  vic.write(0x16, 0x05);
  expect((vic.regs[0x16] & 0x07) === 5,
    `XSCROLL must update immediately on $D016 write`);
  ok('Bauer §3.7: XSCROLL ($D016 bits 0-2) update is immediate');
}

// ── 5: $D011 ECM bit change mid-line switches idle byte address ──────────
// Bauer §3.7.5: idle byte read from $3FFF (non-ECM) or $39FF (ECM). A CPU
// write to $D011 between cycles flips the idle source mid-line. Test by
// reading idle byte before and after a write.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0xAA;
  vic.ram[0x39FF] = 0xBB;
  vic.write(0x11, 0x1B);       // ECM=0
  expect(vic._readIdleGByte(vic.regs, 0) === 0xAA, `non-ECM idle = $AA`);
  vic.write(0x11, 0x5B);       // ECM=1
  expect(vic._readIdleGByte(vic.regs, 0) === 0xBB,
    `ECM idle source switches immediately to $39FF`);
  ok('Bauer §3.7.5: $D011 ECM bit selects idle byte source on next read');
}

// ── 6: $D011 BMM bit change mid-line ─────────────────────────────────────
// Bauer §3.7: BMM ($D011 bit 5) toggles bitmap mode. The change is live
// per cycle for rendering decisions.
{
  const vic = makeVic();
  vic.write(0x11, 0x1B);       // BMM=0
  expect(((vic.regs[0x11] >> 5) & 1) === 0, `pre: BMM=0 (text mode)`);
  vic.write(0x11, 0x3B);       // BMM=1
  expect(((vic.regs[0x11] >> 5) & 1) === 1, `BMM=1 takes effect immediately on $D011 write`);
  ok('Bauer §3.7: $D011 BMM update is immediate');
}

// ── 7: DEN cleared at end of L47 leaves displayEnabled false on L48 ──────
// Bauer §3.5: displayEnabled is sampled at any cycle of L48 (raster $30).
// Clearing DEN on L47 ensures all of L48 has DEN=0 → displayEnabled stays
// false → no bad lines fire that frame.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 47);
  driveCycles(vic, CYCLES_PER_LINE - 1);    // through L47.c62
  vic.write(0x11, 0x0B);                     // DEN=0 at L47.c63
  driveCycles(vic, 1);                        // wrap to L48.c0
  driveCycles(vic, CYCLES_PER_LINE);         // run all of L48
  expect(vic.displayEnabled === false,
    `DEN cleared before L48: displayEnabled must stay false (Bauer §3.5)`);
  ok('Bauer §3.5: DEN cleared before L48 keeps displayEnabled false');
}

// ── 8: DEN set during L48 latches displayEnabled true ────────────────────
// Bauer §3.5: if DEN is set at ANY cycle during L48, displayEnabled
// latches true for the frame.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;       // DEN=0 initially
  driveTo(vic, 48);
  driveCycles(vic, 30);                       // mid-L48
  vic.write(0x11, 0x1B);                       // DEN=1 mid-L48
  driveCycles(vic, CYCLES_PER_LINE - 30);     // finish L48
  expect(vic.displayEnabled === true,
    `DEN set mid-L48: displayEnabled must latch true`);
  ok('Bauer §3.5: DEN set during any cycle of L48 latches displayEnabled');
}

// ── 9: $D015 enable + Y match: DMA latches at cycle 55 of match line ─────
// Already covered in clock-cycle-spec (test 23). This verifies that
// enabling the sprite mid-line BEFORE cycle 55 still latches DMA on this
// line if Y also matches.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveTo(vic, 51);
  driveCycles(vic, 30);                       // L51.c30
  vic.write(0x15, 0x01);                       // enable sp0 mid-line
  driveCycles(vic, 25);                        // through L51.c55
  expect(vic.spriteDmaOn[0] === 1,
    `sp0 enabled at L51.c30 + Y=51 match: DMA must latch at L51.c55`);
  ok('Bauer §3.8.1 rule 3: enabling sprite mid-line still latches DMA at cycle 55');
}

// ── 10: $D015 disable mid-display does NOT clear active DMA ──────────────
// Bauer §3.8.1: disable bit only gates the cycle 55/56 DMA-START check.
// An active DMA continues until rule 8 (MCBASE=63 at cycle 16) shuts it
// off. nine.prg multiplexer relies on this.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveTo(vic, 51);
  driveCycles(vic, 60);                       // past cycle 55, DMA on
  expect(vic.spriteDmaOn[0] === 1, `pre: sp0 DMA active`);
  vic.write(0x15, 0x00);                       // disable sp0
  driveCycles(vic, CYCLES_PER_LINE * 5);     // run several lines
  expect(vic.spriteDmaOn[0] === 1,
    `disabling sp0 mid-display must NOT clear active DMA (Bauer §3.8.1)`);
  ok('Bauer §3.8.1: $D015 disable mid-display does not interrupt active DMA');
}

// ── 11: $D017 cleared in cycle 15 with FF=0 latches sprite-crunch ────────
// Bauer §3.8.1 rule 7a: CPU clearing MxYE in cycle 15 with FF=0 latches
// _spriteCrunchPending. Already in vic2-test.js but re-verify here.
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;                       // MxYE=1 for sp0
  vic.spriteYExpandFF[0] = 0;                  // FF clear
  vic.cycleInLine = 15;
  vic.write(0x17, 0x00);                       // clear MxYE in cycle 15
  expect(vic.spriteYExpandFF[0] === 1,
    `Bauer rule 1: clearing MxYE force-sets FF`);
  expect(vic._spriteCrunchPending[0] === 1,
    `Bauer rule 7a: clearing MxYE in cycle 15 with FF=0 latches sprite-crunch`);
  ok('Bauer §3.8.1 rule 7a: clearing MxYE in cycle 15 with FF=0 latches sprite-crunch');
}

// ── 12: $D017 cleared OUTSIDE cycle 15 does NOT latch sprite-crunch ──────
// Rule 7a only fires in cycle 15. Other cycles get the FF force-set
// (rule 1) but no crunch.
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;
  vic.spriteYExpandFF[0] = 0;
  vic.cycleInLine = 30;
  vic.write(0x17, 0x00);
  expect(vic.spriteYExpandFF[0] === 1, `rule 1: FF still force-set`);
  expect(vic._spriteCrunchPending[0] === 0,
    `rule 7a does NOT fire outside cycle 15: crunch-pending stays clear`);
  ok('Bauer §3.8.1 rule 7a: cycle 15 is the only crunch-trigger window');
}

// ── 13: Sprite Y mid-line write affects next line's match check ──────────
// Bauer §3.8.1: sprite Y is sampled at cycle 55 of each line. A write
// before cycle 55 lands in time for THIS line's check; a write after
// cycle 55 affects only NEXT line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 50;                         // initial Y=50, no match at L51
  vic.displayEnabled = true;
  driveTo(vic, 51);
  driveCycles(vic, 50);                        // L51.c50, before cycle 55
  vic.write(0x01, 51);                          // Y=51 — should match THIS line
  driveCycles(vic, 6);                          // through L51.c56
  expect(vic.spriteDmaOn[0] === 1,
    `sp0 Y=51 written at L51.c50: DMA must latch at L51.c55`);
  ok('Bauer §3.8.1 rule 3: sprite Y write before cycle 55 lands in time');
}

// ── 14: Sprite Y written AFTER cycle 55 misses this line's match ─────────
// Use a Y that never matches in the warmup (Y=200, raster passes 0..51 with
// no match) so DMA stays off entering L51. Write Y=51 at L51.c57 → too late
// for cycle-55 check this line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 200;
  vic.displayEnabled = true;
  driveTo(vic, 51);
  driveCycles(vic, 57);
  expect(vic.spriteDmaOn[0] === 0, `pre: sp0 DMA off — no Y match yet`);
  vic.write(0x01, 51);
  driveCycles(vic, CYCLES_PER_LINE - 57);
  expect(vic.spriteDmaOn[0] === 0,
    `Y written after L51.c55: DMA must NOT latch this line`);
  ok('Bauer §3.8.1: sprite Y write after cycle 55 misses this line\'s match');
}

// ── 15: $D018 changes screen-RAM base for NEXT bad-line c-fetch ──────────
// Bauer §3.7.2: screen RAM base = (D018 >> 4) * $0400. Changing it mid-
// line does NOT retroactively change the c-fetched matrix already buffered
// for THIS line. Verify the register reflects new value but the rendered
// output for current line uses old data (we just test register reflection
// since rendering test would be more involved).
{
  const vic = makeVic();
  vic.write(0x18, 0x14);                       // screen base $0400
  expect(((vic.regs[0x18] >> 4) & 0x0F) === 0x01, `pre: screen base bits = 1`);
  vic.write(0x18, 0x24);                       // screen base $0800
  expect(((vic.regs[0x18] >> 4) & 0x0F) === 0x02,
    `$D018 screen-base update reflects in regs immediately`);
  ok('Bauer §3.7.2: $D018 register update is immediate');
}

// ── 16: $DD00 (CIA2) bank flip routed via noteBankChange affects VIC ─────
// Bauer §3.4: bank selected via CIA2 PA bits 0,1 (inverted). Mid-line
// bank flip should immediately change the VIC's view of memory.
{
  const vic = makeVic();
  vic.noteBankChange(0x4000);
  expect(vic.currentVicBank === 0x4000, `pre: bank 1 ($4000)`);
  vic.noteBankChange(0xC000);
  expect(vic.currentVicBank === 0xC000, `bank flipped to 3 ($C000) immediately`);
  ok('Bauer §3.4: VIC bank change via noteBankChange is immediate');
}

// ── 17: Sprite p-access reads from the CURRENT VIC bank ──────────────────
// DEMO-NINE.md §3 / Bauer §3.7.4: p-access reads (screenBase + $3F8 + s)
// via _vicReadWithBank(addr, currentVicBank). Bank flip BEFORE p-access
// must redirect the fetch.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x10;                       // VM bits = $1 → screen base $0400
  vic.spriteDmaOn[0] = 1;
  // Bank-relative address of sp0 pointer = screenBase + $3F8 = $0400 + $3F8 = $07F8.
  vic.ram[0x0000 + 0x07F8] = 0xAA;            // bank 0 ($0000) sp0 pointer
  vic.ram[0x4000 + 0x07F8] = 0xBB;            // bank 1 ($4000) sp0 pointer
  vic.noteBankChange(0x0000);
  vic._spriteSequencerPointerAccess(58);
  expect(vic.spritePointerValue[0] === 0xAA, `bank 0 p-access fetched $AA`);
  vic.noteBankChange(0x4000);
  vic._spriteSequencerPointerAccess(58);
  expect(vic.spritePointerValue[0] === 0xBB,
    `after bank flip: p-access fetches from new bank ($BB)`);
  ok('Bauer §3.7.4: sprite p-access uses live VIC bank');
}

// ── 18: $D012 mid-line write fires IRQ immediately on the current line ──
// Bauer §3.12 verbatim: "It is possible to trigger an interrupt
// immediately by writing to $d011/$d012, but the interrupt can never
// occur more than once per raster line." A mid-line write that brings
// the comparator from no-match to match fires the IRQ at that write's
// cycle, even if cycle 1 of the line has already passed.
//
// This is the OrbitUntold IRQ-chain mechanism: $D012=$f8 written at
// L248.c3 (long-path) fires the L248 IRQ at c3 so the chain doesn't
// split. The full raster-IRQ edge-trigger semantic is covered in
// test/raster-irq-edge-trigger-spec-test.js.
{
  const vic = makeVic();
  let irqFired = false;
  vic.irqHandler = (state) => { if (state) irqFired = true; };
  vic.regs[0x12] = 200;
  vic.write(0x1A, 0x01);
  driveTo(vic, 100);
  driveCycles(vic, 30);                        // mid-L100
  vic.write(0x12, 100);                         // target = current raster
  expect(irqFired === true,
    `$D012=current_raster mid-line: IRQ fires immediately`);
  ok('Bauer §3.12: $D012 mid-line LOW→HIGH fires IRQ immediately');
}

// ── 19: $D019 W1C clears only the bits written ───────────────────────────
// Bauer §3.12: $D019 IRQ status is write-1-to-clear. Writing bit N=1
// clears bit N; bit N=0 leaves it untouched.
{
  const vic = makeVic();
  vic.irqStatus = 0x07;                        // bits 0,1,2 set
  vic.write(0x19, 0x01);                       // clear only bit 0
  expect((vic.irqStatus & 0x07) === 0x06,
    `$D019 W1C: bit 0 cleared, bits 1,2 retained, got $${(vic.irqStatus & 0x07).toString(16)}`);
  vic.write(0x19, 0x06);                       // clear bits 1, 2
  expect((vic.irqStatus & 0x07) === 0x00,
    `$D019 W1C: writing bits 1,2 must clear them too`);
  ok('Bauer §3.12: $D019 is write-1-to-clear (per-bit independent)');
}

// ── 20: CIA1 ICR is read-and-clear ───────────────────────────────────────
// MOS6526 datasheet: reading $DC0D returns the IRQ status mask AND clears
// it. Differentiates from VIC $D019 (W1C).
{
  const cia = new CIA(1);
  cia.icrStatus = 0x03;                        // data bits 0, 1 set
  cia._irLatch = true;                         // IR latched → bit 7 reads set
  const v1 = cia.read(0x0D);
  expect((v1 & 0x83) === 0x83,
    `CIA $DC0D first read returns latched ICR (got $${v1.toString(16)})`);
  const v2 = cia.read(0x0D);
  expect((v2 & 0x83) === 0x00,
    `CIA $DC0D second read must be 0 (read-and-clear)`);
  ok('MOS6526: CIA ICR ($DC0D) is read-and-clear');
}

console.log(`\n${testNo} mid-line / register-timing spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
