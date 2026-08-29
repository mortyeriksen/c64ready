// Cartridge specs for the two paths every cart type shares but no test covered:
// building the device from a .CRT image, and the save-state round trip.
//
// The .CRT side is where a mis-laid bank silently loads the wrong 8K; the
// save-state side is where a restored state re-points the active bank (the ROM
// banks themselves are not in the snapshot — see Memory.serialize). Both are
// invisible until a cart boots wrong, so they are pinned here per hardware type.
//
// Usage: node test/cartridge-crt-state-spec-test.js

import { parseCRT } from '../src/crt.js';
import { Memory } from '../src/memory.js';
import { CartridgeDevice, IO_UNHANDLED } from '../src/cartridges/device.js';
import { ActionReplayCartridge } from '../src/cartridges/action-replay.js';
import { EasyFlashCartridge } from '../src/cartridges/easyflash.js';
import { FinalCartridge3 } from '../src/cartridges/final3.js';
import {
  createCartridgeFromCRT, createCartridgeFromConfig,
} from '../src/cartridges/registry.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const msg of currentFailures) console.log(`     - ${msg}`);
    currentFailures = [];
  }
}
function throws(fn, pattern, msg) {
  try { fn(); } catch (e) { expect(pattern.test(e.message), `${msg} (got "${e.message}")`); return; }
  expect(false, `${msg} (nothing thrown)`);
}

// ── .CRT builder (header + CHIP packets), same layout as crt-test.js ─────────
function writeAscii(buf, offset, str, pad = 0) {
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  for (let i = str.length; i < pad; i++) buf[offset + i] = 0;
}
function writeU16BE(buf, o, v) { buf[o] = (v >> 8) & 0xFF; buf[o + 1] = v & 0xFF; }
function writeU32BE(buf, o, v) {
  buf[o] = (v >>> 24) & 0xFF; buf[o + 1] = (v >>> 16) & 0xFF;
  buf[o + 2] = (v >>> 8) & 0xFF; buf[o + 3] = v & 0xFF;
}
function crtImage({ hwType, exrom = 0, game = 1, name = 'SPEC CART', chips }) {
  const HEADER_LEN = 0x40;
  const buf = new Uint8Array(
    HEADER_LEN + chips.reduce((s, c) => s + 16 + c.data.length, 0),
  );
  writeAscii(buf, 0x00, 'C64 CARTRIDGE   ');
  writeU32BE(buf, 0x10, HEADER_LEN);
  writeU16BE(buf, 0x14, 0x0100);
  writeU16BE(buf, 0x16, hwType);
  buf[0x18] = exrom;
  buf[0x19] = game;
  writeAscii(buf, 0x20, name, 32);
  let off = HEADER_LEN;
  for (const c of chips) {
    writeAscii(buf, off, 'CHIP');
    writeU32BE(buf, off + 4, 16 + c.data.length);
    writeU16BE(buf, off + 8, c.type ?? 2);
    writeU16BE(buf, off + 10, c.bank ?? 0);
    writeU16BE(buf, off + 12, c.loadAddr);
    writeU16BE(buf, off + 14, c.data.length);
    buf.set(c.data, off + 16);
    off += 16 + c.data.length;
  }
  return parseCRT(buf);
}
const chunk = (byte, size = 8192) => new Uint8Array(size).fill(byte);
const allZero = a => a.every(b => b === 0);

// A Memory with recognizable ROMs behind the cart windows.
function makeMem() {
  const m = new Memory();
  m.kernal = new Uint8Array(8192).fill(0xEE);
  m.basic = new Uint8Array(8192).fill(0xBB);
  m.charRom = new Uint8Array(4096).fill(0xCC);
  m.reset();
  return m;
}
// 64 banks, each marked with its own byte, for the config-object carts.
function markedBanks(base) {
  return Array.from({ length: 64 }, (_, i) => chunk((base + i) & 0xFF));
}

