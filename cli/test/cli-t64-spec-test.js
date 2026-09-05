// Spec test for the .t64 reader and writer (cli/t64.mjs). Every expected value
// below is derived from the T64 layout — a 64 byte header, 32 byte directory
// entries, raw file data at each entry's own offset — and from the two ways
// archives in the wild break it: a used-entries count of zero on an archive
// that holds a file, and an end address the container cannot honour. Archives
// are built here byte by byte; nothing binary is committed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t64Files, buildT64, diskPrograms, t642prg } from '../t64.mjs';
import { sniff } from '../formats.mjs';
import { archiveListing } from '../listing.mjs';
import { setQuiet } from '../report.mjs';
import { D64, createBlankD64 } from '../core.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

// A .t64, assembled from the format: header, then entries, then each file's
// bytes at the offset its entry names.
function mkT64({ magic = 'C64 tape image file', label = 'ARCHIVE', used = null, entries = [] }) {
  const dataAt = 64 + entries.length * 32;
  let data = [];
  const dir = [];
  for (const e of entries) {
    const at = dataAt + data.length;
    const row = new Uint8Array(32);
    row[0] = e.type ?? 1;
    row[2] = e.start & 0xFF; row[3] = e.start >> 8;
    const end = e.claimEnd ?? (e.start + (e.bytes?.length ?? 0));
    row[4] = end & 0xFF; row[5] = end >> 8;
    row[8] = at & 0xFF; row[9] = (at >> 8) & 0xFF; row[10] = (at >> 16) & 0xFF;
    const name = (e.name ?? '').padEnd(16, ' ');
    for (let i = 0; i < 16; i++) row[16 + i] = name.charCodeAt(i);
    dir.push(row);
    data = data.concat([...(e.bytes ?? [])]);
  }
  const head = new Uint8Array(64);
  for (let i = 0; i < magic.length; i++) head[i] = magic.charCodeAt(i);
  head[34] = entries.length & 0xFF; head[35] = entries.length >> 8;
  const u = used ?? entries.length;
  head[36] = u & 0xFF; head[37] = u >> 8;
  const lab = label.padEnd(24, ' ');
  for (let i = 0; i < 24; i++) head[40 + i] = lab.charCodeAt(i);
  const out = new Uint8Array(dataAt + data.length);
  out.set(head, 0);
  dir.forEach((row, i) => out.set(row, 64 + i * 32));
  out.set(Uint8Array.from(data), dataAt);
  return out;
}

// The signature is prose and the wordings vary, so the prefix decides — and the
// two other magics that begin the same way must win first.
{
  eq(sniff(mkT64({ entries: [{ name: 'A', start: 0x0801, bytes: [1] }] })), 't64',
    'the usual signature reads as a .t64');
  eq(sniff(mkT64({ magic: 'C64S tape file', entries: [{ name: 'A', start: 0x0801, bytes: [1] }] })), 't64',
    'so does the C64S wording');
  const tap = new Uint8Array(96); 'C64-TAPE-RAW'.split('').forEach((c, i) => tap[i] = c.charCodeAt(0));
  eq(sniff(tap), 'tap', 'a .tap begins with the same three letters and is not an archive');
}

// One ordinary file comes back as a ready .prg: address first, then the bytes.
{
  const t = t64Files(mkT64({ label: 'MY TAPE', entries: [{ name: 'GAME', start: 0x0801, bytes: [9, 8, 7] }] }));
  eq(t.name, 'MY TAPE', 'the archive label is read');
  eq(t.files.length, 1, 'one entry is one file');
  eq(t.files[0].name, 'GAME', 'the name loses its space padding');
  eq([...t.files[0].bytes].join(), '1,8,9,8,7', 'a file is its load address and then its bytes');
}

