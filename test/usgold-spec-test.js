// Spec test for the US Gold / Datasoft loader (src/tap-turbo-formats.js).
//
// The format was read out of the loader the tape carries, which decrypts itself
// before it runs, so this is what the decrypted reader in the tape buffer does:
//   one bit per pulse, MSB first (ROL eight times), 224 cycles for a 0 and 512
//     for a 1
//   the boundary is CIA2 timer B armed with $016B, so 363 cycles, not a midpoint
//   a lead-in of $02 bytes and a countdown $09…$01, as Turbo Tape 64 writes them
//   then $01, its sync byte $96, $00, the load address, the length negated, and
//     one spare byte
//   then the data, and no checksum anywhere in the format
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

const G = { zero: 224, one: 512 };
const SYNC = 0x96;

const bitsOf = (out, v, w) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? w.one : w.zero); };

/** One block as the loader reads it. */
function block(out, { start, body, widths = G, lead = 200, sync = SYNC, spare = 0x00, size = null }) {
  for (let i = 0; i < lead; i++) bitsOf(out, 0x02, widths);
  for (let v = 9; v >= 1; v--) bitsOf(out, v, widths);
  bitsOf(out, 0x01, widths);                       // the byte the loader only checks is not $00
  bitsOf(out, sync, widths);
  bitsOf(out, 0x00, widths);
  bitsOf(out, start & 0xFF, widths); bitsOf(out, start >> 8, widths);
  const n = size ?? body.length;                   // `size` writes a length the body does not reach
  const neg = (0x10000 - n) & 0xFFFF;
  bitsOf(out, neg & 0xFF, widths); bitsOf(out, neg >> 8, widths);
  bitsOf(out, spare, widths);
  for (const b of body) bitsOf(out, b, widths);
  out.push(1000000);                               // the silence before whatever is next
}

const body = (n, seed = 0) => Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

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
const usGold = (p, o) => tapDirectory(tapOf(p), o).filter(f => f.format === 'US Gold / Datasoft');

// ── One block ────────────────────────────────────────────────────────────────
{
  const p = [];
  block(p, { start: 0x0400, body: body(768) });
  const files = usGold(p);
  eq(files.length, 1, 'one US Gold / Datasoft block on the tape');
  eq([files[0].start, files[0].end, files[0].size], [0x0400, 0x0700, 768],
     'the load address and the negated length give the range');
  eq(files[0].name, '', 'the format carries no name');
  eq(files[0].damaged, false, 'and nothing about its pulses is wrong');
}

// ── Several, in tape order ───────────────────────────────────────────────────
{
  // The shape the real tape has: a few blocks that fill memory, then level
  // blocks that reload the same buffer over and over.
  const p = [];
  block(p, { start: 0x0400, body: body(768) });
  block(p, { start: 0x6000, body: body(1280, 1) });
  block(p, { start: 0x4140, body: body(2207, 2) });
  block(p, { start: 0x4140, body: body(2575, 3) });
  eq(usGold(p).map(f => [f.start, f.size]),
     [[0x0400, 768], [0x6000, 1280], [0x4140, 2207], [0x4140, 2575]],
     'each block lists where it loads, in the order the tape holds them');
}

// ── The sync byte is what makes it this format ───────────────────────────────
{
  // A countdown $09…$01 is Turbo Tape 64's too, so the countdown alone claims
  // nothing. $96 after it is the tell.
  const p = [];
  block(p, { start: 0x0400, body: body(768), sync: 0x95 });
  eq(usGold(p), [], 'a countdown without the sync byte is not this format');
}

// ── A length that runs off the top of memory ─────────────────────────────────
{
  const p = [];
  block(p, { start: 0xF000, body: body(200), size: 0x2000 });
  eq(usGold(p), [], 'a block that would load past $FFFF is not claimed');
}

// ── No checksum, so the widths are the whole verdict ─────────────────────────
{
  // The loader stores until its counter wraps and never adds anything up. What
  // is left to judge a block on is whether its pulses are its two symbols, as
  // for GRL-Supertape.
  const p = [];
  block(p, { start: 0x0400, body: body(768) });
  // Well inside the data: the lead-in is 200 bytes and the countdown and header
  // 17 more, so the payload starts around pulse 1736 and only it is judged.
  for (let k = 0; k < 8; k++) p[2000 + k * 5] = 1100;    // neither symbol, nor a hole
  const files = usGold(p);
  eq(files.length, 1, 'the block is still listed');
  eq(files.map(f => f.damaged), [true], 'and marked damaged from its pulse widths alone');
}

// ── A deck off speed ─────────────────────────────────────────────────────────
{
  // 224 and 512 sit either side of the loader's own 363, with room: it holds
  // from a deck 29% slow to one 62% fast.
  for (const rate of [0.8, 1.5]) {
    const widths = { zero: Math.round(G.zero * rate), one: Math.round(G.one * rate) };
    const p = [];
    block(p, { start: 0x0400, body: body(768), widths });
    eq(usGold(p).map(f => [f.start, f.size, f.damaged]), [[0x0400, 768, false]],
       `a deck running at ${rate}x still reads`);
  }
}

// ── The payload ──────────────────────────────────────────────────────────────
// Asked for, the bytes come back with the file: `size` of them, covering
// start..end, and the same ones that were written. Not asked for, they are not
// built at all, a tape's worth being megabytes a listing has no use for.
{
  const p = [];
  const data = body(600, 9);
  block(p, { start: 0x8000, body: data });
  eq(usGold(p)[0].bytes === undefined, true, 'no payload unless it is asked for');
  const f = usGold(p, { payload: true })[0];
  eq(f.bytes.length, f.size, 'the payload is as long as the size says');
  eq([...f.bytes], data, 'and is byte for byte what the tape carries');
}

console.log(failures ? `us gold / datasoft spec: FAIL (${failures})` : 'us gold / datasoft spec: PASS');
process.exit(failures ? 1 : 0);
