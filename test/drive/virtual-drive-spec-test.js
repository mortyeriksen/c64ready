// test/drive/virtual-drive-spec-test.js
//
// Spec test for the DOS behind a trap-served drive (src/virtual-drive.js),
// driven through the serial primitives the KERNAL calls: LISTEN/SECOND,
// CIOUT, UNLISTEN, TALK/TKSA, ACPTR, UNTALK.
//
// Spec basis: the 1541 User's Guide and the 1581 User's Guide for the DOS
// commands, file open syntax ("[@][0:]name[,type][,mode]", "$", "#"), the
// error messages and codes (00 OK, 01 FILES SCRATCHED, 26 WRITE PROTECT ON,
// 31 SYNTAX ERROR, 62 FILE NOT FOUND, 63 FILE EXISTS, 64 FILE TYPE MISMATCH,
// 66 ILLEGAL TRACK OR SECTOR, 70 NO CHANNEL, 72 DISK FULL, 73 the DOS
// version, 74 DRIVE NOT READY), the status line format "NN,MESSAGE,TT,SS",
// and the block commands U1/U2, B-P. The serial contract (Programmer's
// Reference Guide): EOI arrives with the last byte; a channel with nothing to
// send times out.
//
// Observed surface: VirtualDrive's listen/write/unlisten/talk/read/untalk,
// its status text, and the disk image it writes.

import { VirtualDrive } from '../../src/virtual-drive.js';
import { createBlankD64, createBlankD81, TYPE_SEQ } from '../../src/media/d64.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const bytesOf = s => Array.from(s, c => c.charCodeAt(0) & 0xFF);

// The KERNAL's calling sequences, as OPEN, CHKIN/CHRIN, CLOSE and the
// command channel issue them.
function open(v, ch, name) { v.listen(0xF0 | ch); for (const b of bytesOf(name)) v.write(b); v.unlisten(); }
function close(v, ch) { v.listen(0xE0 | ch); v.unlisten(); }
function send(v, ch, bytes) { v.listen(0x60 | ch); for (const b of bytes) v.write(b); v.unlisten(); }
function readAll(v, ch) {
  v.talk(0x60 | ch);
  const out = []; let last = null;
  for (let guard = 0; guard < 1_000_000; guard++) {
    last = v.read();
    if (last.timeout) break;
    out.push(last.byte);
    if (last.eoi) break;
  }
  v.untalk();
  return { bytes: out, last };
}
const status = v => String.fromCharCode(...readAll(v, 15).bytes);
const command = (v, text) => { send(v, 15, bytesOf(text)); return status(v); };

function disks() {
  const d64 = createBlankD64('SPEC', 'S1');
  d64.writePRG('HELLO', new Uint8Array([0x01, 0x08, 0x41, 0x42, 0x43]));
  d64.writeFile('NOTES', new Uint8Array([0x4E, 0x4F, 0x54, 0x45]), TYPE_SEQ);
  d64.writeProtected = false;
  return d64;
}

// ── 1. power-on status names the DOS, and reading it clears it ───────────────
{
  const v64 = new VirtualDrive(() => disks());
  assert(status(v64) === '73,CBM DOS V2.6 1541,00,00\r', 'a 1541 disk announces CBM DOS V2.6 1541');
  assert(status(v64) === '00, OK,00,00\r', 'reading the status clears it to 00, OK');
  const v81 = new VirtualDrive(() => createBlankD81('D', '81'));
  assert(status(v81) === '73,COPYRIGHT CBM DOS V10 1581,00,00\r', 'a 1581 disk announces its own DOS');
  const { last } = readAll(v81, 15);
  assert(last.eoi && last.byte === 0x0D, 'the status line ends in a return sent with EOI');
}

