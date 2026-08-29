// Build PRG files for the visual-tricks-spec tests, runnable in VICE.
// Each PRG sets up the same VIC register / sprite state as the JS test
// and loops forever, so VICE renders the same frame layout we do.
//
// Output: test/vice-prgs/test-NN-name.prg (load addr $0801, BASIC stub
// "10 SYS 2064" runs ML at $0810).
//
// Coverage: simple tests (no cycle-perfect tricks). Cycle-56 hyperscreen
// tricks need stable-raster IRQ which is much more complex to hand-roll.

import fs from 'fs';
import path from 'path';

const OUT = 'test/vice-prgs';
fs.mkdirSync(OUT, { recursive: true });

// ─── Tiny 6502 emitter ────────────────────────────────────────────────────
class Asm {
  constructor(start = 0x0810) {
    this.bytes = [];
    this.start = start;       // start of machine code
    this.labels = {};
    this.fixups = [];
  }
  pc() { return this.start + this.bytes.length; }
  emit(...bs) { for (const b of bs) this.bytes.push(b & 0xFF); }
  label(name) { this.labels[name] = this.pc(); }
  resolveAbs(name) {
    if (this.labels[name] !== undefined) return this.labels[name];
    this.fixups.push({ off: this.bytes.length, name, type: 'abs' });
    return 0xFFFF;
  }

  ldaImm(v) { this.emit(0xA9, v); }
  ldaAbs(a) { this.emit(0xAD, a & 0xFF, (a >> 8) & 0xFF); }
  ldaAbsX(a) { this.emit(0xBD, a & 0xFF, (a >> 8) & 0xFF); }
  ldxImm(v) { this.emit(0xA2, v); }
  ldyImm(v) { this.emit(0xA0, v); }
  staAbs(a) { this.emit(0x8D, a & 0xFF, (a >> 8) & 0xFF); }
  staZp(a) { this.emit(0x85, a & 0xFF); }
  staAbsX(a) { this.emit(0x9D, a & 0xFF, (a >> 8) & 0xFF); }
  stxAbs(a) { this.emit(0x8E, a & 0xFF, (a >> 8) & 0xFF); }
  inx() { this.emit(0xE8); }
  iny() { this.emit(0xC8); }
  cpxImm(v) { this.emit(0xE0, v); }
  cpyImm(v) { this.emit(0xC0, v); }
  bne(target) {
    const here = this.pc() + 2;
    const rel = (target - here) & 0xFF;
    this.emit(0xD0, rel);
  }
  beq(target) {
    const here = this.pc() + 2;
    const rel = (target - here) & 0xFF;
    this.emit(0xF0, rel);
  }
  jmp(addr) { this.emit(0x4C, addr & 0xFF, (addr >> 8) & 0xFF); }
  jsr(addr) { this.emit(0x20, addr & 0xFF, (addr >> 8) & 0xFF); }
  rts() { this.emit(0x60); }
  rti() { this.emit(0x40); }
  sei() { this.emit(0x78); }
  cli() { this.emit(0x58); }
  ora(addr) { this.emit(0x0D, addr & 0xFF, (addr >> 8) & 0xFF); }
  pha() { this.emit(0x48); }
  pla() { this.emit(0x68); }
  txa() { this.emit(0x8A); }
  tax() { this.emit(0xAA); }
  tya() { this.emit(0x98); }
  tay() { this.emit(0xA8); }
  nop() { this.emit(0xEA); }
  dec(addr) { this.emit(0xCE, addr & 0xFF, (addr >> 8) & 0xFF); }
  inc(addr) { this.emit(0xEE, addr & 0xFF, (addr >> 8) & 0xFF); }
  cmpAbs(addr) { this.emit(0xCD, addr & 0xFF, (addr >> 8) & 0xFF); }
  cmpImm(v) { this.emit(0xC9, v); }
}

