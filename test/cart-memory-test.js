// test/cart-memory-test.js
// Comprehensive tests for cartridge memory mapping and logic.
// Verifies visibility rules for 8K, 16K, and Ultimax modes across all CPU port configurations.

import { Memory } from '../src/memory.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const m = new Memory();
// Banking is driven by the port PINS, not the raw latch. Raw power-up DDR
// is now $00 (all inputs), so the LORAM/HIRAM/CHAREN bits would float to
// their pull-ups (=1) and the `m.write(0x01, …)` banking writes below
// could never bank a ROM OUT. Put DDR into the post-KERNAL state ($2F:
// bits 0-3,5 output) so bits 0,1,2 actually drive the bank lines.
m.cpuDDR = 0x2F;
m.kernal  = new Uint8Array(8192).fill(0xEE); // $E000
m.basic   = new Uint8Array(8192).fill(0xBB); // $A000
m.charRom = new Uint8Array(4096).fill(0xCC); // $D000

const romLo = new Uint8Array(8192).fill(0x11);
const romHi = new Uint8Array(8192).fill(0x22);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Generic 8K Cartridge
// ─────────────────────────────────────────────────────────────────────────────
console.log('Testing Generic 8K...');
m.setCartridge({ type: 'generic', mode: '8k', romLo, romHi: null });

// BASIC + KERNAL + IO visible ($37)
m.write(0x01, 0x37);
assert(m.read(0x8000) === 0x11, '8K: ROML visible at $8000 ($37)');
assert(m.read(0xA000) === 0xBB, '8K: BASIC visible at $A000 ($37)');
assert(m.read(0xE000) === 0xEE, '8K: KERNAL visible at $E000 ($37)');

// LORAM=0 (BASIC -> RAM, ROML also masked: PLA gates ROML on LORAM&HIRAM)
m.write(0x01, 0x36);
assert(m.read(0x8000) === 0x00, '8K: ROML masked at $8000 when LORAM=0');
assert(m.read(0xA000) === 0x00, '8K: RAM visible at $A000 (LORAM=0)');

// HIRAM=0 (KERNAL -> RAM, ROML also masked)
m.write(0x01, 0x35);
assert(m.read(0x8000) === 0x00, '8K: ROML masked at $8000 when HIRAM=0');
assert(m.read(0xE000) === 0x00, '8K: RAM visible at $E000 (HIRAM=0)');

// All RAM ($30) — ROML masked
m.write(0x01, 0x30);
assert(m.read(0x8000) === 0x00, '8K: ROML masked at $8000 ($30)');
console.log('ok  – Generic 8K mapping');

// ─────────────────────────────────────────────────────────────────────────────
// 2. Generic 16K Cartridge
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTesting Generic 16K...');
m.setCartridge({ type: 'generic', mode: '16k', romLo, romHi });

m.write(0x01, 0x37);
assert(m.read(0x8000) === 0x11, '16K: ROML visible at $8000');
assert(m.read(0xA000) === 0x22, '16K: ROMH visible at $A000 (replaces BASIC)');

// HIRAM=0 (port $34) — ROML and ROMH both masked
m.write(0x01, 0x34);
assert(m.read(0x8000) === 0x00, '16K: ROML masked when HIRAM=0');
assert(m.read(0xA000) === 0x00, '16K: ROMH masked when HIRAM=0');

// LORAM=0, HIRAM=1 (port $36) — ROML masked, ROMH still visible
// (PLA gates ROMH on HIRAM only.)
m.write(0x01, 0x36);
assert(m.read(0x8000) === 0x00, '16K: ROML masked when LORAM=0');
assert(m.read(0xA000) === 0x22, '16K: ROMH still visible when LORAM=0,HIRAM=1');

m.write(0x01, 0x30); // All RAM — both masked
assert(m.read(0x8000) === 0x00, '16K: ROML masked with $30');
assert(m.read(0xA000) === 0x00, '16K: ROMH masked with $30');
console.log('ok  – Generic 16K mapping');

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ultimax Mode
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTesting Ultimax...');
m.setCartridge({ type: 'generic', mode: 'ultimax', romLo, romHi });

