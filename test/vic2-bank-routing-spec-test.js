// VIC-II: Bank-switch and screen-RAM routing
// Extracted from vic2-test.js.

import {
  VIC2,
  CANVAS_W,
  CANVAS_H,
  CYCLES_PER_FRAME,
  CYCLES_PER_LINE,
  C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE,
  ACCESS_REFRESH,
  ACCESS_C,
  ACCESS_G,
  assert,
  softAssert,
  makeVic,
  makeRenderSeg,
  fillSpriteLineState,
  fillOpaqueSpriteAcrossLine,
  clearLineBuffers,
  setupSpriteForRender,
  setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow,
  firstForegroundX,
  lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
} from './_vic2-helpers.js';

// ============================================================================
// Bank-switch and screen-RAM routing.
// Sprite pointers are fetched from `currentVicBank + ((D018 >> 4) & 0xF) * 0x400 + 0x3F8 + s`.
// Demos that do per-line sprite multiplexing rewrite that pointer area; if the
// VIC reads from a stale bank or stale D018, every sprite renders with the
// wrong shape. These tests pin the live-read behavior on each axis.
// ============================================================================

// BANK-1: noteBankChange updates currentVicBank (masked to $C000 bits) and
// the next pointer fetch reads from the new bank's RAM.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x30;             // screen base = $0C00 within the bank
  vic.ram[0x4FF8] = 0xAA;            // sp0 pointer in bank $4000 area
  vic.ram[0xCFF8] = 0xBB;            // sp0 pointer in bank $C000 area

  // Bank=$4000: cycle 58 p-access reads $4FF8 → $AA.
  vic.noteBankChange(0x4000);
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0xAA,
    'sp0 pointer reads from bank $4000 + screen $0C00 + $3F8');

  // Switch banks; re-fetch on the same line. The new bank must be observed.
  vic.noteBankChange(0xC000);
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0xBB,
    'after noteBankChange($C000), the next p-access uses the new bank ($CFF8 = $BB)');

  console.log('ok  - BANK-1: noteBankChange routes subsequent sprite p-accesses to the new bank');
}

// BANK-2: D018 change mid-line moves the screen base — subsequent p-accesses
// read pointers from the NEW screen RAM area, not the old one cached at line
// start.
{
  const vic = makeVic();
  vic.noteBankChange(0x4000);
  vic.ram[0x4FF8] = 0x11;            // sp0 ptr at D018=$30 (screen $0C00)
  vic.ram[0x47F8] = 0x22;            // sp0 ptr at D018=$10 (screen $0400)

  vic.regs[0x18] = 0x30;
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0x11,
    'D018=$30 → sp0 ptr fetched from screen $0C00 → $11');

  vic.regs[0x18] = 0x10;             // CPU writes D018 mid-line
  vic._spriteSequencerPointerAccess(60);
  // sp1 p-access also reads from the new D018 — but write a sp1 marker to
  // verify it actually came from the new screen base.
  vic.ram[0x47F9] = 0x33;
  vic._spriteSequencerPointerAccess(60);
  assert(vic.spritePointerValue[1] === 0x33,
    'after CPU writes D018=$10, the next p-access at cycle 60 reads sp1 from screen $0400 ($47F9 = $33)');

  console.log('ok  - BANK-2: D018 change mid-line reroutes subsequent p-accesses to the new screen base');
}

// BANK-3: CPU mid-line write to the screen-RAM sprite-pointer area is visible
// to the next sprite p-access on the same line. This is the per-line sprite
// multiplexing scheme (demos like nine.prg).
{
  const vic = makeVic();
  vic.noteBankChange(0x4000);
  vic.regs[0x18] = 0x30;
  vic.ram[0x4FF8] = 0x77;            // initial sp0 pointer
  vic.ram[0x4FF9] = 0x88;            // initial sp1 pointer
  vic.ram[0x4FFA] = 0x99;            // initial sp2 pointer

  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0x77,
    'sp0 p-access at cycle 58 reads the initial pointer');

  // CPU rewrites sp1 and sp2 pointers between cycles 58 and 60-62.
  vic.ram[0x4FF9] = 0xC2;
  vic.ram[0x4FFA] = 0xC3;

  vic._spriteSequencerPointerAccess(60);
  vic._spriteSequencerPointerAccess(62);
  assert(vic.spritePointerValue[1] === 0xC2,
    'sp1 p-access at cycle 60 reads the freshly-written pointer ($C2)');
  assert(vic.spritePointerValue[2] === 0xC3,
    'sp2 p-access at cycle 62 reads the freshly-written pointer ($C3)');

  console.log('ok  - BANK-3: CPU mid-line writes to screen-RAM ptrs are visible to subsequent same-line p-accesses');
}

