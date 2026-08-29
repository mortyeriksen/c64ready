// Reading a worn tape, and mending what it can prove.
//
// Two things are asserted here, both taken from real transfers of 1980s tapes:
//
//  1. A played-back tape does not hold its shape. The head differentiates the
//     signal and any azimuth error skews it, so a wave's two halves stop being
//     equal — on the tapes this was measured against, one half ran 156 cycles
//     against the other's 290. The reading has to survive that.
//  2. The KERNAL writes every block twice and reads both before it returns, so a
//     transfer that loses the tail of the repeat copy leaves the data in memory
//     and then hangs or errors. The first copy carries a checksum, and a checksum
//     that adds up is proof — so the repeat is written again from it.
import { wavToTap } from '../src/wav-tape.js';
import { repairTape } from '../src/tap-repair.js';
import { tapDirectory } from '../src/tap-directory.js';
import { PAL_CPU_HZ } from '../src/tap-audio.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

const RATE = 44100;
const SAMPLES_PER_CYCLE = RATE / PAL_CPU_HZ;

// The KERNAL's three symbols, in cycles.
const SYM = { S: 0x30 * 8, M: 0x42 * 8, L: 0x56 * 8 };

// Lay a symbol down as a wave whose halves are deliberately unequal — `skew` is
// the first half's share of it. A clean signal is 0.5; a worn tape is not.
function renderSymbol(out, cycles, skew) {
  const total = Math.round(cycles * SAMPLES_PER_CYCLE);
  const first = Math.max(1, Math.round(total * skew));
  for (let i = 0; i < first; i++) out.push(220);
  for (let i = first; i < total; i++) out.push(36);
}

function encodeByte(sym, value) {
  sym.push('L', 'M');
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    sym.push(one ? 'M' : 'S', one ? 'S' : 'M');
  }
  sym.push(parity ? 'M' : 'S', parity ? 'S' : 'M');
}
/** One byte with a data bit flipped but the parity of the byte that was written
 *  — what a single misread pulse leaves behind, and what marks it as known-bad. */
function encodeFlipped(sym, value, bit) {
  const wrong = value ^ (1 << bit);
  sym.push('L', 'M');
  let parity = 1;
  for (let b = 0; b < 8; b++) {
    const one = (wrong >> b) & 1;
    parity ^= (value >> b) & 1;                    // the parity the tape carries
    sym.push(one ? 'M' : 'S', one ? 'S' : 'M');
  }
  sym.push(parity ? 'M' : 'S', parity ? 'S' : 'M');
}

function encodeBlock(sym, payload, pilot, sync, flips = []) {
  for (let i = 0; i < pilot; i++) sym.push('S');
  for (let v = sync; v >= sync - 8; v--) encodeByte(sym, v);
  let sum = 0;
  payload.forEach((b, i) => {
    sum ^= b;                                      // the checksum is of what was written
    const flip = flips.find(f => f.at === i);
    if (flip) encodeFlipped(sym, b, flip.bit); else encodeByte(sym, b);
  });
  encodeByte(sym, sum);
  sym.push('L');
  for (let i = 0; i < 60; i++) sym.push('S');
}

// A dropout takes the signal away for a moment, and with it both the bytes and
// the pulses they sat in — which is why the two copies of a block cannot be
// lined up by counting anything. Each byte is 20 symbols; the countdown is 9 of
// them, and the pilot comes first.
function dropout(sym, holes) {
  for (const { at, bytes } of holes || []) sym.splice(200 + 9 * 20 + at * 20, bytes * 20);
}

function buildWav(samples) {
  const n = samples.length;
  const b = new Uint8Array(44 + n);
  const dv = new DataView(b.buffer);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + n, true); ascii(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  ascii(36, 'data'); dv.setUint32(40, n, true);
  b.set(samples, 44);
  return b;
}

// A file on tape: header twice, data twice — with the repeat cut short by
// `lose` bytes, the way a transfer clips the tail of the last block.
function tapeOf({ name, start, body, skew, lose = 0, gaps = {}, flips = {} }) {
  const header = new Uint8Array(192).fill(0x20);
  const end = start + body.length;
  header[0] = 0x03;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < name.length; i++) header[5 + i] = name.charCodeAt(i);

  const sym = [];
  encodeBlock(sym, header, 600, 0x89);
  encodeBlock(sym, header, 200, 0x09);
  const one = [];
  encodeBlock(one, body, 200, 0x89, flips.first);
  dropout(one, gaps.first);
  sym.push(...one);
  const cut = [];
  encodeBlock(cut, lose ? body.slice(0, body.length - lose) : body, 200, 0x09, flips.repeat);
  if (lose) cut.length = cut.length - 62;             // and its end marker with it
  dropout(cut, gaps.repeat);
  sym.push(...cut);

  const samples = [];
  // A skew that wanders, as a stretched tape's does.
  let s = skew;
  for (const k of sym) {
    s = skew + (s > skew ? -0.04 : 0.04);
    renderSymbol(samples, SYM[k], s);
  }
  return buildWav(Uint8Array.from(samples));
}

const BODY = new Uint8Array(300);
for (let i = 0; i < BODY.length; i++) BODY[i] = (i * 37 + 11) & 0xFF;