// ── 2. reading a file: the bytes, EOI on the last, then a timeout ────────────
{
  const d = disks();
  const v = new VirtualDrive(() => d);
  open(v, 2, 'HELLO');
  assert(status(v) === '00, OK,00,00\r', 'opening an existing file reports OK');
  const { bytes, last } = readAll(v, 2);
  assert(same(bytes, [0x01, 0x08, 0x41, 0x42, 0x43]), 'a PRG reads back whole, load address first');
  assert(last.eoi && !last.timeout, 'EOI arrives with the last byte');
  const after = (v.talk(0x62), v.read());
  assert(after.timeout && after.byte === 0x0D, 'a drained channel times out with a return');
  close(v, 2);
  open(v, 3, '0:HELLO,P,R');
  assert(same(readAll(v, 3).bytes, [0x01, 0x08, 0x41, 0x42, 0x43]), 'a drive prefix, type and mode are understood');
  open(v, 4, 'HELLO,S');
  assert(status(v) === '64,FILE TYPE MISMATCH,00,00\r', 'asking for the wrong type is a type mismatch');
  open(v, 5, 'H*');
  assert(same(readAll(v, 5).bytes.slice(0, 2), [0x01, 0x08]), 'wildcards open the first match');
}

// ── 3. a missing file, no disk, and the command channel ─────────────────────
{
  const v = new VirtualDrive(() => disks());
  open(v, 2, 'ABSENT');
  assert(status(v) === '62,FILE NOT FOUND,00,00\r', 'a name the disk lacks is FILE NOT FOUND');
  assert(readAll(v, 2).last.timeout, 'and the channel has nothing to give');
  const empty = new VirtualDrive(() => null);
  open(empty, 2, 'HELLO');
  assert(status(empty) === '74,DRIVE NOT READY,00,00\r', 'no disk in the drive is DRIVE NOT READY');
  assert(command(v, 'I') === '00, OK,00,00\r', 'I initialises');
  assert(command(v, 'V') === '00, OK,00,00\r', 'V validates');
  assert(command(v, 'XYZ') === '31,SYNTAX ERROR,00,00\r', 'an unknown command is a syntax error');
  assert(command(v, 'UI') === '73,CBM DOS V2.6 1541,00,00\r', 'UI resets the DOS and it announces itself again');
  send(v, 15, [0x4D, 0x2D, 0x52, 0x00, 0xC0, 0x03]);
  const mr = readAll(v, 15);
  assert(mr.bytes.length === 3 && mr.last.eoi, 'M-R hands back the asked-for number of bytes');
}

// ── 4. the directory as a channel ────────────────────────────────────────────
{
  const d = disks();
  const v = new VirtualDrive(() => d);
  open(v, 0, '$');
  assert(same(readAll(v, 0).bytes, Array.from(d.buildDirectoryPRG(''))), 'LOAD"$" bytes come through channel 0');
  open(v, 2, '$0:N*');
  const listing = String.fromCharCode(...readAll(v, 2).bytes);
  assert(listing.includes('NOTES') && !listing.includes('HELLO'), 'a pattern after $ narrows the listing');
}

// ── 5. writing: SAVE, sequential files, replace, exists, protect, full ───────
{
  const d = disks();
  const v = new VirtualDrive(() => d);
  open(v, 1, 'SAVED');
  send(v, 1, [0x01, 0x08, 0x99, 0x98]);
  close(v, 1);
  assert(status(v) === '00, OK,00,00\r', 'closing a write channel reports OK');
  const saved = d.findEntry('SAVED');
  assert(saved && saved.type === 'PRG' && same(Array.from(d.readEntry(saved)), [0x01, 0x08, 0x99, 0x98]),
    'secondary address 1 writes a PRG with the bytes sent');
  open(v, 2, 'LOG,S,W');
  send(v, 2, bytesOf('LINE'));
  close(v, 2);
  const log = d.findEntry('LOG');
  assert(log && log.type === 'SEQ' && String.fromCharCode(...d.readEntry(log)) === 'LINE', ',S,W writes a sequential file');
  open(v, 2, 'LOG,S,A');
  send(v, 2, bytesOf('+MORE'));
  close(v, 2);
  assert(String.fromCharCode(...d.readEntry(d.findEntry('LOG'))) === 'LINE+MORE', ',A appends to it');
  open(v, 2, 'LOG,S,W');
  assert(status(v) === '63,FILE EXISTS,00,00\r', 'writing over a name without @ is FILE EXISTS');
  open(v, 2, '@0:LOG,S,W');
  send(v, 2, bytesOf('NEW'));
  close(v, 2);
  assert(String.fromCharCode(...d.readEntry(d.findEntry('LOG'))) === 'NEW' && d.entries.filter(e => !e.deleted && e.name === 'LOG').length === 1,
    '@ replaces the file');
  d.writeProtected = true;
  open(v, 2, 'NOPE,S,W');
  assert(status(v) === '26,WRITE PROTECT ON,00,00\r', 'a protected disk refuses a write channel');
  d.writeProtected = false;
  open(v, 2, 'BIG,S,W');
  send(v, 2, new Uint8Array(254 * 700));
  close(v, 2);
  assert(status(v) === '72,DISK FULL,00,00\r', 'a file the disk cannot hold is DISK FULL at close');
  assert(!d.findEntry('BIG'), 'and leaves no entry behind');
}

