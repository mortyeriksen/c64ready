// Spec test for the collage compositor (cli/collage.mjs). No machine boots: the
// films are built by hand from Apng, so this checks the parts that are easy to
// get wrong on their own — the grid layout, and that an --anim sheet comes out a
// valid animated PNG whose frame count follows the longest film it tiled. The
// pixel compositing is checked by eye on a real run; here the container is what
// is asserted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Apng } from '../png.mjs';
import { writeCollage } from '../collage.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-collage-'));
const chargen = Buffer.alloc(4096);              // a blank char ROM: captions draw nothing, layout still runs
const W = 8, H = 6;                              // tiny tiles keep it fast
const PAD = 6, LABEL_H = 10;                     // must match collage.mjs

// A film of `n` distinct screens, so every frame is its own (nothing collapses).
function film(n) {
  const a = new Apng(W, H, 5);
  for (let k = 0; k < n; k++) a.add(new Uint32Array(W * H).fill((k * 0x111111) >>> 0));
  return a;
}
const isPng = b => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';

// A still sheet: a plain PNG, its size fixed by how the tiles grid.
{
  const out = path.join(tmp, 'still.png');
  const tiles = [0, 1, 2].map(i => ({ name: `T${i}`, fb: new Uint32Array(W * H).fill((0x112233 * (i + 1)) >>> 0) }));
  writeCollage(out, tiles, { tileW: W, tileH: H, chargen, anim: false, fps: 5 });
  const b = fs.readFileSync(out);
  assert(isPng(b), 'a still sheet is a PNG');
  eq(b.readUInt32BE(16), 3 * (W + PAD) + PAD, 'three tiles set the sheet width');
  eq(b.readUInt32BE(20), 1 * (H + LABEL_H + PAD) + PAD, 'one row sets the sheet height');
  assert(!b.includes(Buffer.from('acTL')), 'a still sheet carries no animation control');
}

// Four tiles wrap to a second row.
{
  const out = path.join(tmp, 'wrap.png');
  const tiles = [0, 1, 2, 3, 4].map(i => ({ name: `T${i}`, fb: new Uint32Array(W * H) }));
  writeCollage(out, tiles, { tileW: W, tileH: H, chargen, anim: false, fps: 5 });
  const b = fs.readFileSync(out);
  eq(b.readUInt32BE(16), 4 * (W + PAD) + PAD, 'five tiles fill a four-wide row');
  eq(b.readUInt32BE(20), 2 * (H + LABEL_H + PAD) + PAD, 'and spill onto a second row');
}

// An --anim sheet: a valid APNG that runs as long as the longest film it tiled.
{
  const out = path.join(tmp, 'anim.png');
  const tiles = [film(3), film(5)].map((f, i) => ({ name: `A${i}`, film: f }));
  writeCollage(out, tiles, { tileW: W, tileH: H, chargen, anim: true, fps: 5 });
  const b = fs.readFileSync(out);
  assert(isPng(b), 'an anim sheet is a PNG');
  const at = b.indexOf(Buffer.from('acTL'));
  assert(at >= 0, 'an anim sheet carries acTL');
  eq(b.readUInt32BE(at + 4), 5, 'the sheet runs the longest film\'s length, the shorter one held');
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} collage assertion(s) failed`);
  process.exit(1);
}
console.log('cli collage spec: PASS');
