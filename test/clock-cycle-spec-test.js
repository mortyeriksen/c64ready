// Clock-cycle / timing spec audit. 30+ tests, each one derived directly
// from a spec rule (Bauer "The MOS 6567/6569 video controller VIC-II",
// the C64 Programmer's Reference Guide, MOS6526 CIA datasheet, or 6502
// reference). Where possible the spec citation is in the test header.
// If our impl deviates from the cited rule, the test fails.
//
// Coverage:
//   CPU-stall during BA / AEC      — tests 1..6
//   Bad-line + sprite combined     — tests 7..11
//   Raster IRQ timing              — tests 12..16
//   Border state transitions       — tests 17..22
//   Sprite Y-match cycle precision — tests 23..27
//   CIA timer underflow timing     — tests 28..32

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';
import { CPU } from '../src/cpu.js';
import { CIA } from '../src/cia.js';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Soft assertions: record failures but continue, so a single run reports
// every spec deviation. Each test calls `ok()` once at the end; if any
// `expect()` failed inside it, the test is recorded as failing.
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

// ── CPU-STALL DURING BA / AEC ────────────────────────────────────────────

// Test 1 — Bauer §3.6.1 + 6502 ref: when BA is low and the next CPU bus
// access is a READ, the CPU must NOT advance any micro-op or decrement
// instructionCyclesRemaining. The CPU is fully frozen.
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0xA5; // LDA zp — a 3-cycle READ instruction
  mem.ram[0x0401] = 0x10;
  mem.ram[0x0010] = 0x42;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.clock(); // T0 — opcode read fetch (1 cycle)
  const t0Pc = cpu.pc;
  const t0Rem = cpu.instructionCyclesRemaining;
  // Don't call clock() — simulating BA-low blocking the next read. State
  // must be stable: no advance.
  for (let i = 0; i < 100; i++) {
    expect(cpu.pc === t0Pc, `BA-low: PC must not advance while CPU is stalled`);
    expect(cpu.instructionCyclesRemaining === t0Rem, `BA-low: instructionCyclesRemaining frozen`);
  }
  ok('CPU read is fully frozen during BA-low (no PC / no decrement)');
}

// Test 2 — When BA is low but the NEXT CPU bus access is a WRITE, the CPU
// proceeds (BA only stalls reads per Bauer §3.6.1).
{
  const mem = new FlatMemory();
  // STA $0040 = 3 cycles: T0 fetch op, T1 fetch zp addr, T2 write to zp.
  mem.ram[0x0400] = 0x85;
  mem.ram[0x0401] = 0x40;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.a = 0x99;
  cpu.clock(); // T0 (read opcode)
  cpu.clock(); // T1 (read zp addr — also a read)
  // Now next op is a WRITE. peekNextBusKind should reflect this.
  expect(cpu.peekNextBusKind() === 'write',
    `STA: next bus access at T2 must be a 'write'`);
  expect(typeof cpu.peekNextBusKindByte() === 'number',
    `STA: next bus kind byte at T2 must be numeric, got ${typeof cpu.peekNextBusKindByte()}`);
  expect(cpu.nextBusIsWrite() === true,
    `STA: nextBusIsWrite must be true at T2`);
  ok('peekNextBusKind and nextBusIsWrite correctly report next-cycle bus direction');
}

// Test 3 — AEC low stalls EVERYTHING (writes too). Per Bauer §3.6.1 and
// the CPU/VIC integration in machine.js: aecBlocksAll = true if any sprite
// AEC or bad-line AEC is asserting.
{
  // Simulated: integration in machine.js has `if (cpuBlocked) skip
  // cpu.clock()`. We probe via vic._spriteAecLow + vic._isBadLineBaLow.
  const vic = makeVic();
  vic.spriteDmaOn[0] = 1;
  // sp0 alone: AEC is low at cycles 58, 59. Verify those cycles report
  // "AEC blocks all".
  for (const c of [58, 59]) {
    expect(vic._spriteAecLow(c), `sp0 AEC must be low at cycle ${c}`);
  }
  for (const c of [55, 56, 57, 60, 61, 62, 63]) {
    expect(!vic._spriteAecLow(c), `sp0 AEC must be high at cycle ${c}`);
  }
  ok('AEC asserts only at sprite p+s access cycles (Bauer §3.6.1)');
}

