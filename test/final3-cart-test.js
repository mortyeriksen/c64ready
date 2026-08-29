// Final Cartridge III (CRT type 3) hardware spec tests.
// Sources:
//   https://rr.c64.org/wiki/Final_Cartridge
//   https://rr.c64.org/wiki/Final_Cartridge_III_Internals_Errata.txt

import { Memory } from '../src/memory.js';
import { C64Machine } from '../src/machine.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function makeBanks() {
  const lo = new Array(4);
  const hi = new Array(4);
  for (let bank = 0; bank < 4; bank++) {
    lo[bank] = new Uint8Array(8192).fill(0x10 + bank);
    hi[bank] = new Uint8Array(8192).fill(0x80 + bank);
    lo[bank][0x1E00] = 0xA0 + bank;
    lo[bank][0x1FFF] = 0xD0 + bank;
  }
  return { lo, hi };
}

function makeMemory() {
  const m = new Memory();
  m.kernal = new Uint8Array(8192).fill(0xEE);
  m.basic = new Uint8Array(8192).fill(0xBB);
  const { lo, hi } = makeBanks();
  m.setCartridge({ type: 'final3', romLoBanks: lo, romHiBanks: hi });
  return m;
}

function writeAscii(buf, offset, str, pad = 0) {
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  for (let i = str.length; i < pad; i++) buf[offset + i] = 0;
}
function writeU16BE(buf, o, v) { buf[o] = (v >> 8) & 0xFF; buf[o + 1] = v & 0xFF; }
function writeU32BE(buf, o, v) {
  buf[o] = (v >>> 24) & 0xFF;
  buf[o + 1] = (v >>> 16) & 0xFF;
  buf[o + 2] = (v >>> 8) & 0xFF;
  buf[o + 3] = v & 0xFF;
}
function buildFinal3CRT() {
  const chips = [];
  for (let bank = 0; bank < 4; bank++) {
    const data = new Uint8Array(16384);
    data.fill(0x10 + bank, 0, 8192);
    data.fill(0x80 + bank, 8192);
    data[0x1E00] = 0xA0 + bank;
    chips.push({ bank, data });
  }
  const buf = new Uint8Array(0x40 + chips.length * (16 + 16384));
  writeAscii(buf, 0, 'C64 CARTRIDGE   ');
  writeU32BE(buf, 0x10, 0x40);
  writeU16BE(buf, 0x14, 0x0100);
  writeU16BE(buf, 0x16, 3);
  buf[0x18] = 1;
  buf[0x19] = 1;
  writeAscii(buf, 0x20, 'FINAL CARTRIDGE 3', 32);
  let off = 0x40;
  for (const chip of chips) {
    writeAscii(buf, off, 'CHIP');
    writeU32BE(buf, off + 4, 16 + chip.data.length);
    writeU16BE(buf, off + 8, 0);
    writeU16BE(buf, off + 10, chip.bank);
    writeU16BE(buf, off + 12, 0x8000);
    writeU16BE(buf, off + 14, chip.data.length);
    buf.set(chip.data, off + 16);
    off += 16 + chip.data.length;
  }
  return buf;
}

// Power-up: latch $00 selects bank 0, 16K, and asserts active-low NMI.
{
  const m = makeMemory();
  assert(m.cartControl === 0x00, 'FC3 power-up control latch is $00');
  assert(m.cartMode === '16k', 'FC3 power-up maps 16K');
  assert(m.cartBank === 0, 'FC3 power-up selects bank 0');
  assert(m.cartNmiAsserted, 'FC3 power-up bit 6 low asserts NMI');
  assert(m.read(0x8000) === 0x10, 'FC3 power-up ROML is bank 0');
  assert(m.read(0xA000) === 0x80, 'FC3 power-up ROMH is bank 0');
  m.setCartridge({ type: 'generic', mode: '8k', romLo: new Uint8Array(8192) });
  assert(!m.cartNmiAsserted, 'replacing FC3 releases its cartridge NMI source');
  console.log('ok  - FC3 power-up latch selects bank 0, 16K, and active NMI');
}