// BANK-4: bank-switch + same-D018 = different physical screen RAM. The same
// D018=$30 maps to $4C00+$3F8 in bank $4000 and to $CC00+$3F8 in bank $C000.
// This is the exact scenario nine.prg uses (bank changes mid-frame, D018
// fixed, but the live screen-RAM pointer area moves with the bank).
{
  const vic = makeVic();
  vic.regs[0x18] = 0x30;
  // Different pointer values in each bank's $0C00 + $3F8 area.
  for (let s = 0; s < 8; s++) {
    vic.ram[0x4FF8 + s] = 0x40 + s;  // bank $4000 sees $40, $41, ..., $47
    vic.ram[0xCFF8 + s] = 0xC0 + s;  // bank $C000 sees $C0, $C1, ..., $C7
  }

  vic.noteBankChange(0x4000);
  for (const cyc of [58, 60, 62, 1, 3, 5, 7, 9]) {
    vic._spriteSequencerPointerAccess(cyc);
  }
  for (let s = 0; s < 8; s++) {
    assert(vic.spritePointerValue[s] === 0x40 + s,
      `bank $4000 sp${s} pointer reads as $${(0x40+s).toString(16)} from $4FF${(8+s).toString(16)}`);
  }

  vic.noteBankChange(0xC000);
  for (const cyc of [58, 60, 62, 1, 3, 5, 7, 9]) {
    vic._spriteSequencerPointerAccess(cyc);
  }
  for (let s = 0; s < 8; s++) {
    assert(vic.spritePointerValue[s] === 0xC0 + s,
      `after bank switch, sp${s} pointer reads as $${(0xC0+s).toString(16)} from $CFF${(8+s).toString(16)}`);
  }

  console.log('ok  - BANK-4: same D018 maps to different physical RAM after a bank switch (nine.prg scenario)');
}

// BANK-5: per-line sprite-pointer rewrite multiplexer. Verify that across
// successive lines, the VIC reads the latest pointer the CPU wrote — the
// sprite shape data fetched on each line follows the per-line pointer.
{
  const vic = makeVic();
  vic.noteBankChange(0xC000);
  vic.regs[0x18] = 0x30;            // screen $CC00 within bank
  // Place 4 distinct sprite shapes at 4 different ptrs.
  for (let p = 0xC2; p <= 0xC5; p++) {
    const addr = 0xC000 + p * 64;
    vic.ram[addr] = p;              // 1st byte = pointer marker
  }

  // Simulate 4 successive lines; each line the CPU writes a different ptr to
  // sp0's slot, then the VIC fetches at cycle 58 + does the s-access.
  for (const ptr of [0xC2, 0xC3, 0xC4, 0xC5]) {
    vic.ram[0xCFF8] = ptr;
    vic._spriteSequencerPointerAccess(58);
    assert(vic.spritePointerValue[0] === ptr,
      `line with screen-RAM ptr=$${ptr.toString(16)} fetches that ptr at cycle 58`);
    assert(vic.spriteDataBase[0] === ptr * 64,
      `sp0 dataBase tracks the pointer × 64 ($${(ptr*64).toString(16)})`);
    // Confirm the data fetched at base would be the marker we placed.
    const phys = (vic.spriteDataBank[0] + (vic.spriteDataBase[0] & 0x3FFF));
    assert(vic.ram[phys] === ptr,
      `s-access at base would fetch marker byte $${ptr.toString(16)} from $${phys.toString(16)}`);
  }

  console.log('ok  - BANK-5: per-line ptr rewrites are picked up at each line\'s p-access (multiplexer scheme)');
}

// BANK-6: noteBankChange masks input to A14/A15 only. CIA2 PA bits 0-1 select
// the bank — the VIC sees `~portA & 3` shifted left 14. The full machine
// path from CIA2 portA → bank uses C64Machine; here we just pin the
// noteBankChange masking behavior the VIC relies on.
{
  const vic = makeVic();
  vic.noteBankChange(0x0000);   assert(vic.currentVicBank === 0x0000, 'bank 0 = $0000');
  vic.noteBankChange(0x4000);   assert(vic.currentVicBank === 0x4000, 'bank 1 = $4000');
  vic.noteBankChange(0x8000);   assert(vic.currentVicBank === 0x8000, 'bank 2 = $8000');
  vic.noteBankChange(0xC000);   assert(vic.currentVicBank === 0xC000, 'bank 3 = $C000');
  // Stray low bits get masked away — only A14/A15 matter.
  vic.noteBankChange(0xC123);   assert(vic.currentVicBank === 0xC000, 'low bits below A14 are ignored');
  vic.noteBankChange(0x4FFF);   assert(vic.currentVicBank === 0x4000, 'low bits do not perturb the selected bank');
  console.log('ok  - BANK-6: noteBankChange masks to A14/A15 (the only physical bank-select bits)');
}