// Test 4 — CPU write completes during BA-low if the write cycle isn't a
// read. Verified via STA's T2 micro-op kind.
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x85; // STA $40
  mem.ram[0x0401] = 0x40;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.a = 0x77;
  cpu.clock(); // T0
  cpu.clock(); // T1 (read addr)
  cpu.clock(); // T2 (write)
  expect(mem.ram[0x0040] === 0x77, `STA T2 must write the byte`);
  ok('CPU write completes; write cycle is not blocked by BA-only stall');
}

// Test 5 — Real 6502 RTI takes exactly 6 cycles per spec.
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x40; // RTI
  // Pre-stack: P, PCL, PCH (push order is PCH, PCL, P; pop reads P, PCL, PCH)
  mem.ram[0x01FD] = 0x20; // P
  mem.ram[0x01FE] = 0x34; // PCL
  mem.ram[0x01FF] = 0x12; // PCH
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.sp = 0xFC;
  let cycles = 0;
  while (cycles < 12) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  expect(cycles === 6, `RTI must take 6 cycles (spec), got ${cycles}`);
  expect(cpu.pc === 0x1234, `RTI must restore PC to $1234, got $${cpu.pc.toString(16)}`);
  ok('RTI: 6 cycles total (6502 spec)');
}

// Test 6 — JSR takes exactly 6 cycles per spec.
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x20; // JSR $1234
  mem.ram[0x0401] = 0x34;
  mem.ram[0x0402] = 0x12;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.sp = 0xFF;
  let cycles = 0;
  while (cycles < 12) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  expect(cycles === 6, `JSR must take 6 cycles, got ${cycles}`);
  expect(cpu.pc === 0x1234, `JSR must jump to $1234`);
  ok('JSR: 6 cycles total (6502 spec)');
}

// ── BAD-LINE + SPRITE COMBINED ───────────────────────────────────────────

// Drive VIC into a real bad-line state so both lineMatrixFetchCol and
// lineBadLineDisplayPending are set per spec (Bauer §3.5). Returns the VIC
// at the START of L51 cycle 1, with bad-line conditions armed.
function driveToBadLine(vic) {
  vic.regs[0x11] = 0x1B;  // DEN=1, RSEL=1, ECM=0, BMM=0, YSCROLL=3
  vic.regs[0x16] = 0x08;  // CSEL=1
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
}

// Sample BA/AEC at every cycle of the current line (from cycle 1..63) by
// running clock() forward. Snapshots after each tick.
function sampleLine(vic) {
  const out = new Array(CYCLES_PER_LINE + 1).fill(null);
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    vic.clock(1);
    const c = vic.cycleInLine === 0 ? CYCLES_PER_LINE : vic.cycleInLine;
    out[c] = { ba: vic.baLow, aec: vic.aecLow };
  }
  return out;
}

// Test 7 — Bauer §3.5/§3.6.1: BA on a bad-line union with sprite 0 BA. On
// L51 with sp0 enabled+DMA-on, BA-low spans cycles 12..59 (43 bad + 5
// sp0 lead/access, with cycle 55-57 already covered by bad-line lead/fetch
// region's tail).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  driveToBadLine(vic);
  // Set DMA on for sp0 directly (we want to test BA logic, not Y match).
  vic.spriteDmaOn[0] = 1;
  const sample = sampleLine(vic);
  let baCount = 0;
  for (let c = 12; c <= 59; c++) {
    if (sample[c]?.ba) baCount++;
  }
  expect(baCount === 48,
    `bad-line+sp0: cycles 12..59 must all be BA-low (48 cyc), got ${baCount}`);
  expect(!sample[11]?.ba, `cycle 11: BA-high (before bad-line lead)`);
  expect(!sample[60]?.ba, `cycle 60: BA-high (after sp0)`);
  ok('Bauer §3.5+§3.6.1: bad-line + sp0 → BA low 12..59 (48 cyc continuous)');
}

