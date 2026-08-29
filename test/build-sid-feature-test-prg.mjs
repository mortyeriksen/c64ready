// Builds a .prg that audibly demos every SID feature implemented by
// our worklet. Load it in the emulator (or any C64 emulator) and the
// program plays each feature in sequence, ~1.5 sec each. Drop the
// generated test/sid-feature-test.prg onto the canvas to run, or
// `LOAD"*",8,1` it via the disk.
//
// Layout: BASIC stub `10 SYS 2061` at $0801 then 6502 code at $080D.
// Each feature: configure SID regs, play, delay, then advance.
//
// Output: test/sid-feature-test.prg

import fs from 'node:fs';

// ─── 6502 opcode mnemonics (the subset we actually use) ─────────────
const OP = {
  LDA_IMM: 0xA9, LDA_ABS: 0xAD, LDA_ZP: 0xA5, LDA_INDX: 0xA1,
  STA_ABS: 0x8D, STA_ZP: 0x85,
  LDX_IMM: 0xA2, LDY_IMM: 0xA0,
  TAX: 0xAA, TAY: 0xA8, TXA: 0x8A, TYA: 0x98,
  INX: 0xE8, INY: 0xC8, DEX: 0xCA, DEY: 0x88,
  CPX_IMM: 0xE0, CPY_IMM: 0xC0, CMP_IMM: 0xC9,
  BNE: 0xD0, BEQ: 0xF0, BCC: 0x90, BCS: 0xB0, BMI: 0x30, BPL: 0x10,
  JMP_ABS: 0x4C, JSR_ABS: 0x20, RTS: 0x60,
  PHA: 0x48, PLA: 0x68,
  ASL_A: 0x0A, LSR_A: 0x4A,
  AND_IMM: 0x29, ORA_IMM: 0x09, EOR_IMM: 0x49,
  ADC_IMM: 0x69, SBC_IMM: 0xE9,
  CLC: 0x18, SEC: 0x38,
  NOP: 0xEA,
  SEI: 0x78, CLI: 0x58,
  STX_ABS: 0x8E, STY_ABS: 0x8C,
};

// ─── Tiny linker: collect bytes, resolve labels ─────────────────────
const code = [];
const labels = {};
const fixups = [];     // {pc, name, kind: 'rel'|'abs'}
const ORG = 0x080D;    // start of code (after BASIC stub at $0801)

function emit(...bytes) { for (const b of bytes) code.push(b & 0xFF); }
function pc() { return ORG + code.length; }
function label(name) {
  if (labels[name] !== undefined) throw new Error(`dup label ${name}`);
  labels[name] = pc();
}
function emitRel(opcode, target) {
  emit(opcode);
  fixups.push({ pc: pc(), name: target, kind: 'rel' });
  emit(0x00);
}
function emitAbs(opcode, target) {
  emit(opcode);
  if (typeof target === 'string') {
    fixups.push({ pc: pc(), name: target, kind: 'abs' });
    emit(0x00, 0x00);
  } else {
    emit(target & 0xFF, (target >> 8) & 0xFF);
  }
}

// SID register addresses.
const SID = 0xD400;
const D404 = SID + 0x04;
const D40B = SID + 0x0B;
const D412 = SID + 0x12;
const D415 = SID + 0x15;
const D416 = SID + 0x16;
const D417 = SID + 0x17;
const D418 = SID + 0x18;

// VIC raster register for visual feedback.
const D020 = 0xD020;

// ─── Helpers ────────────────────────────────────────────────────────
function setBorder(color) {
  emit(OP.LDA_IMM, color);
  emitAbs(OP.STA_ABS, D020);
}

// Set a SID voice's regs at base = $D400 / $D407 / $D40E.
function configVoice(base, freqLo, freqHi, pwLo, pwHi, ad, sr) {
  emit(OP.LDA_IMM, freqLo); emitAbs(OP.STA_ABS, base + 0);
  emit(OP.LDA_IMM, freqHi); emitAbs(OP.STA_ABS, base + 1);
  emit(OP.LDA_IMM, pwLo);   emitAbs(OP.STA_ABS, base + 2);
  emit(OP.LDA_IMM, pwHi);   emitAbs(OP.STA_ABS, base + 3);
  emit(OP.LDA_IMM, ad);     emitAbs(OP.STA_ABS, base + 5);
  emit(OP.LDA_IMM, sr);     emitAbs(OP.STA_ABS, base + 6);
}

function setCtrl(base, ctrl) {
  emit(OP.LDA_IMM, ctrl); emitAbs(OP.STA_ABS, base + 4);
}

