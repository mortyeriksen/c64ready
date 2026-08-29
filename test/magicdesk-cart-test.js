// magicdesk-cart-test.js
//
// Locks the CRT type 19 (Magic Desk / Domark / HES Australia) cart
// emulation: 8K ROM banks at $8000-$9FFF, $DE00 bank-select register
// (bits 0-5 = bank, bit 7 = disable), EXROM=0/GAME=1 (8K mode).
//
// Hardware source: Universal Cartridge 1's documented Magic Desk-compatible
// register form.
// https://github.com/msolajic/c64-uni-cart

import { Memory } from '../src/memory.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Make a Memory instance with KERNAL/BASIC/CHARROM filled to recognizable bytes.
function makeMem() {
  const m = new Memory();
  m.kernal  = new Uint8Array(8192).fill(0xEE);
  m.basic   = new Uint8Array(8192).fill(0xBB);
  m.charRom = new Uint8Array(4096).fill(0xCC);
  m.reset();
  return m;
}

// Make 4 distinct 8K banks for testing — each filled with a unique byte
// so we can identify which bank is mapped.
function makeBanks() {
  const banks = new Array(64);
  for (let i = 0; i < 64; i++) {
    banks[i] = new Uint8Array(8192).fill(0x10 + i);
  }
  return banks;
}

// Test 1: load Magic Desk cart, verify default = bank 0 visible at $8000
{
  const m = makeMem();
  const banks = makeBanks();
  m.setCartridge({ type: 'magicdesk', romLoBanks: banks });

  assert(m.cartType === 'magicdesk', `cartType set to magicdesk, got ${m.cartType}`);
  assert(m.cartMode === '8k', `cartMode = 8k by default, got ${m.cartMode}`);
  assert(m.cartBank === 0, `default bank = 0, got ${m.cartBank}`);

  // Cart ROM should be visible at $8000-$9FFF (cpuPort=$37 = LORAM+HIRAM+CHAREN).
  assert(m.read(0x8000) === 0x10, `$8000 reads bank 0's first byte ($10), got $${m.read(0x8000).toString(16)}`);
  assert(m.read(0x9FFF) === 0x10, `$9FFF reads bank 0 (last byte), got $${m.read(0x9FFF).toString(16)}`);
  // ROMH not used — $A000-$BFFF should map to BASIC ROM, not cart.
  assert(m.read(0xA000) === 0xBB, `$A000 maps to BASIC (Magic Desk has no ROMH), got $${m.read(0xA000).toString(16)}`);

  console.log('ok  - Magic Desk: bank 0 visible at $8000-$9FFF; ROMH untouched');
}

// Test 2: $DE00 write selects bank
{
  const m = makeMem();
  const banks = makeBanks();
  m.setCartridge({ type: 'magicdesk', romLoBanks: banks });

  m.write(0xDE00, 0x05);
  assert(m.cartBank === 5, `$DE00=5 → bank 5, got ${m.cartBank}`);
  assert(m.read(0x8000) === 0x15, `bank 5 visible at $8000, got $${m.read(0x8000).toString(16)}`);

  m.write(0xDE00, 0x3F);
  assert(m.cartBank === 0x3F, `$DE00=$3F → bank 63, got ${m.cartBank}`);
  assert(m.read(0x8000) === 0x10 + 0x3F, `bank 63 visible at $8000`);

  // Bank bits are 6 wide; higher bits ignored (except bit 7).
  m.write(0xDE00, 0x45);  // 0x45 = 0b01000101 — bit 6 set, bit 0+2 set
  assert(m.cartBank === 0x05, `$DE00=$45 keeps low 6 bits, got ${m.cartBank}`);

  console.log('ok  - Magic Desk: $DE00 selects bank from bits 0-5');
}

// Test 3: $DE00 bit 7 disables the cart
{
  const m = makeMem();
  const banks = makeBanks();
  m.setCartridge({ type: 'magicdesk', romLoBanks: banks });

  m.write(0xDE00, 0x07);   // bank 7 active
  assert(m.read(0x8000) === 0x17, `bank 7 visible at $8000`);

  m.write(0xDE00, 0x80);   // disable
  assert(m.cartMode === 'none', `bit 7 set → cartMode = none, got ${m.cartMode}`);
  assert(m.cartRomLo === null, `bit 7 set → cartRomLo cleared`);
  // $8000 should now read RAM (whatever's there from the DRAM init pattern).
  const dramExpected = (((0x8000 >> 1) ^ (0x8000 >> 2)) & 1) ? 0xFF : 0x00;
  assert(m.read(0x8000) === dramExpected,
    `cart disabled → $8000 reads RAM ($${dramExpected.toString(16)}), got $${m.read(0x8000).toString(16)}`);

  // Re-enable with bit 7 clear.
  m.write(0xDE00, 0x02);
  assert(m.cartMode === '8k', `bit 7 clear → cartMode back to 8k`);
  assert(m.cartBank === 2, `bank 2 selected after re-enable`);
  assert(m.read(0x8000) === 0x12, `bank 2 visible at $8000 after re-enable`);

  console.log('ok  - Magic Desk: $DE00 bit 7 disables/re-enables cart');
}

// Test 4: $DE00 reads return open bus ($FF)
{
  const m = makeMem();
  const banks = makeBanks();
  m.setCartridge({ type: 'magicdesk', romLoBanks: banks });

  assert(m.read(0xDE00) === 0xFF, `$DE00 read = open bus ($FF), got $${m.read(0xDE00).toString(16)}`);
  assert(m.read(0xDE7F) === 0xFF, `$DE7F read = open bus`);

  console.log('ok  - Magic Desk: $DE00 reads return open bus');
}

// Test 5: cart survives soft reset; bank resets to 0
{
  const m = makeMem();
  const banks = makeBanks();
  m.setCartridge({ type: 'magicdesk', romLoBanks: banks });

  m.write(0xDE00, 0x80);   // disable
  m.write(0xDE00, 0x10);   // bank 16
  assert(m.cartBank === 0x10);

  m.softReset({ allowSoft: true });
  assert(m.cartType === 'magicdesk', `cart type preserved across softReset`);
  assert(m.cartBank === 0, `bank reset to 0, got ${m.cartBank}`);
  assert(m.cartMode === '8k', `mode back to 8k after softReset`);
  assert(m.read(0x8000) === 0x10, `bank 0 visible after softReset`);

  console.log('ok  - Magic Desk: bank resets to 0 on softReset, cart preserved');
}

console.log('\nAll Magic Desk cart tests passed.');