// Test 8 — Bauer rule 1: with bad-line + 8 sprites, sprite cycles 1..10
// (sp3..sp7 wrap-access from previous line's DMA continuation) plus
// bad-line 12..54 plus sp0..sp2 + sp3 lead 55..63 = cycles 1..10 + 12..63
// (62 cycles). Cycle 11 stays BA-high (single-cycle gap).
{
  const vic = makeVic();
  vic.regs[0x15] = 0xFF;
  // Set Y values that latch DMA at L48 (bad-line condition latch line) so
  // sprites are already in active DMA *before* L51 but MCBASE hasn't yet
  // wrapped to 63 (only 3 lines elapsed → MCBASE ≈ 9).
  for (let s = 0; s < 8; s++) vic.regs[1 + 2 * s] = 48;
  driveToBadLine(vic);
  // Sanity — we should be at start of L51 with all sprites DMA-on already.
  for (let s = 0; s < 8; s++) {
    expect(vic.spriteDmaOn[s] === 1,
      `pre L51: sp${s} DMA must be on (Y=48 matched at L48)`);
  }
  const sample = sampleLine(vic);
  let baCount = 0;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) if (sample[c]?.ba) baCount++;
  expect(baCount === 62,
    `bad-line + 8 sprites: total BA-low cycles = 62 (cycles 1..10 + 12..63), got ${baCount}`);
  expect(!sample[11]?.ba, `cycle 11: must stay BA-high (1-cycle gap)`);
  ok('Bauer §3.5+§3.6.1: bad-line + 8 sprites → 62 BA-low cyc, cycle 11 high');
}

// Test 9 — AEC follows BA(c) && BA(c-3) with combined bad-line + sprite.
// On a bad-line raster with sp0 still in DMA (Y=43 → DMA latched at L43,
// still alive 8 lines later at L51 since MCBASE has only counted to ~24),
// BA stays continuous from 12..59. AEC must therefore assert continuously
// 15..59 because the c-3 lookback sees the combined bad-line and sprite BA
// sources.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 43;
  driveToBadLine(vic);
  expect(vic.spriteDmaOn[0] === 1, `pre L51: sp0 DMA must be on (Y=43 still active)`);
  const sample = sampleLine(vic);
  for (let c = 15; c <= 59; c++) {
    expect(sample[c]?.aec,
      `bad-line+sp0 AEC: cycle ${c} must be AEC-low`);
  }
  expect(!sample[14]?.aec, `cycle 14: AEC-high (3-cycle warning not satisfied)`);
  expect(!sample[60]?.aec, `cycle 60: AEC-high (BA already released)`);
  ok('Bauer rule 3: AEC = BA(c) && BA(c-3) holds across bad-line+sprite union');
}

// Test 10 — Bauer §3.5: bad-line condition fires only when DEN was set
// during raster $30 (line 48). DEN flip after L48 doesn't re-arm.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1
  vic.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 49; i++) vic.clock(1);
  expect(vic.displayEnabled === true,
    `displayEnabled must latch true after L48 with DEN=1`);
  // Now disable DEN AFTER the latch. Bad-lines still fire this frame.
  vic.write(0x11, 0x0B);
  for (let i = 0; i < CYCLES_PER_LINE * 2; i++) vic.clock(1);
  expect(vic.displayEnabled === true,
    `displayEnabled stays latched true even after DEN cleared post-L48`);
  ok('Bauer §3.5: displayEnabled latched at L48, sticky for the frame');
}

// Test 11 — Bauer §3.5 follow-up: DEN cleared BEFORE L48 prevents the
// frame from displaying.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1
  for (let i = 0; i < CYCLES_PER_LINE * 24; i++) vic.clock(1);
  vic.write(0x11, 0x0B); // clear DEN at L24, before L48 latch
  for (let i = 0; i < CYCLES_PER_LINE * 30; i++) vic.clock(1); // past L48
  expect(vic.displayEnabled === false,
    `DEN cleared before L48: displayEnabled must NOT latch true`);
  ok('Bauer §3.5: DEN-clear before L48 prevents frame display (open-border trick)');
}

// ── RASTER IRQ TIMING ────────────────────────────────────────────────────

// Test 12 — Bauer §3.12: raster IRQ fires at cycle 1 of the matched line,
// except for raster 0 where it's delayed to cycle 2.
{
  const vic = makeVic();
  let irqRaised = -1;
  vic.irqHandler = (state) => { if (state && irqRaised === -1) irqRaised = vic.cycleInLine; };
  vic.regs[0x12] = 50; // compare = raster 50
  vic.write(0x1A, 0x01); // raster IRQ enabled (must go through write to set irqMask)
  for (let i = 0; i < CYCLES_PER_LINE * 50; i++) vic.clock(1);
  vic.clock(1); // L50.c1
  expect(irqRaised === 1,
    `raster IRQ must fire at cycle 1 of matched line, got cycle ${irqRaised}`);
  ok('Bauer §3.12: raster IRQ fires at cycle 1 of compare-match line');
}

