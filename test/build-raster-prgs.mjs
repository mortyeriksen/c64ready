// Build a minimal raster-bar test PRG. Two variants:
//   1. NAIVE: IRQ at raster N writes border color, then RTI. Has natural
//      ~4-cycle 6502 IRQ-entry latency jitter (the floor we expect).
//   2. STABLE: Double-IRQ stable raster. First IRQ acks and re-arms one
//      line later, then CLI + 9 NOPs. The second IRQ fires somewhere in
//      that NOP sled at a near-deterministic cycle. After a 1-cycle
//      LDA/CMP $D012 stabilizer the draw point is pixel-stable.
//
// Both variants draw an 8-line color bar starting at raster 100 by writing
// $D020 from a small color table on each successive raster IRQ.

import fs from 'fs';

function build(stable) {
  // Layout: load at $C000.
  //   $C000  init
  //   $C100  IRQ1
  //   $C200  IRQ2 (stable variant only)
  //   $C300  color table + saved-SP storage
  const ram = new Uint8Array(0x400);
  function put(off, ...b) { for (let i=0;i<b.length;i++) ram[off+i] = b[i] & 0xFF; }

  // -- INIT at $C000 --
  let p = 0x000;
  // SEI
  put(p++, 0x78);
  // LDA #<IRQ1 ; STA $0314 ; LDA #>IRQ1 ; STA $0315
  put(p, 0xA9, 0x00); p+=2;
  put(p, 0x8D, 0x14, 0x03); p+=3;
  put(p, 0xA9, 0xC1); p+=2;
  put(p, 0x8D, 0x15, 0x03); p+=3;
  // LDA $D011 ; AND #$7F ; STA $D011  (clear raster bit 8)
  put(p, 0xAD, 0x11, 0xD0); p+=3;
  put(p, 0x29, 0x7F); p+=2;
  put(p, 0x8D, 0x11, 0xD0); p+=3;
  // LDA #100 ; STA $D012
  put(p, 0xA9, 100); p+=2;
  put(p, 0x8D, 0x12, 0xD0); p+=3;
  // LDA #$01 ; STA $D01A  (enable raster IRQ)
  put(p, 0xA9, 0x01); p+=2;
  put(p, 0x8D, 0x1A, 0xD0); p+=3;
  // LDA #$7F ; STA $DC0D  (disable CIA1 IRQ)
  put(p, 0xA9, 0x7F); p+=2;
  put(p, 0x8D, 0x0D, 0xDC); p+=3;
  // LDA $DC0D  (ack)
  put(p, 0xAD, 0x0D, 0xDC); p+=3;
  // ASL $D019  (ack any pending VIC)
  put(p, 0x0E, 0x19, 0xD0); p+=3;
  // Reset bar index to 0
  // LDA #0 ; STA $C300
  put(p, 0xA9, 0x00); p+=2;
  put(p, 0x8D, 0x00, 0xC3); p+=3;
  // CLI
  put(p++, 0x58);
  // HANG: JMP HANG  -> we record the hang addr to use for absolute jmp
  const hangAddr = 0xC000 + p;
  put(p, 0x4C, hangAddr & 0xFF, (hangAddr>>8) & 0xFF); p+=3;

  // -- IRQ1 at $C100 --
  p = 0x100;

  if (!stable) {
    // NAIVE variant: write color from table indexed by C300, advance index
    // & target raster, ack, exit. Each IRQ enters with raw 6502 latency.
    // LDX $C300
    put(p, 0xAE, 0x00, 0xC3); p+=3;
    // LDA $C310,X  (color table base)
    put(p, 0xBD, 0x10, 0xC3); p+=3;
    // STA $D020
    put(p, 0x8D, 0x20, 0xD0); p+=3;
    // INX
    put(p++, 0xE8);
    // CPX #8 ; BNE +5 ; LDX #0 (wrap)
    put(p, 0xE0, 0x08); p+=2;
    put(p, 0xD0, 0x02); p+=2;  // BNE skip-reset (skip 2 bytes)
    put(p, 0xA2, 0x00); p+=2;  // LDX #0
    // STX $C300
    put(p, 0x8E, 0x00, 0xC3); p+=3;
    // LDA $D012 ; CLC ; ADC #1 ; STA $D012   (advance one line)
    put(p, 0xAD, 0x12, 0xD0); p+=3;
    put(p++, 0x18);
    put(p, 0x69, 0x01); p+=2;
    put(p, 0x8D, 0x12, 0xD0); p+=3;
    // If wrapped (X==0 now), reset target raster to 100
    // LDA $C300 ; BNE +5 ; LDA #100 ; STA $D012
    put(p, 0xAD, 0x00, 0xC3); p+=3;
    put(p, 0xD0, 0x05); p+=2;
    put(p, 0xA9, 100); p+=2;
    put(p, 0x8D, 0x12, 0xD0); p+=3;
    // ASL $D019 (ack)
    put(p, 0x0E, 0x19, 0xD0); p+=3;
    // JMP $EA81 (KERNAL IRQ exit: PLA/TAY/PLA/TAX/PLA/RTI)
    put(p, 0x4C, 0x81, 0xEA); p+=3;
  } else {
    // STABLE variant: re-arm IRQ to next line, save SP, hop into IRQ2.
    // ASL $D019  (ack)
    put(p, 0x0E, 0x19, 0xD0); p+=3;
    // LDA $D012 ; CLC ; ADC #1 ; STA $D012
    put(p, 0xAD, 0x12, 0xD0); p+=3;
    put(p++, 0x18);
    put(p, 0x69, 0x01); p+=2;
    put(p, 0x8D, 0x12, 0xD0); p+=3;
    // Point soft IRQ vector at IRQ2
    put(p, 0xA9, 0x00); p+=2;          // LDA #<IRQ2
    put(p, 0x8D, 0x14, 0x03); p+=3;
    put(p, 0xA9, 0xC2); p+=2;          // LDA #>IRQ2
    put(p, 0x8D, 0x15, 0x03); p+=3;
    // TSX ; STX $C301  (save SP for IRQ2)
    put(p++, 0xBA);
    put(p, 0x8E, 0x01, 0xC3); p+=3;
    // CLI
    put(p++, 0x58);
    // 9 NOPs - wait for IRQ2 to fire (max ~9 cyc + 7 vector = 16 cyc cushion)
    for (let i = 0; i < 12; i++) put(p++, 0xEA);
    // Should never reach here. Hang.
    put(p, 0x4C, hangAddr & 0xFF, (hangAddr>>8) & 0xFF); p+=3;
  }

  if (stable) {
    // -- IRQ2 at $C200 --
    p = 0x200;
    // LDX $C301 ; TXS  (restore SP from before IRQ1 nesting)
    put(p, 0xAE, 0x01, 0xC3); p+=3;
    put(p++, 0x9A);
    // 1-cycle compensator: LDA $D012; CMP $D012; BEQ skip; NOP
    put(p, 0xAD, 0x12, 0xD0); p+=3;
    put(p, 0xCD, 0x12, 0xD0); p+=3;
    put(p, 0xF0, 0x01); p+=2;
    put(p++, 0xEA);
    // -- bar draw, identical to naive variant body --
    put(p, 0xAE, 0x00, 0xC3); p+=3;       // LDX $C300
    put(p, 0xBD, 0x10, 0xC3); p+=3;       // LDA $C310,X
    put(p, 0x8D, 0x20, 0xD0); p+=3;       // STA $D020
    put(p++, 0xE8);                         // INX
    put(p, 0xE0, 0x08); p+=2;             // CPX #8
    put(p, 0xD0, 0x02); p+=2;             // BNE +2
    put(p, 0xA2, 0x00); p+=2;             // LDX #0
    put(p, 0x8E, 0x00, 0xC3); p+=3;       // STX $C300
    put(p, 0xAD, 0x00, 0xC3); p+=3;       // LDA $C300
    put(p, 0xD0, 0x05); p+=2;             // BNE +5
    put(p, 0xA9, 100); p+=2;              // LDA #100
    put(p, 0x8D, 0x12, 0xD0); p+=3;       // STA $D012
    // Restore IRQ1 vector
    put(p, 0xA9, 0x00); p+=2;
    put(p, 0x8D, 0x14, 0x03); p+=3;
    put(p, 0xA9, 0xC1); p+=2;
    put(p, 0x8D, 0x15, 0x03); p+=3;
    put(p, 0x0E, 0x19, 0xD0); p+=3;       // ack
    put(p, 0x4C, 0x81, 0xEA); p+=3;        // JMP $EA81
  }

  // -- Color table at $C310 --
  const colors = [0x01, 0x07, 0x0D, 0x05, 0x03, 0x0E, 0x06, 0x0E];
  for (let i = 0; i < 8; i++) ram[0x310 + i] = colors[i];

  // PRG = load addr ($C000) + bytes
  const prg = new Uint8Array(2 + ram.length);
  prg[0] = 0x00; prg[1] = 0xC0;
  prg.set(ram, 2);
  return prg;
}

