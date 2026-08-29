// test/iec-inter-block-handshake-spec-test.js
//
// Sparkle's multi-block fast loader uses the IEC bus state during inter-block
// handshakes (see Sparkle v1.5 source, drive code at $0575-$057C, and C64 code
// at $01B5+). The "drive busy/ready" signal is encoded in the wired-AND state
// of DATA + ATN, with the drive's auto-DATA-on-ATN (PB4 ATNA bit) logic.
//
// What's already covered elsewhere (intentionally NOT re-tested here):
//   - drive-test.js lines 53-95: PB4-ATNA XOR ATN_bus 4-quadrant truth table
//   - drive-test.js lines 824-836: ATN-asserted → auto-DATA-pull
//   - iec-handshake-test.js: ATN-edge → CA1 IRQ, atnIn tracking 50 edges
//   - nosdos-bootstrap-test.js: standard CBM-serial via _atna_pin XOR atnIn
//
// What this file adds (specifically for Sparkle's inter-block handshake bug
// found in the Aloft investigation):
//   1. Bus-state ROUND-TRIP at the machine level: drive sets AA=1 ("drive
//      busy" per Sparkle), C64 reads $DD00 — C64 must see DATA bit reflect
//      the wired-AND of drive-pulled DATA via ATNA XOR.
//   2. Drive's poll of $1800 sees live bus state on EVERY read (memory
//      every-read re-sync requirement) — not just after C64 writes.
//   3. Inter-block trigger sequence: drive AA=1, C64 toggles ATN, drive's
//      DATA OUT and bus state both update via the XOR.
//   4. C64's $DD00 input bits (PA6 CLK IN, PA7 DATA IN) honor the bus
//      wired-AND across both sides' OUT pins, even with rapid toggling.

import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { D64 } from '../src/d64.js';

const ROOT = new URL('../roms/', import.meta.url).pathname;
function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const kernal  = tryRead(ROOT + 'kernal.bin');
const basic   = tryRead(ROOT + 'basic.bin');
const chargen = tryRead(ROOT + 'chargen.bin');
const drvRom  = tryRead(ROOT + '1541.bin');