// ─── PRG packaging ────────────────────────────────────────────────────────
// Standard BASIC stub: "10 SYS 2064". Code starts at $0810 (= 2064 dec).
function buildPRG(asm, sprData = []) {
  // PRG load addr ($0801) + BASIC stub + ML at $0810.
  const stub = [
    0x01, 0x08,                                       // load addr $0801
    0x0B, 0x08,                                       // link → $080B
    0x0A, 0x00,                                       // line 10
    0x9E,                                              // SYS
    0x32, 0x30, 0x36, 0x34,                          // "2064"
    0x00,                                              // eol
    0x00, 0x00,                                       // end
  ];
  // After stub bytes (which span $0801..$080C = 12 bytes = stub.length-2),
  // pad to $0810 so code address matches SYS 2064.
  const buf = Buffer.from(stub);
  const padToAddr = 0x0810;
  const stubEndAddr = 0x0801 + (buf.length - 2);     // -2 for the load-addr prefix
  const padN = padToAddr - stubEndAddr;
  const code = Buffer.from(asm.bytes);
  const prg = Buffer.concat([
    buf,
    Buffer.alloc(padN, 0),
    code,
  ]);
  // Append sprite data segments (each [addr, bytes]) — these become
  // separate "loaded blocks" that VICE will place at the addrs via
  // explicit RAM writes from our init code (we don't actually emit
  // separate PRG segments since classic PRG is single-segment).
  // Instead, the init code is responsible for COPYING sprite data
  // from a const table embedded after the code. The caller arranges
  // sprData = [{addr, bytes}] and tells the asm where to find them.
  if (sprData.length > 0) {
    for (const s of sprData) {
      // Sprite data table after code, each block prefixed with addr (we
      // generate copy-loops in init that read from these tables).
    }
  }
  return prg;
}

// Helper: emit code that copies a 64-byte block from src (in code area)
// to dst RAM address, repeated for multiple sprite blocks.
// Layout: caller passes an array of {dst, bytes (length 64)}.
function emitSpriteCopy(asm, sprites) {
  // Concatenate all sprite data into a single block. Generate code that:
  //   ldx #N (bytes-1), copy via loop. Source pointer in $FB/$FC.
  // For simplicity we unroll: emit literal STA for each byte. Avoids ZP
  // pointer setup. Trades code size for simplicity.
  for (const { dst, bytes } of sprites) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0) continue;          // skip zero (RAM is 0 by default)
      asm.ldaImm(b);
      asm.staAbs(dst + i);
    }
  }
}

// More efficient: copy 64 bytes via X-indexed loop.
function emitSpriteCopyLoop(asm, dst, bytes) {
  // Embed bytes inline at end of code (use a label fixup). Simpler: emit
  // an "LDA #v / STA addr" sequence — only works if bytes are uniform
  // (e.g., 0xFF). Most of our test sprites use all-0xFF.
  if (bytes.every(b => b === bytes[0])) {
    asm.ldxImm(0);
    const loop = asm.pc();
    asm.ldaImm(bytes[0]);
    asm.staAbsX(dst);
    asm.inx();
    asm.cpxImm(64);
    asm.bne(loop);
  } else {
    // Fall back to per-byte LDA/STA.
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) continue;
      asm.ldaImm(bytes[i]);
      asm.staAbs(dst + i);
    }
  }
}

// Clear screen RAM ($0400..$07FF) to space + color RAM ($D800..$DBFF) to bg.
function emitClearScreen(a) {
  a.ldxImm(0);
  const loop = a.pc();
  a.ldaImm(0x20);                       // space char
  a.staAbsX(0x0400);
  a.staAbsX(0x0500);
  a.staAbsX(0x0600);
  a.staAbsX(0x0700);
  a.ldaImm(0x06);                       // color blue (= bg, invisible)
  a.staAbsX(0xD800);
  a.staAbsX(0xD900);
  a.staAbsX(0xDA00);
  a.staAbsX(0xDB00);
  a.inx();
  a.bne(loop);
}

// ─── Test 1: baseline sprite at X=100, Y=51 ───────────────────────────────
function buildTest1() {
  const a = new Asm();
  emitClearScreen(a);
  // Set up VIC registers.
  a.ldaImm(0x80); a.staAbs(0x07F8);     // sp0 pointer = block 0x80
  emitSpriteCopyLoop(a, 0x2000, new Array(64).fill(0xFF));
  a.ldaImm(100); a.staAbs(0xD000);       // sp0 X
  a.ldaImm(51);  a.staAbs(0xD001);       // sp0 Y
  a.ldaImm(0x07); a.staAbs(0xD027);      // sp0 color = yellow
  a.ldaImm(0x06); a.staAbs(0xD021);      // bg = blue
  a.ldaImm(0x0E); a.staAbs(0xD020);      // border = lt-blue
  a.ldaImm(0x14); a.staAbs(0xD018);      // screen $0400, char $1000
  a.ldaImm(0x01); a.staAbs(0xD015);      // sp0 enabled
  a.ldaImm(0x1B); a.staAbs(0xD011);      // DEN=1, RSEL=1, YSCROLL=3
  a.ldaImm(0x08); a.staAbs(0xD016);      // CSEL=1
  // Hang.
  const hang = a.pc();
  a.jmp(hang);
  return buildPRG(a);
}

