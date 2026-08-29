// test/pla-ba-io-read-spec-test.js
//
// Spec guard for the PLA's BA + R/#W gating of I/O reads, from "The C64 PLA
// Dissected" (Giesel), Appendix A intro + the `and ba` term on every #IO READ
// product term (p9/p11/p13/p15):
//
//   "If write accesses by the CPU address the I/O area during [VIC bus
//    takeover], the PLA selects the I/O chips accordingly. But to make sure
//    that the (dummy) read cycles in this phase will never accidentally
//    acknowledge an interrupt, the PLA redirects them to RAM. The signals BA
//    and R/#W are used to identify this situation."
//
// On real hardware, while the VIC has pulled BA low to take the bus, a CPU
// READ in $D000-$DFFF is redirected to RAM so it can't side-effect I/O (e.g.
// clear a CIA ICR flag — $DC0D clears on read — and thereby drop an IRQ).
//
// Our emulator reaches the SAME observable result by a different mechanism:
// the CPU is frozen on RDY during BA-low, so it never performs the dummy I/O
// read at all. This test locks in that invariant as a regression guard:
//
//   No CPU read of an I/O register ($DC0D, the read-clears-ICR case) ever
//   executes while BA is low.
//
// If a future change let the CPU read I/O during BA-low, this fails — which
// would be a real bug (spurious ICR clear / IRQ drop during a bad line).

import fs from 'fs';
import { C64Machine } from '../src/machine.js';

const ROOT = new URL('../roms/', import.meta.url).pathname;
function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const kernal  = tryRead(ROOT + 'kernal.bin');
const basic   = tryRead(ROOT + 'basic.bin');
const chargen = tryRead(ROOT + 'chargen.bin');
if (!kernal || !basic || !chargen) { console.log('# SKIP C64 ROMs not available'); process.exit(0); }

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

const m = new C64Machine();
m.loadROMs({ kernal, basic, charRom: chargen });
m.reset();

// Boot so the KERNAL turns the screen on (DEN=1) → bad lines (BA-low) occur.
for (let f = 0; f < 20; f++) m.runFrame();

// Inject a tight loop that hammers $DC0D:  LDA $DC0D / JMP $C000.
// Reading $DC0D clears the CIA1 ICR on real hardware, so it's the canonical
// "read with an I/O side effect" the PLA protects during BA-low.
m.mem.ram[0xC000] = 0xAD; m.mem.ram[0xC001] = 0x0D; m.mem.ram[0xC002] = 0xDC; // LDA $DC0D
m.mem.ram[0xC003] = 0x4C; m.mem.ram[0xC004] = 0x00; m.mem.ram[0xC005] = 0xC0; // JMP $C000
m.cpu.pc = 0xC000;
m.cpu.I = 1;  // mask IRQs so the loop runs uninterrupted

// Instrument at the I/O CHIP boundary (CIA1), not the CPU bus address — this
// measures the spec observable ("does an I/O register get accessed during
// BA-low") independent of the mechanism (our RDY-freeze vs the PLA's
// redirect-to-RAM). Count reads of the ICR register ($0D) and how many land
// while BA is low; also track whether BA ever went low.
let icrReads = 0, icrDuringBaLow = 0, baEverLow = false;
const origCiaRead = m.cia1.read.bind(m.cia1);
m.cia1.read = function (reg) {
  if ((reg & 0x0F) === 0x0D) {
    icrReads++;
    if (m.vic2.baLow) icrDuringBaLow++;
  }
  return origCiaRead(reg);
};
const origIsBaLow = m.vic2.isBaLow.bind(m.vic2);
m.vic2.isBaLow = function () { const r = origIsBaLow(); if (r) baEverLow = true; return r; };

// Run a few frames spanning many bad lines.
for (let f = 0; f < 4; f++) m.runFrame();

console.log(`Spec[PLA BA/IO]: CIA ICR is never accessed while BA is low...`);
console.log(`    ICR ($DC0D) reads: ${icrReads}; while BA-low: ${icrDuringBaLow}; BA went low: ${baEverLow}`);

// The loop must have run, and bad lines must have happened — otherwise the
// test proves nothing.
assert(icrReads > 100, `loop hammered the ICR (got ${icrReads} reads)`);
assert(baEverLow, 'BA went low during the run (bad lines occurred)');

// THE SPEC OBSERVABLE: the I/O chip (CIA1 ICR) is never accessed by a CPU read
// while BA is low. On real hardware the PLA redirects such reads to RAM (the
// ICR is never touched); in our model the CPU is frozen on RDY (the read never
// issues). Either way the observable holds — the ICR is not side-effected, so
// a dummy read during a bad line can't drop a pending interrupt.
assert(icrDuringBaLow === 0,
  `CIA ICR not accessed while BA is low (got ${icrDuringBaLow}). An access here would ` +
  `clear the ICR and could drop a pending IRQ during a bad line.`);

console.log('ok  – CIA ICR untouched during BA-low (matches PLA BA/R-#W gating)');
console.log('\nPLA BA/IO-read spec test passed.');