// ── Magic Desk: CRT layout ───────────────────────────────────────────────────
// Only 8K CHIPs at $8000 are cart ROM; a short one leaves the rest of its bank
// blank, and anything else in the image belongs to a different mapper.
{
  const dev = createCartridgeFromCRT(crtImage({
    hwType: 19, exrom: 0, game: 1, name: 'MAGIC DESK',
    chips: [
      { bank: 0, loadAddr: 0x8000, data: chunk(0xA0) },
      { bank: 3, loadAddr: 0x8000, data: chunk(0x33, 4096) },   // short bank
      { bank: 5, loadAddr: 0xA000, data: chunk(0x55) },         // not a ROML chip
      { bank: 6, loadAddr: 0x8000, data: chunk(0x66, 16384) },  // too big for 8K
      { bank: 64, loadAddr: 0x8000, data: chunk(0x77) },        // past the 64-bank window
    ],
  }));

  expect(dev.id === 'magicdesk', `type 19 builds a Magic Desk, got ${dev.id}`);
  expect(dev.hwType === 19, 'Magic Desk keeps its CRT hardware type');
  expect(dev.romBanks.length === 64, 'Magic Desk always allocates 64 banks');
  expect(dev.romBanks[0][0] === 0xA0 && dev.romBanks[0][8191] === 0xA0,
    'a full 8K CHIP fills its whole bank');
  expect(dev.romBanks[3][0] === 0x33 && dev.romBanks[3][4095] === 0x33,
    'a short CHIP loads at the start of its bank');
  expect(allZero(dev.romBanks[3].subarray(4096)),
    'a short CHIP leaves the rest of its bank blank');
  expect(allZero(dev.romBanks[5]), 'a CHIP outside $8000 is not Magic Desk ROM');
  expect(allZero(dev.romBanks[6]), 'a CHIP larger than 8K is not a Magic Desk bank');
  expect(dev.mode === '8k' && dev.bank === 0 && dev.romLo === dev.romBanks[0],
    'a fresh Magic Desk powers up as 8K on bank 0');
  expect(dev.romHi === null, 'Magic Desk drives no ROMH');
  ok('Magic Desk .CRT loads $8000 banks and ignores everything else');
}

// ── Magic Desk: save state ───────────────────────────────────────────────────
{
  const m = makeMem();
  const banks = markedBanks(0x10);
  m.setCartridge({ type: 'magicdesk', romLoBanks: banks });

  m.write(0xDE00, 7);
  const saved = m.serialize();
  expect(saved.cart.id === 'magicdesk', 'snapshot names the cart type');
  expect(saved.cart.bank === 7 && saved.cart.mode === '8k',
    `snapshot holds bank + mode, got ${JSON.stringify(saved.cart)}`);

  m.write(0xDE00, 0x80);
  expect(m.cartMode === 'none', 'bit 7 disables before the restore');
  m.deserialize(saved);
  expect(m.cartMode === '8k' && m.cartBank === 7, 'restore brings back bank 7 in 8K');
  expect(m.read(0x8000) === 0x17, `restore re-points ROML at bank 7, got $${m.read(0x8000).toString(16)}`);

  // The disabled state is part of the state: restoring it must not re-expose ROM.
  m.write(0xDE00, 0x80);
  const savedOff = m.serialize();
  m.write(0xDE00, 2);
  m.deserialize(savedOff);
  expect(m.cartMode === 'none' && m.cartRomLo === null, 'a disabled cart restores disabled');
  expect(m.read(0x8000) === m.ram[0x8000], 'a restored disabled cart leaves RAM at $8000');

  m.cartridge.deserialize({ id: 'magicdesk', mode: '8k', bank: 0x45 });
  expect(m.cartBank === 5, `restore masks the bank to 6 bits, got ${m.cartBank}`);
  m.cartridge.deserialize({ id: 'magicdesk', mode: '8k' });
  expect(m.cartBank === 0 && m.cartRomLo === banks[0], 'a bankless state restores bank 0');
  ok('Magic Desk save state round-trips bank, mode and the disabled state');
}

