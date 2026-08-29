// raster-irq-chain-spec-test.js
//
// CPU+VIC integration test: chained raster IRQs across multiple lines
// AND multiple frames. Builds a PRG inline that installs 4 raster
// IRQ handlers, each writing a unique $D020 (border color) and re-
// arming for the next line in the chain. Loop closes back to the
// first line at end of frame. Then asserts:
//
//   1. Each color band appears at the expected canvas Y row range.
//   2. The CPU+VIC integration is cycle-stable across frames — frame N
//      and frame N+10 produce identical canvases.
//
// This is the gap our visual-tricks-spec tests don't cover: those
// drive the VIC directly via vic.write(), bypassing CPU instruction
// timing. Real raster IRQ chains depend on:
//   - 6502 IRQ entry latency (~7 cycles + in-flight instruction)
//   - KERNAL trampoline at $EA31 (~25 cycles)
//   - User handler timing
//   - $D012 re-arm + $D019 ack
//
// Any drift in CPU cycle counting or VIC raster compare would break
// the steady-state assertion.

import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { CANVAS_W, CANVAS_H, C64_PALETTE } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFails = [];
function expect(cond, msg) { if (!cond) currentFails.push(msg); }
function ok(label) {
  testNo++;
  if (currentFails.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFails) console.log(`     - ${m}`);
    currentFails = [];
  }
}