if (!kernal || !basic || !chargen || !drvRom) {
  console.log('# SKIP C64/1541 ROMs not available under roms/');
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function buildEmptyD64() {
  const d = new Uint8Array(174848);
  const bamOff = 17 * 21 * 256;
  d[bamOff + 0] = 18; d[bamOff + 1] = 1; d[bamOff + 2] = 0x41;
  d[bamOff + 0xA2] = 0x30; d[bamOff + 0xA3] = 0x30;
  const dirOff = (17 * 21 + 1) * 256;
  d[dirOff + 0] = 0; d[dirOff + 1] = 0xFF;
  return d;
}

function makeMachine() {
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.setD64(new D64(buildEmptyD64()));
  m.reset();
  for (let f = 0; f < 2; f++) m.runFrame();
  return m;
}

// Configure CIA2 so PA3 (ATN OUT), PA4 (CLK OUT), PA5 (DATA OUT) are
// outputs and PA6/PA7 are inputs. Returns the value to write that sets
// ATN/CLK/DATA per the (atn, clk, data) flags where 1 = assert (=pull),
// 0 = release. (Mirrors how Sparkle/sl.asm conditions its bus state.)
function ciaPaForOuts(atn, clk, data) {
  let v = 0;
  if (atn)  v |= 0x08;   // PA3 ATN OUT (1 = asserted)
  if (clk)  v |= 0x10;   // PA4 CLK OUT
  if (data) v |= 0x20;   // PA5 DATA OUT
  return v;
}

// These are steady-state protocol assertions: settle the IEC edge-latency
// pipeline (three steps cover the longest chain — C64 edge → drive ATNA
// reaction → drive pins back through the C64-facing delay line) before
// observing either side. The 1-cycle edge latency itself is spec-locked in
// fastloader-test.
function settle(m) { if (m.iecEdgeLatency) { m._iecClock(); m._iecClock(); m._iecClock(); } }
function readDD00BitDI(m) { settle(m); return (m.cia2.readPortA() & 0x80) ? 1 : 0; } // PA7 = DATA IN
function readDD00BitCI(m) { settle(m); return (m.cia2.readPortA() & 0x40) ? 1 : 0; } // PA6 = CLK IN

// ─────────────────────────────────────────────────────────────────────────
// 1. Round-trip: drive sets AA=1 (PB4=1), C64 sees DATA bit on $DD00
//    track the XOR result.
//
//    Sparkle's drive code writes $1800 = #busy = $10 (AA=1, CO=0, DO=0)
//    between blocks. With AA=1 (= _atna_pin=0 per inversion) and ATN
//    released (atnIn=1): XOR = 1 → drive pulls DATA. C64's $DD00 PA7 should
//    read 0 (= DATA bus low = drive pulled).
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[Sparkle inter-block]: AA=1 + ATN released → drive pulls DATA, C64 sees DI=0...');
  const m = makeMachine();
  const drv = m.drive1541;

  // C64 side: set ATN/CLK/DATA all RELEASED ($DD00 output bits clear)
  m.cia2.portADir = 0x3F;
  m.cia2.portA    = ciaPaForOuts(/*atn=*/0, /*clk=*/0, /*data=*/0);
  m._syncIecBus(); settle(m);
  assert(drv.atnIn === 1, 'baseline: drive sees ATN released');

  // Drive side: set DDRB so PB1 (DATA OUT), PB3 (CLK OUT), PB4 (ATNA) are
  // outputs; write $1800 = $10 (= AA=1, others 0). This is Sparkle's "busy".
  drv.write(0x1802, 0x1A);           // DDRB: PB1+PB3+PB4 = outputs
  drv.write(0x1800, 0x10);           // PB4=1 ATNA → _atna_pin = 0

  // Per spec formula DATA_pin = (PB1==0) OR (_atna_pin XOR atnIn)
  //   PB1=1 → manual data pin = 0 (NOT pulled by PB1)
  //   _atna_pin=0, atnIn=1: XOR = 1 → drive PULLS DATA
  assert(drv.dataOut === 0, 'spec: AA=1 + ATN-released → drive auto-pulls DATA');

  // The wired-AND state must propagate: C64's $DD00 PA7 must read 0
  // (= bus DATA low). This is the round-trip the existing drive-test.js
  // doesn't cover — it checks drive.iecData but not C64-side visibility.
  assert(readDD00BitDI(m) === 0,
    'round-trip: C64 reads $DD00 PA7=0 (DATA bus low) when drive auto-pulls DATA');

  // Sanity: bit 6 (CI = CLK IN) should be 1 (bus CLK released — neither side pulls)
  assert(readDD00BitCI(m) === 1, 'CLK bit = released (neither side pulled)');
  console.log('ok  – drive AA=1 "busy" state propagates DI=0 to C64 $DD00 read');
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Inter-block trigger: drive AA=1 + C64 pulls ATN → drive releases DATA,
//    bus DATA goes high, C64 sees DI=1 ("ready for next block" signal).
//
//    This is the SPECIFIC transition Sparkle's drive at $0575-$057C polls
//    for, per the Aloft investigation's disassembly finding:
//    "the drive went to its idle poll at $0575-$057C which waits for
//     'ATN asserted AND DATA released' as the next-block trigger".
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[Sparkle inter-block]: AA=1 + ATN asserted → drive releases DATA, C64 sees DI=1...');
  const m = makeMachine();
  const drv = m.drive1541;

  drv.write(0x1802, 0x1A);
  drv.write(0x1800, 0x10);           // AA=1 (drive busy)
  m.cia2.portADir = 0x3F;
  m.cia2.portA    = ciaPaForOuts(0, 0, 0);   // ATN released
  m._syncIecBus(); settle(m);
  assert(drv.dataOut === 0, 'pre: drive pulling DATA');
  assert(readDD00BitDI(m) === 0, 'pre: C64 sees DI=0');

  // Now C64 pulls ATN (= signals "ready for next block" per Sparkle convention).
  m.cia2.portA = ciaPaForOuts(/*atn=*/1, 0, 0);
  m._syncIecBus(); settle(m);
  assert(drv.atnIn === 0, 'drive sees ATN asserted');

  // With _atna_pin=0 and atnIn=0: XOR = 0 → drive RELEASES DATA.
  assert(drv.dataOut === 1, 'spec: AA=1 + ATN-asserted → drive releases DATA (XOR=0)');

  // Bus DATA now released (neither side pulling) → C64 reads PA7=1.
  assert(readDD00BitDI(m) === 1,
    'round-trip: C64 reads DI=1 after drive releases DATA (the inter-block trigger Sparkle waits for)');

  // Toggle back: C64 releases ATN → drive re-pulls DATA → bus low.
  m.cia2.portA = ciaPaForOuts(0, 0, 0);
  m._syncIecBus(); settle(m);
  assert(drv.dataOut === 0, 'cycle back: drive re-pulls DATA on ATN-release');
  assert(readDD00BitDI(m) === 0, 'cycle back: C64 sees DI=0 again');
  console.log('ok  – AA=1 inter-block ATN-toggle round-trips both sides cleanly');
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Drive's poll of $1800 sees live bus state on EVERY read (the
//    every-read re-sync requirement). The drive's busSyncCallback must run
//    at the top of its VIA1 PB read so a tight `LDA $1800` loop sees C64
//    changes that happened between previous-write and current-read.
//
//    Scenario: C64 changes ATN via $DD00 *without* the drive having
//    written anything in between. Drive's next $1800 read must show the
//    new ATN state on PB7.
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[IEC bus sync]: drive `LDA $1800` sees live bus state, not stale cache...');
  const m = makeMachine();
  const drv = m.drive1541;

  // Configure VIA1 DDRB so PB7 (ATN IN) is a pure input.
  drv.write(0x1802, 0x1A);

  // Baseline: ATN released. Drive's first read sees PB7=0 (ATN-IN bit
  // active-low through 7406 → cleared register bit when bus high).
  m.cia2.portADir = 0x3F;
  m.cia2.portA    = ciaPaForOuts(0, 0, 0);
  m._syncIecBus(); settle(m);
  let pb0 = drv.read(0x1800);
  assert((pb0 & 0x80) === 0, 'baseline: drive PB7=0 (ATN bus released)');

  // C64 pulls ATN (host-side write to $DD00). Drive has NOT done any
  // write in between — only a read. busSyncCallback must fire to refresh
  // drive's cached atnIn before the next $1800 read returns.
  m.cia2.portA = ciaPaForOuts(1, 0, 0);
  m._syncIecBus(); settle(m);
  // NB: in real polling the drive does many `LDA $1800` calls without
  // writes. Make sure the FIRST such call sees the new bus state.
  let pb1 = drv.read(0x1800);
  assert((pb1 & 0x80) !== 0,
    'spec: drive\'s `LDA $1800` reflects C64-side ATN edge without drive having to write first');

  // And the opposite transition: release ATN, drive sees PB7 clear again
  // immediately on next read.
  m.cia2.portA = ciaPaForOuts(0, 0, 0);
  m._syncIecBus(); settle(m);
  let pb2 = drv.read(0x1800);
  assert((pb2 & 0x80) === 0,
    'spec: drive\'s `LDA $1800` reflects C64-side ATN release on the very next read');

  console.log('ok  – drive PB read refreshes bus state on every call (no stale cache)');
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Tight inter-block poll loop: C64 toggles ATN rapidly, drive sees
//    every transition on PB7, and drive's AA-XOR pulls/releases DATA
//    accordingly. Bus state stays consistent across both sides through
//    50 rapid toggles.
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[Sparkle inter-block]: AA=1 + rapid ATN toggle keeps both sides consistent...');
  const m = makeMachine();
  const drv = m.drive1541;

  drv.write(0x1802, 0x1A);
  drv.write(0x1800, 0x10);                // AA=1 sticky
  m.cia2.portADir = 0x3F;

  let mismatch = 0;
  for (let i = 0; i < 50; i++) {
    const atnAsserted = (i & 1) === 0;
    m.cia2.portA = ciaPaForOuts(atnAsserted ? 1 : 0, 0, 0);
    m._syncIecBus(); settle(m);

    // Drive sees ATN
    const drvAtnExpected = atnAsserted ? 0 : 1;
    if (drv.atnIn !== drvAtnExpected) mismatch++;

    // Drive's auto-DATA via XOR: when ATN asserted, drive releases DATA;
    // when ATN released, drive pulls DATA.
    const drvDataExpected = atnAsserted ? 1 : 0;
    if (drv.dataOut !== drvDataExpected) mismatch++;

    // C64's PA7 (DI) sees bus DATA via wired-AND. With drive's dataOut
    // varying and C64 not pulling, bus = drive.dataOut.
    const c64DiExpected = drvDataExpected;
    if (readDD00BitDI(m) !== c64DiExpected) mismatch++;
  }
  assert(mismatch === 0,
    `spec: 50 ATN toggles propagate XOR-driven DATA through wired-AND to C64 (mismatches: ${mismatch})`);
  console.log('ok  – AA=1 + 50 rapid ATN toggles propagate XOR result to C64 without drift');
}

