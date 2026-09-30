// test/drive/g64-drive-spec-test.js
//
// The 1541 reading and writing a G64. The head takes its bitstream from the
// half-track it sits on (a G64 records each separately), and the DOS ROM must
// load and save through a G64's raw tracks exactly as through a D64's
// synthesised ones. G64 images are built from the format layout by
// test/drive/_g64-fixtures.js. The DOS checks need the C64 + 1541 ROMs and SKIP
// without them; the head checks run with a blank drive ROM.

import { readFileSync, existsSync } from 'fs';
import { Drive1541 } from '../../src/drive1541.js';
import { C64Machine } from '../../src/machine.js';
import { G64 } from '../../src/media/g64.js';
import { createBlankD64 } from '../../src/media/d64.js';
import { buildG64, tracksFromD64 } from './_g64-fixtures.js';

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`ok  - ${msg}`);
  else { console.error(`FAIL: ${msg}`); failed++; }
}

function programDisk() {
  const d = createBlankD64('G64 DRIVE', 'GD');
  const prg = new Uint8Array(700);
  prg[0] = 0x00; prg[1] = 0xC0;                     // loads at $C000
  for (let i = 2; i < prg.length; i++) prg[i] = (i * 13 + 5) & 0xFF;
  d.writePRG('PROG', prg);
  return { d, prg };
}

// ── Head: the stream comes from the half-track under it ──────────────────────
{
  const tracks = tracksFromD64(programDisk().d);
  tracks.set(35, new Uint8Array(3000).fill(0xA5));   // track 18.5
  const g = new G64(buildG64(tracks));
  const drive = new Drive1541(new Uint8Array(16384), null);
  drive.setDisk(g);
  assert(drive.gcrDisk === g, 'a G64 is its own GCR source (no sector synthesis)');
  drive.motorOn = true;
  drive.currentSpeedZone = 2;

  drive.currentHalfTrack = 37; drive.trackDirty = true;
  drive._advanceSpindle(64);
  assert(drive.trackStream === g.getTrackStream(18, 37),
    'on half-track 37 the head reads the track 18.5 entry, not track 18');

  drive.currentHalfTrack = 36; drive.trackDirty = true;
  drive._advanceSpindle(64);
  assert(drive.trackStream === g.getTrackStream(18, 36), 'on half-track 36 the head reads track 18');

  // Step off a SYNC mark onto an unrecorded half-track: blank surface, no flux,
  // so the SYNC line must drop rather than hold what the last track showed.
  const syncOnly = new G64(buildG64(new Map([[36, new Uint8Array(400).fill(0xFF)]])));
  drive.setDisk(syncOnly);
  drive.motorOn = true;
  drive.currentHalfTrack = 38; drive.trackDirty = true;
  drive._advanceSpindle(28 * 4);
  assert(drive._syncBit === 0x00, 'a run of one-bits reads as SYNC');
  drive.currentHalfTrack = 39; drive.trackDirty = true;
  drive._advanceSpindle(28 * 2);
  assert(drive.trackStream === null && drive._syncBit === 0x80,
    'an unrecorded half-track gives no stream and no SYNC, even straight off a SYNC mark');
  drive.setDisk(g);

  // One revolution of a longer-than-standard track wraps back to its start.
  const long = new G64(buildG64(tracksFromD64(programDisk().d, { padTo: 7900 })));
  drive.setDisk(long);
  drive.motorOn = true;
  drive.currentHalfTrack = 2; drive.trackDirty = true; drive.currentSpeedZone = 3;
  drive._advanceSpindle(26);                        // load the stream: 8 bits in
  const start = drive.trackBitPos;
  for (let i = 0; i < 7900; i++) drive._advanceSpindle(26);   // one byte per 26 cycles
  assert(drive.trackStream.length === 7900 && drive.trackBitPos === start,
    'a 7900-byte track takes 7900 byte times to come round again');

  // The disk turns at 300 rpm whatever density the drive selects, so a track's
  // bits pass the head at the rate they were recorded in: a zone-3 track is
  // 26 cycles a byte even with the density bits set for zone 0.
  drive.setDisk(long);
  drive.motorOn = true;
  drive.currentHalfTrack = 2; drive.trackDirty = true; drive.currentSpeedZone = 0;
  drive._advanceSpindle(26);
  const at = drive.trackBitPos;
  for (let i = 0; i < 100; i++) drive._advanceSpindle(26);
  assert(drive.trackBitPos === (at + 800) % (7900 * 8),
    'a recorded track is clocked at its recorded bit rate, not the density the drive selected');

  // Save-state restore re-reads the stream at the restored half-track.
  drive.currentHalfTrack = 37;
  const snap = drive.serialize();
  const restored = new Drive1541(new Uint8Array(16384), null);
  restored.setDisk(g);
  restored.deserialize(snap);
  restored.motorOn = true;
  restored._advanceSpindle(64);
  assert(restored.trackStream === g.getTrackStream(18, 37), 'a restored drive reads the half-track it was saved on');
}

