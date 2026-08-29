// Memory-level tests for EasyFlash cart behaviour.
// Verifies bank switching ($DE00), mode switching ($DE02), and cart RAM ($DF00-$DFFF).
//
// Usage:  node test/easyflash-test.js

import { Memory } from '../src/memory.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function makeBanks(countLo, countHi) {
  const lo = new Array(64), hi = new Array(64);
  for (let i = 0; i < 64; i++) {
    lo[i] = new Uint8Array(8192);
    hi[i] = new Uint8Array(8192);
    lo[i][0] = 0x10 + (i & 0x3F);   // marker byte per bank
    hi[i][0] = 0x80 + (i & 0x3F);
  }
  return { lo, hi };
}

const m = new Memory();
m.kernal = new Uint8Array(8192).fill(0xEE);
m.basic  = new Uint8Array(8192).fill(0xFF);

const { lo: romLoBanks, hi: romHiBanks } = makeBanks();
m.setCartridge({ type: 'easyflash', mode: '8k', romLoBanks, romHiBanks });

// Initial state: Ultimax mode, bank 0.
assert(m.cartMode === 'ultimax', 'default EF mode is Ultimax');
assert(m.cartBank === 0,      'default bank 0');
assert(m.read(0x8000) === 0x10, 'bank 0 ROML at $8000');
// $E000 should be ROMH in Ultimax mode
assert(m.read(0xE000) === 0x80, 'ROMH visible in Ultimax mode');
console.log('ok  – EF power-on defaults');

// Switch to bank 5
m.write(0xDE00, 5);
assert(m.cartBank === 5, 'bank register accepts bank 5');
assert(m.read(0x8000) === 0x15, 'bank 5 ROML at $8000');
console.log('ok  – $DE00 bank switch');

// Bank value masked to 0x3F
m.write(0xDE00, 0xFF);
assert(m.cartBank === 0x3F, 'bank masked to 6 bits');
console.log('ok  – bank register mask');

// Control register: 16K mode (/EXROM=0, /GAME=0 -> bits M=1, X=1, G=1 -> 0x07)
m.write(0xDE00, 0);
m.write(0xDE02, 0x07);
assert(m.cartMode === '16k', '$DE02=0x07 → 16K');
assert(m.read(0x8000) === 0x10, 'ROML still bank 0');
assert(m.read(0xA000) === 0x80, 'ROMH at $A000 in 16K mode');
// KERNAL unaffected
assert(m.read(0xE000) === 0xEE, 'KERNAL still visible in 16K mode');
console.log('ok  – 16K mode via $DE02=$07');

// Ultimax: $DE02=0x00 (/EXROM=1, /GAME=0 jumper boot default)
m.write(0xDE02, 0x00);
assert(m.cartMode === 'ultimax', '$DE02=0x00 → ultimax');
assert(m.read(0xE000) === 0x80, 'cart ROMH replaces KERNAL in ultimax');
// $5000 open bus in ultimax
assert(m.read(0x5000) === 0xFF, 'ultimax open-bus in $1000-$7FFF');
console.log('ok  – Ultimax mode via $DE02=0x00');

// Change to 8K mode via $DE02
// /EXROM=0, /GAME=1 -> bits M=1, X=1, G=0 -> 0x06
m.write(0xDE02, 0x06);
assert(m.cartMode === '8k', '$DE02=0x06 -> 8K mode');
console.log('ok  – 8K mode via $DE02=0x06');

// Cart off: $DE02=0x04 (only LED on)
m.write(0xDE02, 0x04);
assert(m.cartMode === 'none', '$DE02=0x04 → cart off');
// Back in normal C64 mode — KERNAL visible
assert(m.read(0xE000) === 0xEE, 'KERNAL visible when cart off');
// $8000 reads from RAM
assert(m.read(0x8000) === 0x00, 'RAM visible at $8000 when cart off');
console.log('ok  – cart-off mode via $DE02=0x04');

// Cart RAM at $DF00-$DFFF
m.write(0xDF00, 0xAB);
m.write(0xDFFF, 0xCD);
assert(m.read(0xDF00) === 0xAB, 'cart RAM write/read at $DF00');
assert(m.read(0xDFFF) === 0xCD, 'cart RAM write/read at $DFFF');
// Distinct from C64 RAM behind
m.ram[0xDF00] = 0x11;
assert(m.read(0xDF00) === 0xAB, 'cart RAM shadows C64 RAM');
console.log('ok  – EF cart RAM $DF00-$DFFF');

// Reset: bank/mode restored, cart ROMs preserved, cart RAM zeroed
m.write(0xDE00, 10);
m.write(0xDE02, 0x07);
m.write(0xDF00, 0x99);
m.reset();
assert(m.cartBank === 0,   'reset restores bank 0');
assert(m.cartMode === 'ultimax', 'reset restores Ultimax mode');
assert(m.read(0x8000) === 0x10, 'reset re-points ROML to bank 0');
assert(m.read(0xDF00) === 0x00, 'reset clears cart RAM');
// ROM banks still intact
assert(m.cartRomLoBanks[10][0] === 0x1A, 'bank data preserved across reset');
console.log('ok  – reset preserves ROM banks, clears registers + RAM');

// Eject via setCartridge({ mode: 'none' })
m.setCartridge({ mode: 'none' });
assert(m.cartType === 'none', 'eject clears cartType');
assert(m.cartRomLoBanks === null, 'eject clears bank arrays');
console.log('ok  – eject clears all EF state');

console.log('\nAll EasyFlash tests passed.');