function paletteRGBA(idx) {
  const c = C64_PALETTE[idx & 0x0F];
  return (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
}

// ─── 6502 emitter ─────────────────────────────────────────────────────────
class Asm {
  constructor(start) { this.bytes = []; this.start = start; }
  pc() { return this.start + this.bytes.length; }
  emit(...bs) { for (const b of bs) this.bytes.push(b & 0xFF); }
  ldaImm(v) { this.emit(0xA9, v); }
  ldaAbs(a) { this.emit(0xAD, a & 0xFF, (a >> 8) & 0xFF); }
  ldaAbsX(a) { this.emit(0xBD, a & 0xFF, (a >> 8) & 0xFF); }
  ldxImm(v) { this.emit(0xA2, v); }
  ldxAbs(a) { this.emit(0xAE, a & 0xFF, (a >> 8) & 0xFF); }
  staAbs(a) { this.emit(0x8D, a & 0xFF, (a >> 8) & 0xFF); }
  staAbsX(a) { this.emit(0x9D, a & 0xFF, (a >> 8) & 0xFF); }
  stxAbs(a) { this.emit(0x8E, a & 0xFF, (a >> 8) & 0xFF); }
  inx() { this.emit(0xE8); }
  iny() { this.emit(0xC8); }
  cpxImm(v) { this.emit(0xE0, v); }
  cmpImm(v) { this.emit(0xC9, v); }
  bne(target) {
    const here = this.pc() + 2;
    this.emit(0xD0, (target - here) & 0xFF);
  }
  jmp(addr) { this.emit(0x4C, addr & 0xFF, (addr >> 8) & 0xFF); }
  rts() { this.emit(0x60); }
  rti() { this.emit(0x40); }
  sei() { this.emit(0x78); }
  cli() { this.emit(0x58); }
  pha() { this.emit(0x48); }
  pla() { this.emit(0x68); }
  tax() { this.emit(0xAA); }
  tay() { this.emit(0xA8); }
  inc(addr) { this.emit(0xEE, addr & 0xFF, (addr >> 8) & 0xFF); }
  ora(v) { this.emit(0x09, v); }   // ORA imm
  and(v) { this.emit(0x29, v); }   // AND imm
}

// Build a PRG that installs a 4-bar raster IRQ chain.
// Color bands: red @ L60..L99, green @ L100..L139, blue @ L140..L179,
// yellow @ L180..L286 + (wrap) start of next frame.
// Border default: lt-blue ($0E). Default $D020 set in init.
function buildChainPRG() {
  const a = new Asm(0x0810);
  // Clear screen RAM to space, color RAM to bg.
  a.ldxImm(0);
  const clrLoop = a.pc();
  a.ldaImm(0x20);
  a.staAbsX(0x0400);
  a.staAbsX(0x0500);
  a.staAbsX(0x0600);
  a.staAbsX(0x0700);
  a.ldaImm(0x06);
  a.staAbsX(0xD800);
  a.staAbsX(0xD900);
  a.staAbsX(0xDA00);
  a.staAbsX(0xDB00);
  a.inx();
  a.bne(clrLoop);
  // Set default border / bg.
  a.ldaImm(0x0E); a.staAbs(0xD020);    // lt-blue (default — visible above first IRQ line)
  a.ldaImm(0x06); a.staAbs(0xD021);    // bg blue
  a.ldaImm(0x14); a.staAbs(0xD018);    // screen $0400
  a.ldaImm(0x1B); a.staAbs(0xD011);    // DEN=1, RSEL=1
  a.ldaImm(0x08); a.staAbs(0xD016);    // CSEL=1
  // Counter for which bar (0..3). Stored in $FB (zero page).
  a.ldaImm(0x00); a.staAbs(0x00FB);
  // Install IRQ vector → $C000.
  a.sei();
  a.ldaImm(0x00); a.staAbs(0x0314);
  a.ldaImm(0xC0); a.staAbs(0x0315);
  // First raster compare = L60.
  a.ldaImm(60); a.staAbs(0xD012);
  a.ldaAbs(0xD011);
  a.and(0x7F);
  a.staAbs(0xD011);
  // Disable CIA1 IRQ, enable VIC raster IRQ.
  a.ldaImm(0x7F); a.staAbs(0xDC0D);
  a.ldaAbs(0xDC0D);
  a.ldaImm(0x01); a.staAbs(0xD01A);
  a.ldaImm(0x01); a.staAbs(0xD019);    // ack pending
  // Build the IRQ handler at $C000 separately.
  const irq = new Asm(0xC000);
  // Ack VIC IRQ.
  irq.ldaImm(0x01); irq.staAbs(0xD019);
  // X = bar counter ($FB).
  irq.ldxAbs(0x00FB);
  // $D020 = colors[X], $D012 = rasters[X].
  // Color/raster tables stored at $C100 (colors) and $C108 (rasters).
  irq.ldaAbsX(0xC100);
  irq.staAbs(0xD020);
  irq.ldaAbsX(0xC108);
  irq.staAbs(0xD012);
  // counter = (counter + 1) & 3.
  irq.inx();
  irq.ldaImm(0x03);
  // AND X with 3 (no AND-X opcode; use TXA / AND / TAX).
  // Simpler: use a small lookup.
  irq.bytes.pop(); irq.bytes.pop();      // remove LDA #$03 (we'll do differently)
  irq.bytes.pop();                        // remove INX
  // counter = (counter + 1); if == 4 reset to 0.
  irq.inc(0x00FB);
  irq.ldaAbs(0x00FB);
  irq.cmpImm(4);
  irq.bne(irq.pc() + 7);                  // skip BNE(2) + LDA#$00(2) + STA$FB(3) = 7 bytes
  irq.ldaImm(0x00);
  irq.staAbs(0x00FB);                     // reset counter
  // Manually pull A,X,Y and RTI (kernel pre-pushed them).
  irq.pla(); irq.tay();
  irq.pla(); irq.tax();
  irq.pla();
  irq.rti();
  // Inline-copy IRQ bytes + tables to $C000+ in init.
  const irqBytes = irq.bytes;
  for (let i = 0; i < irqBytes.length; i++) {
    a.ldaImm(irqBytes[i]);
    a.staAbs(0xC000 + i);
  }
  // Color table at $C100: red, green, blue, yellow.
  const colors = [0x02, 0x05, 0x06, 0x07];
  for (let i = 0; i < 4; i++) {
    a.ldaImm(colors[i]);
    a.staAbs(0xC100 + i);
  }
  // Raster table at $C108: next IRQ line for each bar.
  // Bar 0 (red) ends at L100, bar 1 (green) ends at L140, etc.
  // Bar 3 (yellow) wraps back to L60 for next frame.
  const rasters = [100, 140, 180, 60];
  for (let i = 0; i < 4; i++) {
    a.ldaImm(rasters[i]);
    a.staAbs(0xC108 + i);
  }
  a.cli();
  // Hang.
  const hang = a.pc();
  a.jmp(hang);
  // Wrap as PRG.
  const stub = [
    0x01, 0x08, 0x0B, 0x08, 0x0A, 0x00, 0x9E,
    0x32, 0x30, 0x36, 0x34, 0x00, 0x00, 0x00,
  ];
  const buf = Buffer.from(stub);
  const padN = 0x0810 - (0x0801 + buf.length - 2);
  return Buffer.concat([buf, Buffer.alloc(padN, 0), Buffer.from(a.bytes)]);
}

// ─── Run PRG and return canvas snapshot ───────────────────────────────────
function runPRG(prg, frames) {
  const machine = new C64Machine();
  machine.loadROMs({
    kernal:  fs.readFileSync('roms/kernal.bin'),
    basic:   fs.readFileSync('roms/basic.bin'),
    charRom: fs.readFileSync('roms/chargen.bin'),
  });
  machine.loadPRG(prg);
  for (let i = 0; i < 100; i++) machine.runFrame();   // BASIC startup
  machine.cpu.pc = 0x0810;                              // jump to ML
  for (let i = 0; i < frames; i++) machine.runFrame();
  // Return a fresh copy of fb32 + state for further runs.
  return {
    fb32: new Uint32Array(machine.vic2.fb32),
    machine,
  };
}

// ─── 1: each color band appears at the expected canvasY range ─────────────
// IRQ at L60 writes red. Color visible from after the STA write
// completes (on L60) through L99 (just before the L100 IRQ writes
// green). Sample border zone (canvas X 0..31) at canvasY = raster - 15.
//
// Border $D020 default is lt-blue ($0E). At the START of the frame
// (canvas Y 0..44 = L15..L59), border is lt-blue. From canvasY 45
// (L60) onwards: red, green, blue, yellow per bar.
{
  const prg = buildChainPRG();
  const { fb32 } = runPRG(prg, 5);

  const ltBlue = paletteRGBA(0x0E);
  const red    = paletteRGBA(0x02);
  const green  = paletteRGBA(0x05);
  const blue   = paletteRGBA(0x06);
  const yellow = paletteRGBA(0x07);

  // Sample LEFT border (canvas X 4) at canvasY corresponding to mid-bar
  // rasters. The left border is rendered at cycles 11-14 of each line,
  // BEFORE any IRQ handler runs on that line — so the color we see is
  // whatever was last written. In steady state, by cy=Y the last write
  // was from the bar that ENDS at this raster.
  //   canvasY = raster - 15.
  //   - cy 5  (raster 20) — before frame's L60 IRQ. Last write =
  //     yellow from previous frame's L180. → yellow
  //   - cy 50 (raster 65) — between L60 and L100 IRQs. Last write = red.
  //   - cy 90 (raster 105) — between L100 and L140. Last = green.
  //   - cy 130 (raster 145) — between L140 and L180. Last = blue.
  //   - cy 180 (raster 195) — after L180. Last = yellow.
  function pxAt(x, y) { return fb32[y * CANVAS_W + x] >>> 0; }

  expect(pxAt(4, 5) === yellow,
    `cy=5 (before L60 IRQ, last write was L180 prev frame): expect yellow, got 0x${pxAt(4, 5).toString(16)}`);
  expect(pxAt(4, 50) === red,
    `cy=50 (red bar): expect red, got 0x${pxAt(4, 50).toString(16)}`);
  expect(pxAt(4, 90) === green,
    `cy=90 (green bar): expect green, got 0x${pxAt(4, 90).toString(16)}`);
  expect(pxAt(4, 130) === blue,
    `cy=130 (blue bar): expect blue, got 0x${pxAt(4, 130).toString(16)}`);
  expect(pxAt(4, 180) === yellow,
    `cy=180 (after L180 IRQ): expect yellow, got 0x${pxAt(4, 180).toString(16)}`);
  ok('CPU+VIC: chained raster IRQ produces 4 color bars at expected rasters');
}

// ─── 2: IRQ entry latency is consistent across frames (steady state) ──────
// Run for N frames. Sample frame after frame 5 vs frame 60. They must
// be IDENTICAL — any cycle drift in CPU+VIC would change the canvas.
{
  const prg = buildChainPRG();
  const r1 = runPRG(prg, 5);
  const r2 = runPRG(prg, 60);

  // Compare frame buffers pixel-by-pixel.
  let mismatches = 0;
  const samples = [];
  for (let i = 0; i < r1.fb32.length; i++) {
    if (r1.fb32[i] !== r2.fb32[i]) {
      mismatches++;
      if (samples.length < 5) {
        const x = i % CANVAS_W, y = Math.floor(i / CANVAS_W);
        samples.push(`(${x},${y}) f5=0x${r1.fb32[i].toString(16)} f60=0x${r2.fb32[i].toString(16)}`);
      }
    }
  }
  expect(mismatches === 0,
    `steady-state: frame-5 vs frame-60 must be identical, got ${mismatches} pixel diffs. Samples: ${samples.join(' | ')}`);
  ok('CPU+VIC: chained raster IRQ chain steady-state across 60 frames (no cycle drift)');
}

// ─── 3: the 4 chained IRQ $D020 writes land at a consistent cycle ─────────
// Test 3 catches CPU+VIC drift: each bar's IRQ handler must reach its
// STA $D020 at the same raster cycle across all four bars, up to the
// main loop's `jmp *` boundary jitter (0-2 cycles on real hardware).
//
// This invariant CANNOT be read from the rendered border. Rasters
// 60/100/140/180 are display lines, so $D020 only shows in the side
// borders (X<32 and X>=352). And because the border color leads the
// graphics by the 12-pixel pipeline delay (Bauer §3.6.1 + §3.9 — the
// border is X-coordinate-gated, the graphics is delayed), a write near
// cycle 57 lands right at the display/right-border boundary: for one bar
// the new color fills the whole right border (transition hidden in the
// display gap), for another it straddles it. "Last old-color pixel" then
// jumps between the left-border edge and the right border — a rendering
// artifact, not drift. So we measure the invariant at its source: the
// raster cycle of each STA $D020. (Consistency only — the absolute cycle
// is the handler's business, not a spec value.)
{
  const prg = buildChainPRG();
  const machine = new C64Machine();
  machine.loadROMs({
    kernal:  fs.readFileSync('roms/kernal.bin'),
    basic:   fs.readFileSync('roms/basic.bin'),
    charRom: fs.readFileSync('roms/chargen.bin'),
  });
  machine.loadPRG(prg);
  for (let i = 0; i < 100; i++) machine.runFrame();   // BASIC startup
  machine.cpu.pc = 0x0810;                             // jump to ML
  for (let i = 0; i < 5; i++) machine.runFrame();      // settle the chain

  // Capture (raster, cycle) of every $D020 write across one steady frame.
  const vic = machine.vic2;
  const writes = [];
  const origWrite = vic.write.bind(vic);
  vic.write = (reg, val) => {
    if ((reg & 0x3F) === 0x20) writes.push({ raster: vic.raster, cyc: vic.cycleInLine });
    return origWrite(reg, val);
  };
  machine.runFrame();
  vic.write = origWrite;

  // One $D020 write per bar IRQ, at four distinct rasters in the bar band.
  const barWrites = writes.filter(w => w.raster >= 55 && w.raster <= 200);
  expect(barWrites.length === 4,
    `expected 4 chained-IRQ $D020 writes per frame, got ${barWrites.length}: ${JSON.stringify(writes)}`);
  if (barWrites.length === 4) {
    const cycles = barWrites.map(w => w.cyc);
    const min = Math.min(...cycles), max = Math.max(...cycles);
    expect(max - min <= 2,
      `the 4 IRQ $D020 writes must land within JMP-loop jitter (≤2 cycles), got ${JSON.stringify(barWrites)}`);
  }
  ok('CPU+VIC: the 4 chained-IRQ $D020 writes land at a consistent cycle (no inter-bar drift)');
}

console.log(`\n${testNo} raster-IRQ-chain CPU+VIC integration tests; ${failing} fail`);
if (failing) process.exit(1);
