// Recovering a tape from a recording must not depend on which way up the
// recording is. A C64 tape's half-cycles are not equal halves, so pairing edges
// on the wrong polarity pairs the second half of one symbol with the first half
// of the next: every width lands between two real ones and no pulse comes out
// long enough for the KERNAL's byte marker. The tape still starts loading, and
// the header decodes to garbage.
import { wavToTap } from '../src/wav-tape.js';
import { PAL_CPU_HZ } from '../src/tap-audio.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const RATE = 44100;
const CYCLES_PER_SAMPLE = PAL_CPU_HZ / RATE;

// 8-bit unsigned mono PCM, the shape a sound card writes when digitising a deck.
function buildWav(samples) {
  const n = samples.length;
  const b = new Uint8Array(44 + n);
  const dv = new DataView(b.buffer);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + n, true); ascii(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);        // PCM
  dv.setUint16(22, 1, true);        // mono
  dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE, true);
  dv.setUint16(32, 1, true);        // block align
  dv.setUint16(34, 8, true);        // bits
  ascii(36, 'data'); dv.setUint32(40, n, true);
  b.set(samples, 44);
  return b;
}

// Lay a tape down as a square wave with DELIBERATELY unequal halves, which is
// what makes polarity matter. `high` samples at the top, `low` at the bottom.
function render(symbols, invert) {
  const out = [];
  for (const [high, low] of symbols) {
    for (let i = 0; i < high; i++) out.push(invert ? 0 : 255);
    for (let i = 0; i < low; i++) out.push(invert ? 255 : 0);
  }
  return Uint8Array.from(out);
}

function tapPulses(tap) {
  const out = [];
  for (let i = 20; i < tap.length; ) {
    const b = tap[i];
    if (b !== 0) { out.push(b * 8); i++; }
    else { out.push(tap[i + 1] | (tap[i + 2] << 8) | (tap[i + 3] << 16)); i += 4; }
  }
  return out;
}

// Three symbols with unequal halves, the shorter half leading — roughly the
// proportions a real recording of the KERNAL's short/medium/long shows.
const SHORT = [7, 10], MEDIUM = [10, 14], LONG = [13, 18];
const SEQ = [];
for (let i = 0; i < 40; i++) SEQ.push(SHORT, MEDIUM, SHORT, LONG, MEDIUM, MEDIUM, LONG, SHORT);

const upright = tapPulses(wavToTap(buildWav(render(SEQ, false))).tap);
const flipped = tapPulses(wavToTap(buildWav(render(SEQ, true))).tap);

expect(upright.length > 100, `recovered a usable number of pulses (got ${upright.length})`);

// The reading must be identical whichever way up the recording is.
expect(
  upright.length === flipped.length,
  `both polarities recover the same pulse count (${upright.length} vs ${flipped.length})`,
);
const mismatched = upright.filter((v, i) => v !== flipped[i]).length;
expect(
  mismatched === 0,
  `both polarities recover identical pulse widths (${mismatched} of ${upright.length} differ)`,
);

// And the widths must be the symbols that were laid down, not the halves of
// adjacent ones added together. Allow one sample of edge-detection slack.
const want = SEQ.map(([h, l]) => (h + l) * CYCLES_PER_SAMPLE);
const slack = CYCLES_PER_SAMPLE * 1.5;
// Mis-paired, these come out as low[i] + high[i+1] — a width that belongs to no
// symbol at all, and between two that do.
let offBy = 0;
for (let i = 0; i < upright.length; i++) {
  if (Math.abs(upright[i] - want[i]) > slack) offBy++;
}
expect(
  offBy === 0,
  `every recovered width matches the symbol laid down (${offBy} of ${upright.length} off by more than a sample)`,
);

// The distinguishing failure: mis-paired edges never produce the longest symbol,
// which is what the KERNAL uses to mark the start of a byte.
const longest = Math.max(...upright);
const wantLongest = (LONG[0] + LONG[1]) * CYCLES_PER_SAMPLE;
expect(
  Math.abs(longest - wantLongest) <= slack,
  `the longest symbol survives (${longest.toFixed(0)} cycles, expected ~${wantLongest.toFixed(0)})`,
);

// Three symbols in, three distinct widths out — mis-pairing smears them into
// roughly twice as many.
const distinct = new Set(upright.map(c => Math.round(c / 8))).size;
expect(
  distinct <= 4,
  `three symbols recover as at most four quantised widths (got ${distinct})`,
);


// ── Two recordings on one tape, the second the other way up ──────────────────
// A home tape holds what several decks wrote, and two decks need not agree on
// which way up a wave goes. One pairing for the whole tape then reads one
// recording and garbles the other, so the pairing is chosen per stretch between
// long silences — when the stretch holds enough pulses to be sure of it.
{
  const LONGSEQ = [];
  for (let i = 0; i < 300; i++) LONGSEQ.push(SHORT, MEDIUM, SHORT, LONG, MEDIUM, MEDIUM, LONG, SHORT);
  const silence = new Uint8Array(Math.round(RATE * 1.5)).fill(128);     // 8-bit unsigned: the centre
  const twoWays = Uint8Array.from([...render(LONGSEQ, false), ...silence, ...render(LONGSEQ, true)]);
  const widths = tapPulses(wavToTap(buildWav(twoWays)).tap);

  const symbols = [SHORT, MEDIUM, LONG].map(([h, l]) => (h + l) * CYCLES_PER_SAMPLE);
  const isSymbol = (c) => symbols.some(w => Math.abs(c - w) <= slack);
  const gapAt = widths.findIndex(c => c > RATE);                          // the silence, in cycles, is far longer
  expect(gapAt > 0, 'the silence between the two recordings is one long pulse');
  const before = widths.slice(0, gapAt), after = widths.slice(gapAt + 1);
  // Each half is one symbol per pulse laid down, give or take one at the seams.
  expect(before.filter(isSymbol).length >= LONGSEQ.length - 2,
    `the upright recording reads (${before.filter(isSymbol).length} of ${LONGSEQ.length} symbols)`);
  expect(after.filter(isSymbol).length >= LONGSEQ.length - 2,
    `and so does the inverted one after it (${after.filter(isSymbol).length} of ${LONGSEQ.length} symbols)`);
}

console.log('ok  - wav tape recovery is independent of recording polarity');
