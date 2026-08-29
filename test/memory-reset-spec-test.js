// test/memory-reset-spec-test.js
// Regression test for the soft-reset hang fixed in 99a16a5.
//
// Memory.read/write use a per-page dispatch table that's rebuilt on
// cpuPort changes. reset() reverts cpuPort to its default (0x37) but
// must also rebuild the table — otherwise a pre-reset banking
// configuration that hid KERNAL (e.g. a demo writing $30 to $01)
// would persist in the table, the CPU's $FFFC/$FFFD reset-vector
// fetch would read RAM garbage instead of KERNAL ROM, and the
// machine would jump to a random address and hang.

import { Memory } from '../src/memory.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const m = new Memory();
m.kernal  = new Uint8Array(8192).fill(0xEE);  // $E000-$FFFF when visible
m.basic   = new Uint8Array(8192).fill(0xBB);
m.charRom = new Uint8Array(4096).fill(0xCC);

// Plant a recognizable RAM byte under the KERNAL window.
m.ram[0xFFFC] = 0x42;
m.ram[0xFFFD] = 0x43;

// Raw power-up: DDR=$00, latch=$00. With every bank bit an INPUT the
// external pull-ups force LORAM/HIRAM/CHAREN=1 → KERNAL visible. (The
// effective $01 read here is $17.)
assert(m.read(0xFFFC) === 0xEE, 'baseline: KERNAL visible at $FFFC under power-up pull-ups');

// To actually drive the bank bits from the latch we must make them
// OUTPUTS first — raw reset DDR is $00 (inputs), so the latch is ignored
// for banking until DDR is raised. This mirrors what real software (and
// the KERNAL) does: write DDR=$2F, then write $01.
m.cpuDDR = 0x2F;                 // bits 0-3 + 5 output (post-KERNAL DDR)
// Now a port value with HIRAM=0 actually hides KERNAL — RAM shows through.
m.write(0x01, 0x30);
assert(m.read(0xFFFC) === 0x42, 'HIRAM=0 (DDR drives bits): RAM visible at $FFFC');
assert(m.read(0xFFFD) === 0x43, 'HIRAM=0 (DDR drives bits): RAM visible at $FFFD');

// Soft reset — should restore default banking AND rebuild the dispatch
// table. reset() reverts the 6510 port to its silicon power-up state
// (DDR=$00, latch=$00). With DDR=$00 the pull-ups force the bank bits
// back to 1, so KERNAL is reachable again at the $FFFC/$FFFD reset
// vector. Without the table rebuild, $FFFC would still resolve to RAM
// (the prior HIRAM=0 config) and the CPU would jump to garbage.
m.reset();

assert(m.cpuPort === 0x00, 'reset restores cpuPort to power-up $00');
assert(m.cpuDDR === 0x00, 'reset restores cpuDDR to power-up $00 (all inputs)');
assert(m.read(0x01) === 0x17,
  `reset: $01 reads $17 via pull-ups + SENSE (got $${m.read(0x01).toString(16)})`);
assert(m.read(0xFFFC) === 0xEE,
  `KERNAL visible at $FFFC after reset (got $${m.read(0xFFFC).toString(16)} — dispatch table not rebuilt?)`);
assert(m.read(0xFFFD) === 0xEE, 'KERNAL visible at $FFFD after reset');

// Also verify BASIC ($A000-$BFFF, gated on LORAM&HIRAM) and CHARROM
// ($D000 with CHAREN=0) are correctly remapped. Pull-ups give LORAM=
// HIRAM=CHAREN=1 (= I/O at $D000), so BASIC is visible; to expose CHARROM
// we must drive CHAREN=0, which means raising DDR first.
assert(m.read(0xA000) === 0xBB, 'BASIC visible at $A000 after reset');
m.cpuDDR = 0x2F;      // drive the bank bits from the latch again
m.write(0x01, 0x33);  // CHAREN=0 → CHARROM at $D000
assert(m.read(0xD000) === 0xCC, 'CHARROM visible at $D000 after CHAREN=0 write');

console.log('ok  - soft reset rebuilds memory dispatch table');