// -- Moving-bar variant ------------------------------------------------------
// Single IRQ that fires at the current bar Y. The handler:
//   1. Writes bar color to BOTH $D020 (border) and $D021 (screen bg) so
//      the bar shows across border AND active display.
//   2. Burns ~5 raster lines via a cycle-counted DEX loop (raster polling
//      doesn't work cleanly for barY > 255, so we use cycle counting).
//   3. Restores the default colors.
//   4. Advances barY (16-bit) by the current direction; flips direction
//      at min/max bounds.
//   5. Writes the new low byte to $D012 and updates $D011 bit 7 (raster
//      bit 8) so the IRQ correctly fires for rasters 256..311.
//
// State (in RAM):
//   $C300 = barY low byte
//   $C301 = barY raster-bit-8 mask (0x00 or 0x80, as it goes into $D011)
//   $C302 = direction (0x01 going down, 0xFF going up)
function buildMovingBar() {
  const ram = new Uint8Array(0x400);
  const put = (off, ...b) => { for (let i=0;i<b.length;i++) ram[off+i] = b[i] & 0xFF; };

  const BAR_MIN = 30;      // raster (top, in upper border)
  const BAR_MAX = 281;     // raster (deep into lower border, still on canvas)
  const BAR_MAX_LO = BAR_MAX & 0xFF;                    // 0x19
  const BAR_MAX_HI = (BAR_MAX > 0xFF) ? 0x80 : 0x00;    // 0x80
  const BAR_COLOR  = 0x02; // red
  const BORDER_BG  = 0x0E; // KERNAL default border color (light blue)
  const SCREEN_BG  = 0x06; // KERNAL default screen color (blue)

  // -- INIT at $C000 --
  let p = 0x000;
  put(p++, 0x78);                                 // SEI
  put(p, 0xA9, 0x00); p += 2;                     // LDA #<IRQ
  put(p, 0x8D, 0x14, 0x03); p += 3;
  put(p, 0xA9, 0xC1); p += 2;                     // LDA #>IRQ
  put(p, 0x8D, 0x15, 0x03); p += 3;
  put(p, 0xAD, 0x11, 0xD0); p += 3;               // LDA $D011
  put(p, 0x29, 0x7F); p += 2;                     // AND #$7F (raster bit 8 = 0)
  put(p, 0x8D, 0x11, 0xD0); p += 3;
  // Initial barY = BAR_MIN (low byte), high bit = 0, direction = +1
  put(p, 0xA9, BAR_MIN); p += 2;
  put(p, 0x8D, 0x00, 0xC3); p += 3;               // STA $C300 (lo)
  put(p, 0x8D, 0x12, 0xD0); p += 3;               // STA $D012
  put(p, 0xA9, 0x00); p += 2;                     // LDA #0
  put(p, 0x8D, 0x01, 0xC3); p += 3;               // STA $C301 (hi mask)
  put(p, 0xA9, 0x01); p += 2;                     // LDA #1
  put(p, 0x8D, 0x02, 0xC3); p += 3;               // STA $C302 (direction)
  put(p, 0xA9, 0x01); p += 2;                     // LDA #$01
  put(p, 0x8D, 0x1A, 0xD0); p += 3;               // STA $D01A (enable raster IRQ)
  put(p, 0xA9, 0x7F); p += 2;
  put(p, 0x8D, 0x0D, 0xDC); p += 3;               // disable CIA1 IRQ
  put(p, 0xAD, 0x0D, 0xDC); p += 3;               // ack
  put(p, 0x0E, 0x19, 0xD0); p += 3;               // ack VIC IRQ
  put(p++, 0x58);                                  // CLI
  const hangAddr = 0xC000 + p;
  put(p, 0x4C, hangAddr & 0xFF, (hangAddr >> 8) & 0xFF); p += 3;

  // -- IRQ at $C100 --
  p = 0x100;
  put(p, 0x0E, 0x19, 0xD0); p += 3;               // ASL $D019  (ack)

  // Write bar color to BOTH border ($D020) and screen background ($D021)
  // so the bar shows across border AND active display area.
  put(p, 0xA9, BAR_COLOR); p += 2;                // LDA #BAR_COLOR
  put(p, 0x8D, 0x20, 0xD0); p += 3;               // STA $D020 (border)
  put(p, 0x8D, 0x21, 0xD0); p += 3;               // STA $D021 (screen bg)

  // Hold the bar color via cycle-counted DEX loop. The visible bar height
  // is one larger than the number of full raster lines covered (because
  // the IRQ writes mid-line, so the first and last partial lines both
  // count as visible rows). Tune for 5 visible rows: total delay between
  // STA red and STA bg writes ≈ 4 raster lines = 252 cycles.
  // delay = STA_d021(4) + LDX(2) + loop(5N-1) + LDA(2) + STA_d020(4) - 1
  //       = 5N + 11 cycles. For 252 cyc: N ≈ 48.
  put(p, 0xA2, 48); p += 2;                       // LDX #48
  put(p++, 0xCA);                                  // DEX  (loop body)
  put(p, 0xD0, 0xFD); p += 2;                     // BNE -3

  // Restore border color and screen background.
  put(p, 0xA9, BORDER_BG); p += 2;
  put(p, 0x8D, 0x20, 0xD0); p += 3;
  put(p, 0xA9, SCREEN_BG); p += 2;
  put(p, 0x8D, 0x21, 0xD0); p += 3;

  // -- Advance barY (16-bit), branching on direction sign. --
  put(p, 0xAD, 0x02, 0xC3); p += 3;               // LDA $C302  (direction)
  put(p, 0x10, 16); p += 2;                       // BPL dir_pos (skip 16-byte dir_neg block)

  // direction = -1: decrement barY low; if it was 0, decrement hi (clear bit 7).
  put(p, 0xAD, 0x00, 0xC3); p += 3;               // LDA $C300
  put(p, 0xD0, 0x05); p += 2;                     // BNE skip_hi_dec (5 bytes)
  put(p, 0xA9, 0x00); p += 2;                     // LDA #0
  put(p, 0x8D, 0x01, 0xC3); p += 3;               // STA $C301 (hi mask = 0)
  // skip_hi_dec:
  put(p, 0xCE, 0x00, 0xC3); p += 3;               // DEC $C300
  put(p, 0x4C, 0, 0);                              // JMP done_advance (operand fixed up below)
  const fixupAdvanceDoneNeg = p + 1; p += 3;

  // dir_pos: increment barY low; if it overflows, set hi bit.
  // Currently at offset relative to BPL above
  // INC $C300 ; BNE skip_hi_inc ; LDA #$80 ; STA $C301 ; skip_hi_inc:
  put(p, 0xEE, 0x00, 0xC3); p += 3;               // INC $C300
  put(p, 0xD0, 0x05); p += 2;                     // BNE skip_hi_inc
  put(p, 0xA9, 0x80); p += 2;
  put(p, 0x8D, 0x01, 0xC3); p += 3;
  // skip_hi_inc / done_advance:
  const doneAdvance = 0xC000 + p;
  ram[fixupAdvanceDoneNeg]     = doneAdvance & 0xFF;
  ram[fixupAdvanceDoneNeg + 1] = (doneAdvance >> 8) & 0xFF;

  // -- Bounds check (16-bit) --
  // Hit max if (hi == BAR_MAX_HI && lo > BAR_MAX_LO) (with BAR_MAX_HI = 0x80
  // here). When hi == 0, can't be over max.
  put(p, 0xAD, 0x01, 0xC3); p += 3;               // LDA $C301 (hi mask)
  put(p, 0xF0, 20); p += 2;                       // BEQ check_min (skip whole max check: 20 bytes)
  put(p, 0xAD, 0x00, 0xC3); p += 3;               // LDA $C300
  put(p, 0xC9, BAR_MAX_LO + 1); p += 2;           // CMP #BAR_MAX_LO+1
  put(p, 0x90, 13); p += 2;                       // BCC done_bounds (lo <= MAX_LO -> within, skip 13)
  // hit max — flip direction, clamp lo to BAR_MAX_LO (hi already 0x80)
  put(p, 0xA9, 0xFF); p += 2;                     // LDA #$FF
  put(p, 0x8D, 0x02, 0xC3); p += 3;               // STA $C302
  put(p, 0xA9, BAR_MAX_LO); p += 2;
  put(p, 0x8D, 0x00, 0xC3); p += 3;               // STA $C300
  put(p, 0x4C, 0, 0);                              // JMP done_bounds (operand fixed up below)
  const fixupDoneBoundsMax = p + 1; p += 3;

  // check_min: hit min if (hi == 0 && lo < BAR_MIN). When hi != 0, above min.
  put(p, 0xAD, 0x01, 0xC3); p += 3;               // LDA $C301
  put(p, 0xD0, 17); p += 2;                       // BNE done_bounds (skip 17 bytes)
  put(p, 0xAD, 0x00, 0xC3); p += 3;               // LDA $C300
  put(p, 0xC9, BAR_MIN); p += 2;
  put(p, 0xB0, 10); p += 2;                       // BCS done_bounds (skip 10 bytes of min-flip)
  // hit min — flip direction, clamp lo to BAR_MIN
  put(p, 0xA9, 0x01); p += 2;
  put(p, 0x8D, 0x02, 0xC3); p += 3;
  put(p, 0xA9, BAR_MIN); p += 2;
  put(p, 0x8D, 0x00, 0xC3); p += 3;

  // done_bounds:
  const doneBounds = 0xC000 + p;
  ram[fixupDoneBoundsMax]     = doneBounds & 0xFF;
  ram[fixupDoneBoundsMax + 1] = (doneBounds >> 8) & 0xFF;

  // -- Push new barY into VIC: D012 = lo, D011 bit 7 = hi mask. --
  put(p, 0xAD, 0x00, 0xC3); p += 3;               // LDA $C300
  put(p, 0x8D, 0x12, 0xD0); p += 3;               // STA $D012
  put(p, 0xAD, 0x11, 0xD0); p += 3;               // LDA $D011
  put(p, 0x29, 0x7F); p += 2;                     // AND #$7F (clear bit 7)
  put(p, 0x0D, 0x01, 0xC3); p += 3;               // ORA $C301 (merge hi mask)
  put(p, 0x8D, 0x11, 0xD0); p += 3;               // STA $D011

  put(p, 0x4C, 0x81, 0xEA); p += 3;               // JMP $EA81 (KERNAL exit)

  const prg = new Uint8Array(2 + ram.length);
  prg[0] = 0x00; prg[1] = 0xC0;
  prg.set(ram, 2);
  return prg;
}

const naive = build(false);
const stable = build(true);
const moving = buildMovingBar();
const outDir = new URL('.', import.meta.url).pathname;
fs.writeFileSync(outDir + 'raster-naive.prg', naive);
fs.writeFileSync(outDir + 'raster-stable.prg', stable);
fs.writeFileSync(outDir + 'raster-moving.prg', moving);
console.log(`wrote ${outDir}raster-naive.prg`, naive.length, 'bytes');
console.log(`wrote ${outDir}raster-stable.prg`, stable.length, 'bytes');
console.log(`wrote ${outDir}raster-moving.prg`, moving.length, 'bytes');