// ── 6. scratch, rename, format ───────────────────────────────────────────────
{
  const d = disks();
  const v = new VirtualDrive(() => d);
  assert(command(v, 'S0:NOTES') === '01,FILES SCRATCHED,01,00\r', 'S reports the scratched count in the track field');
  assert(!d.findEntry('NOTES'), 'and the file is gone');
  assert(command(v, 'R0:GREET=HELLO') === '00, OK,00,00\r', 'R renames');
  assert(d.findEntry('GREET') && !d.findEntry('HELLO'), 'under the new name only');
  assert(command(v, 'R0:OTHER=NOTHING') === '62,FILE NOT FOUND,00,00\r', 'renaming a missing file is FILE NOT FOUND');
  assert(command(v, 'R0:GREET=OTHER') === '63,FILE EXISTS,00,00\r', 'renaming onto a taken name is FILE EXISTS');
  assert(command(v, 'N0:FRESH,F1') === '00, OK,00,00\r', 'N formats');
  assert(d.diskName === 'FRESH' && d.diskId === 'F1' && d.freeBlocks === 664 && d.entries.length === 0, 'to an empty disk with the new name and ID');
  d.writeProtected = true;
  assert(command(v, 'S0:X') === '26,WRITE PROTECT ON,00,00\r', 'a protected disk refuses to scratch');
}

// ── 7. buffers and block commands ────────────────────────────────────────────
{
  const d = disks();
  const v = new VirtualDrive(() => d);
  open(v, 2, '#');
  assert(command(v, 'U1:2 0 18 0') === '00, OK,00,00\r', 'U1 reads a sector into the buffer');
  const { bytes, last } = readAll(v, 2);
  assert(bytes.length === 256 && same(bytes, Array.from(d.readSector(18, 0))) && last.eoi, 'the buffer reads back as the whole sector, EOI on byte 256');
  assert(command(v, 'B-P:2 144') === '00, OK,00,00\r', 'B-P moves the buffer pointer');
  assert(same(readAll(v, 2).bytes, Array.from(d.readSector(18, 0).subarray(144))), 'and reading continues from there');
  assert(command(v, 'U1:2 0 40 0') === '66,ILLEGAL TRACK OR SECTOR,40,00\r', 'a track the disk lacks is ILLEGAL TRACK OR SECTOR, naming it');
  assert(command(v, 'U1:5 0 1 0') === '70,NO CHANNEL,00,00\r', 'a channel without a buffer is NO CHANNEL');
  command(v, 'U1:2 0 1 0');
  v.talk(0x62); v.untalk();
  const c = v.channels[2];
  c.data.fill(0xEE); c.pos = 0;
  assert(command(v, 'U2:2 0 1 5') === '00, OK,00,00\r', 'U2 writes the buffer to a sector');
  assert(d.readSector(1, 5).every(b => b === 0xEE) && d.dirty, 'and the image holds it');
}

// ── 8. a D81 partition is not a file ─────────────────────────────────────────
{
  const d = createBlankD81('PARTS', 'PT');
  const dir = d.readSector(40, 3);
  dir[2] = 0x85; dir[3] = 50; dir[4] = 0;
  for (let i = 0; i < 16; i++) dir[5 + i] = 0xA0;
  'PART'.split('').forEach((c, i) => { dir[5 + i] = c.charCodeAt(0); });
  d._parse();
  const v = new VirtualDrive(() => d);
  open(v, 2, 'PART');
  assert(status(v) === '64,FILE TYPE MISMATCH,00,00\r', 'opening a partition is FILE TYPE MISMATCH');
}

if (failed > 0) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS – virtual drive: status, files, directory, writes, commands, blocks');