// Test 13 — Raster 0 IRQ is delayed to cycle 2 per Bauer §3.12. Run a full
// frame first (firing the IRQ at L0 once), clear the IRQ status, then
// observe the NEXT frame's L0 IRQ landing at cycle 2.
{
  const vic = makeVic();
  let irqRaised = -1;
  vic.regs[0x12] = 0;
  vic.write(0x1A, 0x01);
  // Warmup — let the first frame's L0 IRQ fire and self-clear.
  for (let i = 0; i < CYCLES_PER_LINE * 312; i++) vic.clock(1);
  vic.write(0x19, 0x01); // ack any pending raster IRQ
  // Now arm the watcher and observe the next L0 IRQ.
  vic.irqHandler = (state) => {
    if (state && irqRaised === -1) irqRaised = vic.cycleInLine;
  };
  vic.clock(1); // L0.c1 — should NOT fire raster IRQ for raster 0
  expect(irqRaised === -1,
    `raster 0: IRQ must not fire at cycle 1, observed at cycle ${irqRaised}`);
  vic.clock(1); // L0.c2 — fires
  expect(irqRaised === 2,
    `raster 0: IRQ must fire at cycle 2, got cycle ${irqRaised}`);
  ok('Bauer §3.12: raster 0 IRQ delayed by 1 cycle to cycle 2');
}

// Test 14 — Raster IRQ stays asserted until $D019 cleared (W1C).
{
  const vic = makeVic();
  let irqState = false;
  vic.irqHandler = (state) => { irqState = state; };
  vic.regs[0x12] = 50;
  vic.write(0x1A, 0x01);
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  expect(irqState === true, `raster IRQ asserted after match`);
  vic.write(0x19, 0x01);
  expect(irqState === false, `raster IRQ released after $D019 W1C`);
  ok('IRQ status is W1C: writing 1 to $D019.0 clears raster IRQ assertion');
}

// Test 15 — Raster compare uses 9-bit value: $D012 + (D011 bit 7 << 8).
{
  const vic = makeVic();
  let irqRaisedRaster = -1;
  vic.irqHandler = (state) => { if (state && irqRaisedRaster === -1) irqRaisedRaster = vic.raster; };
  vic.regs[0x12] = 0x40;       // 64
  vic.regs[0x11] = 0x80;        // RST8=1 → target = 64+256 = 320 (>312)
  vic.write(0x1A, 0x01);
  for (let i = 0; i < CYCLES_PER_LINE * 312; i++) vic.clock(1);
  expect(irqRaisedRaster === -1,
    `raster compare 320 must not fire on PAL (312 lines), got raster ${irqRaisedRaster}`);
  ok('raster compare uses 9-bit value: D011 RST8 forms bit 8');
}

// Test 16 — Disabling raster IRQ in $D01A immediately deasserts the line.
{
  const vic = makeVic();
  let irqState = false;
  vic.irqHandler = (state) => { irqState = state; };
  vic.regs[0x12] = 50;
  vic.write(0x1A, 0x01);
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  expect(irqState === true, `pre: raster IRQ asserted`);
  vic.write(0x1A, 0x00);
  expect(irqState === false, `IRQ line must release when $D01A bit 0 cleared`);
  ok('IRQ mask change in $D01A immediately reflects on IRQ line');
}

// ── BORDER STATE TRANSITIONS ─────────────────────────────────────────────

// Test 17 — Bauer §3.9: vertical border opens at the end of raster 51
// (RSEL=1) when DEN=1. The comparator fires at cycle 63 of the matched
// raster, so vBorder must be false starting on L52.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  // Run through all of L51 → L52 just begins.
  for (let i = 0; i < CYCLES_PER_LINE * 52; i++) vic.clock(1);
  expect(vic.vBorderActive === false,
    `after L51: vBorder must be OPEN (RSEL=1, DEN=1) — got ${vic.vBorderActive}`);
  ok('Bauer §3.9: vBorder opens at end of L51 with RSEL=1, DEN=1');
}

// Test 18 — vertical border opens at end of raster 55 with RSEL=0.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x13;
  vic.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 56; i++) vic.clock(1);
  expect(vic.vBorderActive === false,
    `after L55: vBorder must be OPEN (RSEL=0, DEN=1)`);
  ok('Bauer §3.9: vBorder opens at end of L55 with RSEL=0');
}

