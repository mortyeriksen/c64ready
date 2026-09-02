// Spec test for the Freeload loader (src/tap-turbo-formats.js).
//
// Read out of the loader its tapes carry. It measures a pulse as Novaload does,
// and keeps its state as Novaload does, by writing over a branch's operand:
//   LDA $DC05 / LDY #$19 / STY $DC0E / EOR #$02 / LSR / LSR / ROL $A9
// The last instruction differs: Novaload rotates right and reads LSB first,
// this rotates left, so Freeload is MSB first. CIA1 timer A is armed with
// $0368, and the bit is whether its high byte still reads 2 or more, so the
// boundary is 872 - 512 = 360 cycles.
//
// A block is the register reaching $40, a $5A, the load address, the end
// address exclusive, the bytes, and one byte holding the XOR of them. That
// checksum is the only one any of the four commercial loaders here carries, and
// it is what a claim rests on: two bytes of sync is one in 65536, which a tape
// supplies several times over.
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

const F = { zero: 264, one: 544 };

const bitsOf = (out, v, w) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? w.one : w.zero); };
const body = (n, seed = 0) => Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

/** One block as the loader reads it. */
function block(out, { start, body: data, widths = F, pilot = 200, sync = 0x40,
                      after = 0x5A, spoilSum = 0, end = null }) {
  for (let i = 0; i < pilot; i++) bitsOf(out, 0x00, widths);
  bitsOf(out, sync, widths);
  bitsOf(out, after, widths);
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
const free = (p, o) => tapDirectory(tapOf(p), o).filter(f => f.format === 'Freeload');

// ── One block ────────────────────────────────────────────────────────────────
{
  const p = [];
  block(p, { start: 0xE000, body: body(2000) });
  const files = free(p);
  eq(files.length, 1, 'one Freeload block on the tape');
  eq([files[0].start, files[0].end, files[0].size], [0xE000, 0xE7D0, 2000],
     'the two addresses give the range, the end being exclusive');
  eq(files[0].name, '', 'the format carries no name');
  eq(files[0].damaged, false, 'and it adds up');
}

// ── Two, in tape order ───────────────────────────────────────────────────────
{
  // The shape Silkworm has: a small block under the KERNAL, then the game.
  const p = [];
  block(p, { start: 0xE000, body: body(1200) });
  block(p, { start: 0x0801, body: body(3000, 1) });
  eq(free(p).map(f => [f.start, f.size]), [[0xE000, 1200], [0x0801, 3000]],
     'each block lists where it loads, in the order the tape holds them');
}

// ── The checksum is what a claim rests on ────────────────────────────────────
{
  // Two bytes of sync is one in 65536, and a tape supplies that several times:
  // six of the eight candidates on Silkworm are coincidence, with addresses as
  // reasonable as the real ones. So a block that does not add up is not claimed
  // at all, where Turbo Tape 64 can afford to list one and strike it through.
  const p = [];
  block(p, { start: 0xE000, body: body(2000), spoilSum: 0xFF });
  eq(free(p), [], 'a block whose XOR is wrong is not claimed');
}

// ── What is not a block ──────────────────────────────────────────────────────
{
  const p = [];
  block(p, { start: 0xE000, body: body(500), after: 0x5B });
  eq(free(p), [], 'the byte after the sync has to be $5A');
}
{
  // The addresses have to run forwards, and not into zero page or the stack.
  const p = [];
  block(p, { start: 0xE000, body: body(500), end: 0xD000 });
  eq(free(p), [], 'an end address below the start is not a block');
}
{
  const p = [];
  block(p, { start: 0x0020, body: body(500) });
  eq(free(p), [], 'a block claiming to load into zero page is not one');
}

// ── A deck off speed ─────────────────────────────────────────────────────────
{
  // 264 and 544 sit either side of the loader's own 360.
  for (const rate of [0.85, 1.3]) {
    const widths = { zero: Math.round(F.zero * rate), one: Math.round(F.one * rate) };
    const p = [];
    block(p, { start: 0xE000, body: body(2000), widths });
    eq(free(p).map(f => [f.size, f.damaged]), [[2000, false]],
       `a deck running at ${rate}x still reads`);
  }
}

// ── The payload ──────────────────────────────────────────────────────────────
// This format reads MSB first where Novaload reads LSB first, so a payload read
// the other way round would come back with every byte's bits reversed.
{
  const p = [];
  const data = body(600, 3);
  block(p, { start: 0x0801, body: data });
  eq(free(p)[0].bytes === undefined, true, 'no payload unless it is asked for');
  const f = free(p, { payload: true })[0];
  eq(f.bytes.length, f.size, 'the payload is as long as the size says');
  eq([...f.bytes], data, 'and is byte for byte what the tape carries');
  let x = 0; for (const b of f.bytes) x ^= b;
  eq(x, data.reduce((a, b) => a ^ b, 0), "and answers to the block's own checksum");
}

console.log(failures ? `freeload spec: FAIL (${failures})` : 'freeload spec: PASS');
process.exit(failures ? 1 : 0);