// The four EXROM/GAME combinations select 16K, Ultimax, 8K, and disabled.
{
  const m = makeMemory();
  m.write(0xDFFF, 0x40);
  assert(m.cartMode === '16k', '$DFFF GAME=0 EXROM=0 selects 16K');
  m.write(0xDFFF, 0x50);
  assert(m.cartMode === 'ultimax', '$DFFF GAME=0 EXROM=1 selects Ultimax');
  assert(m.read(0xE000) === 0x80, 'FC3 Ultimax maps selected ROMH at $E000');
  m.write(0xDFFF, 0x62);
  assert(m.cartMode === '8k', '$DFFF GAME=1 EXROM=0 selects 8K');
  assert(m.cartBank === 2 && m.read(0x8000) === 0x12, 'FC3 bank bits select bank 2');
  assert(m.read(0xA000) === 0xBB, 'FC3 8K mode leaves BASIC visible');
  m.write(0xDFFF, 0x73);
  assert(m.cartMode === 'none', '$DFFF GAME=1 EXROM=1 disables main ROM');
  assert(m.read(0xE000) === 0xEE, 'FC3 disabled mode leaves KERNAL visible');
  console.log('ok  - FC3 EXROM/GAME truth table and bank selection');
}

// IO1/IO2 always mirror $1E00-$1FFF of the selected ROML bank.
{
  const m = makeMemory();
  m.write(0xDFFF, 0x72);
  assert(m.cartMode === 'none', 'precondition: FC3 main ROM disabled');
  assert(m.read(0xDE00) === 0xA2, 'FC3 IO1 mirrors selected bank ROM at $1E00');
  assert(m.read(0xDFFF) === 0xD2, 'FC3 $DFFF read returns ROM, not control latch');
  console.log('ok  - FC3 IO1/IO2 ROM mirror remains visible when main ROM is off');
}

// Bit 7 hides the register; FREEZE temporarily unlocks it and forces GAME/NMI.
{
  const m = makeMemory();
  const nmi = [];
  m.cartNmiHandler = asserted => nmi.push(asserted);
  m.write(0xDFFF, 0xE1); // bank 1, 8K, NMI released, register hidden
  assert(m.cartControl === 0xE1 && m.cartMode === '8k', 'FC3 bit 7 hides configured latch');
  nmi.length = 0;
  m.write(0xDFFF, 0x40);
  assert(m.cartControl === 0xE1, 'FC3 hidden $DFFF ignores ordinary writes');
  m.setFinal3Freeze(true);
  assert(m.cartMode === '16k', 'FC3 FREEZE forces GAME low');
  assert(m.cartNmiAsserted, 'FC3 FREEZE asserts NMI');
  m.write(0xDFFF, 0x43);
  assert(m.cartControl === 0x43 && m.cartBank === 3, 'FC3 FREEZE temporarily unlocks $DFFF');
  m.setFinal3Freeze(false);
  assert(m.cartMode === '16k' && !m.cartNmiAsserted, 'FC3 FREEZE release restores latch lines');
  assert(nmi.join(',') === 'true,false', 'FC3 FREEZE produces one NMI assertion and release');
  console.log('ok  - FC3 hidden register, FREEZE unlock, line override, and NMI');
}

// The FREEZE button pulls /NMI and GAME only — EXROM stays latched — so whether
// the /NMI vector at $FFFA belongs to the cartridge depends on the latch. From
// the EXROM-high state BASIC runs in, freezing reaches Ultimax and the freezer
// gets the vector; from an EXROM-low state (the FC3's own BASIC extension and
// DESKTOP) it reaches only 16K and the vector stays in the KERNAL. Both are
// hardware behaviour: forcing EXROM here would be wrong.
{
  const m = makeMemory();
  m.write(0xDFFF, 0x71);   // bank 1, EXROM high, GAME high → cart hidden
  assert(m.cartMode === 'none', 'precondition: FC3 hidden, as at the BASIC prompt');
  m.setFinal3Freeze(true);
  assert(m.cartMode === 'ultimax', 'FC3 FREEZE on an EXROM-high latch reaches Ultimax');
  assert(m.read(0xFFFA) === 0x81, 'FC3 Ultimax freeze maps selected cart ROMH over $FFFA');
  m.setFinal3Freeze(false);

  m.write(0xDFFF, 0x42);   // bank 2, EXROM low, GAME low → 16K, DESKTOP-style
  assert(m.cartMode === '16k', 'precondition: FC3 in its own 16K configuration');
  m.setFinal3Freeze(true);
  assert(m.cartMode === '16k', 'FC3 FREEZE on an EXROM-low latch stays 16K');
  assert(m.read(0xFFFA) === 0xEE, 'FC3 16K freeze leaves the KERNAL NMI vector in place');
  m.setFinal3Freeze(false);
  console.log('ok  - FC3 FREEZE pulls GAME only; EXROM latch decides who owns $FFFA');
}