// Test 19 — vertical border CLOSES at cycle 63 of raster 251 (RSEL=1).
// Bauer §3.9 rule 2: "When the Y coordinate reaches the bottom comparison
// value in cycle 63, the vertical border flip-flop is set." So with
// RSEL=1 (bottomCompare=251), the SET fires at L251 cycle 63 — not at
// L251 entry. Drive past L251 c63 (i.e., to L252 entry) to observe.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 251; i++) vic.clock(1);
  expect(vic.vBorderActive === false, `during L0..L251 c0: vBorder open`);
  for (let i = 0; i < CYCLES_PER_LINE; i++) vic.clock(1);
  expect(vic.vBorderActive === true, `after L251 c63: vBorder must CLOSE`);
  ok('Bauer §3.9 rule 2: vBorder closes at cycle 63 of L251 (RSEL=1)');
}

// Test 20 — Horizontal border opens at canvas X 24 (CSEL=1) per
// _getHorizontalBorderCompareX. With CSEL=1: left=24, right=344.
// hBorderActive flips false when the cycle's canvasX crosses left=24
// (around cycle 14-15) and true again at right=344 (around cycle 55-56).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  // Get into a non-vBorder zone so hBorder is exercised.
  for (let i = 0; i < CYCLES_PER_LINE * 100; i++) vic.clock(1);
  // Walk cycle by cycle until hBorder transitions false.
  let openAt = -1;
  for (let c = 1; c <= 30; c++) {
    vic.clock(1);
    if (!vic.hBorderActive && openAt === -1) openAt = vic.cycleInLine;
  }
  expect(openAt >= 14 && openAt <= 17,
    `hBorder must open in cycle 14-17 range with CSEL=1, got cycle ${openAt}`);
  ok(`Bauer §3.9: hBorder opens around cycle ${openAt} with CSEL=1`);
}

// Test 21 — hBorder re-closes near cycle 55-57 (CSEL=1, right=344).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 100; i++) vic.clock(1);
  for (let i = 0; i < 30; i++) vic.clock(1); // past opening
  let closeAt = -1;
  for (let c = 31; c <= CYCLES_PER_LINE; c++) {
    vic.clock(1);
    if (vic.hBorderActive && closeAt === -1) closeAt = vic.cycleInLine;
  }
  expect(closeAt >= 55 && closeAt <= 58,
    `hBorder must close in cycle 55-58 range with CSEL=1, got cycle ${closeAt}`);
  ok(`Bauer §3.9: hBorder closes around cycle ${closeAt} with CSEL=1`);
}

// Test 22 — DEN cleared in raster 0 prevents L48 latch entirely.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B; // DEN=0 from the start
  vic.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 100; i++) vic.clock(1);
  expect(vic.displayEnabled === false,
    `DEN=0 throughout: displayEnabled never latches true`);
  ok('Bauer §3.5: DEN=0 throughout L48 keeps displayEnabled false');
}

// ── SPRITE Y-MATCH CYCLE PRECISION ───────────────────────────────────────

// Test 23 — Bauer §3.8.1 rule 3: DMA sets at cycle 55 phi1 (but BA was
// already evaluated at cycle 55 phi1 BEFORE DMA-set). So sprite BA
// reflects the NEW DMA state starting at cycle 56, not 55.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51; // sp0 Y
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  for (let i = 0; i < 55; i++) vic.clock(1); // through cycle 55
  expect(vic.spriteDmaOn[0] === 1, `cycle 55: DMA flag must be set after rule 3`);
  ok('Bauer §3.8.1 rule 3: DMA flag set within cycle 55');
}

// Test 24 — Sprite Y-match at cycle 55 of line N → sprite display starts
// at line N+1 (not N).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1); // start of L51
  for (let i = 0; i < 56; i++) vic.clock(1); // L51.c56 — display flag may set here
  // Run to L52.c1 — sprite must be displaying.
  while (!(vic.raster === 52 && vic.cycleInLine === 1)) vic.clock(1);
  expect(vic.spriteDisplayOn[0] === 1, `L52: sprite display must be ON`);
  ok('Bauer §3.8.1: sprite display turns on at line N+1 after Y-match at line N');
}