// ── EasyFlash: CRT layout ────────────────────────────────────────────────────
// A 16K CHIP at $8000 is one bank's low and high half; $A000 and $E000 CHIPs are
// ROMH only (the latter is how Ultimax images ship).
{
  const split = new Uint8Array(16384);
  split.fill(0x11, 0, 8192);
  split.fill(0x22, 8192);
  const dev = createCartridgeFromCRT(crtImage({
    hwType: 32, exrom: 1, game: 0, name: 'EASYFLASH',
    chips: [
      { bank: 0, loadAddr: 0x8000, data: split },
      { bank: 1, loadAddr: 0x8000, data: chunk(0x33) },
      { bank: 2, loadAddr: 0xA000, data: chunk(0x44) },
      { bank: 3, loadAddr: 0xE000, data: chunk(0x55) },
      { bank: 4, loadAddr: 0xC000, data: chunk(0x66) },   // no such EasyFlash window
      { bank: 64, loadAddr: 0x8000, data: chunk(0x77) },  // past the 64-bank window
    ],
  }));

  expect(dev.id === 'easyflash', `type 32 builds an EasyFlash, got ${dev.id}`);
  expect(dev.romLoBanks.length === 64 && dev.romHiBanks.length === 64,
    'EasyFlash always allocates 64 low + 64 high banks');
  expect(dev.romLoBanks[0][0] === 0x11 && dev.romHiBanks[0][0] === 0x22,
    'a 16K CHIP splits into the low and high half of one bank');
  expect(dev.romLoBanks[1][0] === 0x33 && allZero(dev.romHiBanks[1]),
    'an 8K CHIP at $8000 is ROML only');
  expect(dev.romHiBanks[2][0] === 0x44 && allZero(dev.romLoBanks[2]),
    'a CHIP at $A000 is ROMH only');
  expect(dev.romHiBanks[3][0] === 0x55 && allZero(dev.romLoBanks[3]),
    'a CHIP at $E000 is ROMH (Ultimax image)');
  expect(allZero(dev.romLoBanks[4]) && allZero(dev.romHiBanks[4]),
    'a CHIP at any other address is not EasyFlash ROM');
  expect(dev.mode === 'ultimax' && dev.bank === 0,
    'a fresh EasyFlash powers up in Ultimax on bank 0');
  ok('EasyFlash .CRT splits 16K banks and takes ROMH from $A000/$E000');
}

// ── EasyFlash: I/O window reads ──────────────────────────────────────────────
{
  const m = makeMem();
  const romLoBanks = markedBanks(0x10);
  const romHiBanks = markedBanks(0x80);
  m.setCartridge({ type: 'easyflash', romLoBanks, romHiBanks });

  m.write(0xDF10, 0x5A);
  expect(m.peekForCpu(0xDF10) === 0x5A, 'peek reads cart RAM without disturbing it');
  expect(m.read(0xDF10) === 0x5A, 'cart RAM reads back what was written');

  // $DE00-$DEFF is write-only: reads see whatever last drove the bus.
  m.externalDataBus8 = 0x3C;
  expect(m.cartridge.ioRead(0xDE00) === 0x3C,
    `a $DE00 read floats with the bus, got $${m.cartridge.ioRead(0xDE00).toString(16)}`);
  expect(m.cartridge.ioPeek(0xDE55) === 0x3C, 'peek mirrors the read for $DE00');
  expect(m.cartridge.ioRead(0xD000) === IO_UNHANDLED,
    'the cart claims nothing outside $DE00-$DFFF');
  expect(m.cartridge.ioWrite(0xD000, 0) === false,
    'the cart refuses writes outside $DE00-$DFFF');

  const detached = new EasyFlashCartridge(romLoBanks, romHiBanks);
  expect(detached.ioRead(0xDE00) === 0xFF, 'with no bus to sample the read is open ($FF)');
  ok('EasyFlash I/O reads cover cart RAM, the write-only register and open bus');
}

// ── EasyFlash: save state ────────────────────────────────────────────────────
{
  const m = makeMem();
  const romLoBanks = markedBanks(0x10);
  const romHiBanks = markedBanks(0x80);
  m.setCartridge({ type: 'easyflash', romLoBanks, romHiBanks });

  m.write(0xDE00, 9);
  m.write(0xDE02, 0x07);   // M=1 X=1 G=1 → 16K
  m.write(0xDF20, 0x77);
  const saved = m.serialize();
  expect(saved.cart.bank === 9 && saved.cart.mode === '16k' && saved.cart.control === 0x07,
    `snapshot holds bank, mode and control, got ${JSON.stringify({ ...saved.cart, ram: null })}`);
  expect(saved.cart.ram[0x20] === 0x77, 'snapshot holds the 256 bytes of cart RAM');

  m.write(0xDF20, 0x11);
  expect(saved.cart.ram[0x20] === 0x77, 'the snapshot copied cart RAM, it does not alias it');

  m.write(0xDE00, 0);
  m.write(0xDE02, 0x04);   // cart off
  m.deserialize(saved);
  expect(m.cartMode === '16k' && m.cartBank === 9 && m.cartControl === 0x07,
    'restore brings back bank, mode and control');
  expect(m.read(0x8000) === 0x19 && m.read(0xA000) === 0x89,
    'restore re-points both ROML and ROMH at bank 9');
  expect(m.read(0xDF20) === 0x77, 'restore brings back cart RAM');

  m.cartridge.deserialize({ id: 'easyflash', mode: '8k', bank: 1 });
  expect(m.cartControl === 0, 'a controlless state restores control 0');
  expect(m.read(0xDF20) === 0x77, 'a RAM-less state leaves cart RAM alone');
  expect(m.cartMode === '8k' && m.read(0x8000) === 0x11, 'the restored bank is re-selected');
  ok('EasyFlash save state round-trips bank, mode, control and cart RAM');
}

