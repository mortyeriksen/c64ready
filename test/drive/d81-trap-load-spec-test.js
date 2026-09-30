// test/drive/d81-trap-load-spec-test.js
//
// Spec test for a .d81 served through the KERNAL LOAD trap. The trap reads
// sectors, not tracks, so the whole 1581 disk is reachable; a 1541 cannot read
// the medium, so the attached drive holds nothing while the machine keeps the
// image for the trap.
//
// Spec basis: the KERNAL LOAD contract (SETNAM, SETLFS, LOAD; carry and A on
// error, the end address in X/Y) and the 1581 DOS directory (LOAD"$" lists the
// name, ID and "3D", then BLOCKS FREE). The file sits on track 60, past the
// first BAM sector and past anything a 1541 geometry describes.
//
// Not covered elsewhere: kernal-load-trap-address-spec-test.js loads off a
// D64; d81-format-spec-test.js never boots a machine.

import { existsSync, readFileSync } from 'node:fs';
import { C64Machine } from '../../src/machine.js';
import { createBlankD81 } from '../../src/media/d64.js';

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

const STUB   = 0xC000;
const PARK   = 0xC02A;
const RESULT = 0xCF00;
const NAME   = 0xCF10;
const BASIC  = 0x0801;

const PAYLOAD_LEN = 300;
const FILE = new Uint8Array(PAYLOAD_LEN + 2);
FILE[0] = BASIC & 0xFF; FILE[1] = BASIC >> 8;
for (let i = 0; i < PAYLOAD_LEN; i++) FILE[i + 2] = ((i * 31 + 7) & 0xFF) || 0xA5;

// The disk: every track but 60 and above marked full, so the file lands on
// 60/0, the second half of the disk.
function makeDisk() {
  const d = createBlankD81('EIGHTY ONE', '81');
  const bam1 = d.readSector(40, 1), bam2 = d.readSector(40, 2);
  for (let t = 1; t <= 39; t++) bam1.fill(0, 0x10 + (t - 1) * 6, 0x16 + (t - 1) * 6);
  for (let t = 41; t <= 59; t++) bam2.fill(0, 0x10 + (t - 41) * 6, 0x16 + (t - 41) * 6);
  d._parse();
  if (d.writePRG('TARGET', FILE) !== 2) throw new Error('the test file did not fit');
  if (d.entries[0].startTrack !== 60) throw new Error(`the test file is on track ${d.entries[0].startTrack}, not 60`);
  return d;
}

function poke(m, addr, bytes) { bytes.forEach((b, i) => { m.mem.ram[addr + i] = b; }); }
function buildStub(m, { name, sa, loadAddr }) {
  for (let i = 0; i < name.length; i++) m.mem.ram[NAME + i] = name.charCodeAt(i);
  poke(m, STUB, [
    0xA9, name.length, 0xA2, NAME & 0xFF, 0xA0, NAME >> 8, 0x20, 0xBD, 0xFF,   // SETNAM
    0xA9, 0x01, 0xA2, 0x08, 0xA0, sa, 0x20, 0xBA, 0xFF,                       // SETLFS 1,8,sa
    0xA9, 0x00, 0xA2, loadAddr & 0xFF, 0xA0, loadAddr >> 8, 0x20, 0xD5, 0xFF, // LOAD
    0x8D, RESULT & 0xFF, RESULT >> 8,
    0x8E, (RESULT + 1) & 0xFF, RESULT >> 8,
    0x8C, (RESULT + 2) & 0xFF, RESULT >> 8,
    0xA9, 0x00, 0x2A, 0x8D, (RESULT + 3) & 0xFF, RESULT >> 8,
    0x4C, PARK & 0xFF, PARK >> 8,
  ]);
}

const basicReady = (m) => m.mem.ram[0xC6] === 0 && m.mem.ram[0xCC] === 0 && m.mem.ram[0x2C] === 0x08;

function bootWith(disk, { drive = false } = {}) {
  const m = new C64Machine();
  m.loadROMs({ kernal: rom(ROMS[0]), basic: rom(ROMS[1]), charRom: rom(ROMS[2]) });
  if (drive) m.attachDrive(rom(DRIVE_ROM));
  m.setTrueDrive(false);                 // the $FFD5 trap serves device 8
  m.setD64(disk);
  m.reset();
  for (let f = 0; f < 500 && !basicReady(m); f++) m.runFrame();
  if (!basicReady(m)) throw new Error('the C64 never reached READY');
  return m;
}