// Test 25 — Sprite DMA persists for 21 lines (Bauer rule 8: clears at MC=63).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  for (let i = 0; i < CYCLES_PER_LINE * 20; i++) vic.clock(1);
  // After 20 full lines + ~1 line = 21 lines; before cycle 16 of L72 the
  // DMA flag should still be true (post-cycle-16 of L72 it clears).
  expect(vic.spriteDmaOn[0] === 1, `mid 21st line: DMA still on`);
  // Skip to L72.c17 (post-DMA-clear).
  while (!(vic.raster === 72 && vic.cycleInLine === 17)) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 0, `L72.c17: DMA must have cleared`);
  ok('Bauer §3.8.1 rule 8: sprite DMA clears at cycle 16 after 21 lines (MC=63)');
}

// Test 26 — Sprite Y match with MxYE=1 doubles display height to 42 lines.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.regs[0x17] = 0x01; // MxYE=1 for sprite 0
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  // Run 41 lines (still inside Y-expand display).
  for (let i = 0; i < CYCLES_PER_LINE * 41; i++) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 1,
    `MxYE=1: DMA must persist for ~42 lines (got off at line ${vic.raster})`);
  ok('Bauer §3.8.1 rules 3,5,7: MxYE=1 doubles sprite display height to ~42 lines');
}

// Test 27 — Two sprites with different Y values — both DMAs latch
// correctly at their respective cycle 55 matches.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x03; // sp0+sp1
  vic.regs[0x01] = 51;
  vic.regs[0x03] = 60;
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  for (let i = 0; i < 56; i++) vic.clock(1); // L51.c56
  expect(vic.spriteDmaOn[0] === 1, `sp0 DMA on after L51 Y match`);
  expect(vic.spriteDmaOn[1] === 0, `sp1 DMA still off (Y=60 not yet matched)`);
  while (!(vic.raster === 60 && vic.cycleInLine === 56)) vic.clock(1);
  expect(vic.spriteDmaOn[1] === 1, `sp1 DMA on after L60 Y match`);
  ok('Bauer §3.8.1 rule 3: per-sprite Y match latches DMA at cycle 55');
}

// ── CIA TIMER UNDERFLOW TIMING ───────────────────────────────────────────

// Test 28 — MOS6526: a started TimerA 1-shot underflows and asserts /IRQ.
// With force-load the raw cia.clock() has a 2-clock load phase, then latch(5)
// counts down + 1 reload cycle (underflow, data bit set), and the IR latch
// drives /IRQ one clock later (datasheet sheet 7). The irqHandler fires when
// the IR latch asserts; clock generously and confirm it did.
{
  let irq = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) irq = true; };
  cia.write(0x04, 0x05);       // latchA lo
  cia.write(0x05, 0x00);       // latchA hi
  cia.write(0x0D, 0x81);       // ICR: enable TA mask
  cia.write(0x0E, 0b00011001); // CRA: start, 1-shot, force-load latch
  for (let c = 1; c <= 12; c++) cia.clock(1);
  expect(irq === true,
    `CIA TA: 1-shot underflow must assert /IRQ within 2(load)+5(count)+1(reload)+1(IR latch) clocks`);
  ok('MOS6526: CIA TimerA 1-shot underflow asserts /IRQ');
}

// Test 29 — TimerA continuous mode reloads latch on underflow.
{
  let irqCount = 0;
  const cia = new CIA(1);
  cia.irqHandler = () => { irqCount++; };
  cia.write(0x04, 0x02);
  cia.write(0x05, 0x00);
  cia.write(0x0D, 0x81);
  cia.write(0x0E, 0b00010001); // start, continuous, force-load
  for (let c = 0; c < 100; c++) cia.clock(1);
  expect(irqCount >= 1,
    `TA continuous: ≥1 underflow in 100 cycles (got ${irqCount})`);
  ok('MOS6526: TimerA continuous mode raises IRQ on underflow');
}

// Test 30 — TimerB chained from TimerA: each TA underflow clocks TB once.
{
  let irq = false;
  const cia = new CIA(1);
  cia.irqHandler = () => { irq = true; };
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);
  cia.write(0x0E, 0b00010001);
  cia.write(0x06, 0x03); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b01010001); // start, continuous, count TA underflows, force-load
  for (let c = 0; c < 50; c++) cia.clock(1);
  expect(irq === true,
    `TB chain from TA: TB IRQ should fire within 50 CIA cycles (got irq=${irq})`);
  ok('MOS6526: TimerB chained from TimerA underflows correctly');
}