// ── Action Replay: $DF00 window, save state, reset line ──────────────────────
{
  const arChips = Array.from({ length: 4 }, (_, bank) => {
    const data = chunk(0xA0 + bank);
    data[0x1F00] = 0xB0 + bank;      // the byte the $DF00 window exposes
    return { bank, loadAddr: 0x8000, data };
  });
  const m = makeMem();
  m.installCartridge(ActionReplayCartridge.fromCRT(crtImage({ hwType: 1, chips: arChips })));

  expect(m.peekForCpu(0xDF00) === 0xB0,
    `peek $DF00 reads ROM $9F00, got $${m.peekForCpu(0xDF00).toString(16)}`);
  m.write(0xDE00, 0x22);   // RAM at ROML + cart RAM in the I/O window
  m.write(0xDF00, 0x5E);
  expect(m.peekForCpu(0xDF00) === 0x5E,
    'peek $DF00 reads cart RAM once control bit 5 is set');
  expect(m.cartridge.ioRead(0xD000) === IO_UNHANDLED
      && m.cartridge.ioPeek(0xD000) === IO_UNHANDLED,
    'Action Replay claims nothing outside its two I/O pages');
  expect(m.cartridge.ioWrite(0xD000, 0) === false,
    'Action Replay refuses writes outside its two I/O pages');

  const saved = m.serialize();
  expect(saved.cart.control === 0x22 && saved.cart.freezeLatched === false,
    `snapshot holds control + freeze latch, got control $${saved.cart.control.toString(16)}`);
  expect(saved.cart.ram[0x1F00] === 0x5E, 'snapshot holds the 8K of cart RAM');

  m.write(0xDE00, 0x04);   // cart disabled
  expect(m.cartMode === 'none', 'control bit 2 disables before the restore');
  m.deserialize(saved);
  expect(m.cartControl === 0x22 && m.read(0xDF00) === 0x5E,
    'restore brings back control and cart RAM');

  expect(m.resetCartridgeControl() === true, 'Action Replay drives the reset line');
  expect(m.cartControl === 0 && m.cartFreezeHeld === false,
    'the reset line clears control and the freeze latch');
  ok('Action Replay save state round-trips control + RAM, and resets');
}

// ── Final Cartridge III: I/O peek and CRT validation ─────────────────────────
{
  const fcChips = Array.from({ length: 4 }, (_, bank) => {
    const data = new Uint8Array(16384);
    data.fill(0x40 + bank, 0, 8192);
    data.fill(0xC0 + bank, 8192);
    data[0x1E00] = 0xF0 + bank;      // the byte the $DE00 window exposes
    return { bank, loadAddr: 0x8000, data };
  });
  const m = makeMem();
  m.installCartridge(FinalCartridge3.fromCRT(crtImage({ hwType: 3, chips: fcChips })));
  expect(m.peekForCpu(0xDE00) === 0xF0,
    `peek $DE00 reads ROML $9E00, got $${m.peekForCpu(0xDE00).toString(16)}`);
  expect(m.peekForCpu(0xDFFE) === m.read(0xDFFE), 'peek and read agree across the window');

  const bad = size => () => FinalCartridge3.fromCRT(crtImage({
    hwType: 3, chips: [{ bank: 0, loadAddr: 0x8000, data: new Uint8Array(size) }],
  }));
  throws(bad(8192), /Invalid Final Cartridge III CHIP/, 'an 8K CHIP is not an FC3 bank');
  throws(
    () => FinalCartridge3.fromCRT(crtImage({
      hwType: 3, chips: [fcChips[0], fcChips[0]],
    })),
    /Duplicate Final Cartridge III bank 0/, 'a duplicate bank is rejected',
  );
  throws(
    () => FinalCartridge3.fromCRT(crtImage({ hwType: 3, chips: fcChips.slice(0, 2) })),
    /expected 4 banks, found 2/, 'a short FC3 image is rejected',
  );
  ok('Final Cartridge III peeks its ROM window and rejects malformed images');
}