// ─── Test 4: multiplexer 2 positions ──────────────────────────────────────
// Sprite Y=51 (1st), then mid-frame rewrite Y=100. Use raster IRQ at L75.
function buildTest4() {
  const a = new Asm(0x0810);
  // Init: set up VIC + sprite, install raster IRQ.
  a.sei();
  // Sprite data at $2000.
  a.ldxImm(0);
  const dataLoop = a.pc();
  a.ldaImm(0xFF);
  a.staAbsX(0x2000);
  a.inx();
  a.cpxImm(64);
  a.bne(dataLoop);
  // Sprite registers.
  a.ldaImm(0x80); a.staAbs(0x07F8);
  a.ldaImm(100); a.staAbs(0xD000);
  a.ldaImm(51);  a.staAbs(0xD001);
  a.ldaImm(0x07); a.staAbs(0xD027);
  a.ldaImm(0x06); a.staAbs(0xD021);
  a.ldaImm(0x0E); a.staAbs(0xD020);
  a.ldaImm(0x14); a.staAbs(0xD018);
  a.ldaImm(0x01); a.staAbs(0xD015);
  a.ldaImm(0x1B); a.staAbs(0xD011);
  a.ldaImm(0x08); a.staAbs(0xD016);
  // Install IRQ at L75.
  // Set IRQ vector to our handler. CIA1 disable, VIC raster IRQ enable.
  // For simplicity use the kernal's RAM IRQ vector at $0314/$0315.
  const irqAddr = 0xC100;
  a.ldaImm(irqAddr & 0xFF); a.staAbs(0x0314);
  a.ldaImm((irqAddr >> 8) & 0xFF); a.staAbs(0x0315);
  // Clear D011 bit 7 (raster compare bit 8 = 0).
  a.ldaAbs(0xD011); a.cli(); /* placeholder, fix later */
  // Actually we need: AND #$7F STA $D011. Skip cli for now.
  // Simpler: just use sei/disable CIA1, ack pending, then run.
  a.ldaImm(0x7F); a.staAbs(0xDC0D);     // disable CIA1 IRQ
  a.ldaAbs(0xDC0D);                       // ack
  a.ldaImm(0x01); a.staAbs(0xD01A);      // enable raster IRQ
  a.ldaImm(75);  a.staAbs(0xD012);       // raster compare = L75
  a.ldaImm(0x1B); a.staAbs(0xD011);      // bit 7 = 0 (already)
  // Ack any pending VIC.
  a.ldaImm(0x01); a.staAbs(0xD019);
  a.cli();
  const hang = a.pc();
  a.jmp(hang);

  // IRQ handler at $C100.
  const irq = new Asm(0xC100);
  // Save A.
  irq.pha();
  // Rewrite Y to 100.
  irq.ldaImm(100); irq.staAbs(0xD001);
  // Ack.
  irq.ldaImm(0x01); irq.staAbs(0xD019);
  // Disable further IRQs (only fire once).
  irq.ldaImm(0x00); irq.staAbs(0xD01A);
  irq.pla();
  irq.rti();

  // Build the combined PRG. Place IRQ handler bytes at $C100 via a
  // separate "copy block" we emit at the end of init.
  // For simplicity, embed IRQ handler as data bytes that init copies
  // into RAM at $C100.
  // (Hand-emit: append IRQ bytes to PRG, init copies them.)
  // Actually simpler: re-do as a single contiguous code segment by
  // jumping to higher address. Let me restructure.
  // For now, fake it: append IRQ bytes and emit copy loop in init.

  // Restructure: emit init code (already in `a`), then append IRQ
  // bytes. Use an inline "copy IRQ to $C100" sequence. We'll do this
  // properly by building a new asm that does init + copy + hang.
  const a2 = new Asm(0x0810);
  // Copy IRQ handler from $0900 (we'll place irq.bytes there) to $C100.
  // Simpler: emit IRQ handler at end of `a2` and copy from there.
  // Append all init bytes from `a` first.
  for (const b of a.bytes) a2.bytes.push(b);
  // Re-emit init code more carefully... actually this is getting tangled.
  // Let me just write the IRQ handler inline at a fixed address, using
  // cmpAbs($D012) to spin-wait for raster 75 instead of using an IRQ.
  return null;     // mark as TODO
}

