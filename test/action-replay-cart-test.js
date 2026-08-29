// Action Replay v4.x/v5/v6 (CRT type 1) hardware behavior tests.
// Hardware references:
//   https://rr.c64.org/wiki/File:Action_Replay_MK5_6.gif
//   https://rr.c64.org/wiki/File:Ar6pla.rar

import { Memory } from '../src/memory.js';
import { C64Machine } from '../src/machine.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function makeBanks() {
  return Array.from({ length: 4 }, (_, bank) => {
    const bytes = new Uint8Array(8192).fill(0x10 + bank);
    bytes[0x1f00] = 0xa0 + bank;
    return bytes;
  });
}

function makeMemory() {
  const memory = new Memory();
  memory.kernal = new Uint8Array(8192).fill(0xee);
  memory.basic = new Uint8Array(8192).fill(0xbb);
  memory.setCartridge({ type: 'action-replay', romBanks: makeBanks() });
  return memory;
}

function writeAscii(buf, offset, str, pad = 0) {
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  for (let i = str.length; i < pad; i++) buf[offset + i] = 0;
}
function writeU16BE(buf, o, v) { buf[o] = v >> 8; buf[o + 1] = v; }
function writeU32BE(buf, o, v) {
  buf[o] = v >>> 24; buf[o + 1] = v >>> 16; buf[o + 2] = v >>> 8; buf[o + 3] = v;
}
function buildCRT() {
  const banks = makeBanks();
  const buf = new Uint8Array(0x40 + 4 * (16 + 8192));
  writeAscii(buf, 0, 'C64 CARTRIDGE   ');
  writeU32BE(buf, 0x10, 0x40);
  writeU16BE(buf, 0x14, 0x0100);
  writeU16BE(buf, 0x16, 1);
  writeAscii(buf, 0x20, 'ACTION REPLAY VI', 32);
  let offset = 0x40;
  for (let bank = 0; bank < 4; bank++) {
    writeAscii(buf, offset, 'CHIP');
    writeU32BE(buf, offset + 4, 16 + 8192);
    writeU16BE(buf, offset + 8, 0);
    writeU16BE(buf, offset + 10, bank);
    writeU16BE(buf, offset + 12, 0x8000);
    writeU16BE(buf, offset + 14, 8192);
    buf.set(banks[bank], offset + 16);
    offset += 16 + 8192;
  }
  return buf;
}

{
  const m = makeMemory();
  assert(m.cartMode === '8k' && m.cartBank === 0, 'reset register $00 selects bank 0 in 8K mode');
  assert(m.read(0x8000) === 0x10, 'reset maps ROM bank 0 at ROML');
  m.write(0xde00, 0x19);
  assert(m.cartMode === '16k' && m.cartBank === 3, 'bits 3-4 bank ROM and bit 0 asserts GAME');
  assert(m.read(0x8000) === 0x13 && m.read(0xa000) === 0x13,
    '16K mode mirrors the selected 8K ROM through ROML and ROMH');
  m.write(0xde00, 0x1b);
  assert(m.cartMode === 'ultimax' && m.read(0xe000) === 0x13,
    'GAME asserted with EXROM released selects Ultimax ROMH');
  console.log('ok  - Action Replay control-line and ROM-bank mapping');
}

{
  const m = makeMemory();
  m.write(0xde00, 0x10);
  assert(m.read(0xdf00) === 0xa2, 'IO2 reads the final page of the selected ROM bank');
  m.write(0xdf00, 0x55);
  assert(m.read(0xdf00) === 0xa2, 'IO2 writes do not alter ROM when RAM is not selected');
  m.write(0xde00, 0x20);
  m.write(0x8000, 0x34);
  m.write(0xdf00, 0x56);
  assert(m.read(0x8000) === 0x34, 'RAM-select maps writable cartridge RAM at ROML');
  assert(m.read(0xdf00) === 0x56 && m.cartRam[0x1f00] === 0x56,
    'RAM-select maps its final page through IO2');
  console.log('ok  - Action Replay RAM and IO2 selection');
}

{
  const m = makeMemory();
  m.write(0xde00, 0x20);
  m.write(0x8000, 0x30);
  m.ram[0x8000] = 0x05;
  m.write(0xde00, 0x22);
  assert(m.read(0x8000) === 0x35, '$22 ROML contention combines C64 and cartridge RAM data');
  console.log('ok  - Action Replay $22 contended ROML read');
}

{
  const m = makeMemory();
  m.write(0xde00, 0x08);
  m.externalDataBus8 = 0x19;
  assert(m.peekForCpu(0xde20) === 0x19, 'IO1 peek reports the phi1 bus byte');
  assert(m.cartControl === 0x08, 'IO1 peek does not corrupt the register');
  assert(m.read(0xde20) === 0x19, 'IO1 read returns the phi1 bus byte');
  assert(m.cartControl === 0x19 && m.cartBank === 3,
    'IO1 read clocks the phi1 bus byte into the control register');
  console.log('ok  - Action Replay IO1 reads corrupt the control register from the bus');
}

{
  const m = makeMemory();
  m.write(0xde00, 0x04);
  m.write(0xde00, 0x00);
  assert(m.cartMode === 'none' && m.cartControl === 0x04,
    'kill bit hides the cartridge register until reset or freeze');
  m.softReset();
  assert(m.cartControl === 0 && m.cartMode === '8k', '/RESET re-enables Action Replay');
  console.log('ok  - Action Replay kill and reset lifecycle');
}

{
  const m = makeMemory();
  m.write(0xde00, 0x04);
  assert(m.setCartridgeFreeze(true), 'FREEZE input is accepted');
  assert(m.cartMode === 'ultimax' && m.cartNmiAsserted, 'FREEZE forces Ultimax and asserts NMI');
  assert(m.read(0xe000) === 0x10, 'FREEZE maps bank 0 ROM at ROMH');
  m.write(0x8000, 0x67);
  assert(m.cartRam[0] === 0x67, 'FREEZE maps cartridge RAM at ROML');
  m.setCartridgeFreeze(false);
  assert(m.cartNmiAsserted, 'physical button release leaves the freeze latch asserted');
  m.write(0xde00, 0x40);
  assert(!m.cartNmiAsserted && m.cartMode === '8k', 'bit 6 acknowledges FREEZE and restores mapping');
  console.log('ok  - Action Replay latched FREEZE sequence');
}

{
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: new Uint8Array(8192).fill(0xee),
    basic: new Uint8Array(8192).fill(0xbb),
    charRom: new Uint8Array(4096),
  });
  const info = machine.loadCartridge(buildCRT());
  assert(info.hwType === 1 && info.hasReset && info.hasFreeze,
    'type 1 loader exposes Action Replay physical controls');
  assert(machine.mem.cartType === 'action-replay' && machine.mem.read(0x8000) === 0x10,
    'type 1 CRT constructs the Action Replay device');
  console.log('ok  - Action Replay CRT type 1 registry loading');
}

console.log('\nAll Action Replay cartridge tests passed.');