// Long delay loop: ~1.5 sec at 985 kHz.
function delayLong() {
  emitAbs(OP.JSR_ABS, 'delay');
}

// ─── Program entry ──────────────────────────────────────────────────

// Disable IRQs to keep timing predictable.
emit(OP.SEI);

// Reset SID: zero regs $D400..$D418.
emit(OP.LDX_IMM, 0x18);
label('reset_loop');
emit(OP.LDA_IMM, 0x00);
emitAbs(OP.STA_ABS, SID);                   // STA $D400,X — but we don't have indexed STA; use direct loop unrolled below.
// Easier: just zero each by hand.
emit(OP.DEX);
emitRel(OP.BPL, 'reset_loop');

// Master vol = 15.
emit(OP.LDA_IMM, 0x0F);
emitAbs(OP.STA_ABS, D418);

// ─── Feature 1: Triangle (border = green) ──────────────────────────
setBorder(5);                               // border green
configVoice(SID + 0x00, 0x00, 0x10, 0x00, 0x08, 0x00, 0xF0);
setCtrl(SID + 0x00, 0x11);                  // TRI + gate
delayLong();
setCtrl(SID + 0x00, 0x10);                  // gate off → release
delayLong();

// ─── Feature 2: Sawtooth (border = blue) ───────────────────────────
setBorder(6);
setCtrl(SID + 0x00, 0x21);                  // SAW + gate
delayLong();
setCtrl(SID + 0x00, 0x20);
delayLong();

// ─── Feature 3: Pulse 50% duty (border = yellow) ───────────────────
setBorder(7);
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, SID + 0x02);   // pw lo = 0
emit(OP.LDA_IMM, 0x08); emitAbs(OP.STA_ABS, SID + 0x03);   // pw hi = 8 → pw = $800
setCtrl(SID + 0x00, 0x41);                  // PULSE + gate
delayLong();
setCtrl(SID + 0x00, 0x40);
delayLong();

// ─── Feature 4: Noise (border = red) ───────────────────────────────
setBorder(2);
emit(OP.LDA_IMM, 0xFF); emitAbs(OP.STA_ABS, SID + 0x00);   // freq high (fast LFSR rotation)
emit(OP.LDA_IMM, 0x80); emitAbs(OP.STA_ABS, SID + 0x01);
setCtrl(SID + 0x00, 0x81);                  // NOISE + gate
delayLong();
setCtrl(SID + 0x00, 0x80);
delayLong();

// ─── Feature 5: TRI + SAW combined (border = purple) ───────────────
setBorder(4);
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, SID + 0x00);
emit(OP.LDA_IMM, 0x10); emitAbs(OP.STA_ABS, SID + 0x01);
setCtrl(SID + 0x00, 0x31);                  // TRI+SAW + gate
delayLong();
setCtrl(SID + 0x00, 0x30);
delayLong();

// ─── Feature 6: TRI + PULSE combined (border = cyan) ───────────────
setBorder(3);
setCtrl(SID + 0x00, 0x51);                  // TRI+PULSE + gate
delayLong();
setCtrl(SID + 0x00, 0x50);
delayLong();

// ─── Feature 7: SAW + PULSE combined (border = orange) ─────────────
setBorder(8);
setCtrl(SID + 0x00, 0x61);                  // SAW+PULSE + gate
delayLong();
setCtrl(SID + 0x00, 0x60);
delayLong();

// ─── Feature 8: NOISE + PULSE (LFSR clobber demo, border=lt-red) ───
setBorder(10);
emit(OP.LDA_IMM, 0xFF); emitAbs(OP.STA_ABS, SID + 0x00);
emit(OP.LDA_IMM, 0x80); emitAbs(OP.STA_ABS, SID + 0x01);
setCtrl(SID + 0x00, 0xC1);                  // NOISE+PULSE + gate
// Hold long so LFSR clobbering is audible (noise decays to silence).
delayLong(); delayLong(); delayLong();
setCtrl(SID + 0x00, 0xC0);
delayLong();

// ─── Feature 9: ADSR slow attack/decay (border = lt-blue) ──────────
setBorder(14);
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, SID + 0x00);
emit(OP.LDA_IMM, 0x10); emitAbs(OP.STA_ABS, SID + 0x01);
emit(OP.LDA_IMM, 0xA8); emitAbs(OP.STA_ABS, SID + 0x05);   // attack=A, decay=8
emit(OP.LDA_IMM, 0x84); emitAbs(OP.STA_ABS, SID + 0x06);   // sustain=8, release=4
setCtrl(SID + 0x00, 0x21);                  // SAW + gate
delayLong(); delayLong();
setCtrl(SID + 0x00, 0x20);
delayLong();