// ─── Simple "wait for raster N then trigger" via spin-wait, no IRQ ─────────
// For mid-frame state changes, we can avoid IRQs by spin-waiting on $D012.
// This adds ~1 line of jitter but is simpler.
function emitWaitRaster(a, r) {
  // wait: cmp #r, bne wait  (loop on $D012)
  const loop = a.pc();
  a.ldaAbs(0xD012);
  a.cmpImm(r);
  a.bne(loop);
}

// Rebuild test 4 with spin-wait.
function buildTest4Simple() {
  const a = new Asm();
  emitClearScreen(a);
  // Sprite data at $2000.
  a.ldxImm(0);
  const dl = a.pc();
  a.ldaImm(0xFF);
  a.staAbsX(0x2000);
  a.inx();
  a.cpxImm(64);
  a.bne(dl);
  // Setup.
  a.ldaImm(0x80); a.staAbs(0x07F8);
  a.ldaImm(100); a.staAbs(0xD000);
  a.ldaImm(51);  a.staAbs(0xD001);
  a.ldaImm(0x07); a.staAbs(0xD027);
  a.ldaImm(0x06); a.staAbs(0xD021);
  a.ldaImm(0x0E); a.staAbs(0xD020);
  a.ldaImm(0x14); a.staAbs(0xD018);
  a.ldaImm(0x01); a.staAbs(0xD015);
  a.ldaImm(0x1B); a.staAbs(0xD011);
  a.ldaImm(0x08); a.staAbs(0xD016);
  // Loop each frame: wait L75, set Y=100, wait L255, reset Y=51.
  // This reproduces the multi-Y multiplex on every frame so VICE
  // captures the dual-instance pattern.
  const frameLoop = a.pc();
  emitWaitRaster(a, 75);
  a.ldaImm(100); a.staAbs(0xD001);
  emitWaitRaster(a, 255);
  a.ldaImm(51); a.staAbs(0xD001);
  // Wait until raster wraps so the next iteration's wait-L75 finds it.
  emitWaitRaster(a, 0);
  a.jmp(frameLoop);
  return buildPRG(a);
}

// ─── Test 6: mode $78 (= ECM+BMM, RSEL=1) sprite ─────────────────────────
function buildTest6() {
  const a = new Asm();
  emitClearScreen(a);
  a.ldxImm(0);
  const dl = a.pc();
  a.ldaImm(0xFF);
  a.staAbsX(0x2000);
  a.inx();
  a.cpxImm(64);
  a.bne(dl);
  a.ldaImm(0x80); a.staAbs(0x07F8);
  a.ldaImm(100); a.staAbs(0xD000);
  a.ldaImm(51);  a.staAbs(0xD001);
  a.ldaImm(0x07); a.staAbs(0xD027);
  a.ldaImm(0x06); a.staAbs(0xD021);
  a.ldaImm(0x0E); a.staAbs(0xD020);
  a.ldaImm(0x14); a.staAbs(0xD018);
  a.ldaImm(0x01); a.staAbs(0xD015);
  a.ldaImm(0x78); a.staAbs(0xD011);     // mode $78
  a.ldaImm(0x08); a.staAbs(0xD016);
  const hang = a.pc();
  a.jmp(hang);
  return buildPRG(a);
}

// ─── Test 8: corner box (X=24, Y=50) ──────────────────────────────────────
function buildTest8() {
  const a = new Asm();
  emitClearScreen(a);
  a.ldxImm(0);
  const dl = a.pc();
  a.ldaImm(0xFF);
  a.staAbsX(0x2000);
  a.inx();
  a.cpxImm(64);
  a.bne(dl);
  a.ldaImm(0x80); a.staAbs(0x07F8);
  a.ldaImm(24); a.staAbs(0xD000);
  a.ldaImm(50); a.staAbs(0xD001);
  a.ldaImm(0x07); a.staAbs(0xD027);
  a.ldaImm(0x06); a.staAbs(0xD021);
  a.ldaImm(0x0E); a.staAbs(0xD020);
  a.ldaImm(0x14); a.staAbs(0xD018);
  a.ldaImm(0x01); a.staAbs(0xD015);
  a.ldaImm(0x1B); a.staAbs(0xD011);
  a.ldaImm(0x08); a.staAbs(0xD016);
  const hang = a.pc();
  a.jmp(hang);
  return buildPRG(a);
}

