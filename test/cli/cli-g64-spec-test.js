// Spec test for .g64 through the CLI: the sniffer names it by its signature,
// dir and info read the directory decoded from its tracks, disk2prg pulls a
// file out byte-identical, disk add refuses it (raw tracks are read-only
// here), and — with the four ROMs on hand — run boots it through the emulated
// 1541 and writes a PNG. The image is built from the format layout by
// test/drive/_g64-fixtures.js, never by the parser under test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildG64, tracksFromD64 } from '../drive/_g64-fixtures.js';
import { assetPath, missingNote } from '../external-assets.js';
import { createBlankD64 } from '../../cli/core.mjs';
import { sniff, KIND_NAMES } from '../../cli/formats.mjs';
import { dir } from '../../cli/tape.mjs';
import { run as info } from '../../cli/info.mjs';
import { disk, disk2prg } from '../../cli/disk.mjs';
import { disk2t64, t64Files } from '../../cli/t64.mjs';
import { run } from '../../cli/run.mjs';
import { setQuiet } from '../../cli/report.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}
// The commands print through say(); the assertions read what they printed.
function printed(fn) {
  const lines = [];
  const real = console.log;
  setQuiet(false);
  console.log = (...parts) => lines.push(parts.join(' '));
  try { fn(); } finally { console.log = real; setQuiet(true); }
  return lines.join('\n');
}

setQuiet(true);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-g64-'));
const at = (...p) => path.join(tmp, ...p);

// 10 PRINT "HI", as BASIC keeps it in memory, with its load address in front.
const prg = Uint8Array.from([0x01, 0x08, 0x0C, 0x08, 0x0A, 0x00, 0x99, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
const d = createBlankD64('G64 CLI', 'GC');
d.writePRG('HELLO', prg);
const g64 = at('original.g64');
fs.writeFileSync(g64, buildG64(tracksFromD64(d)));
fs.writeFileSync(at('hello.prg'), prg);
const bytes = fs.readFileSync(g64);

eq(sniff(bytes, g64), 'g64', 'a GCR-1541 signature is a .g64, whatever the name');
eq(sniff(bytes, at('renamed.d64')), 'g64', 'the signature beats a misleading extension');
assert(/raw/i.test(KIND_NAMES.g64), 'the kind is named as a raw disk image');

// dir and info read the sectors decoded from the tracks.
const listing = printed(() => dir([g64]));
assert(/"G64 CLI" GC/.test(listing), 'dir heads the listing with the decoded disk name and ID');
assert(/"HELLO"\s+PRG/.test(listing), 'dir lists the file the tracks carry');
const line = printed(() => info([g64]));
assert(/\.g64, 35 of 42 tracks recorded/.test(line), `info counts the recorded whole tracks (got: ${line})`);
assert(/"G64 CLI", 1 file, 663 blocks free/.test(line), 'info reads the name, file count and free blocks');

// Both extraction commands read decoded sectors.
eq(disk2prg([g64, '-d', at('out')]), 0, 'disk2prg reads a .g64');
assert(fs.readFileSync(at('out', 'HELLO.prg')).equals(prg), 'the extracted PRG is byte-identical');
eq(disk(['extract', g64, '-d', at('out2')]), 0, 'disk extract reads a .g64');
fs.writeFileSync(at('renamed.d71'), bytes);
eq(disk2prg([at('renamed.d71'), '-d', at('renamed')]), 0, 'G64 signature overrides a D71 extension');

eq(disk2t64([g64, '-o', at('out.t64')]), 0, 'disk2t64 reads a .g64');
const archived = t64Files(fs.readFileSync(at('out.t64')));
assert(archived.files.length === 1 && archived.files[0].name.trim() === 'HELLO', 'the archive holds the program off the tracks');
assert(Buffer.from(archived.files[0].bytes).equals(prg), 'the archive preserves program bytes');
eq(disk2t64([at('hello.prg'), '-o', at('wrong.t64')]), 1, 'disk2t64 refuses a PRG');
assert(!fs.existsSync(at('wrong.t64')), 'the refusal wrote no archive');

// Nothing writes into raw tracks here.
let refused = null;
try { disk(['add', g64, at('hello.prg')]); } catch (e) { refused = e; }
assert(refused && /read-only/.test(refused.message), 'disk add refuses a .g64 as read-only');
assert(fs.readFileSync(g64).equals(bytes), 'the refused write left the image untouched');

// run boots a .g64 through the emulated 1541, so it needs the drive ROM too.
const missing = ['kernal', 'basic', 'chargen'].find(key => !assetPath(key));
const romsDir = missing ? null : path.dirname(assetPath('kernal'));
if (missing || !fs.existsSync(path.join(romsDir, '1541.bin'))) {
  console.log(`ok  - run boots a .g64 through the 1541 # SKIP ${missing ? missingNote(missing) : '1541.bin not beside the C64 ROMs'}`);
} else {
  const out = at('shot.png');
  const code = await run([g64, '--frames', '300', '-o', out, '--roms', romsDir, '--no-press']);
  eq(code, 0, 'run returns 0 for a .g64');
  assert(fs.existsSync(out) && fs.statSync(out).size > 0, 'run wrote the PNG');
}

if (failures) {
  console.error(`\n${failures} g64 assertion(s) failed`);
  process.exit(1);
}
console.log('cli g64 spec: PASS');