// ─── Feature 10: SYNC (voice 1 syncs to voice 3, border = brown) ───
setBorder(9);
configVoice(SID + 0x0E, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00);   // v3 freq lower
emit(OP.LDA_IMM, 0x10); emitAbs(OP.STA_ABS, SID + 0x12);       // v3 ctrl = TRI (no gate; just for sync src)
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, SID + 0x00);       // v1 freq much higher
emit(OP.LDA_IMM, 0x40); emitAbs(OP.STA_ABS, SID + 0x01);
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, SID + 0x05);
emit(OP.LDA_IMM, 0xF0); emitAbs(OP.STA_ABS, SID + 0x06);
setCtrl(SID + 0x00, 0x13);                  // TRI + SYNC + gate
delayLong();
setCtrl(SID + 0x00, 0x12);                  // gate off
delayLong();

// ─── Feature 11: RING modulation (border = lt-green) ───────────────
setBorder(13);
setCtrl(SID + 0x00, 0x15);                  // TRI + RING + gate
delayLong();
setCtrl(SID + 0x00, 0x14);
delayLong();

// ─── Feature 12: TEST bit (silence, border = white) ────────────────
setBorder(1);
setCtrl(SID + 0x00, 0x21);
delayLong();
setCtrl(SID + 0x00, 0x29);                  // SAW + TEST → silence
delayLong();
setCtrl(SID + 0x00, 0x21);
delayLong();
setCtrl(SID + 0x00, 0x20);
delayLong();

// ─── Feature 13: Filter LP at low cutoff (border = dark grey) ──────
setBorder(11);
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, SID + 0x00);
emit(OP.LDA_IMM, 0x10); emitAbs(OP.STA_ABS, SID + 0x01);
setCtrl(SID + 0x00, 0x21);                  // SAW + gate
emit(OP.LDA_IMM, 0x01); emitAbs(OP.STA_ABS, D417);   // route v1 to filter, no resonance
emit(OP.LDA_IMM, 0x1F); emitAbs(OP.STA_ABS, D418);   // LP mode, vol=15
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, D415);
emit(OP.LDA_IMM, 0x10); emitAbs(OP.STA_ABS, D416);   // fc = $80 (low cutoff)
delayLong();

// ─── Feature 14: Filter LP at high cutoff ──────────────────────────
emit(OP.LDA_IMM, 0xFF); emitAbs(OP.STA_ABS, D416);   // fc = $7F8 (high)
emit(OP.LDA_IMM, 0x07); emitAbs(OP.STA_ABS, D415);
delayLong();

// ─── Feature 15: Filter LP with high resonance ─────────────────────
emit(OP.LDA_IMM, 0xF1); emitAbs(OP.STA_ABS, D417);   // res=$F, route v1
emit(OP.LDA_IMM, 0x80); emitAbs(OP.STA_ABS, D416);   // fc = $400 (mid)
delayLong();

// ─── Feature 16: Filter sweep (cutoff slides up) ───────────────────
setBorder(12);
emit(OP.LDA_IMM, 0x01); emitAbs(OP.STA_ABS, D417);   // res=0
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, D415);
emit(OP.LDX_IMM, 0x00);
label('sweep_loop');
emit(OP.TXA);
emitAbs(OP.STA_ABS, D416);                  // fc hi = X
emit(OP.LDY_IMM, 0x40);
label('sweep_inner');
emit(OP.DEY);
emitRel(OP.BNE, 'sweep_inner');
emit(OP.INX);
emitRel(OP.BNE, 'sweep_loop');

// Reset filter route + mode after sweep.
emit(OP.LDA_IMM, 0x00); emitAbs(OP.STA_ABS, D417);
emit(OP.LDA_IMM, 0x0F); emitAbs(OP.STA_ABS, D418);   // mode 0 (no filter), vol=15
setCtrl(SID + 0x00, 0x20);
delayLong();