// ── Write protect is the disk's own session attribute ────────────────────────
{
  const g = new G64(buildG64(tracksFromD64(programDisk().d)));
  const drive = new Drive1541(new Uint8Array(16384), null);
  drive.setDisk(g);
  assert((drive.via2.readPortB() & 0x10) === 0, 'a mounted G64 is write-protected (PB4 low)');
  drive.setWriteProtect(false);
  assert(g.writeProtected === false && (drive.via2.readPortB() & 0x10) !== 0,
    'unlocking records it on the G64 and drives PB4 high');
}

// ── DOS: LOAD and SAVE through the real 1541 ROM ─────────────────────────────
const ROM_FILES = ['roms/kernal.bin', 'roms/basic.bin', 'roms/chargen.bin', 'roms/1541.bin'];
if (!ROM_FILES.every(existsSync)) {
  console.log('ok  - DOS LOAD/SAVE from a G64 # SKIP C64/1541 ROMs not available');
} else {
  const KERNAL  = new Uint8Array(readFileSync('roms/kernal.bin'));
  const BASIC   = new Uint8Array(readFileSync('roms/basic.bin'));
  const CHARGEN = new Uint8Array(readFileSync('roms/chargen.bin'));
  const ROM1541 = new Uint8Array(readFileSync('roms/1541.bin'));
  const ready = (m) => { const r = m.mem.ram; return r[0xC6] === 0 && r[0xCC] === 0 && r[0x2C] === 0x08; };
  const typeLine = (m, t) => { const s = t + '\r'; for (let i = 0; i < s.length; i++) m.mem.ram[0x0277 + i] = s.charCodeAt(i) & 0xFF; m.mem.ram[0xC6] = s.length; };
  const boot = () => {
    const m = new C64Machine();
    m.loadROMs({ kernal: KERNAL, basic: BASIC, charRom: CHARGEN });
    m.attachDrive(ROM1541);
    m.setTrueDrive(true);
    for (let f = 0; f < 500 && !ready(m); f++) m.runFrame();
    assert(ready(m), 'C64 reached the READY prompt');
    return m;
  };

  // LOAD through the DOS from tracks as long as a real mastered disk's.
  {
    const { d, prg } = programDisk();
    const m = boot();
    m.setD64(new G64(buildG64(tracksFromD64(d, { padBy: 100 }))));
    m.mem.ram[0x90] = 0;
    typeLine(m, 'LOAD"PROG",8,1');
    for (let i = 0; i < 1500; i++) m.runFrame();
    let bad = 0;
    for (let i = 2; i < prg.length; i++) if (m.mem.ram[0xC000 + i - 2] !== prg[i]) bad++;
    assert(bad === 0 && (m.mem.ram[0x90] & 0x40) !== 0 && m.mem.ram[0xAE] === ((0xC000 + prg.length - 2) & 0xFF),
      `the DOS LOADs a file from a G64 through the true drive (${bad} bytes differ)`);
  }

  // SAVE onto a writable G64: the file lands and every track keeps its length.
  {
    const g = new G64(buildG64(tracksFromD64(programDisk().d)));
    const lengths = [];
    for (let i = 0; i < g.halfTrackCount; i++) lengths.push(g.getTrackStream(0, i + 2)?.length ?? 0);
    const m = boot();
    g.writeProtected = false;
    m.setD64(g);
    const prog = [0x07, 0x08, 0x0A, 0x00, 0x8F, 0x00, 0x00, 0x00];   // 10 REM
    for (let i = 0; i < prog.length; i++) m.mem.ram[0x0801 + i] = prog[i];
    m.mem.ram[0x2D] = 0x09; m.mem.ram[0x2E] = 0x08;
    m.mem.ram[0x90] = 0;
    typeLine(m, 'SAVE"NEWFILE",8');
    for (let i = 0; i < 900; i++) m.runFrame();
    m.commitDriveWrites();
    assert(g.dirty, 'a DOS write marks the G64 dirty');
    assert(g.entries.some(e => e.name === 'NEWFILE'), 'the saved file is in the decoded directory');
    const reread = new G64(g.img.slice());
    const bytes = reread.loadFile('NEWFILE');
    assert(bytes && bytes.length === 10 && bytes[0] === 0x01 && bytes[1] === 0x08 && bytes[6] === 0x8F,
      'the exported G64 carries the saved program');
    let changed = 0;
    for (let i = 0; i < reread.halfTrackCount; i++) if ((reread.getTrackStream(0, i + 2)?.length ?? 0) !== lengths[i]) changed++;
    assert(changed === 0, 'writing never changes a track\'s recorded length');
  }
}

if (failed) { console.error(`\n${failed} G64 drive check(s) failed.`); process.exit(1); }
console.log('\nAll G64 drive spec tests passed.');