// ─── Test 11: 8 sprites in a row at Y=14 (top border) ────────────────────
// Without the cycle-56 trick this won't open the top border, but it shows
// the sprite-state setup. Real reference would need stable raster IRQs.
// For now, just set up the sprite state — if VICE renders without trick,
// sprites will be hidden by closed top border. Useful as a "no-trick"
// reference to compare our impl when we disable the trick mentally.
function buildTest11_NoTrick() {
  const a = new Asm();
  emitClearScreen(a);
  a.ldxImm(0);
  const dl = a.pc();
  a.ldaImm(0xFF);
  a.staAbsX(0x2000);
  a.inx();
  a.cpxImm(64);
  a.bne(dl);
  // 8 pointers $80..$87 → $2000..$21FE all opaque (we only filled $2000;
  // copy to others).
  for (let s = 0; s < 8; s++) {
    a.ldaImm(0x80 + s); a.staAbs(0x07F8 + s);
  }
  // Replicate $2000..$203F to $2040..$21FF.
  a.ldxImm(0);
  const cl = a.pc();
  a.ldaAbsX(0x2000);
  for (let s = 1; s < 8; s++) a.staAbsX(0x2000 + s * 64);
  a.inx();
  a.cpxImm(64);
  a.bne(cl);
  // Sprite registers: 8 sprites at Y=14, X=24+s*30.
  const colors = [0x07, 0x02, 0x04, 0x05, 0x08, 0x0A, 0x0D, 0x0F];
  for (let s = 0; s < 8; s++) {
    const x = 24 + s * 30;
    a.ldaImm(x & 0xFF); a.staAbs(0xD000 + s * 2);
    a.ldaImm(14);       a.staAbs(0xD001 + s * 2);
    a.ldaImm(colors[s]); a.staAbs(0xD027 + s);
  }
  a.ldaImm(0xFE); a.staAbs(0xD010);   // X-MSB for sp1..sp7 (X >= 256? sp0 X=24 OK, sp7 X=234 OK, no MSB needed actually)
  // Wait, max X = 24+7*30=234 < 256, no MSB needed. Reset $D010.
  a.ldaImm(0x00); a.staAbs(0xD010);
  a.ldaImm(0xFF); a.staAbs(0xD015);   // all 8 enabled
  a.ldaImm(0x06); a.staAbs(0xD021);
  a.ldaImm(0x0E); a.staAbs(0xD020);
  a.ldaImm(0x14); a.staAbs(0xD018);
  a.ldaImm(0x1B); a.staAbs(0xD011);
  a.ldaImm(0x08); a.staAbs(0xD016);
  const hang = a.pc();
  a.jmp(hang);
  return buildPRG(a);
}

