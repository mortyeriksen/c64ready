// test/pla-test.js — exhaustive verification of the C64 PLA memory map
// against the JEDEC-derived configuration tables from
// "The C64 PLA Dissected" (Giesel, 2012), Appendix A, tables A.1–A.9.
//
// Each table fixes the (LORAM, HIRAM, /GAME, /EXROM) inputs and lists what
// the CPU sees at every $1000-aligned page for both CHAREN values, both
// for read and write. We replicate every row.
//
// cart-memory-test.js spot-checks a handful of cartridge configurations;
// this file pins down the full PLA truth table including the corner cases
// that distinguish a 16k cart from no/8k carts (e.g. p4 vs p5 for
// CHARROM gating) and that a few entries in the standard "Mapping the
// 64" table are wrong.
//
// Usage:  node test/pla-test.js

import { Memory } from '../src/memory.js';

// Distinct fill bytes so we can identify which chip backed a read.
const BASIC_FILL  = 0xAA;
const KERNAL_FILL = 0xEE;
const CHAR_FILL   = 0xCC;
const ROML_FILL   = 0x11;
const ROMH_FILL   = 0x22;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

function makeMem() {
  const m = new Memory();
  m.kernal  = new Uint8Array(8192).fill(KERNAL_FILL);
  m.basic   = new Uint8Array(8192).fill(BASIC_FILL);
  m.charRom = new Uint8Array(4096).fill(CHAR_FILL);
  // Banking is driven by the port PINS, not the raw latch. Raw power-up DDR
  // is now $00 (all inputs) → the LORAM/HIRAM/CHAREN bits float to their
  // pull-ups (=1) and a `write(0x01, …)` could never bank anything OUT.
  // These tables set $01 directly to exercise every PLA config, so we put
  // DDR into the post-KERNAL state ($2F: bits 0-3,5 output) so bits 0,1,2
  // actually drive LORAM/HIRAM/CHAREN from the latch.
  m.cpuDDR = 0x2F;
  // This test pins PLA address-decoding only; with the shared external bus
  // model active, an unwired I/O read samples the latch (which holds the
  // last RAM byte read), defeating the legacy 0xFF check. Disable open-bus
  // locally so unwired I/O reads return 0xFF as the table expects.
  m.openBusMode = 'disabled';
  return m;
}

function makeRomLo() { return new Uint8Array(8192).fill(ROML_FILL); }
function makeRomHi() { return new Uint8Array(8192).fill(ROMH_FILL); }

// Probe a $1000-aligned page. The probe value at page $X000+$5 distinguishes
// "RAM read returns underlying value" from "ROM/IO masked it out". We seed
// every page with a unique non-zero stamp at offset $005 before each table.
function seedRamProbes(m) {
  for (let page = 0; page < 16; page++) {
    // Use $page<<12 | 5 as the stamp address; value = 0x40+page so each is
    // distinct from all of the ROM fills.
    m.ram[(page << 12) | 5] = 0x40 + page;
  }
}

function probeRam(page) { return 0x40 + page; }

// What does the spec say should be visible at this page after CPU read?
// Encoded as one of: 'ram' | 'basic' | 'kernal' | 'charrom' | 'io' |
// 'roml' | 'romh' | 'open'. 'open' = unmapped (0xFF approximation).
function expectedRead(map, page) { return map[page]; }

function actualReadStamp(m, page) {
  // Read offset 5 within the page so we hit the seeded RAM stamp if the PLA
  // routes to RAM. Otherwise we get the ROM fill (uniform across the chip).
  return m.read((page << 12) | 5);
}

function checkTable(label, m, map, charenLabel) {
  for (let page = 0; page < 16; page++) {
    const want = expectedRead(map, page);
    const got  = actualReadStamp(m, page);
    let expected;
    switch (want) {
      case 'ram':     expected = probeRam(page); break;
      case 'basic':   expected = BASIC_FILL;     break;
      case 'kernal':  expected = KERNAL_FILL;    break;
      case 'charrom': expected = CHAR_FILL;      break;
      case 'roml':    expected = ROML_FILL;      break;
      case 'romh':    expected = ROMH_FILL;      break;
      case 'io':      expected = 0xFF;           break; // no I/O attached → 0xFF
      case 'open':    expected = 0xFF;           break;
      default: throw new Error(`bad expectation ${want}`);
    }
    // $0000/$0001 are special on page 0 — skip them by reading offset 5.
    assert(got === expected,
      `${label} ${charenLabel}: \$${(page<<12).toString(16).padStart(4,'0').toUpperCase()} expected ${want} (=0x${expected.toString(16)}), got 0x${got.toString(16)}`);
  }
}

