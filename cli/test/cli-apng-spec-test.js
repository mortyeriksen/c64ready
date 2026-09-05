// Spec test for the APNG writer (cli/png.mjs): what `run --anim` writes is a
// PNG first and an animation second. Every rule here comes from the APNG
// specification and PNG's own chunk layout — the frame control chunks form one
// unbroken sequence, the default image stands outside the animation so a
// viewer that ignores APNG still sees the final screen, and a frame carries
// only the rectangle that moved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { writePng, Apng } from '../png.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-apng-'));
const at = name => path.join(tmp, name);

const W = 8, H = 4;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Every chunk in the file, in order, with its CRC checked. */
function chunks(file) {
  const buf = fs.readFileSync(file);
  eq([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'the file opens with the PNG signature');
  const out = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    assert(buf.readUInt32BE(p + 8 + len) === crc32(buf.subarray(p + 4, p + 8 + len)), `${type} carries a valid CRC`);
    out.push({ type, data });
    p += 12 + len;
  }
  return out;
}

const frame = fill => {
  const fb = new Uint32Array(W * H);
  fb.fill(fill);
  return fb;
};
/** The pixels a chunk of unfiltered RGB scanlines describes, as ABGR words. */
function pixels(raw, w, h) {
  const px = new Uint32Array(w * h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    assert(raw[i++] === 0, 'every scanline is written unfiltered');
    for (let x = 0; x < w; x++) {
      px[y * w + x] = (0xFF << 24 | raw[i + 2] << 16 | raw[i + 1] << 8 | raw[i]) >>> 0;
      i += 3;
    }
  }
  return px;
}
const opaque = n => (0xFF000000 | n) >>> 0;

// A still PNG is unchanged by any of this: signature, IHDR, one IDAT, IEND and
// nothing else — the reference harness's file, byte for byte.
{
  writePng(at('still.png'), frame(opaque(0x0000FF)), W, H);
  eq(chunks(at('still.png')).map(c => c.type), ['IHDR', 'IDAT', 'IEND'], 'a still run writes a plain PNG, with no animation chunks');
}

// Three screens: blue, blue again (nothing moved), then one pixel turned red.
const film = new Apng(W, H, 5);
film.add(frame(opaque(0x0000FF)));
film.add(frame(opaque(0x0000FF)));
const moved = frame(opaque(0x0000FF));
moved[2 * W + 3] = opaque(0xFF0000);
film.add(moved);
film.write(at('film.png'));
const cs = chunks(at('film.png'));
const types = cs.map(c => c.type);

eq(types[0], 'IHDR', 'IHDR comes first');
eq(types[types.length - 1], 'IEND', 'IEND comes last');
assert(types.indexOf('acTL') < types.indexOf('IDAT'), 'acTL precedes IDAT');
assert(types.indexOf('IDAT') < types.indexOf('fcTL'), 'no fcTL precedes IDAT: the default image is not part of the animation');

const actl = cs.find(c => c.type === 'acTL').data;
const fcTLs = cs.filter(c => c.type === 'fcTL').map(c => c.data);
const fdATs = cs.filter(c => c.type === 'fdAT').map(c => c.data);
eq(actl.readUInt32BE(0), fcTLs.length, 'acTL num_frames counts the frames the file holds');
eq(actl.readUInt32BE(4), 0, 'acTL num_plays 0 loops forever');
eq(fdATs.length, fcTLs.length, 'every frame is one fcTL and one fdAT');

// Sequence numbers run 0,1,2,… across fcTL and fdAT together, with no gaps.
const seqs = cs.filter(c => c.type === 'fcTL' || c.type === 'fdAT').map(c => c.data.readUInt32BE(0));
eq(seqs, seqs.map((_, i) => i), 'sequence numbers count from 0 with no gap and no repeat');

// The output buffer starts fully transparent, so the first frame must cover it.
const rect = d => ({ w: d.readUInt32BE(4), h: d.readUInt32BE(8), x: d.readUInt32BE(12), y: d.readUInt32BE(16) });
eq(rect(fcTLs[0]), { w: W, h: H, x: 0, y: 0 }, 'the first frame covers the whole canvas');
for (const d of fcTLs) {
  const r = rect(d);
  assert(r.x + r.w <= W && r.y + r.h <= H, 'a frame rectangle stays inside the canvas');
  assert(d.readUInt16BE(22) !== 0, 'delay_den is never 0');
  eq(d[24], 0, 'dispose_op 0 leaves the frame standing for the next one');
  eq(d[25], 0, 'blend_op 0 replaces the rectangle rather than compositing over it');
}

// The screen that did not move costs no frame — it holds the one before it, so
// two screens at 5 fps are one frame of 2/5 s.
eq(fcTLs.length, 2, 'a screen identical to the last adds no frame');
eq([fcTLs[0].readUInt16BE(20), fcTLs[0].readUInt16BE(22)], [400, 1000], 'the held frame waits 2/5 s: two screens at 5 fps');
eq([fcTLs[1].readUInt16BE(20), fcTLs[1].readUInt16BE(22)], [200, 1000], 'a frame of its own waits 1/5 s');

// A single pixel that changed travels as a single pixel.
eq(rect(fcTLs[1]), { w: 1, h: 1, x: 3, y: 2 }, 'a frame carries only the box that changed');
eq(pixels(zlib.inflateSync(fdATs[1].subarray(4)), 1, 1)[0], opaque(0xFF0000), 'and it carries the new colour');

// The default image is the last screen — what a viewer without APNG shows is
// the screenshot a still run would have written.
const idat = cs.find(c => c.type === 'IDAT').data;
eq([...pixels(zlib.inflateSync(idat), W, H)], [...moved], 'the default image is the final screen');

// A playback rate is a rate: 25 fps is 1/25 s a frame.
{
  const fast = new Apng(W, H, 25);
  fast.add(frame(opaque(0x102030)));
  fast.write(at('fast.png'));
  const d = chunks(at('fast.png')).find(c => c.type === 'fcTL').data;
  eq([d.readUInt16BE(20), d.readUInt16BE(22)], [40, 1000], '25 fps is 40 ms a frame');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} apng assertion(s) failed`);
  process.exit(1);
}
console.log('cli apng spec: PASS');