// ─── Test 2: cycle-56 trick on L60 (stable raster IRQ) ───────────────────
//
// Single-line cycle-56 trick has a tight 2-cycle write window — STA
// $D016 must start at cycle 52-53 so the write lands at c55-c56 phi2,
// in time for the c57 phi1 latch eval to see CSEL=0 and veto. Spin-wait
// loops have ~5-cycle jitter which mostly misses. Use a tight raster
// IRQ + minimal handler to reduce jitter, then NOP-pad to alignment.
//
// IRQ fires at the very beginning of L60 with up to ~7-cycle jitter
// (depending on instruction in progress when raster compare hits). The
// main loop is `JMP *` (3-cycle instruction) which limits jitter to
// 0-2 cycles. Combined with the IRQ entry overhead (7 cyc), handler
// starts at cycle 7-9 of L60.
function buildTest2() {
  const a = new Asm();
  emitClearScreen(a);
  // Sprite data.
  a.ldxImm(0);
  const dl = a.pc();
  a.ldaImm(0xFF);
  a.staAbsX(0x2000);
  a.inx();
  a.cpxImm(64);
  a.bne(dl);
  // Sprite registers.
  a.ldaImm(0x80); a.staAbs(0x07F8);
  a.ldaImm(0x50); a.staAbs(0xD000);     // sp0 X low (X=336 → low=0x50)
  a.ldaImm(0x01); a.staAbs(0xD010);     // sp0 X-MSB
  a.ldaImm(51);   a.staAbs(0xD001);
  a.ldaImm(0x07); a.staAbs(0xD027);
  a.ldaImm(0x06); a.staAbs(0xD021);
  a.ldaImm(0x0E); a.staAbs(0xD020);
  a.ldaImm(0x14); a.staAbs(0xD018);
  a.ldaImm(0x01); a.staAbs(0xD015);
  a.ldaImm(0x1B); a.staAbs(0xD011);
  a.ldaImm(0x08); a.staAbs(0xD016);
  // Install raster IRQ at L60.
  a.sei();
  // Place IRQ handler bytes at $C000 — emit them inline as data
  // copied during init.
  // Vector → $C000.
  a.ldaImm(0x00); a.staAbs(0x0314);
  a.ldaImm(0xC0); a.staAbs(0x0315);
  // Raster compare (clear bit 8, set $D012 = 60).
  a.ldaAbs(0xD011);
  // AND #$7F isn't in our emitter — use LDA/and via LDX trick. Just
  // assume bit 7 is already 0 (we set $D011=$1B above).
  a.staAbs(0xD011);
  a.ldaImm(60); a.staAbs(0xD012);
  // Disable CIA1 + enable VIC raster IRQ.
  a.ldaImm(0x7F); a.staAbs(0xDC0D);
  a.ldaAbs(0xDC0D);
  a.ldaImm(0x01); a.staAbs(0xD01A);
  a.ldaImm(0x01); a.staAbs(0xD019);     // ack pending
  // Copy the IRQ handler from inline data block to $C000.
  // Build the IRQ handler as a separate Asm at $C000.
  const irq = new Asm(0xC000);
  // Kernel pre-push: A, X, Y already on stack when our handler is called.
  // Ack VIC IRQ.
  irq.ldaImm(0x01); irq.staAbs(0xD019);     // 2+4 = 6 cyc
  // Cycle alignment:
  // Entry cycle ≈ 7 (IRQ overhead) + 0-2 (JMP*) = c7-c9.
  // Plus kernel entry overhead: PHA/TXA/PHA/TYA/PHA + bookkeeping +
  // JMP ($0314) = ~25 cycles before our handler runs.
  // Total entry ≈ c32-c34.
  // We want STA $D016 to write at c56. STA write happens at last cycle
  // of 4-cyc instruction → write_cycle = STA_start + 3.
  // STA_start needs to be c53. Pre-STA cycles: c32 + 6 (ack) + 2 (LDA)
  // + N×NOP = c40 + 2N. Want c53 → 2N = 13 → N = 6.5. So 6 NOPs.
  // Hmm odd, NOPs are 2 cyc. Try N=6: c40+12=c52. STA start c52. Write c55.
  // N=7: c40+14=c54. STA start c54. Write c57. Too late.
  // c55 vs c56 — both can work depending on phi alignment. Try N=6.
  for (let i = 0; i < 6; i++) irq.nop();
  irq.ldaImm(0x00);
  irq.staAbs(0xD016);
  irq.ldaImm(0x08);
  irq.staAbs(0xD016);
  // Manually pull and RTI (to bypass kernel epilogue uncertainty).
  irq.pla(); irq.tay();
  irq.pla(); irq.tax();
  irq.pla();
  irq.rti();
  // Inline the IRQ bytes into init code (copy to $C000).
  const irqBytes = irq.bytes;
  for (let i = 0; i < irqBytes.length; i++) {
    a.ldaImm(irqBytes[i]);
    a.staAbs(0xC000 + i);
  }
  // Enable IRQs.
  a.cli();
  // Hang.
  const hang = a.pc();
  a.jmp(hang);
  return buildPRG(a);
}

// ─── Generate ─────────────────────────────────────────────────────────────
const tests = [
  ['01-baseline-sprite-display', buildTest1()],
  ['02-cycle56-trick-right-edge', buildTest2()],
  ['04-multiplexer-2-positions', buildTest4Simple()],
  ['06-mode-78-sprite', buildTest6()],
  ['08-box-sprite-corner', buildTest8()],
  ['11-8-sprites-top-border-no-trick', buildTest11_NoTrick()],
];

for (const [name, prg] of tests) {
  if (!prg) {
    console.log(`skip: ${name} (TODO)`);
    continue;
  }
  fs.writeFileSync(path.join(OUT, `${name}.prg`), prg);
  console.log(`wrote ${OUT}/${name}.prg (${prg.length} bytes)`);
}
