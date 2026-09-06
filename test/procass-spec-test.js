// Spec test for the PROCASS loader (src/tap-turbo-formats.js).
//
// US Gold's own mastering system, read out of the boot stub Out Run and
// Forgotten Worlds carry. It measures a pulse exactly as Freeload does — CIA1
// timer A armed with $0368, the bit whether the high byte still reads 2 or
// more, so the boundary is 872 - 512 = 360 cycles — and rolls left, so bytes
// are MSB first. The reader is copied below $0400 and hooked onto the ILOAD
// vector, so the game multiloads with plain LOAD"NAME" calls: this is the one
// commercial format here that names its files.
//
// A block is a pilot of repeated $20 bytes, one $FF, a 16-byte space-padded
// name, the load and end addresses, the bytes, and one byte holding their XOR.
// The loader never reads that byte, and masters sometimes carried a
// deliberately wrong one to trip crackers' tools — so it can prove a block but
// cannot fail one.
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

const P = { zero: 264, one: 552 };

const bitsOf = (out, v, w) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? w.one : w.zero); };
const body = (n, seed = 0) => Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

/** One block as the loader reads it. */
function block(out, { name = '', start, body: data, widths = P, pilot = 64,
                      sync = 0xFF, spoilSum = 0, end = null }) {
  for (let i = 0; i < pilot; i++) bitsOf(out, 0x20, widths);
  bitsOf(out, sync, widths);
  for (let k = 0; k < 16; k++) bitsOf(out, k < name.length ? name.charCodeAt(k) : 0x20, widths);
  const to = end ?? (start + data.length);
  bitsOf(out, start & 0xFF, widths); bitsOf(out, start >> 8, widths);
  bitsOf(out, to & 0xFF, widths); bitsOf(out, to >> 8, widths);
  let x = 0;
  for (const b of data) { x ^= b; bitsOf(out, b, widths); }
  bitsOf(out, x ^ spoilSum, widths);
  out.push(1000000);
}

function tapOf(pulses) {
  const bytes = [];
  for (const c of pulses) {
    const step = Math.round(c / 8);
    if (step >= 1 && step <= 255) bytes.push(step);
    else bytes.push(0, c & 255, (c >> 8) & 255, (c >> 16) & 255);
  }
  const tap = new Uint8Array(20 + bytes.length);
  for (let i = 0; i < 12; i++) tap[i] = 'C64-TAPE-RAW'.charCodeAt(i);
  tap[12] = 1;
  tap[16] = bytes.length & 255; tap[17] = (bytes.length >> 8) & 255; tap[18] = (bytes.length >> 16) & 255;
  tap.set(bytes, 20);
  return tap;
}
const pro = (p, o) => tapDirectory(tapOf(p), o).filter(f => f.format === 'PROCASS');

// ── One block ────────────────────────────────────────────────────────────────
{
  const p = [];
  block(p, { name: 'PIC', start: 0x0400, body: body(2000) });
  const files = pro(p);
  eq(files.length, 1, 'one PROCASS block on the tape');
  eq([files[0].start, files[0].end, files[0].size], [0x0400, 0x0BD0, 2000],
     'the two addresses give the range, the end being exclusive');
  eq(files[0].name, 'PIC', 'the name, its space padding off');
  eq(files[0].damaged, false, 'and it adds up');
}

// ── The shape Out Run has ────────────────────────────────────────────────────
{
  // A loading picture, then the multiload parts the game asks for by name.
  const p = [];
  block(p, { name: 'PIC', start: 0x0400, body: body(1500) });
  block(p, { name: '0', start: 0x0800, body: body(4000, 1) });
  block(p, { name: '2', start: 0xE000, body: body(800, 2) });
  eq(pro(p).map(f => [f.name, f.start]), [['PIC', 0x0400], ['0', 0x0800], ['2', 0xE000]],
     'each block lists its name and where it loads, in the order the tape holds them');
}

// ── A checksum can prove a block but cannot fail one ─────────────────────────
{
  // The loader never reads the byte, and the author of the system has said
  // masters sometimes carried a deliberately wrong one to trip crackers'
  // tools. Clean pulses and a lying checksum is a sound file.
  const p = [];
  block(p, { name: 'LD', start: 0x1000, body: body(2000), spoilSum: 0xFF });
  const files = pro(p);
  eq(files.length, 1, 'a block whose XOR is wrong is still claimed');
  eq(files[0].damaged, false, 'and clean pulse widths outrank the lying byte');
}

// ── What is not a block ──────────────────────────────────────────────────────
{
  const p = [];
  block(p, { name: 'A', start: 0x0400, body: body(500), sync: 0xFE });
  eq(pro(p), [], 'the byte after the pilot has to be $FF');
}
{
  const p = [];
  block(p, { name: 'A', start: 0x0400, body: body(500), pilot: 8 });
  eq(pro(p), [], 'eight pilot bytes are not enough to claim on');
}
{
  const p = [];
  block(p, { name: 'A', start: 0xE000, body: body(500), end: 0xD000 });
  eq(pro(p), [], 'an end address below the start is not a block');
}
{
  const p = [];
  block(p, { name: 'A', start: 0x0020, body: body(500) });
  eq(pro(p), [], 'a block claiming to load into zero page is not one');
}
{
  // A run of spaces in a program is this format's pilot byte, so a stretch of
  // screen text must not read as a block: what follows the run decides.
  const p = [];
  for (let i = 0; i < 200; i++) bitsOf(p, 0x20, P);
  for (const b of body(100)) bitsOf(p, b, P);
  eq(pro(p), [], 'spaces followed by anything but $FF claim nothing');
}

// ── A deck off speed ─────────────────────────────────────────────────────────
{
  // 264 and 552 sit either side of the loader's own 360.
  for (const rate of [0.85, 1.3]) {
    const widths = { zero: Math.round(P.zero * rate), one: Math.round(P.one * rate) };
    const p = [];
    block(p, { name: 'PIC', start: 0x0400, body: body(2000), widths });
    eq(pro(p).map(f => [f.size, f.damaged]), [[2000, false]],
       `a deck running at ${rate}x still reads`);
  }
}

// ── The payload ──────────────────────────────────────────────────────────────
{
  const p = [];
  const data = body(600, 3);
  block(p, { name: 'MU', start: 0xC000, body: data });
  eq(pro(p)[0].bytes === undefined, true, 'no payload unless it is asked for');
  const f = pro(p, { payload: true })[0];
  eq(f.bytes.length, f.size, 'the payload is as long as the size says');
  eq([...f.bytes], data, 'and is byte for byte what the tape carries');
}

console.log(failures ? `procass spec: FAIL (${failures})` : 'procass spec: PASS');
process.exit(failures ? 1 : 0);
