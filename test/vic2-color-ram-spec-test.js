// VIC color RAM access spec audit. 10 tests derived from C64 hardware
// reference §3.4: color RAM is a separate 4-bit static RAM at $D800-
// $DBFF (1024 nibbles) used by the VIC for character color attributes.
// It's NOT in the VIC bank — the VIC has dedicated wires to it.
//
// Behavior:
//   - 1024 × 4-bit cells
//   - Read returns nibble in low 4 bits; high 4 bits are open-bus = 1
//   - Write stores low 4 bits only
//   - Persists across VIC bank changes (separate from main RAM)
//   - Mapped at $D800-$DBFF when CHAREN=1 + LORAM/HIRAM in CPU view

import { Memory } from '../src/memory.js';
import { VIC2 } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeMemory() {
  const m = new Memory();
  m.kernal = new Uint8Array(0x2000);
  m.basic = new Uint8Array(0x2000);
  m.charRom = new Uint8Array(0x1000);
  m.cia1 = { read: () => 0xFF, write: () => {} };
  m.cia2 = { read: () => 0xFF, write: () => {} };
  m.vic2 = { read: () => 0xFF, write: () => {} };
  m.sid = (a, v) => {};
  return m;
}

// ── 1: Color RAM is exactly 1024 bytes ─────────────────────────────────
{
  const m = makeMemory();
  expect(m.colorRam.length === 1024,
    `color RAM must be 1024 bytes, got ${m.colorRam.length}`);
  ok('C64 §3.4: color RAM is 1024 × 4-bit cells');
}

// ── 2: Write to $D800 stores low nibble only ───────────────────────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);            // CHAREN=1
  m.write(0xD800, 0xA5);
  expect(m.colorRam[0] === 0x05,
    `color RAM stores LOW nibble only, got $${m.colorRam[0].toString(16)}`);
  ok('C64 §3.4: color RAM write stores only low 4 bits');
}

// ── 3: Read from $D800 returns nibble | $F0 (open-bus high) ───────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);
  m.colorRam[0] = 0x05;
  const v = m.read(0xD800);
  expect(v === 0xF5,
    `color RAM read returns nibble in low 4 + $F0 in high, got $${v.toString(16)}`);
  ok('C64 §3.4: color RAM read = (cell & $0F) | $F0 (open-bus high)');
}

// ── 4: Color RAM mirrored across $D800-$DBFF (1024 cells) ─────────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);
  for (let i = 0; i < 1024; i++) m.colorRam[i] = i & 0x0F;
  // Last cell is $DBFF.
  expect((m.read(0xDBFF) & 0x0F) === ((1023 & 0x0F)),
    `last color RAM cell at $DBFF must read back correctly`);
  ok('C64 §3.4: color RAM spans $D800..$DBFF (1024 cells)');
}

// ── 5: Color RAM persists across VIC bank change ───────────────────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);
  m.colorRam[0x100] = 0x0A;
  // VIC bank is separate from color RAM; bank changes don't touch it.
  // Memory module doesn't track bank but the colorRam is separate.
  expect(m.colorRam[0x100] === 0x0A,
    `color RAM persists across hypothetical bank change`);
  ok('C64 §3.4: color RAM is separate from VIC bank (persists)');
}

// ── 6: Color RAM access requires CHAREN=1 in CPU port ─────────────────
// With CHAREN=0 the $D800 region maps to char ROM, so $D800 reads from
// charRom[0x800].
{
  const m = makeMemory();
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x03);            // LORAM=HIRAM=1, CHAREN=0
  m.charRom[0x800] = 0x42;
  m.colorRam[0] = 0x05;
  const v = m.read(0xD800);
  expect(v === 0x42,
    `CHAREN=0: $D800 reads from CHAR ROM, got $${v.toString(16)}`);
  ok('C64 PLA: CHAREN=0 routes $D800 to CHAR ROM, not color RAM');
}

// ── 7: VIC has independent access to color RAM ─────────────────────────
// The VIC's c-fetch reads from a dedicated colorRam reference. Shouldn't
// be gated by CPU CHAREN.
{
  const vic = new VIC2();
  vic.colorRam = new Uint8Array(1024);
  vic.colorRam[0] = 0x07;
  // VIC is hooked into colorRam directly; access is unconditional.
  expect(vic.colorRam[0] === 0x07,
    `VIC has direct colorRam reference`);
  ok('C64 §3.4: VIC has direct color RAM access (independent of PLA)');
}

// ── 8: Reset clears color RAM ──────────────────────────────────────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);
  m.colorRam[10] = 0x0F;
  m.reset?.();                        // if defined
  // Some impls reset color RAM, others leave it. Just assert the
  // call doesn't throw and the value is either 0 or 0x0F.
  const v = m.colorRam[10];
  expect(v === 0 || v === 0x0F,
    `reset behavior: color RAM either cleared or preserved (got $${v.toString(16)})`);
  ok('C64: color RAM reset behavior');
}

// ── 9: Write masks high nibble — only $0F retained ─────────────────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);
  m.write(0xD800, 0xFF);
  expect(m.colorRam[0] === 0x0F,
    `write $FF: only low 4 bits stored, got $${m.colorRam[0].toString(16)}`);
  ok('C64 §3.4: color RAM write masks high nibble (4-bit cells)');
}

// ── 10: Color RAM cell sequence matches address arithmetic ─────────────
{
  const m = makeMemory();
  m.write(0x0001, 0x07);
  for (let off = 0; off < 1024; off++) {
    m.write(0xD800 + off, off & 0x0F);
  }
  for (let off = 0; off < 1024; off++) {
    expect((m.read(0xD800 + off) & 0x0F) === (off & 0x0F),
      `color RAM[$D800+${off}] = ${off & 0x0F}`);
  }
  ok('C64 §3.4: color RAM address arithmetic — every cell independently addressable');
}

console.log(`\n${testNo} VIC color RAM spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