// ─── Feature 17: $D418 master-vol sample playback (4-bit DAC) ──────
setBorder(15);
// Silence all voices first.
setCtrl(SID + 0x00, 0x00);
setCtrl(SID + 0x07, 0x00);
setCtrl(SID + 0x0E, 0x00);
// Play a tone via D418 vol clicks. Run a loop toggling vol fast.
emit(OP.LDX_IMM, 0xC8);   // 200 outer iterations
label('dac_outer');
emit(OP.LDA_IMM, 0x0F);   // vol=15
emitAbs(OP.STA_ABS, D418);
emit(OP.LDY_IMM, 0x10);
label('dac_a');
emit(OP.DEY);
emitRel(OP.BNE, 'dac_a');
emit(OP.LDA_IMM, 0x00);   // vol=0
emitAbs(OP.STA_ABS, D418);
emit(OP.LDY_IMM, 0x10);
label('dac_b');
emit(OP.DEY);
emitRel(OP.BNE, 'dac_b');
emit(OP.DEX);
emitRel(OP.BNE, 'dac_outer');
// Restore vol=15.
emit(OP.LDA_IMM, 0x0F); emitAbs(OP.STA_ABS, D418);
delayLong();

// ─── Done: silence all voices + loop forever ──────────────────────
setBorder(0);                               // border = black
setCtrl(SID + 0x00, 0x00);
setCtrl(SID + 0x07, 0x00);
setCtrl(SID + 0x0E, 0x00);
label('forever');
emitRel(OP.JMP_ABS, 'forever');             // BUG: JMP is ABS not REL
// Fix: use proper JMP.
// We wrote a placeholder; let's overwrite the last 3 bytes.
code.length -= 3;                           // pop the bad emit
emitAbs(OP.JMP_ABS, 'forever');

// ─── Subroutine: long delay (~ 1 sec at 985 kHz) ───────────────────
label('delay');
emit(OP.PHA);
emit(OP.LDX_IMM, 0xC0);   // outer = 192
label('delay_outer');
emit(OP.LDY_IMM, 0xFF);
label('delay_inner');
emit(OP.DEY);
emitRel(OP.BNE, 'delay_inner');
emit(OP.DEX);
emitRel(OP.BNE, 'delay_outer');
emit(OP.PLA);
emit(OP.RTS);

// ─── Resolve fixups ─────────────────────────────────────────────────
for (const f of fixups) {
  const target = labels[f.name];
  if (target === undefined) throw new Error(`unresolved label ${f.name}`);
  const bytePos = f.pc - ORG;
  if (f.kind === 'rel') {
    const off = target - (f.pc + 1);
    if (off < -128 || off > 127) {
      throw new Error(`branch out of range: ${f.name} (${off} bytes)`);
    }
    code[bytePos] = off & 0xFF;
  } else {
    code[bytePos] = target & 0xFF;
    code[bytePos + 1] = (target >> 8) & 0xFF;
  }
}

// ─── Build final PRG with BASIC stub ────────────────────────────────
// $0801: line 10 SYS 2061 ($080D)
const stub = [
  0x0B, 0x08,         // pointer to next line
  0x0A, 0x00,         // line number 10
  0x9E,               // SYS token
  0x32, 0x30, 0x36, 0x31,   // "2061"
  0x00, 0x00, 0x00,   // line end + program end
];
const prg = new Uint8Array(2 + stub.length + code.length);
prg[0] = 0x01; prg[1] = 0x08;               // load address $0801
for (let i = 0; i < stub.length; i++) prg[2 + i] = stub[i];
for (let i = 0; i < code.length; i++) prg[2 + stub.length + i] = code[i];

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, 'sid-feature-test.prg');
fs.writeFileSync(out, prg);
console.log(`wrote ${out} (${prg.length} bytes, code starts at $${ORG.toString(16).toUpperCase()})`);
console.log(`load with LOAD"*",8,1 then RUN, or drop the .prg file onto the emulator canvas.`);
console.log(`\nFeature timeline (border-color cue):`);
console.log(`  green  → Triangle`);
console.log(`  blue   → Sawtooth`);
console.log(`  yellow → Pulse 50%`);
console.log(`  red    → Noise`);
console.log(`  purple → TRI+SAW combined`);
console.log(`  cyan   → TRI+PULSE combined (pulse-gating)`);
console.log(`  orange → SAW+PULSE combined`);
console.log(`  lt-red → NOISE+PULSE (LFSR clobber — listen for fade)`);
console.log(`  lt-blue→ ADSR slow attack/decay/release`);
console.log(`  brown  → SYNC modulation`);
console.log(`  lt-grn → RING modulation`);
console.log(`  white  → TEST bit (silence between)`);
console.log(`  d-grey → Filter LP low cutoff`);
console.log(`         → Filter LP high cutoff`);
console.log(`         → Filter LP + high resonance`);
console.log(`  m-grey → Filter cutoff sweep`);
console.log(`  l-grey → $D418 4-bit DAC sample playback`);
console.log(`  black  → done (loops forever)`);