// C64 /RESET preserves the latch; power/cart reset restores $00.
{
  const m = makeMemory();
  m.write(0xDFFF, 0x63);
  m.softReset();
  assert(m.cartControl === 0x63, 'C64 reset-line pulse preserves FC3 latch');
  m.reset();
  assert(m.cartControl === 0x00 && m.cartMode === '16k', 'power reset restores FC3 latch $00');
  console.log('ok  - FC3 external reset preserves latch; power reset restores it');
}

// Save state preserves the latch but never restores a held physical button.
{
  const m = makeMemory();
  m.write(0xDFFF, 0xE2);
  const state = m.serialize();
  m.setFinal3Freeze(true);
  m.deserialize(state);
  assert(m.cartControl === 0xE2 && m.cartBank === 2, 'FC3 save state restores control and bank');
  assert(!m.cartFreezeHeld, 'FC3 save state does not restore held FREEZE input');
  assert(m.cartMode === '8k' && !m.cartNmiAsserted, 'FC3 restore recomputes released lines');
  console.log('ok  - FC3 save/restore preserves latch, not transient FREEZE input');
}

// End-to-end CRT loading and the cartridge-specific RESET operation.
{
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: new Uint8Array(8192).fill(0xEE),
    basic: new Uint8Array(8192).fill(0xBB),
    charRom: new Uint8Array(4096).fill(0xCC),
  });
  const info = machine.loadCartridge(buildFinal3CRT());
  assert(info.hwType === 3 && info.hasReset && info.hasFreeze,
    'FC3 loader reports type and physical controls');
  assert(machine.mem.read(0x8000) === 0x10 && machine.mem.read(0xA000) === 0x80,
    'FC3 loader splits each 16K CHIP into ROML and ROMH');
  machine.mem.write(0xDFFF, 0x51);
  assert(machine.vic2._vicMemRead(0x3000, 0x0000) === 0x81,
    'PLA Ultimax: VIC local $3000 sees upper 4K of selected ROMH');
  assert(machine.vic2._vicMemRead(0x3000, 0xC000) === 0x81,
    'PLA Ultimax: VIC ROMH window is independent of the CIA-selected bank');
  machine.mem.ram[0x1000] = 0x5A;
  assert(machine.vic2._vicMemRead(0x1000, 0x0000) === 0x5A,
    'PLA Ultimax: VIC local $1000 sees DRAM rather than character ROM');

  machine.mem.write(0xDFFF, 0x63);
  machine.mem.ram[0x4000] = 0x5A;
  assert(machine.resetCartridge(), 'FC3 cartridge RESET operation accepted');
  assert(machine.mem.cartControl === 0x00, 'FC3 cartridge RESET restores latch $00');
  assert(machine.mem.ram[0x4000] === 0x5A, 'FC3 cartridge RESET preserves DRAM');
  console.log('ok  - FC3 CRT loader and cartridge RESET button semantics');
}

// Multiple NMI sources share one physical edge.
{
  const machine = new C64Machine();
  machine.mem.setCartridge({ type: 'final3', romLoBanks: makeBanks().lo, romHiBanks: makeBanks().hi });
  machine.mem.write(0xDFFF, 0x40); // release cartridge NMI
  machine._cpuNmiEdgeSeen = false;
  machine.setRestoreNmiLine(true);
  assert(machine._cpuNmiEdgeSeen, 'RESTORE creates an edge on released /NMI');
  machine._cpuNmiEdgeSeen = false;
  machine.mem.write(0xDFFF, 0x00);
  assert(!machine._cpuNmiEdgeSeen, 'cartridge assertion while RESTORE holds /NMI creates no edge');
  machine.setRestoreNmiLine(false);
  machine.mem.write(0xDFFF, 0x40);
  machine.mem.write(0xDFFF, 0x00);
  assert(machine._cpuNmiEdgeSeen, 'cartridge reassertion after full release creates an edge');
  console.log('ok  - CIA/RESTORE/cartridge NMI sources share one physical edge');
}

console.log('\nAll Final Cartridge III tests passed.');
