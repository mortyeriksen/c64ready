// Spec test for the disk group: new → add → extract hands back byte-identical
// PRGs, and the two ways a disk runs out — a full directory and a full disk —
// fail cleanly instead of half-writing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disk, packPRGs, diskSeriesPath } from '../disk.mjs';
import { setQuiet } from '../report.mjs';
import { D64, createBlankD64, d64Variant } from '../core.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

setQuiet(true);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-disk-'));
const at = (...p) => path.join(tmp, ...p);

// A .prg with a recognisable body, so identity means the bytes, not the length.
function somePrg(size, seed) {
  const b = new Uint8Array(size);
  b[0] = 0x01; b[1] = 0x08;
  for (let i = 2; i < size; i++) { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; b[i] = seed & 0xFF; }
  return b;
}

// new → add → extract, byte-identical.
{
  const prg = somePrg(2000, 7);
  fs.writeFileSync(at('game.prg'), prg);
  eq(disk(['new', at('d.d64'), '--name', 'SPEC DISK']), 0, 'disk new succeeds');
  assert(d64Variant(fs.statSync(at('d.d64')).size), 'the new image has a real D64 length');
  eq(disk(['add', at('d.d64'), at('game.prg')]), 0, 'disk add succeeds');
  eq(disk(['extract', at('d.d64'), '-d', at('out')]), 0, 'disk extract succeeds');
  const back = fs.readFileSync(at('out', 'GAME.prg'));
  assert(Buffer.compare(back, prg) === 0, 'the extracted PRG is byte-identical');
}

// new refuses to reformat an existing image.
{
  let threw = null;
  try { disk(['new', at('d.d64')]); } catch (e) { threw = e; }
  assert(threw && /already exists/.test(threw.message), 'disk new refuses an existing file');
}

// Adding a name the disk already holds is refused, as DOS would.
{
  fs.writeFileSync(at('game2.prg'), somePrg(100, 9));
  fs.renameSync(at('game2.prg'), at('game.prg'));
  eq(disk(['add', at('d.d64'), at('game.prg')]), 1, 'a duplicate name is refused');
}

// A full DISK fails cleanly: the file that does not fit reports so, and the
// image still parses with its directory intact.
{
  const d = createBlankD64('FULL', '01');
  const big = somePrg(254 * 300, 11);       // 300 blocks
  assert(d.writePRG('A', big) > 0, 'first 300-block file fits');
  assert(d.writePRG('B', big) > 0, 'second 300-block file fits');
  eq(d.writePRG('C', big), 0, 'the third does not, and says so with 0');
  const parsed = new D64(d.img);
  eq(parsed.entries.filter(e => !e.deleted).length, 2, 'the failed write left no half-entry');
}

// A full DIRECTORY fails cleanly: track 18 holds 144 entries; the 145th is
// turned away and the disk still parses.
{
  const d = createBlankD64('CROWD', '02');
  const tiny = somePrg(10, 13);
  let wrote = 0;
  for (let i = 0; i < 144; i++) if (d.writePRG(`F${String(i).padStart(3, '0')}`, tiny)) wrote++;
  eq(wrote, 144, 'a directory holds 144 files');
  eq(d.writePRG('ONE TOO MANY', tiny), 0, 'the 145th is refused with 0');
  const parsed = new D64(d.img);
  eq(parsed.entries.filter(e => !e.deleted).length, 144, 'the refused write left no half-entry');
}

// packPRGs (the tap2d64 substrate): names deduplicate across the whole set,
// a tape side that outgrows one disk spills onto a second, and a file too big
// for even an empty disk is handed back with a reason instead of vanishing.
{
  const big = somePrg(254 * 300, 17);       // 300 blocks each — three fill 1.35 disks
  const items = [
    { name: 'SIDE A', bytes: somePrg(500, 1) },
    { name: 'SIDE A', bytes: somePrg(500, 2) },
    { name: 'A NAME THAT RUNS PAST 16', bytes: somePrg(500, 3) },
    { name: 'BIG ONE', bytes: big },
    { name: 'BIG TWO', bytes: big },
    { name: 'BIG THREE', bytes: big },
    { name: 'NEVER FITS', bytes: somePrg(254 * 700, 19) },   // 700 blocks > 664
  ];
  const { disks, placed, left } = packPRGs(items, 'MIX');
  eq(disks.length, 2, 'three 300-block files spill onto a second disk');
  eq(placed.length, 6, 'everything that can fit is placed');
  eq(left.map(l => l.item.name), ['NEVER FITS'], 'the impossible file is handed back');
  assert(/too big/.test(left[0].why), 'with a reason');
  const names = placed.map(p => p.name);
  assert(names.includes('SIDE A') && names.includes('SIDE A 2'),
    `duplicate tape names deduplicate on disk, got ${JSON.stringify(names)}`);
  assert(names.every(n => n.length <= 16), 'every disk name fits a directory entry');
  // The small files land before the spill, so disk 1 holds the overflow only.
  for (const d of disks) {
    const parsed = new D64(d.img);
    eq(parsed.entries.filter(e => !e.deleted).length,
      placed.filter(p => p.disk === disks.indexOf(d)).length,
      'each disk parses back with exactly what was placed on it');
  }
}