// The used-entries count lies in the wild — archives holding one file say
// zero — so entries are believed, not the count.
{
  const t = t64Files(mkT64({ used: 0, entries: [{ name: 'GAME', start: 0x0801, bytes: [1, 2] }] }));
  eq(t.files.length, 1, 'an archive whose used count says 0 still yields its file');
}

// The end address lies too. A claim of zero takes what the container holds; a
// claim past the container is cut to it, and the row says so.
{
  const zero = t64Files(mkT64({ entries: [{ name: 'A', start: 0x2000, bytes: [1, 2, 3, 4], claimEnd: 0x2000 }] }));
  eq(zero.files[0].bytes.length, 2 + 4, 'a zero end address takes the bytes the archive holds');
  const fat = t64Files(mkT64({ entries: [{ name: 'A', start: 0x2000, bytes: [1, 2], claimEnd: 0x9000 }] }));
  eq(fat.files[0].bytes.length, 2 + 2, 'a claim past the archive is cut to the archive');
  assert(/archive holds 2/.test(fat.files[0].note), 'and the file says what was claimed against what was held');
}

// Two files: each is measured to where the next one's data begins, whatever
// its own end address says.
{
  const t = t64Files(mkT64({ entries: [
    { name: 'FIRST', start: 0x0801, bytes: [1, 2, 3], claimEnd: 0 },
    { name: 'SECOND', start: 0x4000, bytes: [4, 5] },
  ] }));
  eq(t.files[0].bytes.length, 2 + 3, 'a broken end address stops at the next file\'s data');
  eq(t.files[1].bytes.length, 2 + 2, 'and the last file runs to the end of the archive');
}

// A freed slot is nothing; a snapshot is not a file and says why it was left.
{
  const t = t64Files(mkT64({ entries: [
    { name: 'GONE', start: 0x0801, bytes: [], type: 0 },
    { name: 'FROZEN', start: 0x0801, bytes: [1], type: 3 },
    { name: 'REAL', start: 0x0801, bytes: [2] },
  ] }));
  eq(t.files.length, 1, 'only the real file is a file');
  eq(t.skipped.length, 1, 'the snapshot is reported, the freed slot is not');
  assert(/snapshot/.test(t.skipped[0].why), 'and the reason names what it was');
}

// ── the writer ───────────────────────────────────────────────────────────────

// What buildT64 writes, t64Files reads back whole — and the used-entries count
// is written honestly even though reading rightly distrusts it.
{
  const t64 = buildT64('MY DISK', [
    { name: 'GAME', start: 0x0801, payload: Uint8Array.from([9, 8, 7]) },
    { name: 'LOADER', start: 0xC000, payload: Uint8Array.from([4, 5]) },
  ]);
  eq(sniff(t64), 't64', 'what the writer makes, the sniffer knows');
  eq(t64[36] | (t64[37] << 8), 2, 'the used-entries count is written, not left at zero');
  const t = t64Files(t64);
  eq(t.name, 'MY DISK', 'the label survives the round trip');
  eq(t.files.length, 2, 'both entries come back as files');
  eq(t.files[0].name, 'GAME', 'a name loses only its padding');
  eq([...t.files[0].bytes].join(), '1,8,9,8,7', 'a file reads back as its load address and bytes');
  eq([...t.files[1].bytes].join(), '0,192,4,5', 'the second file sits at its own offset');
  eq(t.files[1].end, 0xC002, 'the end address is real, not a claim to cut down');
  eq(t.files[0].note, null, 'an honest end address earns no note');
}

// Names and labels are cut to the bytes their fields hold.
{
  const t = t64Files(buildT64('A LABEL LONGER THAN TWENTY-FOUR CHARS',
    [{ name: 'A NAME LONGER THAN SIXTEEN', start: 0x0801, payload: Uint8Array.from([1]) }]));
  eq(t.name.length, 24, 'the label field holds 24 characters');
  eq(t.files[0].name.length, 16, 'the name field holds 16');
}