// Verify that a CPU write to $D000 ends up in I/O when expected, or in RAM
// underneath. We check by reading a "phantom" RAM probe through a different
// configuration that exposes RAM at $D000.
function checkDxxxWriteGoesToRam(label, m) {
  // Write a sentinel via the current map, then switch to a config that
  // exposes RAM at $D000 ($30, no cart) and read it back.
  m.ram[0xD123] = 0; // clear
  m.write(0xD123, 0x77);
  const saved01 = m.cpuPort;
  const savedCart = { type: m.cartType, mode: m.cartMode };
  m.setCartridge(null);
  m.write(0x01, 0x30);
  const readback = m.read(0xD123);
  // Restore.
  if (savedCart.type !== 'none') {
    // Tests don't rely on round-trip cart restore beyond this point.
  }
  m.write(0x01, saved01);
  assert(readback === 0x77,
    `${label}: write to \$D123 should land in RAM under I/O (got 0x${readback.toString(16)})`);
}

// ────────────────────────────────────────────────────────────────────────────
// Table A.1 — LHGX = 1111 (no cart, port $37 / $33)
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge(null);

  // $37 = LHGX=1111, CHAREN=1 → I/O at $D000
  m.write(0x01, 0x37);
  const a1_charen1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','basic','basic','ram','io','kernal','kernal',
  ];
  checkTable('A.1 ($37)', m, a1_charen1, 'CHAREN=1');

  // $33 = same but CHAREN=0 → CHARROM at $D000
  m.write(0x01, 0x33);
  const a1_charen0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','basic','basic','ram','charrom','kernal','kernal',
  ];
  checkTable('A.1 ($33)', m, a1_charen0, 'CHAREN=0');
  console.log('ok  – Table A.1: LHGX=1111 (no cart, standard)');
}

// ────────────────────────────────────────────────────────────────────────────
// Table A.2 — LHGX = 011x (no cart or 8k, BASIC banked out)
// ────────────────────────────────────────────────────────────────────────────
for (const cart of ['none', '8k']) {
  const m = makeMem();
  seedRamProbes(m);
  if (cart === '8k') m.setCartridge({type:'generic',mode:'8k',romLo:makeRomLo()});
  else m.setCartridge(null);

  // $36 = LHGX=011x, CHAREN=1
  m.write(0x01, 0x36);
  const a2_c1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','ram','ram','ram','io','kernal','kernal',
  ];
  checkTable(`A.2 ($36, ${cart})`, m, a2_c1, 'CHAREN=1');

  // $32 = LHGX=011x, CHAREN=0
  m.write(0x01, 0x32);
  const a2_c0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','ram','ram','ram','charrom','kernal','kernal',
  ];
  checkTable(`A.2 ($32, ${cart})`, m, a2_c0, 'CHAREN=0');
}
console.log('ok  – Table A.2: LHGX=011x (BASIC banked out)');

// ────────────────────────────────────────────────────────────────────────────
// Table A.3 — LHGX = 1000 (16k cart attached but banked out)
// Notably: CHAREN=0 hides I/O but does NOT bank in CHARROM (p4 is gated on
// /GAME=1; with a 16k cart /GAME=0 so p4 cannot fire).
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge({type:'generic',mode:'16k',romLo:makeRomLo(),romHi:makeRomHi()});

  // $35 = LHGX=1000, CHAREN=1
  m.write(0x01, 0x35);
  const a3_c1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','ram','ram','ram','io','ram','ram',
  ];
  checkTable('A.3 ($35, 16k)', m, a3_c1, 'CHAREN=1');

  // $31 = same but CHAREN=0 → $D000 stays RAM (this is the corner case).
  m.write(0x01, 0x31);
  const a3_c0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','ram','ram','ram','ram','ram','ram',
  ];
  checkTable('A.3 ($31, 16k)', m, a3_c0, 'CHAREN=0');
  console.log('ok  – Table A.3: LHGX=1000 (16k cart, banked out, no CHARROM)');
}

