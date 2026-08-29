// D64 directory PETSCII names are byte strings, not printable ASCII.
//
// Spec basis: Commodore DOS directory entries store the 16-byte filename
// verbatim and pad with PETSCII shift-space ($A0). The same bytes are used by
// LOAD name matching, and BASIC LIST renders control-byte filenames as PETSCII
// screen output. Replacing low control bytes with '?' changes both the visible
// directory and the loadable file name.

import { D64 } from '../src/d64.js';

const SPT = [
  0,
  21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,
  19,19,19,19,19,19,19,
  18,18,18,18,18,18,
  17,17,17,17,17,
];

function sectorOffset(track, sector) {
  let offset = 0;
  for (let t = 1; t < track; t++) offset += SPT[t];
  return (offset + sector) * 256;
}

function sector(img, track, sec) {
  return img.subarray(sectorOffset(track, sec), sectorOffset(track, sec) + 256);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const img = new Uint8Array(174848);

const bam = sector(img, 18, 0);
bam[0] = 18;
bam[1] = 1;
bam[2] = 0x41;
for (let i = 0; i < 16; i++) bam[0x90 + i] = 0xA0;
for (let i = 0; i < 5; i++) bam[0xA2 + i] = 0xA0;
for (let i = 0; i < 'CTRL BYTE TEST'.length; i++) {
  bam[0x90 + i] = 'CTRL BYTE TEST'.charCodeAt(i);
}
bam[0xA2] = 0x49; // I
bam[0xA3] = 0x44; // D
bam[0xA5] = 0x32; // 2
bam[0xA6] = 0x41; // A

const nameBytes = [
  0x9A,             // high control byte
  0x06, 0x0C, 0x01, // low control bytes
  0x10, 0x19,
  0x41, 0x42, 0x43, // ordinary PETSCII uppercase
];

const dir = sector(img, 18, 1);
dir[0] = 0;
dir[1] = 255;
dir[2] = 0x82; // closed PRG
dir[3] = 1;
dir[4] = 0;
for (let i = 0; i < 16; i++) dir[5 + i] = 0xA0;
for (let i = 0; i < nameBytes.length; i++) dir[5 + i] = nameBytes[i];
dir[30] = 1;
dir[31] = 0;

const prg = sector(img, 1, 0);
prg[0] = 0;
prg[1] = 4;
prg[2] = 0x01;
prg[3] = 0x08;
prg[4] = 0x60;

const disk = new D64(img);

assert(disk.entries.length === 1, `one directory entry parsed (got ${disk.entries.length})`);
assert(disk.hasReadableDirectoryNames === true,
  'directory with PETSCII A-Z filename bytes is classified as text-readable');
const entry = disk.entries[0];
const gotNameBytes = Array.from(entry.name, (ch) => ch.charCodeAt(0));
assert(JSON.stringify(gotNameBytes) === JSON.stringify(nameBytes),
  `directory name preserves PETSCII control bytes (${gotNameBytes.map((b) => b.toString(16)).join(' ')})`);

const loaded = disk.loadFile(entry.name);
assert(loaded && loaded.length === 3, 'loadFile accepts the preserved PETSCII control-byte name');
assert(loaded[0] === 0x01 && loaded[1] === 0x08 && loaded[2] === 0x60,
  'loaded PRG bytes match the target file chain');

const listed = disk.buildDirectoryPRG();
let found = false;
for (let i = 0; i <= listed.length - nameBytes.length; i++) {
  let same = true;
  for (let j = 0; j < nameBytes.length; j++) {
    if (listed[i + j] !== nameBytes[j]) { same = false; break; }
  }
  if (same) { found = true; break; }
}
assert(found, 'LOAD "$",8 directory PRG preserves the same PETSCII filename bytes');

const decorativeImg = new Uint8Array(img);
const decorativeDir = sector(decorativeImg, 18, 1);
for (let i = 0; i < 16; i++) decorativeDir[5 + i] = 0xA0;
for (let i = 0; i < 16; i++) decorativeDir[5 + i] = i < 8 ? 0x9A : 0x12;
const decorativeDisk = new D64(decorativeImg);
assert(decorativeDisk.entries.length === 1, 'decorative control-byte entry still parses');
assert(decorativeDisk.hasReadableDirectoryNames === false,
  'all-control-code loader directory is classified as non-text-readable');

console.log('ok – D64 directory PETSCII control-byte names are preserved');
