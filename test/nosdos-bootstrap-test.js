// test/nosdos-bootstrap-test.js — pin down the contracts that NOSDOS's
// drive-side bootstrap depends on.
//
// ───────────────────────────────────────────────────────────────────────────
// Why this file exists — full debug session summary (preserved for the next
// person who tries to make NOSDOS-loaded games work)
// ───────────────────────────────────────────────────────────────────────────
// We chased a "Ghosts'n'Goblins won't load — stuck on Checking…" bug for a
// long time using a temporary drive-side tracer (since removed). The trail
// went deep before it dead-ended on a small VIA2 timing detail we couldn't
// pin down without per-instruction PC tracing. Below is everything we *did*
// prove, codified as tests so a future refactor doesn't quietly re-break it.
//
// What NOSDOS does (high level)
// ─────────────────────────────
// NOSDOS uploads its drive-side code in two phases over standard CBM IEC:
//   1. Many `M-W` writes seed code at $0500–$06FF and $0700–$071F.
//   2. A final `M-E $06F2` JSR's the drive into NOSDOS's bootstrap.
//
// `$06F2` does:
//
//   A9 28 8D 07 1C    LDA #$28 / STA $1C07     ; VIA2 T1 latch high = $28
//   A9 7A 8D 02 18    LDA #$7A / STA $1802     ; VIA1 DDRB = $7A
//   A2 64             LDX #$64
//   BD 74 F5 9D 45 01 LDA $F574,X / STA $0145,X
//   CA D0 F7          DEX / BNE
//   A9 60 8D AA 01    LDA #$60 / STA $01AA     ; RTS sentinel
//   4C 93 04          JMP $0493                ; into the main IRQ loop
//
// `$0493` then sets up state, does `CLI` to enable IRQs, and spins on a
// flag in zero page that the IRQ handler clears each transfer. The IRQ
// handler is paced by VIA2 T1 in free-run mode (ACR bit 6 set), latch
// $0028. NOSDOS's bail path is `BMI $0490 → JMP ($FFFC)` (soft reset) when
// drive PB7 reads as 1, i.e. when ATN is asserted on the bus.
//
// What's at ROM $F574 (the relocation source)
// ───────────────────────────────────────────
// The standard 1541 WRITE SECTOR routine — write-protect check, JMP error
// handler at $F969, sync writes, GCR encoding via `LDA ($30),Y`. NOSDOS
// copies it into RAM at $0146–$01A9 and presumably patches it for its own
// save support. Important: this means **a 1541 ROM swap with a different
// $F574 layout silently breaks NOSDOS** — the relocated routine becomes
// the wrong code. We use 1541-II 251968-03 and the bytes look correct;
// pinned in test 1.
//
// Things we PROVED were correct in our emulator
// ─────────────────────────────────────────────
//   • M-W command writes do land in drive RAM at the right addresses.
//   • M-E command does JSR to its target — drive PC reaches $06F2.
//   • The bootstrap copy loop runs ~1400 cycles and produces a clean
//     copy of ROM $F574–$F5D7 → RAM $0146–$01A9 with RTS at $01AA.
//   • VIA1 PB7 polarity through the 7406 inverter matches real hardware
//     (bus ATN low → PB7 = 1). My initial "ATN polarity inverted" theory
//     was wrong.
//   • ATN falling-edge fires VIA1 CA1 IRQ exactly once (edge-triggered).
//   • DATA-OUT auto-acknowledge via `_atna_pin XOR atnIn` is correct in
//     both PB4 polarities.
//   • VIA2 T1 free-run mode auto-reloads from latch and re-fires IRQ.
//   • `JMP ($FFFC)` from RAM correctly reloads PC from the ROM reset
//     vector (so NOSDOS's bail path lands somewhere sensible).
//
// Where the actual hang lives (unresolved)
// ────────────────────────────────────────
// In our trace, `$0493` enters its IRQ-driven loop, exchanges a few bytes
// with the C64 (~2000 drive cycles of bit-bang), then NOSDOS clears its
// BUSY flag and the drive falls through to the standard 1541 ROM idle/
// load path (motor on, normal CBM LOAD, track-18 read). The C64 stops
// touching `$DD00` shortly after, displays "Checking…" and never
// recovers. A real NOSDOS load runs for tens of milliseconds; ours runs
// for ~2 ms.
//
// The likely culprit is **VIA2 T1 free-run timing precision** — NOSDOS
// is sensitive to byte-pacing and a one-cycle jitter on T1 underflow can
// corrupt every byte of the transfer. Proving that needs per-instruction
// drive-PC instrumentation we didn't build.
//
// What this test file enforces
// ────────────────────────────
// Each test below pins one specific contract NOSDOS depends on. None of
// them exercise NOSDOS proper (that needs the full drive-side image) —
// but if any of these fails after a future IEC/VIA refactor, the cause
// of a "fastloaders broken" regression will be obvious instead of a
// week-long trace-reading mystery.
//
// Usage: node test/nosdos-bootstrap-test.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Drive1541 } from '../src/drive1541.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`  ok – ${msg}`);
}
function info(msg) { console.log(`info – ${msg}`); }