// ─────────────────────────────────────────────────────────────────────────
// 5. The "drive busy" $DD00 value Sparkle's C64 install waits for.
//    Per sl.asm line 184-185: `lda #busy ($f8) / bit $dd00 / bmi *-3`
//    waits for DI=0 (DATA bus low → bit 7 cleared). With drive AA=1 + C64
//    bus output bits cleared, $DD00 should show DI=0 (bit 7 = 0).
//    Sparkle's comment in source: "$dd00=#$4b" example for drive-busy.
//    $4B = 01001011 → bit 7 = 0 (DI=0), bit 6 = 1 (CI=1).
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[Sparkle inter-block]: $dd00 read while drive AA=1 matches Sparkle source convention...');
  const m = makeMachine();
  const drv = m.drive1541;

  drv.write(0x1802, 0x1A);
  drv.write(0x1800, 0x10);           // AA=1, others released
  m.cia2.portADir = 0x3F;
  m.cia2.portA    = ciaPaForOuts(0, 0, 0);
  m._syncIecBus(); settle(m);

  const v = m.cia2.readPortA();
  // bit 7 (DI) must be 0 because drive auto-pulled DATA.
  assert((v & 0x80) === 0,
    `$dd00 bit 7 (DI) = 0 (drive pulling DATA), got $${v.toString(16)}`);
  // bit 6 (CI) must be 1 because neither side pulls CLK.
  assert((v & 0x40) !== 0,
    `$dd00 bit 6 (CI) = 1 (CLK released by both), got $${v.toString(16)}`);

  // Now drive pulls CLK too (PB3=1 ATNA=1 → "CLK low + AA=1"). Per Sparkle:
  //   #busy_clk = $18 = CO=1 AA=1 → also CLK pulled.
  drv.write(0x1800, 0x18);
  // DATA still pulled (AA-XOR), CLK now pulled by drive. C64 $DD00 should
  // see bit 7 = 0 (DI low) AND bit 6 = 0 (CI low).
  settle(m);
  const v2 = m.cia2.readPortA();
  assert((v2 & 0xC0) === 0,
    `$dd00 bits 7+6 (DI+CI) both 0 with drive pulling DATA+CLK, got $${v2.toString(16)}`);
  console.log('ok  – Sparkle inter-block "drive busy" bus state visible to C64 via $dd00');
}

console.log('\nAll Sparkle inter-block IEC handshake spec tests passed.');
