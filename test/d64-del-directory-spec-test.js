// D64 DEL (scratched) directory entries.
//
// Spec basis (D64.TXT, "Scratched vs empty"): scratching a file sets the
// directory entry's file-type byte (+$02) to $00 but leaves the filename and
// start track/sector intact until the slot is reused. Those entries are
// recoverable DEL files — "marked for deletion but not yet overwritten by new
// data." They must surface in the parsed directory as type DEL / deleted so the
// UI can show them, while staying authentic on the C64 side: LOAD by name
// misses them and LOAD"$" omits them, exactly like a real 1541. A truly empty
// slot (type byte $00, no filename, no start track) is still skipped.

import { D64 } from '../src/d64.js';

const SPT = [0,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,19,19,19,19,19,19,19,18,18,18,18,18,18,17,17,17,17,17];
function sectorOffset(track, sec) { let o = 0; for (let t = 1; t < track; t++) o += SPT[t]; return (o + sec) * 256; }
function sector(img, t, s) { return img.subarray(sectorOffset(t, s), sectorOffset(t, s) + 256); }
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } }
function bytesToStr(a) { let s = ''; for (const b of a) s += String.fromCharCode(b); return s; }

const img = new Uint8Array(174848);

const bam = sector(img, 18, 0);
bam[0] = 18; bam[1] = 1; bam[2] = 0x41;
for (let i = 0; i < 16; i++) bam[0x90 + i] = 0xA0;
'DELTEST'.split('').forEach((c, i) => { bam[0x90 + i] = c.charCodeAt(0); });
bam[0xA2] = 0x49; bam[0xA3] = 0x44; bam[0xA5] = 0x32; bam[0xA6] = 0x41;
bam[4] = 5; // 5 free blocks on track 1 (sanity)

const dir = sector(img, 18, 1);
dir[0] = 0; dir[1] = 255;

// Entry 0 — a live, closed PRG "LIVE" @ 1/0, 1 block.
dir[2] = 0x82; dir[3] = 1; dir[4] = 0;
for (let i = 0; i < 16; i++) dir[5 + i] = 0xA0;
'LIVE'.split('').forEach((c, i) => { dir[5 + i] = c.charCodeAt(0); });
dir[30] = 1; dir[31] = 0;

// Entry 1 — a SCRATCHED file "GONE": type byte $00, but filename + start T/S +
// block count left intact (recoverable).
const e1 = 32;
dir[e1 + 2] = 0x00; dir[e1 + 3] = 1; dir[e1 + 4] = 5;
for (let i = 0; i < 16; i++) dir[e1 + 5 + i] = 0xA0;
'GONE'.split('').forEach((c, i) => { dir[e1 + 5 + i] = c.charCodeAt(0); });
dir[e1 + 30] = 3; dir[e1 + 31] = 0;

// Entry 2 — a truly empty slot (all zero) must be skipped (left as-is).

// Live PRG data chain (load address $0801, one RTS).
const prg = sector(img, 1, 0);
prg[0] = 0; prg[1] = 4; prg[2] = 0x01; prg[3] = 0x08; prg[4] = 0x60;

const disk = new D64(img);

assert(disk.entries.length === 2, `PRG + DEL parsed, empty slot skipped (got ${disk.entries.length})`);

const del = disk.entries.find(e => e.name === 'GONE');
assert(del, 'scratched entry "GONE" is surfaced in the directory');
assert(del.deleted === true, 'scratched entry is flagged deleted');
assert(del.typeCode === 0 && del.type === 'DEL', 'scratched entry types as DEL');
assert(del.blocks === 3 && del.startTrack === 1 && del.startSector === 5,
  'DEL keeps its block count + start track/sector (recoverable)');

// Authentic C64 side: DEL entries are invisible to LOAD.
assert(disk.loadFile('GONE') === null, 'LOAD by name does not match a DEL entry');
const listed = bytesToStr(disk.buildDirectoryPRG());
assert(!listed.includes('GONE'), 'LOAD"$" omits the DEL entry (like real DOS)');
assert(listed.includes('LIVE'), 'LOAD"$" still lists the live PRG');

// The live PRG is unaffected.
const live = disk.loadFile('LIVE');
assert(live && live[0] === 0x01 && live[1] === 0x08, 'live PRG still loads');

// Image-variant detection (D64 spec sizes).
assert(disk.trackCount === 35 && disk.hasErrorInfo === false,
  '35-track no-error image variant detected');

console.log('ok – D64 DEL (scratched) entries surface as recoverable DEL, authentic on the C64 side');