// BANK-7: CIA2 port-A write through C64Machine immediately updates VIC bank.
// This is the path the demo uses: CPU writes $DD00 → CIA2 portA latches →
// machine's writePortA callback calls noteBankChange. A bank switch the CPU
// commits in cycle N must be visible to VIC reads in cycle N+1 at the latest.
{
  const machine = new C64Machine();
  // Open CIA2 PA bits 0-1 as outputs (DDR=$3F lets the CPU drive them).
  machine.cia2.portADir = 0x3F;

  // Bank 3 ($C000): PA bits 0-1 = 0b00.
  machine.cia2.portA = 0x00;
  machine.cia2.writePortA(0x00);   // direct invocation matches the bus path
  assert(machine.vic2.currentVicBank === 0xC000,
    'CIA2 PA=$00 → VIC bank $C000 (3 - 0 = 3, 3<<14 = $C000)');

  // Bank 1 ($4000): PA bits = 0b10.
  machine.cia2.portA = 0x02;
  machine.cia2.writePortA(0x02);
  assert(machine.vic2.currentVicBank === 0x4000,
    'CIA2 PA=$02 → VIC bank $4000 (3 - 2 = 1, 1<<14 = $4000)');

  // Bank 0 ($0000): PA bits = 0b11.
  machine.cia2.portA = 0x03;
  machine.cia2.writePortA(0x03);
  assert(machine.vic2.currentVicBank === 0x0000,
    'CIA2 PA=$03 → VIC bank $0000');

  // Pull-ups on input pins: when DDR=0, the bit reads as 1 regardless of
  // portA latch. With DDR=$00, both bits float to 1, giving bank 0.
  machine.cia2.portADir = 0x00;
  machine.cia2.portA = 0x00;       // CPU "wrote" zero but bits are inputs
  machine.cia2.writePortA(0x00);
  assert(machine.vic2.currentVicBank === 0x0000,
    'with DDR=$00 both PA0/PA1 float high → bank 0 ($0000)');

  console.log('ok  - BANK-7: CIA2 PortA writes propagate to VIC bank within the same master cycle');
}

// BANK-8: end-to-end pointer fetch after a bank switch on the same line.
// The demo pattern: CPU writes $DD00 to switch bank, then immediately the
// VIC's next sprite p-access (same line, later cycle) must read pointers
// from the new bank's screen RAM.
{
  const machine = new C64Machine();
  machine.cia2.portADir = 0x3F;
  machine.vic2.regs[0x18] = 0x30;  // screen base $0C00

  // Plant distinct sprite-0 pointer values in each bank's screen-RAM area.
  machine.mem.ram[0x4FF8] = 0x40;   // bank $4000 → sees ptr $40
  machine.mem.ram[0xCFF8] = 0xC0;   // bank $C000 → sees ptr $C0

  // Start in bank $4000. p-access reads $40.
  machine.cia2.portA = 0x02;       // PA=$02 → bank 1 ($4000)
  machine.cia2.writePortA(0x02);
  machine.vic2._spriteSequencerPointerAccess(58);
  assert(machine.vic2.spritePointerValue[0] === 0x40,
    'pre-switch p-access reads sp0 from $4FF8 ($40)');

  // CPU writes $DD00 = $00 to switch to bank $C000. Without re-clocking the
  // VIC, the next p-access on the same line must already see the new bank.
  machine.cia2.portA = 0x00;
  machine.cia2.writePortA(0x00);
  assert(machine.vic2.currentVicBank === 0xC000,
    'bank switch is visible to VIC immediately after the $DD00 write');

  // sp1 p-access at cycle 60 reads from the new bank's screen RAM area.
  machine.mem.ram[0xCFF9] = 0xC1;
  machine.vic2._spriteSequencerPointerAccess(60);
  assert(machine.vic2.spritePointerValue[1] === 0xC1,
    'post-switch p-access at cycle 60 reads sp1 from $CFF9 ($C1) — the new bank');

  console.log('ok  - BANK-8: bank switch and same-line p-access end-to-end (CPU → CIA2 → VIC)');
}


console.log('\nAll Bank-switch and screen-RAM routing tests passed.');