// ────────────────────────────────────────────────────────────────────────────
// Table A.4 — LHGX = 101x (no/8k cart, BASIC and KERNAL banked out)
// ────────────────────────────────────────────────────────────────────────────
for (const cart of ['none','8k']) {
  const m = makeMem();
  seedRamProbes(m);
  if (cart === '8k') m.setCartridge({type:'generic',mode:'8k',romLo:makeRomLo()});
  else m.setCartridge(null);

  m.write(0x01, 0x35);
  const a4_c1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','ram','ram','ram','io','ram','ram',
  ];
  checkTable(`A.4 ($35, ${cart})`, m, a4_c1, 'CHAREN=1');

  m.write(0x01, 0x31);
  const a4_c0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','ram','ram','ram','charrom','ram','ram',
  ];
  checkTable(`A.4 ($31, ${cart})`, m, a4_c0, 'CHAREN=0');
}
console.log('ok  – Table A.4: LHGX=101x (KERNAL banked out, CHARROM via p4)');

// ────────────────────────────────────────────────────────────────────────────
// Table A.5 — LHGX = 001x or 00x0 (everything banked out, all RAM)
// ────────────────────────────────────────────────────────────────────────────
for (const cart of ['none','8k','16k']) {
  const m = makeMem();
  seedRamProbes(m);
  if (cart === '8k') m.setCartridge({type:'generic',mode:'8k',romLo:makeRomLo()});
  else if (cart === '16k') m.setCartridge({type:'generic',mode:'16k',romLo:makeRomLo(),romHi:makeRomHi()});
  else m.setCartridge(null);

  // CHAREN has no effect here per A.5.
  for (const port of [0x30, 0x34]) {
    // 16k cart with $30 falls into LHGX=00x0 (all-RAM). With 8k or no cart,
    // $34 = LHGX=001x → all RAM. Skip the cart/port pairs that aren't
    // covered by table A.5.
    if (cart === '16k' && port === 0x34) continue; // 16k+$34 = LHGX=0100 → A.7
    if (cart === '8k'  && port === 0x30) continue; // 8k+$30 = covered by A.5 since GAME=1, X=0 not Ultimax
    m.write(0x01, port);
    const allRam = new Array(16).fill('ram');
    checkTable(`A.5 ($${port.toString(16)}, ${cart})`, m, allRam, 'CHAREN=any');
  }
}
console.log('ok  – Table A.5: LHGX=001x/00x0 (all RAM)');

// ────────────────────────────────────────────────────────────────────────────
// Table A.6 — LHGX = 1100 (16k cart, standard)
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge({type:'generic',mode:'16k',romLo:makeRomLo(),romHi:makeRomHi()});

  m.write(0x01, 0x37);
  const a6_c1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'roml','roml','romh','romh','ram','io','kernal','kernal',
  ];
  checkTable('A.6 ($37, 16k)', m, a6_c1, 'CHAREN=1');

  m.write(0x01, 0x33);
  const a6_c0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'roml','roml','romh','romh','ram','charrom','kernal','kernal',
  ];
  checkTable('A.6 ($33, 16k)', m, a6_c0, 'CHAREN=0');
  console.log('ok  – Table A.6: LHGX=1100 (16k cart, standard)');
}

// ────────────────────────────────────────────────────────────────────────────
// Table A.7 — LHGX = 0100 (16k cart, ROML banked out)
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge({type:'generic',mode:'16k',romLo:makeRomLo(),romHi:makeRomHi()});

  m.write(0x01, 0x36);
  const a7_c1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','romh','romh','ram','io','kernal','kernal',
  ];
  checkTable('A.7 ($36, 16k)', m, a7_c1, 'CHAREN=1');

  m.write(0x01, 0x32);
  const a7_c0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'ram','ram','romh','romh','ram','charrom','kernal','kernal',
  ];
  checkTable('A.7 ($32, 16k)', m, a7_c0, 'CHAREN=0');
  console.log('ok  – Table A.7: LHGX=0100 (ROMH+I/O+KERNAL, no ROML)');
}