// In Ultimax, port $01 is largely ignored for ROM visibility.
m.write(0x01, 0x37);
assert(m.read(0x8000) === 0x11, 'Ultimax: ROML at $8000');
assert(m.read(0xE000) === 0x22, 'Ultimax: ROMH at $E000 (replaces KERNAL)');
assert(m.read(0x0001) === 0x37, 'Ultimax: Port $01 readable');
assert(m.read(0x1000) === 0xFF, 'Ultimax: $1000 is open bus');
assert(m.read(0xA000) === 0xFF, 'Ultimax: $A000 is open bus');
assert(m.read(0xC000) === 0xFF, 'Ultimax: $C000 is open bus');
assert(m.read(0xD011) === 0xFF, 'Ultimax: IO still visible at $D000 (no VIC attached returns FF)');

m.write(0x01, 0x30);
assert(m.read(0xE000) === 0x22, 'Ultimax: ROMH still at $E000 with $30');
console.log('ok  – Ultimax mapping');

// ─────────────────────────────────────────────────────────────────────────────
// 4. EasyFlash Specifics
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTesting EasyFlash Specifics...');
m.write(0x01, 0x37); // Ensure I/O is mapped
const loBanks = new Array(64).fill(null).map((_, i) => new Uint8Array(8192).fill(i));
const hiBanks = new Array(64).fill(null).map((_, i) => new Uint8Array(8192).fill(i | 0x80));
m.setCartridge({ type: 'easyflash', romLoBanks: loBanks, romHiBanks: hiBanks });

// Default: Bank 0, Ultimax
assert(m.cartMode === 'ultimax', 'EF: starts in Ultimax');
assert(m.read(0x8000) === 0, 'EF: Bank 0 ROML');
assert(m.read(0xE000) === 0x80, 'EF: Bank 0 ROMH');

// Switch to Bank 5
m.write(0xDE00, 5);
assert(m.read(0x8000) === 5, 'EF: Bank 5 ROML');
assert(m.read(0xE000) === 0x85, 'EF: Bank 5 ROMH');

// Switch to 16K Mode (/EXROM=0, /GAME=0 -> 0x07)
m.write(0xDE02, 0x07);
assert(m.cartMode === '16k', 'EF: switched to 16K mode');
assert(m.read(0x8000) === 5, 'EF: ROML bank 5 at $8000');
assert(m.read(0xA000) === 0x85, 'EF: ROMH bank 5 at $A000');

// Switch to 8K Mode (/EXROM=0, /GAME=1 -> 0x06)
m.write(0xDE02, 0x06);
assert(m.cartMode === '8k', 'EF: switched to 8K mode');
assert(m.read(0x8000) === 5, 'EF: ROML bank 5 at $8000');
assert(m.read(0xA000) === 0xBB, 'EF: BASIC visible at $A000 in 8K mode');

// Cart Off (/EXROM=1, /GAME=1 -> 0x04)
m.write(0xDE02, 0x04);
assert(m.cartMode === 'none', 'EF: switched to none');
assert(m.read(0x8000) === 0x00, 'EF: RAM visible at $8000');
assert(m.read(0xE000) === 0xEE, 'EF: KERNAL visible at $E000');

console.log('ok  – EasyFlash banking and mode switching');

// ─────────────────────────────────────────────────────────────────────────────
// 5. Reset Behavior
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTesting Reset...');
m.write(0xDE00, 10); // Bank 10
m.write(0xDE02, 0x06); // 8K mode
m.reset();
assert(m.cartBank === 0, 'Reset: bank restored to 0');
assert(m.cartMode === 'ultimax', 'Reset: mode restored to ultimax');
assert(m.read(0xE000) === 0x80, 'Reset: ROML pointed to bank 0 at $E000');
console.log('ok  – Reset behavior');

console.log('\nAll Cartridge Memory tests passed.');
