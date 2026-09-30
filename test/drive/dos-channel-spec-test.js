// test/drive/dos-channel-spec-test.js
//
// Spec test for disk I/O through the KERNAL with true drive emulation off:
// OPEN, CHKIN, CHRIN, CLOSE, SAVE and the command channel reach the virtual
// drive behind the serial primitives, on a D64 and on a D81, while a real
// 1541 with TDE on keeps the bus.
//
// Spec basis: the KERNAL jump table contract (Programmer's Reference Guide):
// SETNAM/SETLFS/OPEN open a file, CHKIN selects it for input, CHRIN returns
// its bytes with ST bit 6 set on the last, CLRCHN/CLOSE release it, SAVE
// writes the range between the zero-page pointer and X/Y. The DOS answers
// on channel 15 with "NN,MESSAGE,TT,SS" (1541 and 1581 User's Guides).
//
// Not covered elsewhere: the trap tests cover LOAD only; the virtual drive
// spec never boots a machine.

import { existsSync, readFileSync } from 'node:fs';
import { C64Machine } from '../../src/machine.js';
import { createBlankD64, createBlankD81, TYPE_SEQ } from '../../src/media/d64.js';

const ROMS = ['roms/kernal.bin', 'roms/basic.bin', 'roms/chargen.bin'];
if (!ROMS.every(existsSync)) {
  console.log('# SKIP C64 ROMs not available under roms/ (C64_ROM_DIR)');
  process.exit(0);
}
const DRIVE_ROM = 'roms/1541.bin';
const rom = (f) => new Uint8Array(readFileSync(f));