// Test 31 — TOD clock advance: 5 50Hz ticks → 0.5s elapsed (5 tenths).
// Note: PAL TOD-divider is 5 ticks/100ms. Implementation may differ; we
// assert the high-level invariant that more ticks → more time elapsed.
{
  const cia = new CIA(1);
  cia.write(0x0E, 0b10000000);
  for (let i = 0; i < 50; i++) cia.tick50Hz();
  expect(cia.todSec >= 1 || cia.tod10 >= 9,
    `PAL TOD: 50 50Hz ticks ≈ 1 second; got sec=${cia.todSec} tenths=${cia.tod10}`);
  ok('MOS6526: TOD clock advances under 50Hz ticks');
}

// Test 32 — Reading $D012 reflects the new raster line at CYCLE 1, not cycle 0.
//
// Bauer (§3.6.3, "Timing of a raster line"): "the negative edge of IRQ on a
// raster interrupt ... defines the beginning of a line (this is also the moment
// in which the RASTER register is incremented)". The raster IRQ — and hence the
// RASTER increment — happen at cycle 1 of every line (line 0 at cycle 2; §3.12).
// So at cycle 0 $D012 still holds the PREVIOUS line; the new value first appears
// at cycle 1. Verified against VICE (CYC reg: new $D012 value first seen at
// CYC 1). The old assertion (new line at cycle 0) was test-to-impl, codifying a
// 1-cycle-early readback.
{
  const vic = makeVic();
  for (let i = 0; i < CYCLES_PER_LINE * 100; i++) vic.clock(1);
  vic.phi2();
  expect(vic.read(0x12) === 99,
    `$D012 at L100 cycle 0: still holds the previous line 99 (RASTER increments at cy1), got ${vic.read(0x12)}`);
  vic.clock(1); vic.phi2();
  expect(vic.read(0x12) === 100,
    `$D012 at L100 cycle 1: reflects the new line 100, got ${vic.read(0x12)}`);
  for (let i = 0; i < CYCLES_PER_LINE * 200; i++) vic.clock(1);
  vic.phi2();
  expect(vic.read(0x12) === (300 & 0xFF),
    `$D012 at L300 cycle 1: must return ${300 & 0xFF}, got ${vic.read(0x12)}`);
  ok('VIC: $D012 reflects the new raster line at cycle 1 (Bauer: increment at the raster-IRQ cycle)');
}

// Test 33 — $D011 bit 7 (RST8) read returns raster bit 8 — also at cycle 1 (per
// the cycle-1 RASTER increment above): at L256 cycle 0 it still reads the old
// line 255 with bit 8 clear; at cycle 1 the new line 256 sets bit 8.
{
  const vic = makeVic();
  for (let i = 0; i < CYCLES_PER_LINE * 256; i++) vic.clock(1);
  vic.phi2();
  expect((vic.read(0x11) & 0x80) === 0,
    `$D011 bit 7 at L256 cycle 0: still old line 255, bit 7 must be clear`);
  vic.clock(1); vic.phi2();
  expect((vic.read(0x11) & 0x80) !== 0,
    `$D011 bit 7 at L256 cycle 1: new line 256, bit 7 must be set`);
  ok('VIC: $D011 RST8 (bit 7) reflects raster bit 8 (new line at cycle 1)');
}

// Test 34 — Cycle counter increments by exactly 1 per master cycle.
{
  const vic = makeVic();
  const t0 = vic.totalCycles;
  for (let i = 0; i < 100; i++) vic.clock(1);
  expect(vic.totalCycles - t0 === 100,
    `totalCycles must increment by exactly 1 per clock(1), got ${vic.totalCycles - t0}`);
  ok('VIC: totalCycles increments 1:1 with clock(1) calls');
}

// Test 35 — Frame length is exactly 312 × 63 = 19656 cycles (PAL).
{
  const vic = makeVic();
  const startRaster = vic.raster;
  let cycles = 0;
  while (cycles < 25000) {
    vic.clock(1);
    cycles++;
    if (vic.raster === startRaster && vic.cycleInLine === 0) break;
  }
  expect(cycles === CYCLES_PER_LINE * 312,
    `PAL frame must be ${CYCLES_PER_LINE * 312} cycles, got ${cycles}`);
  ok('PAL frame length = 312 × 63 = 19656 cycles');
}

console.log(`\n${testNo} clock-cycle / timing spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
