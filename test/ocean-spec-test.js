// Spec test for the Ocean / Imagine loader (src/tap-turbo-formats.js).
//
// Read out of the reader its tapes copy into zero page, which measures a pulse
// exactly as Novaload's does:
//   LDA $DD07 / LDY #$11 / STY $DD0F / EOR #$02 / LSR / LSR / ROR $02
// CIA2 timer B is armed with $03E0, and the bit is whether its high byte still
// reads 2 or more, so the boundary is 992 - 512 = 480 cycles. One pulse a bit,
// LSB first. A pilot of 0 bits, the one 1 bit the register syncs on, and then
// [flags, page, 256 bytes] over and over until a page byte of $00. No checksum
// anywhere, which is why the pilot's width and the stream's length have to
// carry the whole burden of proof.
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

const O = { zero: 296, one: 640 };

const bitsOf = (out, v, w) => { for (let k = 0; k < 8; k++) out.push((v >> k) & 1 ? w.one : w.zero); };
const body = (n, seed = 0) => Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

/** One stream as the loader reads it. `pilotWidth` is what the lead-in is written at. */
function stream(out, { pages, widths = O, pilot = 200, pilotWidth = null, flags = 0 }) {
  for (let i = 0; i < pilot; i++) out.push(pilotWidth ?? widths.zero);
  out.push(widths.one);                            // the bit the register syncs on
  for (const page of pages) {
    bitsOf(out, flags, widths);
    bitsOf(out, page, widths);
    for (const b of body(256, page)) bitsOf(out, b, widths);
  }
  bitsOf(out, flags, widths);
  bitsOf(out, 0x00, widths);                       // the page that ends it
  out.push(1000000);
}

const upFrom = (first, n) => Array.from({ length: n }, (_, i) => first + i);

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
const ocean = (p, o) => tapDirectory(tapOf(p), o).filter(f => f.format === 'Ocean / Imagine');

// ── One stream ───────────────────────────────────────────────────────────────
{
  const p = [];
  stream(p, { pages: upFrom(0x40, 20) });
  const files = ocean(p);
  eq(files.length, 1, 'one Ocean / Imagine stream on the tape');
  eq([files[0].start, files[0].end, files[0].size], [0x4000, 0x5400, 20 * 256],
     'it spans the pages it wrote, and holds 256 bytes for each');
  eq(files[0].name, '', 'the format carries no name');
  eq(files[0].damaged, false, 'and nothing about its pulses is wrong');
}

// ── The page byte is what ends it ────────────────────────────────────────────
{
  // A stream that runs off the end of the tape never says it finished, and a
  // format with no checksum has nothing else to go on.
  const p = [];
  stream(p, { pages: upFrom(0x40, 20) });
  const cut = p.slice(0, p.length - 8 * 300);
  eq(ocean(cut), [], 'a stream with no terminator on the tape is not claimed');
}

// ── Ascending pages are the proof, there being no checksum ───────────────────
{
  // Length is not proof. A stream of noise does not stop; it runs until a page
  // byte of $00 turns up by chance, 256 blocks on average. Silkworm reads as 141
  // blocks this way and is a Freeload tape.
  //
  // What a page-based loader does and noise does not is count. Measured: 97% of
  // the steps ascend on Green Beret, 96% on Arkanoid, 98% on Head Over Heels,
  // against 1% for the 141 blocks read out of Silkworm.
  const p = [];
  let seed = 7;
  const scattered = Array.from({ length: 60 }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    return ((seed >> 16) & 0xFF) || 1;             // never $00, which would end it
  });
  stream(p, { pages: scattered });
  eq(ocean(p), [], 'a long stream whose pages do not ascend is not claimed');
}
{
  // And too few blocks to judge that share by is not claimed either.
  const p = [];
  stream(p, { pages: upFrom(0x40, 4) });
  eq(ocean(p), [], 'four blocks is too few to tell from a coincidence');
}

// ── A KERNAL lead-in is not this format's pilot ──────────────────────────────
{
  // Both are short. This family writes its 0 at 264 to 296 cycles and a KERNAL
  // lead-in runs 352 to 384, so the pilot is judged against the narrower band:
  // Head Over Heels' lead-in was read as one, and the nonsense that came out of
  // it claimed the tape its KERNAL file was on.
  const p = [];
  stream(p, { pages: upFrom(0x40, 20), pilotWidth: 376 });
  eq(ocean(p), [], 'a lead-in at KERNAL width does not sync this format');
}

// ── The family is retimed from tape to tape ──────────────────────────────────
{
  // One boundary reads all of them, since the loader compares against 480 and
  // every pair measured sits either side of it.
  const seen = [['Green Beret', 296, 640], ['Arkanoid', 288, 648],
                ['Head Over Heels', 264, 664], ['Silkworm', 264, 544]];
  for (const [tape, zero, one] of seen) {
    const p = [];
    stream(p, { pages: upFrom(0x40, 20), widths: { zero, one } });
    eq(ocean(p).map(f => [f.size, f.damaged]), [[20 * 256, false]],
       `the widths ${zero}/${one} measured on ${tape} read at the same boundary`);
  }
}

// ── No checksum, so the widths are the whole verdict ─────────────────────────
{
  const p = [];
  stream(p, { pages: upFrom(0x40, 20) });
  for (let k = 0; k < 8; k++) p[3000 + k * 5] = 1400;   // neither symbol, nor silence
  const files = ocean(p);
  eq(files.length, 1, 'the stream is still listed');
  eq(files.map(f => f.damaged), [true], 'and marked damaged from its pulse widths alone');
}

// ── The payload ──────────────────────────────────────────────────────────────
// This loader names pages, not a byte count, and it may skip one. So the
// payload cannot be `size` bytes: it is the span from the lowest page to the
// highest, with a page the tape never wrote left as zeros, while `size` stays
// what the tape actually carries. A caller writing a program out needs the span;
// a caller judging the tape needs the count; both are here and they differ.
{
  const p = [];
  const pages = [...upFrom(0x40, 12), ...upFrom(0x51, 10)];   // $50 is missing
  stream(p, { pages });
  eq(ocean(p)[0].bytes === undefined, true, 'no payload unless it is asked for');
  const f = ocean(p, { payload: true })[0];
  eq([f.start, f.end], [0x4000, 0x5B00], 'the span runs from the lowest page to the highest');
  eq(f.size, 22 * 256, 'the size counts the pages the tape carries');
  eq(f.bytes.length, f.end - f.start, 'and the payload covers the span, not the count');
  eq([...f.bytes.subarray(0, 256)], body(256, 0x40), 'the first page is where it belongs');
  eq([...f.bytes.subarray(0x1100, 0x1200)], body(256, 0x51),
     'and so is the one after the gap');
  eq(f.bytes.subarray(0x1000, 0x1100).every(b => b === 0), true,
     'the page the tape never wrote is zeros, not another page shifted into it');
}

console.log(failures ? `ocean spec: FAIL (${failures})` : 'ocean spec: PASS');
process.exit(failures ? 1 : 0);