// ── A skewed recording still reads ───────────────────────────────────────────
{
  const { tap, pulses } = wavToTap(tapeOf({ name: 'SKEWED', start: 0x0801, body: BODY, skew: 0.36 }));
  assert(pulses > 1000, `a skewed recording yields pulses (${pulses})`);
  const r = repairTape(tap);
  assert(r.files.length === 1, `one file found (${r.files.length})`);
  assert(r.files[0]?.name === 'SKEWED', `named "${r.files[0]?.name}"`);
  assert(r.files[0]?.state === 'good', `both copies read from a skewed tape (state ${r.files[0]?.state})`);
  assert(r.repaired.length === 0 && r.damaged.length === 0, 'and nothing needed mending');
}

// ── A clipped repeat copy is written again from the first ────────────────────
{
  const wav = tapeOf({ name: 'CLIPPED', start: 0x0801, body: BODY, skew: 0.36, lose: 40 });
  const { tap } = wavToTap(wav);
  const before = repairTape(tap);
  assert(before.files[0]?.state === 'repairable',
    `the clipped copy is spotted (state ${before.files[0]?.state})`);
  assert(before.repaired.includes('CLIPPED'), 'and named as repaired');
  assert(before.tap !== tap, 'a mended tape comes back');

  // Mending is idempotent, and the mended tape has two sound copies.
  const after = repairTape(before.tap);
  assert(after.files[0]?.state === 'good', `the mended tape reads clean (state ${after.files[0]?.state})`);
  assert(after.repaired.length === 0, 'and needs no second pass');
  assert(after.tap === before.tap, 'so it is left alone');
  assert(tapDirectory(before.tap.subarray(20), { version: before.tap[12] })[0]?.damaged === false,
    'and the listing no longer marks it');
}

// ── A wrecked stretch in the first copy, mended from the second ──────────────
{
  const wav = tapeOf({ name: 'GONE', start: 0x0801, body: BODY, skew: 0.36, lose: 40 });
  const { tap } = wavToTap(wav);
  // The repeat copy is already clipped; now wreck a stretch of the first one.
  const wrecked = Uint8Array.from(tap);
  for (let i = 20 + Math.floor((tap.length - 20) * 0.45); i < 20 + Math.floor((tap.length - 20) * 0.5); i++) {
    wrecked[i] = 0x11;
  }
  const r = repairTape(wrecked);
  assert(r.files[0]?.state === 'merged', `neither copy alone, but together (state ${r.files[0]?.state})`);
  assert(repairTape(r.tap).files[0]?.state === 'good', 'and the mended tape reads clean');
}

// ── Two copies, each missing bytes the other has ─────────────────────────────
{
  // Dropouts in different places, so neither copy checks out on its own. Nothing
  // in either stream says how many bytes went missing — the gap swallowed their
  // pulses too — so the copies have to be lined up against each other.
  const wav = tapeOf({
    name: 'DROPOUT', start: 0x0801, body: BODY, skew: 0.36,
    gaps: { first: [{ at: 60, bytes: 2 }], repeat: [{ at: 180, bytes: 3 }] },
  });
  const { tap } = wavToTap(wav);
  const r = repairTape(tap);
  assert(r.files[0]?.state === 'merged',
    `two half-good copies make one file (state ${r.files[0]?.state})`);
  assert(r.repaired.includes('DROPOUT'), 'and it is named as repaired');

  const after = repairTape(r.tap);
  assert(after.files[0]?.state === 'good', `the merged tape reads clean (state ${after.files[0]?.state})`);
  assert(after.repaired.length === 0, 'and needs no second pass');
}

// ── Each copy has a bad byte where the other has a good one ──────────────────
{
  // A misread pulse leaves a byte wrong and its parity failing, so the tape says
  // which byte not to trust. Neither copy adds up alone; taking the sound byte
  // from whichever copy still has it makes the file.
  const wav = tapeOf({
    name: 'PARITY', start: 0x0801, body: BODY, skew: 0.36,
    flips: { first: [{ at: 50, bit: 3 }], repeat: [{ at: 200, bit: 5 }] },
  });
  const { tap } = wavToTap(wav);
  const r = repairTape(tap);
  assert(r.files[0]?.state === 'merged',
    `complementary parity errors are merged (state ${r.files[0]?.state})`);
  assert(r.repaired.includes('PARITY'), 'and the file is named as repaired');

  const after = repairTape(r.tap);
  assert(after.files[0]?.state === 'good', `the mended tape reads clean (state ${after.files[0]?.state})`);
  assert(tapDirectory(r.tap.subarray(20), { version: r.tap[12] })[0]?.damaged === false,
    'and the listing no longer marks it');
}

// ── A hole in both copies at once cannot be filled ───────────────────────────
{
  const wav = tapeOf({
    name: 'BOTHGONE', start: 0x0801, body: BODY, skew: 0.36,
    gaps: { first: [{ at: 120, bytes: 3 }], repeat: [{ at: 120, bytes: 3 }] },
  });
  const { tap } = wavToTap(wav);
  const r = repairTape(tap);
  assert(r.files[0]?.state === 'damaged', `it stays damaged (state ${r.files[0]?.state})`);
  assert(r.damaged.includes('BOTHGONE'), 'and is named as damaged');
  assert(r.tap === tap, 'the tape is left as it was');

  // It is still listed — nothing is removed — but the listing says what it is,
  // reading the tape rather than being told: neither copy adds up.
  const listed = tapDirectory(tap.subarray(20), { version: tap[12] });
  assert(listed.length === 1, `the damaged file is still listed (${listed.length})`);
  assert(listed[0]?.damaged === true, 'and marked damaged');
}

if (failures) {
  console.error(`\n${failures} wav tape repair assertion(s) failed`);
  process.exit(1);
}
console.log('wav tape repair spec: PASS');