// ────────────────────────────────────────────────────────────────────────────
// Table A.8 — LHGX = 1110 (8k cart, standard)
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge({type:'generic',mode:'8k',romLo:makeRomLo()});

  m.write(0x01, 0x37);
  const a8_c1 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'roml','roml','basic','basic','ram','io','kernal','kernal',
  ];
  checkTable('A.8 ($37, 8k)', m, a8_c1, 'CHAREN=1');

  m.write(0x01, 0x33);
  const a8_c0 = [
    'ram','ram','ram','ram','ram','ram','ram','ram',
    'roml','roml','basic','basic','ram','charrom','kernal','kernal',
  ];
  checkTable('A.8 ($33, 8k)', m, a8_c0, 'CHAREN=0');
  console.log('ok  – Table A.8: LHGX=1110 (8k cart, standard)');
}

// ────────────────────────────────────────────────────────────────────────────
// Table A.9 — LHGX = xx01 (Ultimax). $01 has no effect.
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge({type:'generic',mode:'ultimax',romLo:makeRomLo(),romHi:makeRomHi()});

  // Spec: only $0000-$0FFF is RAM, $1000-$7FFF and $A000-$CFFF are open
  // bus, $8000-$9FFF is ROML, $D000-$DFFF is I/O, $E000-$FFFF is ROMH.
  const a9 = [
    'ram','open','open','open','open','open','open','open',
    'roml','roml','open','open','open','io','romh','romh',
  ];
  // $01 doesn't change Ultimax mapping; verify across several values.
  for (const port of [0x37, 0x33, 0x35, 0x30]) {
    m.write(0x01, port);
    checkTable(`A.9 ($${port.toString(16)}, ultimax)`, m, a9, '$01=any');
  }
  console.log('ok  – Table A.9: LHGX=xx01 (Ultimax — $01 ignored)');
}

// ────────────────────────────────────────────────────────────────────────────
// Write-side checks: writes never go to ROM. With CHAREN=0, $D000 writes
// fall through to RAM under the CHARROM (this is how the standard KERNAL
// init clears character RAM before flipping CHAREN back on).
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  m.setCartridge(null);
  m.write(0x01, 0x33);                     // CHAREN=0: $D000 read = CHARROM
  m.write(0xD400, 0x55);                   // write should land in RAM
  m.write(0x01, 0x30);                     // expose RAM
  assert(m.read(0xD400) === 0x55,
    'CHAREN=0 write at \$D400 must land in RAM under CHARROM');

  // With CHAREN=1, $D000 write goes to I/O. Since SID is not attached,
  // the write is dropped — but the RAM under should remain untouched.
  const m2 = makeMem();
  m2.setCartridge(null);
  m2.ram[0xD400] = 0xAA;
  m2.write(0x01, 0x37);
  m2.write(0xD400, 0x55);                  // I/O write, dropped (no SID)
  m2.write(0x01, 0x30);
  assert(m2.read(0xD400) === 0xAA,
    'CHAREN=1 write at \$D400 must NOT corrupt RAM under I/O');

  console.log('ok  – $D000 write routing (RAM-under-ROM vs I/O)');
}

// ────────────────────────────────────────────────────────────────────────────
// Cartridge-attached but $30 forces all RAM. This is the trick the diag-c64
// cart uses to RAM-test under its own ROM image.
// ────────────────────────────────────────────────────────────────────────────
{
  const m = makeMem();
  seedRamProbes(m);
  m.setCartridge({type:'generic',mode:'8k',romLo:makeRomLo()});
  m.write(0x01, 0x30);
  for (let p = 0; p < 16; p++) {
    assert(m.read((p<<12)|5) === probeRam(p),
      `8k cart + \$30: page \$${p.toString(16)} should be RAM`);
  }
  console.log('ok  – $30 (all-RAM) overrides 8k cart presence');
}

// ────────────────────────────────────────────────────────────────────────────
// Final summary
// ────────────────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\n${failed} PLA assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll PLA configuration tests passed.');