// ── Malformed images the other mappers reject ────────────────────────────────
{
  const arChip = bank => ({ bank, loadAddr: 0x8000, data: chunk(0xA0 + bank) });
  throws(
    () => ActionReplayCartridge.fromCRT(crtImage({ hwType: 1, chips: [arChip(4)] })),
    /Invalid Action Replay CHIP: bank 4/, 'bank 4 is past the Action Replay window',
  );
  throws(
    () => ActionReplayCartridge.fromCRT(crtImage({
      hwType: 1, chips: [{ bank: 0, loadAddr: 0x8000, data: chunk(0xA0, 4096) }],
    })),
    /size 4096/, 'a half-size Action Replay bank is rejected',
  );
  throws(
    () => ActionReplayCartridge.fromCRT(crtImage({ hwType: 1, chips: [arChip(0), arChip(0)] })),
    /Duplicate Action Replay bank 0/, 'a duplicate Action Replay bank is rejected',
  );
  throws(
    () => ActionReplayCartridge.fromCRT(crtImage({ hwType: 1, chips: [arChip(0), arChip(1)] })),
    /expected 4 banks, found 2/, 'a short Action Replay image is rejected',
  );
  throws(
    () => createCartridgeFromCRT(crtImage({
      hwType: 0, exrom: 1, game: 1, chips: [{ bank: 0, loadAddr: 0x8000, data: chunk(0x01) }],
    })),
    /EXROM=1, GAME=1/, 'a generic cart must signal at least one line low',
  );
  ok('malformed .CRT images are rejected with the reason named');
}

// ── Registry: unknown hardware types and configs ─────────────────────────────
{
  throws(
    () => createCartridgeFromCRT(crtImage({
      hwType: 5, name: 'OCEAN', chips: [{ bank: 0, loadAddr: 0x8000, data: chunk(0x01) }],
    })),
    /Unsupported cartridge type 5 \("OCEAN"\)/, 'an unsupported CRT type names itself',
  );
  throws(
    () => createCartridgeFromCRT(crtImage({
      hwType: 5, chips: [{ bank: 0, loadAddr: 0x8000, data: chunk(0x01) }],
    })),
    /type 19 \(Magic Desk\), type 32 \(EasyFlash\)/, 'the error lists what is supported',
  );
  throws(
    () => createCartridgeFromConfig({ type: 'ocean' }),
    /Unknown cartridge configuration "ocean"/, 'an unknown config type is rejected',
  );
  expect(createCartridgeFromConfig(null) === null, 'no config means no cart');
  expect(createCartridgeFromConfig({ mode: 'none' }) === null, 'mode none means no cart');
  ok('the registry rejects hardware types and configs it cannot build');
}

// ── The base device is inert ─────────────────────────────────────────────────
// A new mapper only has to implement what it actually does; whatever it leaves
// alone must claim no I/O, no reset and no freeze.
{
  const dev = new CartridgeDevice({ id: 'stub' });
  expect(dev.label === 'stub' && dev.hwType === null,
    'the label defaults to the id and there is no hardware type');
  expect(dev.capabilities.reset === false && dev.capabilities.freeze === false,
    'a bare device has no buttons');
  expect(dev.physicalReset() === false, 'a bare device does not drive the reset line');
  expect(dev.freezePressed() === false && dev.freezeReleased() === false,
    'a bare device ignores the freeze button');
  expect(dev.ioRead(0xDE00) === IO_UNHANDLED && dev.ioPeek(0xDE00) === IO_UNHANDLED,
    'a bare device claims no I/O read');
  expect(dev.ioWrite(0xDE00, 0) === false, 'a bare device claims no I/O write');
  expect(dev.readRomLo(0x8000) === 0xFF, 'ROML reads open with no ROM attached');
  expect(dev.serialize().id === 'stub' && dev.serialize().mode === 'none',
    'the default snapshot is id, mode and bank');
  dev.deserialize({ id: 'stub' });   // no memory attached: must not throw

  dev.romLo = new Uint8Array(8192);
  dev.romLo[0x1234] = 0x7E;
  expect(dev.readRomLo(0x9234) === 0x7E, 'ROML reads mask the address into the 8K window');
  ok('a cartridge device with no overrides is inert');
}

console.log(`\n${testNo} cartridge CRT/state specs; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
