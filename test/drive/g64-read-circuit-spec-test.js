// test/drive/g64-read-circuit-spec-test.js
//
// The 1541 read circuit on a recorded (G64) surface. The read clock runs at
// the density the DOS selects and restarts at every flux transition, so a
// track read at another density yields a different count of zeros between
// ones; after 18 µs without a transition the amplifier's noise gives random
// ones (VICE's rule); a G64 per-byte speed map sets the recorded bit rate byte
// by byte. Images come from test/drive/_g64-fixtures.js. No ROMs needed.

import { Drive1541 } from '../../src/drive1541.js';
import { G64 } from '../../src/media/g64.js';
import { createBlankD64 } from '../../src/media/d64.js';
import { buildG64, tracksFromD64 } from './_g64-fixtures.js';

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`ok  - ${msg}`);
  else { console.error(`FAIL: ${msg}`); failed++; }
}

// Cycles per bit cell at each density zone.
const CELL = [4, 3.75, 3.5, 3.25];

// A drive with `g64` in it, head on track 1, density bits set to `zone`.
function driveOn(g64, zone) {
  const drive = new Drive1541(new Uint8Array(16384), null);
  drive.setDisk(g64);
  drive.motorOn = true;
  drive.currentSpeedZone = zone;
  drive.currentHalfTrack = 2;
  drive.trackDirty = true;
  drive.via2.regs[0x0C] = 0xEE;   // SOE on: byte-ready reaches the SO pin
  return drive;
}

// The bytes the drive clocks out over `cycles`.
function readBytes(drive, cycles) {
  const out = [];
  drive.cpu.setOverflow = () => out.push(drive.lastGCRByte);
  for (let c = 0; c < cycles; c += 2) drive._advanceSpindle(2);
  return out;
}
const bitsOf = bytes => bytes.map(b => b.toString(2).padStart(8, '0')).join('');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function trackOne() {
  const d = createBlankD64('READ', 'RC');
  return tracksFromD64(d).get(0);
}

// ── Density mismatch ─────────────────────────────────────────────────────────
{
  // "1001" over and over: two zero cells between transitions.
  const pattern = new Uint8Array(600);
  for (let i = 0; i < pattern.length * 8; i++) if (i % 3 === 0) pattern[i >> 3] |= 0x80 >> (i & 7);
  const image = zone => new G64(buildG64(new Map([[0, pattern]]), { speeds: new Map([[0, zone]]) }));

  const matched = bitsOf(readBytes(driveOn(image(0), 0), 2000));
  assert(matched.startsWith('100'.repeat(16)), 'at the recorded density the read clock counts the recorded zeros');

  // Recorded at zone 0 (4 µs cells), read at zone 3 (3.25 µs): three cells
  // between ones span 3.7 read cells, so three zeros come out.
  const fast = bitsOf(readBytes(driveOn(image(0), 3), 2000));
  assert(fast.slice(fast.indexOf('1')).startsWith('1000'.repeat(12)), 'a slower track read at a faster density gains a zero between ones (1001 reads 10001)');

  // Recorded at zone 3, read at zone 0: three 3.25 µs cells span 2.4 read cells, so one zero.
  const slow = bitsOf(readBytes(driveOn(image(3), 0), 2000));
  assert(slow.slice(slow.indexOf('1')).startsWith('10'.repeat(24)), 'a faster track read at a slower density loses a zero between ones (1001 reads 101)');

  // A real track: sync marks survive either way (ones every cell), the data
  // bytes do not.
  const track = trackOne();
  const real = zone => new G64(buildG64(new Map([[0, track]]), { speeds: new Map([[0, zone]]) }));
  const good = driveOn(real(3), 3);
  const goodBytes = readBytes(good, 4000);
  // The header and its gap, up to the data block's sync (sync bytes are not clocked out).
  const h = track.indexOf(0x52);
  const recorded = [...track.subarray(h, track.indexOf(0xFF, h))];
  const fromHeader = bytes => { const at = bytes.indexOf(0x52); return at < 0 ? [] : bytes.slice(at, at + recorded.length); };
  assert(same(fromHeader(goodBytes), recorded), 'at the recorded density the sector header and data come out as recorded');
  const bad = driveOn(real(3), 0);
  const badBytes = readBytes(bad, 4000);
  assert(bad._dbgSyncBytesSeen > 0 && !same(fromHeader(badBytes), recorded),
    'at the wrong density the sync is still found but the bytes after it are garbled');
}

// ── Weak bits ────────────────────────────────────────────────────────────────
{
  // Sync, a header, 64 bytes never written, sync, gap.
  const track = new Uint8Array(5 + 21 + 64 + 5 + 40);
  track.fill(0xFF, 0, 5);
  track[5] = 0x52; for (let i = 6; i < 26; i++) track[i] = 0x55 + (i & 1) * 0x50;
  track.fill(0xFF, 90, 95);
  track.fill(0x55, 95);
  const g = new G64(buildG64(new Map([[0, track]]), { speeds: new Map([[0, 3]]) }));
  const drive = driveOn(g, 3);
  const revolution = track.length * 8 * CELL[3];
  const first = readBytes(drive, revolution);
  const second = readBytes(drive, revolution);
  // The first eight ones of the sync clock out as a byte before sync is detected, then $52.
  const inRun = bytes => bytes.slice(22, 22 + 40);
  assert(first.length >= 100 && inRun(first).some(b => b !== 0), 'an unrecorded stretch reads as noise, not as zeros');
  assert(!same(inRun(first), inRun(second)), 'the noise differs from one revolution to the next');
  assert(drive._dbgSyncBytesSeen === 4, `only the two recorded sync marks are seen per revolution (${drive._dbgSyncBytesSeen} in two)`);
  assert(same(first.slice(0, 22), second.slice(0, 22)) && first[1] === 0x52, 'the recorded bytes around it read the same every time');

  // No stream at all (an unrecorded half-track) is noise too, without sync.
  drive.currentHalfTrack = 3; drive.trackDirty = true;
  drive._dbgSyncBytesSeen = 0;
  const blank = readBytes(drive, 3000);
  assert(drive.trackStream === null && blank.some(b => b !== 0) && drive._dbgSyncBytesSeen === 0,
    'an unrecorded half-track reads as noise with no sync in it');
}

// ── Per-byte speed maps ──────────────────────────────────────────────────────
{
  // 400 bytes: the first 200 recorded at zone 3, the rest at zone 0.
  const track = new Uint8Array(400).fill(0x55);
  const map = new Uint8Array(100);
  map.fill(0xFF, 0, 50);
  const g = new G64(buildG64(new Map([[0, track]]), { speedMaps: new Map([[0, map]]) }));
  const drive = driveOn(g, 3);
  drive._advanceSpindle(2);   // load the stream
  const start = drive.trackBitPos;
  for (let c = 0; c < 200 * 8 * CELL[3]; c += 1) drive._advanceSpindle(1);
  const atHalf = drive.trackBitPos - start;
  for (let c = 0; c < 200 * 8 * CELL[0]; c += 1) drive._advanceSpindle(1);
  const atEnd = (drive.trackBitPos - start + 3200) % 3200;
  assert(Math.abs(atHalf - 1600) <= 1, `the first half passes at the zone 3 rate (${atHalf} bits in its time)`);
  assert(atEnd <= 2 || atEnd >= 3198, `the second half passes at the zone 0 rate (${atEnd} bits from the start after a revolution)`);
}

if (failed) { console.error(`\n${failed} read-circuit check(s) failed.`); process.exit(1); }
console.log('\nAll G64 read-circuit spec tests passed.');
