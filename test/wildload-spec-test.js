// Spec test for the Wildload loader (src/tap-turbo-formats.js).
//
// Read out of the reader its tapes copy into the stack page:
//   LDA $DC05 / LDY #$11 / STY $DC0E / EOR #$02 / LSR / LSR / ROR $AE
// It rotates right, so bytes are LSB first, and counts bits in $A9 rather than
// pushing a sentinel through the register. CIA1 timer A is armed with $03E0, so
// the boundary is 992 - 512 = 480 cycles.
//
// A block is a run of $A0 bytes, a countdown $0A to $01, five bytes of header,
// the bytes, and one holding their XOR. Two things are its own: the destination
// descends, so a block fills memory downwards from the address in its header,
// and each byte is EOR'd with the low byte of wherever it goes before storing.
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

const W = { zero: 384, one: 576 };
const bitsOf = (out, v, w) => { for (let k = 0; k < 8; k++) out.push((v >> k) & 1 ? w.one : w.zero); };
const body = (n, seed = 0) => Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

/**
 * One block written the way the loader would have written it, ciphered and
 * descending, so the test exercises the reading rather than agreeing with it.
 */
function block(out, { top, body: data, widths = W, lead = 256, spoilSum = 0,
                      count = null, cipher = true }) {
  for (let i = 0; i < lead; i++) bitsOf(out, 0xA0, widths);
  for (let v = 0x0A; v >= 1; v--) bitsOf(out, v, widths);
  const n = count ?? data.length;
  bitsOf(out, top & 0xFF, widths); bitsOf(out, top >> 8, widths);
  bitsOf(out, n & 0xFF, widths); bitsOf(out, n >> 8, widths);
  bitsOf(out, 0x01, widths);
  let sum = 0, to = top;
  for (const b of data) {
    sum ^= b;
    bitsOf(out, cipher ? ((b ^ (to & 0xFF)) & 0xFF) : b, widths);
    to = (to - 1) & 0xFFFF;
  }
  bitsOf(out, sum ^ spoilSum, widths);
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
const wild = (p, o) => tapDirectory(tapOf(p), o).filter(f => f.format === 'Wildload');

// ── One block, filling downwards ─────────────────────────────────────────────
{
  const p = [];
  block(p, { top: 0x57FF, body: body(2000) });
  const files = wild(p);
  eq(files.length, 1, 'one Wildload block on the tape');
  eq([files[0].start, files[0].end, files[0].size], [0x5030, 0x5800, 2000],
     'the header names the top, and the block fills the range below it');
  eq(files[0].name, '', 'the format carries no name');
  eq(files[0].damaged, false, 'and it adds up');
}

// ── The cipher is part of reading it ─────────────────────────────────────────
{
  // Each byte is EOR'd with the low byte of its destination, so the checksum
  // only agrees if the reading deciphered against a descending address.
  const p = [];
  block(p, { top: 0x4000, body: body(600), cipher: false });
  eq(wild(p), [], 'a block written without the cipher does not read as one');
}

// ── One byte is a block, and that is the point ───────────────────────────────
{
  // IK+ aims a single byte at $D011 to turn the screen off between loads.
  const p = [];
  block(p, { top: 0xD011, body: [0x0B] });
  eq(wild(p).map(f => [f.start, f.size]), [[0xD011, 1]],
     'a block of one byte, which is how it pokes a register');
}

// ── The checksum has the last word ───────────────────────────────────────────
{
  const p = [];
  block(p, { top: 0x57FF, body: body(2000), spoilSum: 0xFF });
  eq(wild(p), [], 'a block whose XOR is wrong has not arrived, so it is not claimed');
}

// ── What is not a block ──────────────────────────────────────────────────────
{
  // Measured on IK+: 49 countdowns decode out of that tape, and only the three
  // with a lead-in behind them are blocks. The other 46 sit inside data.
  const p = [];
  block(p, { top: 0x57FF, body: body(600), lead: 0 });
  eq(wild(p), [], 'a countdown with no lead-in in front of it is not a block');
}
{
  const p = [];
  block(p, { top: 0x0100, body: body(600), count: 0x0400 });
  eq(wild(p), [], 'a count that would run off the bottom of memory is not a block');
}

// ── A deck off speed ─────────────────────────────────────────────────────────
{
  // 384 and 576 sit either side of the loader's own 480, though not far: this is
  // the narrowest pair of any format here.
  for (const rate of [0.9, 1.15]) {
    const widths = { zero: Math.round(W.zero * rate), one: Math.round(W.one * rate) };
    const p = [];
    block(p, { top: 0x57FF, body: body(2000), widths });
    eq(wild(p).map(f => [f.size, f.damaged]), [[2000, false]],
       `a deck running at ${rate}x still reads`);
  }
}

// ── The payload ──────────────────────────────────────────────────────────────
// The hardest of these to hand over: the bytes are enciphered against the low
// byte of where each one lands, and they land from the top down. A payload in
// tape order would be the file backwards, and one left enciphered would be
// noise, so this asserts the plain bytes in address order.
{
  const p = [];
  const data = body(600, 7);
  block(p, { top: 0x9FFF, body: data });
  eq(wild(p)[0].bytes === undefined, true, 'no payload unless it is asked for');
  const f = wild(p, { payload: true })[0];
  eq(f.bytes.length, f.size, 'the payload is as long as the size says');
  eq(f.start, 0x9FFF - 600 + 1, 'the file starts where the descent ends');
  // `data` is what goes on the tape, and its first byte is enciphered against
  // `top`, so it lands at the file's last address. In address order, which is
  // the only order a program can be written out in, the file is that reversed.
  eq([...f.bytes], [...data].reverse(), 'and the payload is deciphered, and the right way round');
}

console.log(failures ? `wildload spec: FAIL (${failures})` : 'wildload spec: PASS');
process.exit(failures ? 1 : 0);
