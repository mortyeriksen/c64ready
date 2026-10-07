// A DC2N dump becomes the tape it recorded (src/media/dmp-tape.js).
//
// The DC2N counts a 2 MHz clock between the cassette port's edges and writes one
// count per pulse, so the conversion is a change of clock — asserted here to
// within TAP's own rounding — plus the format's two rules: a sample at the
// maximum is an overflow that carries into the next, and a version-1 dump may
// hold half-waves, which is a v2 tape.
import { dmpToTap, restoreDump } from '../../src/media/dmp-tape.js';
import { tapDirectory } from '../../src/media/tap-directory.js';
import { PAL_CPU_HZ } from '../../src/media/tap-audio.js';
import { ZERO, ONE, body, turboFile, kernalFile, pulsesOf } from './_tape-fixtures.js';
import { turboTape64Files } from '../../src/media/tap-turbo-formats.js';
import { cleanTurboTape64 } from '../../src/media/wav-tape.js';
import { repairTape } from '../../src/media/tap-repair.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const RATE = 2000000;
// Two seconds of nothing after each file: at 2 MHz that is sixty-one 16-bit overflows.
const tail = 2 * PAL_CPU_HZ;
const cycles = [...turboFile('FIRST', 0x0801, body(2000), { tail }).pulses,
  ...turboFile('SECOND', 0x4000, body(800), { tail }).pulses];

/** A dump as the device writes it: header, then ticks with the overflow rule. */
function dump(pulses, { version = 0, machine = 0, video = 0, bits = 16, flags = 0 } = {}) {
  const max = 2 ** bits - 1, width = bits >> 3;
  const samples = [];
  for (const c of pulses) {
    let ticks = Math.round(c * RATE / PAL_CPU_HZ);
    while (ticks >= max) { samples.push(max); ticks -= max; }
    samples.push(ticks);
  }
  const out = new Uint8Array(20 + samples.length * width);
  out.set([...'DC2N-TAP-RAW'].map(c => c.charCodeAt(0)), 0);
  out[12] = version; out[13] = machine | flags; out[14] = video; out[15] = bits;
  new DataView(out.buffer).setUint32(16, RATE, true);
  let p = 20;
  for (const s of samples) { for (let k = 0; k < width; k++) out[p++] = (s / 256 ** k) & 255; }
  return out;
}

// ── A version-0 dump is the tape, to within TAP's rounding ───────────────────
{
  const read = dmpToTap(dump(cycles));
  expect(read.machine === 'C64' && read.video === 'PAL' && read.sampleRate === RATE,
    `the header is read (${read.machine} ${read.video} ${read.sampleRate})`);
  expect(read.pulses === cycles.length, `one pulse per pulse written (${read.pulses} of ${cycles.length})`);
  expect(read.tap[12] === 1, `full waves make a v1 tape (v${read.tap[12]})`);
  const got = pulsesOf(read.tap);
  let off = 0;
  for (let i = 0; i < cycles.length; i++) if (Math.abs(got[i] - cycles[i]) > 4.5) off++;
  expect(off === 0, `every width comes back within a TAP step (${off} did not)`);
  expect(Math.abs(got[got.length - 1] - 2 * PAL_CPU_HZ) < 8,
    `the overflowed silence is one whole pulse (${got[got.length - 1]} cycles)`);
  const total = cycles.reduce((a, c) => a + c, 0) / PAL_CPU_HZ;
  expect(Math.abs(read.seconds - total) < 0.01, `and the tape is as long as it was (${read.seconds.toFixed(2)} s)`);

  const files = tapDirectory(read.tap.subarray(20), { version: read.tap[12] });
  expect(files.map(f => f.name.trim()).join(',') === 'FIRST,SECOND', `both files are listed, got [${files.map(f => f.name.trim())}]`);
  expect(files.every(f => !f.damaged), 'and both are sound');
}

// ── 32-bit samples read the same ─────────────────────────────────────────────
{
  const read = dmpToTap(dump(cycles, { bits: 32 }));
  const got = pulsesOf(read.tap);
  let off = 0;
  for (let i = 0; i < cycles.length; i++) if (Math.abs(got[i] - cycles[i]) > 4.5) off++;
  expect(off === 0 && read.pulses === cycles.length, `32-bit samples convert alike (${off} off, ${read.pulses} pulses)`);
}

// ── A version-1 dump that kept both half-waves is a v2 tape ──────────────────
{
  const halves = [];
  for (const c of cycles) halves.push(c / 2, c / 2);
  const read = dmpToTap(dump(halves, { version: 1, flags: 0x20 }));
  expect(read.tap[12] === 2, `half-waves make a v2 tape (v${read.tap[12]})`);
  expect(read.pulses === halves.length, `one entry per half-wave (${read.pulses})`);
  // Without the flag, a version-1 dump is full waves like a version-0 one.
  expect(dmpToTap(dump(cycles, { version: 1 })).tap[12] === 1, 'a version-1 dump without the flag is v1');
}

// ── The machine is reported; the clock is the deck's ─────────────────────────
{
  const vic = dmpToTap(dump(cycles, { machine: 1, video: 1 }));
  expect(vic.machine === 'VIC 20' && vic.video === 'NTSC', `another machine is named (${vic.machine}, ${vic.video})`);
  expect(Math.abs(pulsesOf(vic.tap)[0] - cycles[0]) <= 4.5, 'and its pulses last as long on this port');
}

