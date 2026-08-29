// End-to-end tests for generic (type-0) cartridge loading via C64Machine.loadCartridge.
// Covers:
//   – 16K cart delivered as two 8K CHIPs  ($8000 + $A000)
//   – 16K cart delivered as one combined 16K CHIP at $8000
//   – Cart state survives machine.reset()
//   – Ultimax cart with separate $8000 + $E000 CHIPs
//
// Usage: node test/generic-cart-test.js

import { C64Machine } from '../src/machine.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// --- CRT builder helpers (mirrors test/crt-test.js) ---
function writeAscii(buf, o, s, pad = 0) {
  for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
  for (let i = s.length; i < pad; i++) buf[o + i] = 0;
}
function writeU16BE(b, o, v) { b[o] = (v >> 8) & 0xFF; b[o + 1] = v & 0xFF; }
function writeU32BE(b, o, v) {
  b[o] = (v >>> 24) & 0xFF; b[o + 1] = (v >>> 16) & 0xFF;
  b[o + 2] = (v >>> 8) & 0xFF; b[o + 3] = v & 0xFF;
}
function buildCRT({ hwType, exrom, game, name, chips }) {
  const HEADER_LEN = 0x40;
  const payload = chips.reduce((s, c) => s + 16 + c.data.length, 0);
  const buf = new Uint8Array(HEADER_LEN + payload);
  writeAscii(buf, 0x00, 'C64 CARTRIDGE   ');
  writeU32BE(buf, 0x10, HEADER_LEN);
  writeU16BE(buf, 0x14, 0x0100);
  writeU16BE(buf, 0x16, hwType);
  buf[0x18] = exrom;
  buf[0x19] = game;
  writeAscii(buf, 0x20, name, 32);
  let off = HEADER_LEN;
  for (const c of chips) {
    const pl = 16 + c.data.length;
    writeAscii(buf, off, 'CHIP');
    writeU32BE(buf, off + 4, pl);
    writeU16BE(buf, off + 8, 0);
    writeU16BE(buf, off + 10, c.bank ?? 0);
    writeU16BE(buf, off + 12, c.loadAddr);
    writeU16BE(buf, off + 14, c.data.length);
    buf.set(c.data, off + 16);
    off += pl;
  }
  return buf;
}

// Instantiate a machine and wire up ROMs (needed because machine.reset() copies
// CharROM into RAM at $6800).
const machine = new C64Machine();
machine.loadROMs({
  kernal:  new Uint8Array(8192).fill(0xEE),
  basic:   new Uint8Array(8192).fill(0xFF),
  charRom: new Uint8Array(4096).fill(0xCC),
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: 16K cart as two separate CHIPs ($8000 + $A000)
{
  const lo = new Uint8Array(8192); lo[0] = 0x11; lo[0x1FFF] = 0x22;
  const hi = new Uint8Array(8192); hi[0] = 0x33; hi[0x1FFF] = 0x44;
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 0, name: '16K TWO CHIPS',
    chips: [
      { loadAddr: 0x8000, data: lo },
      { loadAddr: 0xA000, data: hi },
    ],
  });
  machine.loadCartridge(crt);
  assert(machine.mem.read(0x8000) === 0x11, '16K split: ROML[0]');
  assert(machine.mem.read(0x9FFF) === 0x22, '16K split: ROML[end]');
  assert(machine.mem.read(0xA000) === 0x33, '16K split: ROMH[0]');
  assert(machine.mem.read(0xBFFF) === 0x44, '16K split: ROMH[end]');
  console.log('ok  – 16K two-CHIP layout loads ROML + ROMH');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: 16K cart as a single 16K CHIP at $8000 (common VICE dump format)
{
  const combined = new Uint8Array(16384);
  combined[0]        = 0xAA; // ROML[0]
  combined[0x1FFF]   = 0xBB; // ROML[end]
  combined[0x2000]   = 0xCC; // ROMH[0]
  combined[0x3FFF]   = 0xDD; // ROMH[end]
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 0, name: '16K ONE CHIP',
    chips: [{ loadAddr: 0x8000, data: combined }],
  });
  machine.loadCartridge(crt);
  assert(machine.mem.read(0x8000) === 0xAA, '16K combined: ROML[0] — was the bug');
  assert(machine.mem.read(0x9FFF) === 0xBB, '16K combined: ROML[end]');
  assert(machine.mem.read(0xA000) === 0xCC, '16K combined: ROMH[0] — was the bug');
  assert(machine.mem.read(0xBFFF) === 0xDD, '16K combined: ROMH[end]');
  console.log('ok  – 16K combined-CHIP layout splits correctly');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Cart survives machine.reset()
{
  // leave previous 16K combined cart loaded from Test 2
  // Dirty RAM so we can tell reset ran
  machine.mem.ram[0x4000] = 0x42;
  machine.reset();
  assert(machine.mem.ram[0x4000] === 0x00, 'reset cleared RAM');
  assert(machine.mem.read(0x8000) === 0xAA, 'cart ROML survives reset');
  assert(machine.mem.read(0xA000) === 0xCC, 'cart ROMH survives reset');
  assert(machine.mem.cartMode === '16k',    'cart mode survives reset');
  console.log('ok  – generic cart ROM + mode survive machine.reset()');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Ultimax cart with $8000 + $E000 CHIPs
{
  const lo = new Uint8Array(8192); lo[0] = 0x55;
  const hi = new Uint8Array(8192); hi[0x1FFC] = 0x00; hi[0x1FFD] = 0x80; // reset vec → $8000
  const crt = buildCRT({
    hwType: 0, exrom: 1, game: 0, name: 'ULTIMAX',
    chips: [
      { loadAddr: 0x8000, data: lo },
      { loadAddr: 0xE000, data: hi },
    ],
  });
  machine.loadCartridge(crt);
  assert(machine.mem.cartMode === 'ultimax', 'ultimax mode selected');
  assert(machine.mem.read(0x8000) === 0x55,  'ultimax ROML at $8000');
  assert(machine.mem.read(0xFFFC) === 0x00,  'ultimax ROMH reset-vec low');
  assert(machine.mem.read(0xFFFD) === 0x80,  'ultimax ROMH reset-vec high');
  // $1000-$7FFF and $A000-$CFFF are open bus (0xFF) in ultimax
  assert(machine.mem.read(0x5000) === 0xFF,  'ultimax open bus $5000');
  console.log('ok  – Ultimax $8000 + $E000 layout');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Reject unsupported type with a clear message
{
  const crt = buildCRT({
    hwType: 5, exrom: 0, game: 0, name: 'OCEAN',
    chips: [{ loadAddr: 0x8000, data: new Uint8Array(8192) }],
  });
  let err = null;
  try { machine.loadCartridge(crt); } catch (e) { err = e; }
  assert(err && /type 5/.test(err.message), 'unsupported type rejected with clear message');
  console.log('ok  – unsupported type 5 rejected');
}

console.log('\nAll generic cartridge tests passed.');