// A set that spills gets one path per disk, whatever -o was called. Two disks
// sharing a path would leave only the last one on the filesystem while the
// listing claimed both.
{
  eq(diskSeriesPath('/out/side-a.d64', 0), '/out/side-a.d64', 'disk 1 keeps the name it was given');
  eq(diskSeriesPath('/out/side-a.d64', 1), '/out/side-a-2.d64', 'disk 2 numbers before the extension');
  eq(diskSeriesPath('/out/my.tape.d64', 2), '/out/my.tape-3.d64', 'only the last extension is the extension');
  eq(diskSeriesPath('/out/archive', 1), '/out/archive-2.d64', 'a name with no extension still numbers, as a .d64');
  eq(diskSeriesPath('/out/archive.img', 1), '/out/archive-2.img', 'a name with another extension keeps it');
  const paths = [0, 1, 2].map(i => diskSeriesPath('/out/archive', i));
  eq(new Set(paths).size, paths.length, 'no two disks of a set share a path');
}

// `disk new` with files formats and fills the disk in one command.
{
  setQuiet(true);
  const prg = fill => Uint8Array.from([0x01, 0x08, ...new Array(300).fill(fill)]);
  const a = path.join(tmp, 'a.prg'), b = path.join(tmp, 'b.prg');
  fs.writeFileSync(a, prg(0x11));
  fs.writeFileSync(b, prg(0x22));
  const out = path.join(tmp, 'combo.d64');
  eq(disk(['new', out, a, b, '--name', 'COMBO']), 0, 'disk new with files succeeds');
  const d = new D64(new Uint8Array(fs.readFileSync(out)));
  const names = d.entries.filter(e => !e.deleted).map(e => e.name.trim());
  assert(names.includes('A') && names.includes('B'), 'both named files land on the fresh disk');
  assert(d.loadFile('A') && d.loadFile('B'), 'and both load back');
}

// scratch frees a file's blocks and its directory entry, leaves the others, and
// hands the freed blocks back for reuse.
{
  const d = createBlankD64('SCRATCH', '01');
  const prg = n => Uint8Array.from([0x01, 0x08, ...new Array(n).fill(0xEE)]);
  d.writePRG('KEEP', prg(2000));
  d.writePRG('GONE', prg(2000));
  const free0 = d.freeBlocks;
  const { scratched, blocks } = d.scratch('GONE');
  eq(scratched, ['GONE'], 'the named file is scratched');
  assert(blocks > 0, 'and its blocks are counted');
  eq(d.freeBlocks, free0 + blocks, 'the freed blocks come back to the BAM');
  assert(d.entries.some(e => !e.deleted && e.name === 'KEEP'), 'the other file is untouched');
  assert(!d.entries.some(e => !e.deleted && e.name === 'GONE'), 'the scratched file is gone from the directory');
  assert(d.loadFile('KEEP') && d.loadFile('KEEP').length > 2, 'the kept file still loads');
  eq(d.loadFile('GONE'), null, 'the scratched file no longer loads');
  assert(d.writePRG('NEW', prg(2000)) > 0, 'a new file reuses the freed space');
  // A pattern scratches every match; nothing matched frees nothing.
  eq(d.scratch('NOSUCH').scratched.length, 0, 'a pattern that matches nothing scratches nothing');
  eq(d.scratch('*').scratched.length, 2, 'a "*" pattern scratches every remaining file');
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} disk assertion(s) failed`);
  process.exit(1);
}
console.log('cli disk spec: PASS');