// ── What is not a dump says so ───────────────────────────────────────────────
for (const [bad, why] of [
  [new Uint8Array(10), 'too short'],
  [Uint8Array.from([...'C64-TAPE-RAW'].map(c => c.charCodeAt(0)).concat(new Array(8).fill(0))), 'a .tap'],
  [(() => { const d = dump(cycles); d[12] = 2; return d; })(), 'an unknown version'],
  [(() => { const d = dump(cycles); d[15] = 12; return d; })(), 'an odd sample size'],
]) {
  let threw = false;
  try { dmpToTap(bad); } catch { threw = true; }
  expect(threw, `${why} is refused`);
}

// ── A dump is restored the way a recording is ───────────────────────────────
// A deck's comparator and speed leave a turbo block's widths scattered about
// the two the format writes. A loader with a fixed threshold reads a block
// whose checksum passes best at those two widths, so it goes back at them.
{
  const jittered = cycles.map((c, i) => (c === ZERO || c === ONE ? c + ((i * 7) % 5 - 2) * 9 : c));
  const raw = dmpToTap(dump(jittered));
  const done = restoreDump(dump(jittered));
  const blocksOf = (tap) => turboTape64Files(pulsesOf(tap)).map(f => pulsesOf(tap).slice(f.data.syncBit, f.data.endBit));
  const widths = (tap) => new Set(blocksOf(tap).flat());
  expect(widths(raw.tap).size > 2, `the dump's own data blocks are scattered (${widths(raw.tap).size} widths)`);
  expect(widths(done.tap).size === 2, `a sound Turbo Tape 64 data block goes back at the format's two widths (${[...widths(done.tap)]})`);
  const files = tapDirectory(done.tap.subarray(20), { version: done.tap[12] });
  expect(files.length === 2 && files.every(f => !f.damaged), 'and both files still read whole');
  // In cycles, before the .tap's steps of 8 round them: the rewrite settles each
  // block's difference with the gap after it.
  const sum = (xs) => xs.reduce((a, c) => a + c, 0);
  const cleaned = cleanTurboTape64(jittered);
  expect(cleaned.rewritten === 2, `both data blocks are rewritten (${cleaned.rewritten})`);
  expect(Math.abs(sum(cleaned.pulses) - sum(jittered)) < 1e-6,
    `and nothing after a rewritten block moves (${sum(cleaned.pulses) - sum(jittered)} cycles)`);
  const kept = restoreDump(dump(jittered), { clean: false });
  expect(widths(kept.tap).size > 2, 'clean: false leaves the widths as dumped');
}

// A KERNAL file whose repeat copy was clipped is rebuilt from the first copy,
// which the block's own checksum proves. The listing calls a file sound when
// either copy is, so the copies are read through the repair itself.
{
  const clipped = kernalFile('CLIPPED', 0x0801, body(300), { lose: 40 });
  const state = (tap) => repairTape(tap).files[0]?.state;
  expect(state(dmpToTap(dump(clipped)).tap) === 'repairable',
    `the clipped repeat is seen as dumped (${state(dmpToTap(dump(clipped)).tap)})`);
  const done = restoreDump(dump(clipped));
  expect(done.repaired.includes('CLIPPED'), `the file is named as repaired ([${done.repaired}])`);
  expect(state(done.tap) === 'good', `and both copies read whole after (${state(done.tap)})`);
  const kept = restoreDump(dump(clipped), { repair: false });
  expect(kept.repaired.length === 0 && state(kept.tap) === 'repairable', 'repair: false leaves it as dumped');

  // The rebuilt copy is longer than the clipped one, and at the KERNAL's own
  // widths where this deck ran 4% slow. The silence after it takes up the
  // difference: the file that follows starts where it did, with the whole of
  // its lead-in.
  const next = turboFile('NEXT', 0x0801, body(500)).pulses;
  const tape = [...clipped.map(c => (c < 20000 ? c * 1.04 : c)), ...next];
  const whereNext = (tap) => {
    const ps = pulsesOf(tap);
    let t = 0, i = ps.length - next.length;
    for (let k = 0; k < i; k++) t += ps[k];
    return { t, lead: ps.slice(i, i + 1600) };
  };
  const before = whereNext(dmpToTap(dump(tape)).tap), after = whereNext(restoreDump(dump(tape), { clean: false }).tap);
  expect(Math.abs(after.t - before.t) < 64, `the next file starts where it did (${after.t - before.t} cycles)`);
  expect(after.lead.every((c, i) => c === before.lead[i]), 'and its lead-in is whole');
}

// Half-waves are neither format's shape: the dump comes through as it was.
{
  const halves = [];
  for (const c of cycles) halves.push(c / 2, c / 2);
  const done = restoreDump(dump(halves, { version: 1, flags: 0x20 }));
  const raw = dmpToTap(dump(halves, { version: 1, flags: 0x20 }));
  expect(done.tap[12] === 2 && done.repaired.length === 0, 'a half-wave dump stays a v2 tape, unrepaired');
  expect(done.tap.length === raw.tap.length && done.tap.every((b, i) => b === raw.tap[i]), 'and is byte for byte the plain conversion');
}

console.log('dmp tape spec: OK');