function loadRealRom() {
  const p = path.join(__dirname, '..', 'roms', '1541.bin');
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

function buildDriveWithStub() {
  // Stub ROM: NOPs everywhere, reset vector → $C000. Useful for tests that
  // execute drive RAM directly and don't care about the ROM body.
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  return new Drive1541(rom);
}

// Run drive for N cycles and report any cleanup needed afterwards.
function runDrive(drive, cycles) { drive.clock(cycles); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. Drive ROM $F574 holds the WRITE SECTOR routine — NOSDOS copies these
//    100 bytes into RAM at $0145 during bootstrap. If the ROM image is
//    swapped for one with a different layout, the relocation produces
//    garbage code and NOSDOS misbehaves silently. Pin the first signature
//    bytes so a ROM swap is caught.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = loadRealRom();
  if (!rom) {
    info('skipping ROM-signature test — roms/1541.bin not present');
  } else {
    // ROM is mapped at $C000-$FFFF, so $F574 → offset $3574 in the image.
    const slice = Array.from(rom.slice(0x3574, 0x3574 + 16));
    // Signature from 1541-II 251968-03 at $F574: f6 20 e9 f5 85 3a ad 00 1c …
    // The opcode-level structure is what matters: the routine starts with a
    // JSR (`20 e9 f5`) at offset +1, a STA $3A, then LDA $1C00 / AND #$10
    // (write-protect check). If the bytes at $F574 don't look like a
    // reasonable 1541 disk-IO routine this test fails fast.
    assert(slice[1] === 0x20 && slice[4] === 0x85 && slice[5] === 0x3A,
      `ROM $F574 area looks like a JSR + STA $3A prologue (got ${slice.slice(0,6).map(b=>b.toString(16).padStart(2,'0')).join(' ')})`);
    assert(slice[6] === 0xAD && slice[7] === 0x00 && slice[8] === 0x1C,
      'ROM $F574 area contains LDA $1C00 (write-protect read)');
    assert(slice[9] === 0x29 && slice[10] === 0x10,
      'ROM $F574 area contains AND #$10 (mask write-protect bit)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Bootstrap simulation: hand-assemble NOSDOS's $06F2 prologue into drive
//    RAM, kick the CPU through it, and check every state the prologue is
//    documented to leave behind. This is the closest we can get to "did
//    M-E + the relocated bootstrap actually do its job" without a full
//    NOSDOS image.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = loadRealRom();
  if (!rom) {
    info('skipping bootstrap-simulation test — needs real 1541.bin');
  } else {
    // Build a drive with the real ROM so $F574,X loads come from the right
    // place. Reset vector points to $06F2 — the bootstrap entry — so we
    // can just drive the CPU forward from reset.
    const drive = new Drive1541(rom);
    // Ignore the ROM's reset vector — patch ours over $FFFC/$FFFD via RAM
    // by repointing the CPU directly after init. (Drive1541._initCpu reads
    // the vector once at construction.)
    drive.cpu.pc = 0x06F2;
    drive.cpu.sp = 0xFF;
    drive.cpu.I = 1;

    // NOSDOS bootstrap, hand-assembled:
    const prologue = [
      0xA9, 0x28,             // LDA #$28
      0x8D, 0x07, 0x1C,       // STA $1C07
      0xA9, 0x7A,             // LDA #$7A
      0x8D, 0x02, 0x18,       // STA $1802
      0xA2, 0x64,             // LDX #$64
      0xBD, 0x74, 0xF5,       // LDA $F574,X
      0x9D, 0x45, 0x01,       // STA $0145,X
      0xCA,                   // DEX
      0xD0, 0xF7,             // BNE $06FE  (relative -9)
      0xA9, 0x60,             // LDA #$60
      0x8D, 0xAA, 0x01,       // STA $01AA
      // Replace the original "JMP $0493" with a BRK so we can detect
      // bootstrap completion deterministically (BRK pushes PC and jumps
      // through the IRQ vector — but we'll just stop driving cycles
      // before then by watching the PC).
      0x00, 0x00, 0x00,
    ];
    for (let i = 0; i < prologue.length; i++) drive.ram[(0x06F2 + i) & 0x07FF] = prologue[i];

    // Run enough cycles to complete the prologue. The copy loop is 100
    // iterations × ~13 cycles + setup ≈ 1500 cycles. We don't gate on PC
    // (STA $01AA finishes its memory write 1 cycle after PC advances past
    // the operand fetch — gating on PC catches the instruction mid-flight).
    // Instead, clock until the RTS sentinel actually lands in RAM, with a
    // generous budget.
    let cycles = 0;
    while (cycles < 4000 && drive.ram[0x01AA] !== 0x60) {
      drive.clock(1); cycles++;
    }
    assert(drive.ram[0x01AA] === 0x60, `bootstrap completed within 4000 cycles (took ${cycles})`);

    // (a) VIA2 T1 latch high written
    assert(drive.via2.t1l >> 8 === 0x28,
      `VIA2 T1L-H = $28 after STA $1C07 (got $${(drive.via2.t1l >> 8).toString(16)})`);

    // (b) VIA1 DDRB set to $7A — the four-bit fastloader pin map
    assert(drive.via1.regs[0x02] === 0x7A,
      `VIA1 DDRB = $7A after STA $1802 (got $${drive.via1.regs[0x02].toString(16)})`);

    // (c) RAM at $0146-$01A9 holds the relocated 100 bytes from ROM $F575+
    //    (the X=100..1 loop copies $F574+X to $0145+X for X in 100..1, so
    //    $F575 → $0146, $F5D8 → $01A9).
    let mismatch = 0;
    for (let i = 1; i <= 100; i++) {
      const romByte = rom[0x3574 + i];           // ROM offset of $F574+i
      const ramByte = drive.ram[0x0145 + i];
      if (romByte !== ramByte) mismatch++;
    }
    assert(mismatch === 0,
      `100-byte ROM→RAM copy at $0145 matches ROM $F574+ exactly (mismatches: ${mismatch})`);

    // (d) RTS sentinel at $01AA was the gating condition on the run-loop
    // above, so reaching this point already means it's in place. Keep an
    // explicit assertion for readers.
    assert(drive.ram[0x01AA] === 0x60, `RTS opcode ($60) installed at $01AA`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. VIA1 PB7 polarity through the 7406 inverter — bus ATN low (asserted)
//    must read as PB7 = 1 on the drive side. NOSDOS's `BMI $0490` exit at
//    $04AC is gated on this; if we got the polarity inverted, NOSDOS would
//    soft-reset on every poll (or never exit when it should).
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDriveWithStub();
  drive.write(0x1802, 0x00);           // DDRB = all inputs (we only care about bit 7)

  drive.setIecLines(1, 1, 1);          // bus all released
  let pb = drive.read(0x1800);
  assert((pb & 0x80) === 0,
    `bus ATN released → drive PB7 = 0 (got pb=$${pb.toString(16)})`);

  drive.setIecLines(0, 1, 1);          // bus ATN asserted (low)
  pb = drive.read(0x1800);
  assert((pb & 0x80) === 0x80,
    `bus ATN asserted → drive PB7 = 1 (got pb=$${pb.toString(16)})`);

  // Same convention for CLK IN (bit 2) and DATA IN (bit 0) — the three
  // inverter inputs share a single polarity rule.
  drive.setIecLines(1, 0, 1);
  pb = drive.read(0x1800);
  assert((pb & 0x04) === 0x04, `bus CLK asserted → drive PB2 = 1`);

  drive.setIecLines(1, 1, 0);
  pb = drive.read(0x1800);
  assert((pb & 0x01) === 0x01, `bus DATA asserted → drive PB0 = 1`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ATN falling-edge fires VIA1 CA1 IRQ. NOSDOS's IRQ handler chains off
//    this — if a high→low ATN transition silently drops the IRQ, the IRQ
//    handler never runs and NOSDOS spins in `LDA $01 / BMI $04DB` forever.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDriveWithStub();
  drive.setIecLines(1, 1, 1);
  drive.via1.write(0x0E, 0x82);        // IER: enable CA1 (bit 1) interrupt
  drive.via1.ifr = 0;                  // clear pending IFR

  drive.setIecLines(0, 1, 1);          // ATN falling edge
  assert((drive.via1.ifr & 0x02) !== 0,
    `VIA1 IFR bit 1 (CA1) set after ATN falling edge (got ifr=$${drive.via1.ifr.toString(16)})`);

  // Subsequent bus refresh with ATN still low must NOT re-trigger CA1 —
  // CA1 is edge-triggered, not level-triggered. Earlier bug surface: a
  // refresh that re-pulses the edge would flood the IRQ line.
  drive.via1.ifr = 0;
  drive.setIecLines(0, 1, 1);
  assert((drive.via1.ifr & 0x02) === 0,
    'CA1 IFR not re-asserted by repeated low-level ATN (edge-triggered)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. VIA2 T1 free-run mode (ACR bit 6 set) keeps re-firing the T1 IRQ at
//    the latch interval. NOSDOS's main loop at $0493 spins waiting for the
//    IRQ handler to clear a flag; if T1 fires once and stops, the spin
//    deadlocks. This test is the closest pinning we can do without
//    actually executing NOSDOS.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDriveWithStub();
  // Free-run mode + IRQ enable
  drive.via2.write(0x0B, 0x40);        // ACR = T1 continuous interrupts
  drive.via2.write(0x0E, 0x80 | 0x40); // IER: T1 enable
  drive.via2.write(0x06, 0x18);        // T1L-L = $18
  drive.via2.write(0x07, 0x00);        // T1L-H = $00 — small latch for fast cycling
  // Writing T1C-H starts the timer.
  drive.via2.write(0x05, 0x00);

  let underflows = 0;
  // Real-hardware T1 fires every (latch + 2) cycles in free-run, so over
  // ~500 cycles a $0018 latch should produce ~16 fires.
  for (let i = 0; i < 500; i++) {
    drive.via2.clock(1);
    if (drive.via2.ifr & 0x40) {
      underflows++;
      drive.via2.read(0x04);           // reading T1C-L clears IFR T1 bit
    }
  }
  info(`VIA2 T1 free-run fired ${underflows} times in 500 cycles (latch=$18 → ~${Math.round(500 / 26)} expected)`);
  assert(underflows >= 10,
    `T1 free-run fires repeatedly (got ${underflows}, expected ≥10)`);
  // No fire-and-stop: at least 5 of those should have come from auto-reload,
  // not the initial countdown.
  assert(underflows >= 15,
    `T1 free-run auto-reloads (got ${underflows}, expected ≥15 over 500 cycles)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. VIA1 PB latch reflects writes correctly under DDRB = $7A.
//    NOSDOS sets DDRB = $7A so bits 1,3,4,5,6 are outputs and bits 0,2,7
//    stay as IEC inputs through the 7406 inverters. A future refactor that
//    accidentally remaps DDR bit semantics is caught here.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDriveWithStub();
  drive.write(0x1802, 0x7A);           // DDRB = $7A

  drive.setIecLines(1, 1, 1);          // bus all released → PB0,2,7 = 0
  drive.write(0x1800, 0x97);           // 1001 0111 — bits 1,4 set (outputs)
  let pb = drive.read(0x1800);
  // Output bits we should see latched back: bit 1 (val&2), bit 4 (val&0x10)
  assert((pb & 0x02) === 0x02, `DDRB=$7A: bit 1 latches output value (got pb=$${pb.toString(16)})`);
  assert((pb & 0x10) === 0x10, `DDRB=$7A: bit 4 latches output value`);
  // bit 3 (output, written 0) reads back 0
  assert((pb & 0x08) === 0x00, `DDRB=$7A: bit 3 latches output value (0)`);
  // bits 0, 2, 7 are inputs — bus released → all 0
  assert((pb & 0x01) === 0x00, `DDRB=$7A: bit 0 reflects bus DATA (released → 0)`);
  assert((pb & 0x04) === 0x00, `DDRB=$7A: bit 2 reflects bus CLK (released → 0)`);
  assert((pb & 0x80) === 0x00, `DDRB=$7A: bit 7 reflects bus ATN (released → 0)`);

  // Now assert ATN — bit 7 must flip even though DDRB = $7A leaves bit 7
  // as input. (The latched output pattern $97 has bit 7 set; that bit is
  // SUPPOSED to be ignored because it's an input pin in our DDR.)
  drive.setIecLines(0, 1, 1);
  pb = drive.read(0x1800);
  assert((pb & 0x80) === 0x80,
    `DDRB=$7A: bit 7 is an input — bus ATN asserted → PB7 = 1 (got pb=$${pb.toString(16)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ATN ACK XOR auto-acknowledge (`_atna_pin XOR atnIn`). Real 1541-II
//    hardware OR's the manual DATA OUT (PB1=0) with `(PB4 XOR ATN_bus)`.
//    NOSDOS uses this so it can leave PB1 high and let ATN swings auto-pull
//    DATA. If the XOR direction flips, NOSDOS's protocol asserts DATA at
//    the wrong moments.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDriveWithStub();
  drive.setIecLines(1, 1, 1);
  // DDRB must let bits 1 and 4 through — without this, every write to
  // $1800 is masked to 0 and the latched output bits never change.
  // NOSDOS's bootstrap sets DDRB = $7A, so use that.
  drive.write(0x1802, 0x7A);

  // PB1=0 (no manual DATA pull → leave the XOR alone) and PB4=0 (ATNA
  // register bit clear → _atna_pin = 1, "transparent" mode).
  drive.write(0x1800, 0x00);
  drive.setIecLines(0, 1, 1);           // ATN asserted → atnIn=0
  // _atna_pin (1) XOR atnIn (0) = 1 → drive pulls DATA → iecData = 0
  assert(drive.iecData === 0,
    `ATNA XOR: PB4=0, ATN asserted → drive auto-pulls DATA (iecData=${drive.iecData})`);

  drive.setIecLines(1, 1, 1);           // ATN released → atnIn=1
  // _atna_pin (1) XOR atnIn (1) = 0 → drive releases DATA → iecData = 1
  assert(drive.iecData === 1,
    `ATNA XOR: PB4=0, ATN released → drive releases DATA`);

  // Flip PB4 to 1 ("inverted" mode) — _atna_pin = 0. With manual
  // DATA-out still 0, the XOR mirrors ATN with opposite polarity, so
  // ATN asserted now LEAVES DATA released.
  drive.write(0x1800, 0x10);            // PB1=0, PB4=1 → _atna_pin=0
  drive.setIecLines(0, 1, 1);           // ATN asserted
  // _atna_pin (0) XOR atnIn (0) = 0 → drive releases DATA → iecData = 1
  assert(drive.iecData === 1,
    `ATNA XOR: PB4=1, ATN asserted → DATA stays released (XOR mirrors ATN inverted)`);

  drive.setIecLines(1, 1, 1);           // ATN released
  // _atna_pin (0) XOR atnIn (1) = 1 → drive pulls DATA → iecData = 0
  assert(drive.iecData === 0,
    `ATNA XOR: PB4=1, ATN released → drive pulls DATA (XOR direction flipped)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Soft-reset path: `JMP ($FFFC)` (the bytes NOSDOS uses at $0490 to
//    bail) reloads PC from the drive ROM's reset vector. Pin that the
//    indirect-JMP through $FFFC works; otherwise NOSDOS's bail path is
//    UB and we'd see weird drive states instead of a clean reset.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = loadRealRom();
  if (!rom) {
    info('skipping soft-reset test — needs real 1541.bin');
  } else {
    const drive = new Drive1541(rom);
    // Stage `JMP ($FFFC)` at $0490 and run from there.
    drive.ram[0x0490] = 0x6C;
    drive.ram[0x0491] = 0xFC;
    drive.ram[0x0492] = 0xFF;
    drive.cpu.pc = 0x0490;
    drive.cpu.sp = 0xFF;
    drive.cpu.I = 1;

    const expectedReset = rom[0x3FFC] | (rom[0x3FFD] << 8);
    info(`drive ROM reset vector → $${expectedReset.toString(16)}`);
    // JMP indirect = 5 cycles. Clock exactly 5 so we land AT the reset
    // vector before the first ROM instruction starts executing past it.
    drive.clock(5);
    assert(drive.cpu.pc === expectedReset,
      `JMP ($FFFC) at $0490 lands at the ROM reset vector (got $${drive.cpu.pc.toString(16)}, expected $${expectedReset.toString(16)})`);
  }
}

console.log('PASS – nosdos-bootstrap-test');
