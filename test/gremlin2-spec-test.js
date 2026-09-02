// Spec test for the Gremlin Type 2 loader (src/tap-turbo-formats.js).
//
// Read out of the 512-byte loader its tapes carry at $0400, which is not
// encrypted. What that loader does:
//   one bit per pulse, MSB first, 424 cycles and 840
//   the bit is whether CIA1 timer A, armed with $0A50, still reads 8 or more in
//     its high byte at the next edge, so the *short* pulse is the 1 and the
//     boundary is 592 cycles
//   each assembled byte is complemented
//   it shifts until its register holds $01, which read the ordinary way round
//     is $FE, and both inversions cancel
//   then two id characters ("01", "02", …), the load address, and the length,
//     counted down to zero
//   then the bytes, and no checksum anywhere
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

// Written the way the scanner reads them: a set bit is the long pulse.
const G = { set: 840, clear: 424 };

const bitsOf = (out, v, w) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? w.set : w.clear); };

/** One block as the loader reads it. */
function block(out, { id = '01', start, body, widths = G, lead = 200, sync = 0xFE, size = null }) {
  for (let i = 0; i < lead; i++) bitsOf(out, 0xFF, widths);   // the 0 bits it shifts through
  bitsOf(out, sync, widths);
  bitsOf(out, id.charCodeAt(0), widths); bitsOf(out, id.charCodeAt(1), widths);
  bitsOf(out, start & 0xFF, widths); bitsOf(out, start >> 8, widths);
  const n = size ?? body.length;
  bitsOf(out, n & 0xFF, widths); bitsOf(out, n >> 8, widths);
  for (const b of body) bitsOf(out, b, widths);
  out.push(1000000);
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
const gremlin = (p, o) => tapDirectory(tapOf(p), o).filter(f => f.format === 'Gremlin Type 2');

// ── One block ────────────────────────────────────────────────────────────────
{
  const p = [];
  block(p, { id: '01', start: 0x0810, body: body(2000) });
  const files = gremlin(p);
  eq(files.length, 1, 'one Gremlin Type 2 block on the tape');
  eq([files[0].name, files[0].start, files[0].size], ['01', 0x0810, 2000],
     'its id, where it loads, and how long it is');
  eq(files[0].damaged, false, 'and nothing about its pulses is wrong');
}

// ── The id is a name, which is what this format has and the others do not ────
{
  const p = [];
  block(p, { id: '01', start: 0x0810, body: body(900) });
  block(p, { id: '02', start: 0x4000, body: body(700, 1) });
  block(p, { id: '03', start: 0xC000, body: body(500, 2) });
  eq(gremlin(p).map(f => [f.name, f.start, f.size]),
     [['01', 0x0810, 900], ['02', 0x4000, 700], ['03', 0xC000, 500]],
     'each block names itself, in tape order');
}

// ── What is not a header ─────────────────────────────────────────────────────
{
  const p = [];
  block(p, { id: 'A1', start: 0x0810, body: body(400) });
  eq(gremlin(p), [], 'an id that is not two digits is not this format');
}
{
  const p = [];
  block(p, { id: '01', start: 0xF000, body: body(200), size: 0x2000 });
  eq(gremlin(p), [], 'a block that would load past $FFFF is not claimed');
}
{
  const p = [];
  block(p, { id: '01', start: 0x0810, body: body(400), sync: 0xFD });
  eq(gremlin(p), [], 'and without the sync byte, nothing');
}

// ── No checksum, so the widths are the whole verdict ─────────────────────────
{
  const p = [];
  block(p, { id: '01', start: 0x0810, body: body(2000) });
  for (let k = 0; k < 8; k++) p[2000 + k * 5] = 2000;   // neither symbol, nor silence
  const files = gremlin(p);
  eq(files.length, 1, 'the block is still listed');
  eq(files.map(f => f.damaged), [true], 'and marked damaged from its pulse widths alone');
}

// ── A deck off speed ─────────────────────────────────────────────────────────
{
  // 424 and 840 sit either side of the loader's own 592: it holds from a deck
  // 29% slow to one 39% fast.
  for (const rate of [0.8, 1.3]) {
    const widths = { set: Math.round(G.set * rate), clear: Math.round(G.clear * rate) };
    const p = [];
    block(p, { id: '01', start: 0x0810, body: body(2000), widths });
    eq(gremlin(p).map(f => [f.name, f.size, f.damaged]), [['01', 2000, false]],
       `a deck running at ${rate}x still reads`);
  }
}

// ── The payload ──────────────────────────────────────────────────────────────
// Every byte of this format is stored complemented, so a payload handed back
// uncomplemented would be the file inverted rather than the file.
{
  const p = [];
  const data = body(600, 5);
  block(p, { id: '07', start: 0x4000, body: data });
  eq(gremlin(p)[0].bytes === undefined, true, 'no payload unless it is asked for');
  const f = gremlin(p, { payload: true })[0];
  eq(f.bytes.length, f.size, 'the payload is as long as the size says');
  eq([...f.bytes], data, 'and is deciphered back to what was written');
}

console.log(failures ? `gremlin type 2 spec: FAIL (${failures})` : 'gremlin type 2 spec: PASS');
process.exit(failures ? 1 : 0);