function callLoad(m, { name, sa, loadAddr = BASIC }) {
  m.mem.ram[0x9D] = 0xC0;
  buildStub(m, { name, sa, loadAddr });
  m.cpu.pc = STUB;
  for (let f = 0; f < 120 && m.cpu.pc !== PARK; f++) m.runFrame();
  if (m.cpu.pc !== PARK) throw new Error(`the stub never reached its parking loop (PC=$${m.cpu.pc.toString(16)})`);
  return {
    a: m.mem.ram[RESULT],
    end: m.mem.ram[RESULT + 1] | (m.mem.ram[RESULT + 2] << 8),
    carry: m.mem.ram[RESULT + 3] & 1,
  };
}

/** BASIC lines in RAM from `at`: [{ num, text }]. */
function basicLines(m, at) {
  const ram = m.mem.ram, lines = [];
  let p = at;
  for (let guard = 0; guard < 400; guard++) {
    const next = ram[p] | (ram[p + 1] << 8);
    if (!next) break;
    const num = ram[p + 2] | (ram[p + 3] << 8);
    let q = p + 4, text = '';
    while (ram[q]) text += String.fromCharCode(ram[q++]);
    lines.push({ num, text });
    p = next;
  }
  return lines;
}

const payload = Array.from(FILE.subarray(2));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── Rule: a file anywhere on the 1581 disk loads through the trap ────────────
{
  const m = bootWith(makeDisk());
  const r = callLoad(m, { name: 'TARGET', sa: 1 });
  expect(r.carry === 0, 'LOAD of a file on track 60 succeeds');
  expect(same(Array.from(m.mem.ram.subarray(BASIC, BASIC + PAYLOAD_LEN)), payload),
    'and the bytes at $0801 are the file, byte for byte');
  expect(r.end === BASIC + PAYLOAD_LEN, `and the end address is $${(BASIC + PAYLOAD_LEN).toString(16).toUpperCase()}`);
  ok('a file on the second half of a D81 loads');
}

// ── Rule: LOAD"$" lists the 1581 directory ───────────────────────────────────
{
  const m = bootWith(makeDisk());
  const r = callLoad(m, { name: '$', sa: 0 });
  expect(r.carry === 0, 'LOAD"$" succeeds');
  const lines = basicLines(m, BASIC);
  expect(lines[0]?.text === '\x12"EIGHTY ONE' + '\xA0'.repeat(6) + '" 81 3D',
    `the header line names the disk, its ID and DOS type 3D (got ${JSON.stringify(lines[0]?.text)})`);
  expect(lines.some(l => l.num === 2 && /"TARGET"\s+PRG/.test(l.text)), 'the file lists as a 2-block PRG');
  const last = lines.at(-1);
  expect(last && last.text === 'BLOCKS FREE.' && last.num === 40 * 21 - 2,
    `BLOCKS FREE. counts the free entries the BAM holds (got ${last?.num})`);
  ok('LOAD"$" shows the 1581 directory');
}

// ── Rule: a missing name is FILE NOT FOUND, as on a D64 ──────────────────────
{
  const m = bootWith(makeDisk());
  const r = callLoad(m, { name: 'ABSENT', sa: 1 });
  expect(r.carry === 1 && r.a === 4, 'a name the disk does not hold returns FILE NOT FOUND');
  ok('a missing file reports FILE NOT FOUND');
}

// ── Rule: with a 1541 attached, it holds nothing and the trap still serves ───
if (existsSync(DRIVE_ROM)) {
  const disk = makeDisk();
  const m = bootWith(disk, { drive: true });
  expect(m.currentD64 === disk, 'the machine keeps the D81 for the trap');
  expect(m.drive1541 && m.drive1541.disk === null, 'the attached 1541 holds no disk: it cannot read 1581 media');
  const r = callLoad(m, { name: 'TARGET', sa: 1 });
  expect(r.carry === 0 && same(Array.from(m.mem.ram.subarray(BASIC, BASIC + PAYLOAD_LEN)), payload),
    'and the file still loads through the trap');
  ok('a mounted D81 leaves the attached 1541 empty');
} else {
  ok('a mounted D81 leaves the attached 1541 empty # SKIP 1541 ROM not available under roms/');
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('d81 trap load spec: PASS');