let failed = 0;
function expect(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
const ok = (label) => console.log(`ok  - ${label}`);

const STUB = 0xC000, PARK = 0xC0F0, NAME = 0xCF00, OUT = 0xC800, COUNT = 0xCF80, LASTST = 0xCF82;
const basicReady = (m) => m.mem.ram[0xC6] === 0 && m.mem.ram[0xCC] === 0 && m.mem.ram[0x2C] === 0x08;
const poke = (m, addr, bytes) => bytes.forEach((b, i) => { m.mem.ram[addr + i] = b; });

// SETNAM, SETLFS(lfn, 8, sa), OPEN, CHKIN, then CHRIN into OUT until ST is
// non-zero, keeping the count and the last ST; CLRCHN and CLOSE; park.
function readStub(m, { name, lfn, sa }) {
  for (let i = 0; i < name.length; i++) m.mem.ram[NAME + i] = name.charCodeAt(i);
  poke(m, STUB, [
    0xA9, name.length, 0xA2, NAME & 0xFF, 0xA0, NAME >> 8, 0x20, 0xBD, 0xFF,   // SETNAM
    0xA9, lfn, 0xA2, 0x08, 0xA0, sa, 0x20, 0xBA, 0xFF,                        // SETLFS
    0x20, 0xC0, 0xFF,                                                         // OPEN
    0xA2, lfn, 0x20, 0xC6, 0xFF,                                              // CHKIN
    0xA9, 0x00, 0x8D, COUNT & 0xFF, COUNT >> 8, 0x8D, (COUNT + 1) & 0xFF, COUNT >> 8,
    0xA0, 0x00,                                                               // Y = 0
    // loop: CHRIN, store at OUT+count, count++, ST? loop
    0x20, 0xCF, 0xFF,                                                         // CHRIN
    0x85, 0xFB,                                                               // STA $FB
    0xAD, COUNT & 0xFF, COUNT >> 8, 0x85, 0xFC,                               // count lo
    0xAD, (COUNT + 1) & 0xFF, COUNT >> 8, 0x18, 0x69, OUT >> 8, 0x85, 0xFD,   // hi + OUT
    0xA5, 0xFB, 0x91, 0xFC,                                                   // STA (ptr),Y   (Y=0, ptr low = count lo)
    0xEE, COUNT & 0xFF, COUNT >> 8, 0xD0, 0x03, 0xEE, (COUNT + 1) & 0xFF, COUNT >> 8, // count++
    0xA5, 0x90, 0x8D, LASTST & 0xFF, LASTST >> 8,                             // last ST
    0xF0, 0xDB,                                                               // BEQ loop (ST == 0)
    0x20, 0xCC, 0xFF,                                                         // CLRCHN
    0xA9, lfn, 0x20, 0xC3, 0xFF,                                              // CLOSE
    0x4C, PARK & 0xFF, PARK >> 8,
  ]);
  poke(m, PARK, [0x4C, PARK & 0xFF, PARK >> 8]);
}

// SETNAM, SETLFS(1, 8, 1), SAVE from $C800 to $C800+len; park.
function saveStub(m, { name, len }) {
  for (let i = 0; i < name.length; i++) m.mem.ram[NAME + i] = name.charCodeAt(i);
  const end = OUT + len;
  poke(m, STUB, [
    0xA9, name.length, 0xA2, NAME & 0xFF, 0xA0, NAME >> 8, 0x20, 0xBD, 0xFF,   // SETNAM
    0xA9, 0x01, 0xA2, 0x08, 0xA0, 0x01, 0x20, 0xBA, 0xFF,                     // SETLFS 1,8,1
    0xA9, OUT & 0xFF, 0x85, 0xFB, 0xA9, OUT >> 8, 0x85, 0xFC,                 // $FB/$FC = start
    0xA9, 0xFB, 0xA2, end & 0xFF, 0xA0, end >> 8, 0x20, 0xD8, 0xFF,           // SAVE
    0x8D, LASTST & 0xFF, LASTST >> 8,                                         // A: error code (if carry)
    0x4C, PARK & 0xFF, PARK >> 8,
  ]);
  poke(m, PARK, [0x4C, PARK & 0xFF, PARK >> 8]);
}

function boot(disk, { drive = false, tde = false } = {}) {
  const m = new C64Machine();
  m.loadROMs({ kernal: rom(ROMS[0]), basic: rom(ROMS[1]), charRom: rom(ROMS[2]) });
  if (drive) m.attachDrive(rom(DRIVE_ROM));
  m.setTrueDrive(tde);
  m.setD64(disk);
  m.reset();
  for (let f = 0; f < 500 && !basicReady(m); f++) m.runFrame();
  if (!basicReady(m)) throw new Error('the C64 never reached READY');
  return m;
}

function run(m, frames = 200) {
  m.cpu.pc = STUB;
  for (let f = 0; f < frames && m.cpu.pc !== PARK; f++) m.runFrame();
  if (m.cpu.pc !== PARK) throw new Error(`the stub never parked (PC=$${m.cpu.pc.toString(16)})`);
}
const got = (m) => {
  const n = m.mem.ram[COUNT] | (m.mem.ram[COUNT + 1] << 8);
  return Array.from(m.mem.ram.subarray(OUT, OUT + n));
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function disk64() {
  const d = createBlankD64('CHAN', 'C1');
  const prg = new Uint8Array(700);
  prg[0] = 0x01; prg[1] = 0x08;
  for (let i = 2; i < prg.length; i++) prg[i] = (i * 7 + 3) & 0xFF;
  d.writePRG('DATA', prg);
  d.writeFile('TEXT', Uint8Array.from('HELLO, DISK', c => c.charCodeAt(0)), TYPE_SEQ);
  d.writeProtected = false;
  return { d, prg };
}

// ── Rule: OPEN/CHKIN/CHRIN read a file to its end, ST=64 on the last byte ───
{
  const { d, prg } = disk64();
  const m = boot(d);
  readStub(m, { name: 'DATA', lfn: 2, sa: 2 });
  run(m);
  expect(same(got(m), Array.from(prg)), `CHRIN hands back the whole PRG through a data channel (${got(m).length} of ${prg.length} bytes)`);
  expect(m.mem.ram[LASTST] === 0x40, `ST is $40 (EOI) after the last byte (got $${m.mem.ram[LASTST].toString(16)})`);
  readStub(m, { name: 'TEXT,S,R', lfn: 3, sa: 3 });
  run(m);
  expect(String.fromCharCode(...got(m)) === 'HELLO, DISK', 'a sequential file reads as its text');
  ok('files read through OPEN, CHKIN and CHRIN with TDE off');
}

// ── Rule: the command channel reports the DOS status ─────────────────────────
{
  const { d } = disk64();
  const m = boot(d);
  readStub(m, { name: '', lfn: 15, sa: 15 });
  run(m);
  expect(String.fromCharCode(...got(m)) === '73,CBM DOS V2.6 1541,00,00\r', `channel 15 opens with the DOS version (got ${JSON.stringify(String.fromCharCode(...got(m)))})`);
  readStub(m, { name: 'ABSENT', lfn: 2, sa: 2 });
  run(m);
  expect(m.mem.ram[LASTST] === 0x42, 'a missing file gives CHRIN a timeout with EOI');
  readStub(m, { name: '', lfn: 15, sa: 15 });
  run(m);
  expect(String.fromCharCode(...got(m)) === '62,FILE NOT FOUND,00,00\r', 'and the status says FILE NOT FOUND');
  ok('the command channel answers');
}

// ── Rule: SAVE writes the file onto the image ────────────────────────────────
{
  const { d } = disk64();
  const m = boot(d);
  const body = Array.from({ length: 300 }, (_, i) => (i * 13 + 1) & 0xFF);
  poke(m, OUT, body);
  saveStub(m, { name: 'KEEP', len: body.length });
  run(m);
  const entry = d.findEntry('KEEP');
  expect(entry && entry.type === 'PRG', 'SAVE creates a PRG on the disk');
  const back = entry && Array.from(d.readEntry(entry));
  expect(back && same(back, [OUT & 0xFF, OUT >> 8, ...body]), 'holding the load address and the bytes saved');
  expect(d.dirty === true, 'and the image is marked changed');
  ok('SAVE lands on the image');
}

// ── Rule: a D81 is served the same way, and names its DOS ───────────────────
{
  const d = createBlankD81('EIGHTY', '81');
  const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 5 + 2) & 0xFF);
  d.writeFile('BIG', data, TYPE_SEQ);
  const m = boot(d);
  // The power-on message goes with the first successful command, so it is
  // read before anything is opened.
  readStub(m, { name: '', lfn: 15, sa: 15 });
  run(m);
  expect(String.fromCharCode(...got(m)) === '73,COPYRIGHT CBM DOS V10 1581,00,00\r', 'a D81 announces the 1581 DOS');
  readStub(m, { name: 'BIG', lfn: 2, sa: 2 });
  run(m);
  expect(same(got(m), Array.from(data)), 'a file on a D81 reads through a channel');
  ok('a D81 answers on its channels');
}

// ── Rule: with TDE on, the real 1541 keeps the bus ───────────────────────────
if (existsSync(DRIVE_ROM)) {
  const { d, prg } = disk64();
  const m = boot(d, { drive: true, tde: true });
  readStub(m, { name: 'DATA', lfn: 2, sa: 2 });
  run(m, 1500);
  expect(m.vdrive8.opens === 0, 'the virtual drive saw no OPEN while the 1541 was on the bus');
  expect(same(got(m), Array.from(prg)), 'and the real drive served the file');
  ok('TDE on leaves the bus to the 1541');
} else {
  ok('TDE on leaves the bus to the 1541 # SKIP 1541 ROM not available under roms/');
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('dos channel spec: PASS');
