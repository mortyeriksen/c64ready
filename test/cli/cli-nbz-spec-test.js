// Nibbler dumps through the CLI: sniffing, info, nbz2g64 and its refusals.
// The dump comes from test/drive/_nbz-fixtures.js; a real c64pp dump converts too
// when present.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNib, rawRead, lzCompress } from '../drive/_nbz-fixtures.js';
import { tracksFromD64 } from '../drive/_g64-fixtures.js';
import { collectionFile, assetPath, missingNote } from '../external-assets.js';
import { createBlankD64, parseG64 } from '../../cli/core.mjs';
import { sniff, KIND_NAMES } from '../../cli/formats.mjs';
import { dir } from '../../cli/tape.mjs';
import { run as info } from '../../cli/info.mjs';
import { nbz2g64 } from '../../cli/nib.mjs';
import { setQuiet } from '../../cli/report.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}
function printed(fn) {
  const lines = [];
  const real = console.log;
  setQuiet(false);
  console.log = (...parts) => lines.push(parts.join(' '));
  try { fn(); } finally { console.log = real; setQuiet(true); }
  return lines.join('\n');
}

setQuiet(true);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-nbz-'));
const at = (...p) => path.join(tmp, ...p);

// A disk with one program, dumped: every track read from some point of its
// revolution, the whole thing LZ-compressed.
const d = createBlankD64('NBZ CLI', 'NC');
d.writePRG('HELLO', Uint8Array.from([0x01, 0x08, 0x0C, 0x08, 0x0A, 0x00, 0x99, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]));
const revolutions = tracksFromD64(d);
const entries = [];
for (let t = 1; t <= 35; t++) {
  entries.push({ halfTrack: t * 2, zone: t <= 17 ? 3 : t <= 24 ? 2 : t <= 30 ? 1 : 0, raw: rawRead(revolutions.get((t - 1) * 2), t * 123) });
}
const nib = buildNib(entries);
const nbz = lzCompress(nib);
fs.writeFileSync(at('dump.nbz'), nbz);
fs.writeFileSync(at('dump.nib'), nib);

eq(sniff(nbz, at('dump.nbz')), 'nbz', 'an LZ marker then MNIB-1541-RAW is a .nbz');
eq(sniff(nib, at('dump.nib')), 'nib', 'MNIB-1541-RAW at 0 is a .nib');
assert(/nibbler/.test(KIND_NAMES.nbz) && /nibbler/.test(KIND_NAMES.nib), 'both kinds are named as nibbler dumps');

const line = printed(() => info([at('dump.nbz')]));
assert(/\.nbz, NIB v3\), 35 tracks of 8 KB raw GCR each/.test(line), `info reads the track table off the inflated dump (got: ${line})`);

eq(nbz2g64([at('dump.nbz'), '-o', at('dump.g64')]), 0, 'nbz2g64 converts a .nbz');
const g64 = fs.readFileSync(at('dump.g64'));
const parsed = parseG64(new Uint8Array(g64));
assert(parsed.halfTrackCount === 84 && parsed.tracks.filter(Boolean).length === 35, 'the .g64 holds one revolution per dumped track');
const listing = printed(() => dir([at('dump.g64')]));
assert(/"NBZ CLI" NC/.test(listing) && /"HELLO"\s+PRG/.test(listing), 'dir lists the disk and its file off the converted tracks');

const report = printed(() => nbz2g64([at('dump.nbz'), '-o', at('again.g64')]));
assert(/35 tracks recorded; longest \d+ bytes/.test(report) && /\b1\.0\s+3\s+\d+\s+gap/.test(report),
  `the conversion report names each track's zone, length and where it was cut (got: ${report.split('\n').slice(0, 4).join(' | ')})`);

eq(nbz2g64([at('dump.g64'), '-o', at('wrong.g64')]), 1, 'a .g64 is refused: this command takes a .nbz');
assert(!fs.existsSync(at('wrong.g64')), 'the refusal wrote nothing');

// A real dump, when the collection is on this machine.
const real = assetPath('c64pp') ? collectionFile('c64pp', 'candidate[mastertronic_1984].nbz') : null;
if (!real || !fs.existsSync(real)) {
  console.log(`ok  - a real C64 Preservation Project dump converts # SKIP ${missingNote('c64pp')}`);
} else {
  eq(nbz2g64([real, '-o', at('candidate.g64')]), 0, 'a real dump converts');
  const realListing = printed(() => dir([at('candidate.g64')]));
  assert(/"MR CHIP\s*" PP/.test(realListing), `the real dump's directory lists (got: ${realListing.split('\n')[2]})`);
}

if (failures) {
  console.error(`\n${failures} nbz assertion(s) failed`);
  process.exit(1);
}
console.log('cli nbz spec: PASS');