// A file that fills memory to the top ends at $10000, which the 16-bit end
// field can only write as zero — the wild's broken case, here for once meant.
// The container measures it back whole.
{
  const payload = new Uint8Array(0x10000 - 0xF000);
  const t = t64Files(buildT64('FULL', [{ name: 'TOP', start: 0xF000, payload }]));
  eq(t.files[0].bytes.length, 2 + payload.length, 'the bytes come back whole past the wrapped end word');
}

// ── the disk side ────────────────────────────────────────────────────────────

// A disk's PRG maps onto an entry: name, load address, and the bytes without
// the address they already carry.
{
  const d = createBlankD64('TEST', '01');
  d.writePRG('GAME', Uint8Array.from([0x01, 0x08, 9, 8, 7]));
  const { files, skipped } = diskPrograms(d);
  eq(files.length, 1, 'one PRG is one entry');
  eq(skipped.length, 0, 'and nothing is skipped for it');
  eq(files[0].name, 'GAME', 'under its directory name');
  eq(files[0].start, 0x0801, 'with the load address its first two bytes named');
  eq([...files[0].payload].join(), '9,8,7', 'and a payload that sheds those two bytes');
}

// A SEQ file is data with no load address, so no entry — reported, not an
// error. The type byte is flipped in the image directly: the directory opens
// at track 18 sector 1 (17 tracks of 21 sectors stand before it), and an
// entry's file type is its third byte.
{
  const d = createBlankD64('TEST', '01');
  d.writePRG('NOTES', Uint8Array.from([0x01, 0x08, 1, 2]));
  d.img[(17 * 21 + 1) * 256 + 2] = 0x81;          // closed SEQ
  const { files, skipped } = diskPrograms(new D64(d.img));
  eq(files.length, 0, 'a SEQ file maps onto no entry');
  eq(skipped.length, 1, 'it is reported instead');
  assert(/SEQ/.test(skipped[0].why), 'by type');
  assert(!skipped[0].broken, 'and skipping it is nature, not damage');
}

// ── the listing ──────────────────────────────────────────────────────────────

// One renderer serves dir and every t64 command; what it shows is the label,
// a row per file, and the skipped entries saying why they were left.
{
  const lines = [];
  const real = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    archiveListing('demo.t64', t64Files(mkT64({ label: 'MY TAPE', entries: [
      { name: 'GAME', start: 0x0801, bytes: [9, 8, 7] },
      { name: 'FROZEN', start: 0x0801, bytes: [1], type: 3 },
    ] })), new Map());
  } finally { console.log = real; }
  const text = lines.join('\n');
  assert(/demo\.t64  ·  "MY TAPE"/.test(text), 'the head carries the name and the label');
  assert(/1\s+GAME\s+\$0801-\$0804\s+3B/.test(text), 'a file row shows load range and size');
  assert(/-\s+FROZEN\s+skipped — a memory snapshot/.test(text), 'a skipped row says why');
}

// t642prg writes each archive file straight out as a .prg — load address first,
// then the bytes — under the name the entry carries.
{
  const t64 = buildT64('DISK', [
    { name: 'ALPHA', start: 0x0801, payload: Uint8Array.from([1, 2, 3]) },
    { name: 'BETA', start: 0x1000, payload: Uint8Array.from([4, 5]) },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-t642prg-'));
  const src = path.join(dir, 'archive.t64');
  fs.writeFileSync(src, t64);
  setQuiet(true);
  const code = t642prg([src, '-d', dir]);
  eq(code, 0, 't642prg reports success');
  eq([...fs.readFileSync(path.join(dir, 'ALPHA.prg'))].join(), '1,8,1,2,3', 'a file is its load address then its bytes');
  eq([...fs.readFileSync(path.join(dir, 'BETA.prg'))].join(), '0,16,4,5', 'and the next at its own address');
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} t64 assertion(s) failed`);
  process.exit(1);
}
console.log('cli t64 spec: PASS');
