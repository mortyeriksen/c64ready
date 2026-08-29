// Reading a turbo tape whose deck was not running at speed.
//
// The format's two symbols are 216 and 328 cycles and the bit threshold sits
// between them at 272. That works while the deck is near speed — the tapes this
// was built against are within 4% — but the threshold is nailed to the nominal
// figures while the widths are not: a deck 20% fast writes 173 and 262, and
// *both* fall below 272, so every bit reads as a zero and the tape decodes to
// nothing whatsoever. A deck 30% slow does the same in the other direction.
//
// So the threshold is also derived from the pulses themselves, and the reading
// that hands over more files that pass their checksum wins. These assertions pin
// that: off-speed tapes read, tapes at speed are unaffected, and a tape of some
// other format still yields nothing rather than inventing files.
import { turboTape64Files, renderTurboTape64Block } from '../src/tap-turbo-formats.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

/** A tape holding two files, written at whatever speed the deck was running. */
function tapeAt(zero, one) {
  const widths = { zero, one };
  const out = [];
  const bits = (v) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? one : zero); };
  const withSum = (bytes) => { let x = 0; for (const b of bytes) x ^= b; return [...bytes, x]; };
  const leadIn = (n) => { for (let i = 0; i < n; i++) bits(0x02); };

  for (const [name, start, size] of [['FIRST', 0x0801, 400], ['SECOND', 0x4000, 250]]) {
    const end = start + size - 1;
    const padded = (name + '                ').slice(0, 16);
    const header = withSum([1, start & 255, start >> 8, end & 255, end >> 8, 0,
      ...[...padded].map(c => c.charCodeAt(0))]);
    const body = withSum(Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xFF));
    leadIn(600);
    for (const c of renderTurboTape64Block(header, widths)) out.push(c);
    out.push(40000);
    leadIn(600);
    for (const c of renderTurboTape64Block(body, widths)) out.push(c);
    out.push(200000);
  }
  return out;
}

/** One file whose header carries the given type byte. */
function tapeOfType(type) {
  const out = [];
  const bits = (v) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? 328 : 216); };
  const withSum = (bytes) => { let x = 0; for (const b of bytes) x ^= b; return [...bytes, x]; };
  const leadIn = (n) => { for (let i = 0; i < n; i++) bits(0x02); };
  const start = 0x0801, size = 200, end = start + size - 1;
  const header = withSum([type, start & 255, start >> 8, end & 255, end >> 8, 0,
    ...[...'TYPED           '].map(c => c.charCodeAt(0))]);
  const body = withSum(Array.from({ length: size }, (_, i) => (i * 13 + 5) & 0xFF));
  leadIn(600);
  for (const c of renderTurboTape64Block(header, { zero: 216, one: 328 })) out.push(c);
  out.push(40000);
  leadIn(600);
  for (const c of renderTurboTape64Block(body, { zero: 216, one: 328 })) out.push(c);
  out.push(200000);
  return out;
}

const namesOf = (pulses) => turboTape64Files(pulses).map(f => f.name.trim());
const soundOf = (pulses) => turboTape64Files(pulses).filter(f => f.data && f.data.checksumOk).map(f => f.name.trim());

// ── At speed, as before ──────────────────────────────────────────────────────
{
  const pulses = tapeAt(216, 328);
  ok(namesOf(pulses).join() === 'FIRST,SECOND', `a tape at speed lists its files, got ${namesOf(pulses)}`);
  ok(soundOf(pulses).join() === 'FIRST,SECOND', `and both check out, got ${soundOf(pulses)}`);
}

// ── A deck running fast: both symbols fall below the nominal threshold ───────
{
  const zero = Math.round(216 * 0.8), one = Math.round(328 * 0.8);   // 173 / 262
  ok(one < 272, `the premise: ${one} is below the nominal threshold`);
  const pulses = tapeAt(zero, one);
  ok(soundOf(pulses).join() === 'FIRST,SECOND',
    `a tape 20% fast still reads, got ${JSON.stringify(soundOf(pulses))}`);
}

// ── A deck running slow: both symbols land above it ─────────────────────────
{
  const zero = Math.round(216 * 1.3), one = Math.round(328 * 1.3);   // 281 / 426
  ok(zero > 272, `the premise: ${zero} is above the nominal threshold`);
  const pulses = tapeAt(zero, one);
  ok(soundOf(pulses).join() === 'FIRST,SECOND',
    `a tape 30% slow still reads, got ${JSON.stringify(soundOf(pulses))}`);
}

// ── Far off in both directions ───────────────────────────────────────────────
for (const factor of [0.7, 0.85, 1.15, 1.45]) {
  const pulses = tapeAt(Math.round(216 * factor), Math.round(328 * factor));
  ok(soundOf(pulses).join() === 'FIRST,SECOND',
    `a tape at ${(factor * 100) | 0}% of speed reads, got ${JSON.stringify(soundOf(pulses))}`);
}

// ── The clones' own timings ──────────────────────────────────────────────────
// Not a deck running off speed — a tool that retimed the format. Both measured
// by saving the same payload with the real program (see the note in
// src/tap-turbo-formats.js). These read at the nominal threshold and must go on
// doing so: the measured one is a fallback, not the first answer.
for (const [zero, one, who] of [[232, 344, 'GWC Turbo 2'], [224, 328, 'Turbo 2002']]) {
  const pulses = tapeAt(zero, one);
  ok(soundOf(pulses).join() === 'FIRST,SECOND',
    `${who}'s ${zero}/${one} reads, got ${JSON.stringify(soundOf(pulses))}`);
}

// ── A type byte of 2 is a file too ───────────────────────────────────────────
{
  // The Turbo 250 family writes $02 where the rest write $01, and its tapes load
  // on hardware. Narrowing this to "1" would lose three of the tools measured.
  ok(turboTape64Files(tapeOfType(2)).length === 1, 'a header with type $02 lists');
  ok(turboTape64Files(tapeOfType(4)).length === 0, 'and one with type $04 does not');
}

// ── Another format is still not this one ─────────────────────────────────────
{
  // The KERNAL's three widths, in its own pattern. Nothing here is a Turbo Tape
  // 64 file, and a threshold derived from these pulses must not invent one.
  const out = [];
  const SYM = [0x30 * 8, 0x42 * 8, 0x56 * 8];
  for (let i = 0; i < 20000; i++) out.push(SYM[i % 3]);
  ok(turboTape64Files(out).length === 0, `a KERNAL tape yields no turbo files, got ${turboTape64Files(out).length}`);
}

// ── Too little to judge by ───────────────────────────────────────────────────
{
  // A handful of pulses says nothing about where the clusters are; the nominal
  // threshold has to carry it, and nothing may crash.
  ok(turboTape64Files([216, 328, 216, 328]).length === 0, 'a few pulses yield nothing');
  ok(turboTape64Files([]).length === 0, 'and neither does an empty tape');
}

if (failures) {
  console.error(`\n${failures} turbo threshold assertion(s) failed`);
  process.exit(1);
}
console.log('turbo threshold spec: PASS');
