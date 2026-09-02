// What counts as a file name in a turbo header, which decides what a tape lists.
//
// Both directions have cost a real tape. Too strict: Turbo Tape 64 pads its
// 16-byte name field with spaces and whatever the saver leaves after that is
// nobody's business — one tape here reads `DRUIDS␣␣␣␣␣.` followed by 80 80 81 19
// on one pass and 40 40 40 c8 on another, and a rule that rejected the byte
// range $80-$9F made a sound 44 KB program visible or invisible by coin toss.
// Too loose: GRL-Supertape pads nothing, so a byte of somebody else's data that
// happens to print passes as a name and lists a file that does not exist.
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}

const TT = { zero: 216, one: 328 };
const GRL = { zero: 170, one: 445 };

const bitsOf = (out, v, w) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? w.one : w.zero); };
const leadIn = (out, n, w) => { for (let i = 0; i < n; i++) bitsOf(out, 0x02, w); };

function block(out, payload, { widths, countdown, pilot = 400, badSum = false,
                              tailZero = false }) {
  leadIn(out, pilot, widths);
  for (let v = countdown; v >= 1; v--) bitsOf(out, v, widths);
  // A Turbo Tape 64 data block carries one more countdown byte than its header
  // does, a $00 between the $01 and the payload. Read off tapes written by six
  // different savers, on all of which it is there; the checksum covers it, and
  // the payload starts after it.
  if (tailZero) bitsOf(out, 0, widths);
  let sum = 0;
  for (const b of payload) { sum ^= b; bitsOf(out, b, widths); }
  bitsOf(out, badSum ? sum ^ 0xFF : sum, widths);
  out.push(80000);                                  // the gap that follows
}

/** A Turbo Tape 64 file whose 16-byte name field is given verbatim. */
function turboFile(out, field, { size = 300, badSum = false } = {}) {
  const start = 0x0801, end = start + size;        // one past the last byte, as on tape
  block(out, [1, start & 255, start >> 8, end & 255, end >> 8, 0, ...field],
    { widths: TT, countdown: 9 });
  const body = Array.from({ length: size }, (_, i) => (i * 7) & 0xFF);
  block(out, body, { widths: TT, countdown: 9, badSum, tailZero: true });
}

/**
 * A GRL-Supertape file, whose name runs until a byte that cannot be one.
 * `flat` fills the data block with zeros so that it cannot itself read as a
 * header — otherwise a rejected name leaves the data block to be claimed, which
 * is a separate fault and would mask what these cases are about.
 */
function grlFile(out, name, { size = 200, flat = false } = {}) {
  const start = 0x0801, end = start + size;
  block(out, [start & 255, start >> 8, end & 255, end >> 8, ...name,
    0x8B, 0xE3, 0x83, 0xA4], { widths: GRL, countdown: 32 });
  block(out, Array.from({ length: size }, (_, i) => (flat ? 0 : (i * 13) & 0xFF)),
    { widths: GRL, countdown: 32 });
}

function tapOf(pulses) {
  const body = [];
  for (const c of pulses) {
    const step = Math.round(c / 8);
    if (step >= 1 && step <= 255) body.push(step);
    else body.push(0, c & 255, (c >> 8) & 255, (c >> 16) & 255);
  }
  const tap = new Uint8Array(20 + body.length);
  for (let i = 0; i < 12; i++) tap[i] = 'C64-TAPE-RAW'.charCodeAt(i);
  tap[12] = 1;
  tap[16] = body.length & 255; tap[17] = (body.length >> 8) & 255; tap[18] = (body.length >> 16) & 255;
  tap.set(body, 20);
  return tap;
}
const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const listed = (pulses) => tapDirectory(tapOf(pulses)).map(f => f.name);

// ── Junk after the padding does not cost the file ────────────────────────────
{
  const p = [];
  turboFile(p, [...ascii('DRUIDS     .'), 0x80, 0x80, 0x81, 0x19]);
  eq(listed(p), ['DRUIDS'], 'a name padded with spaces survives unreadable bytes after it');
}
{
  const p = [];
  turboFile(p, [...ascii('DRUIDS     .'), 0x40, 0x40, 0x40, 0xC8]);
  eq(listed(p), ['DRUIDS'], 'and reads the same when that junk decodes differently');
}

// ── Ordinary names still read ────────────────────────────────────────────────
{
  const p = [];
  turboFile(p, ascii('MIKIE           '));
  eq(listed(p), ['MIKIE'], 'a space-padded name');
}
{
  const p = [];
  turboFile(p, ascii('FIST II(MAIN)C  '));
  eq(listed(p), ['FIST II(MAIN)C'], 'single spaces belong to the name');
}
{
  const p = [];
  turboFile(p, ascii('ABCDEFGHIJKLMNOP'));
  eq(listed(p), ['ABCDEFGHIJKLMNOP'], 'a name that fills the field');
}

// ── A field with no padding at all is not a name ─────────────────────────────
{
  // Letters running straight into an unreadable byte: another format's block
  // being read as this one's, which is exactly how a GRL header gets listed
  // twice. Nothing is claimed for it.
  const p = [];
  turboFile(p, [...ascii('LYONEABCDEFGHI'), 0x8B, 0xE3]);
  eq(listed(p), [], 'letters running into junk with no padding are not a name');
}

// ── A tape need not name its files ───────────────────────────────────────────
{
  // Sixteen spaces. A loader takes whatever comes next, so a magazine tape that
  // only ever loads from its own menu has no use for names — every one of the
  // twenty-one files on the ZZAP! Megatape here is written this way, and a rule
  // that wanted a name listed three of them.
  const p = [];
  turboFile(p, ascii('                '));
  eq(listed(p), [''], 'a file with a blank name field is listed');
}
{
  // And still listed when its block does not add up: a damaged file is struck
  // through, never dropped — dropping it leaves a minute of tape unexplained,
  // which is what a listing that seems to stop halfway through looks like.
  const p = [];
  turboFile(p, ascii('                '), { badSum: true });
  eq(listed(p), [''], 'a nameless file whose block fails is still listed');
  eq(tapDirectory(tapOf(p)).map(f => !!f.damaged), [true], 'and marked damaged');
}
{
  // What stands in for the name is the shape, and a header with no block behind
  // it has none of it left to check.
  const p = [];
  const start = 0x0801, end = start + 299;
  block(p, [1, start & 255, start >> 8, end & 255, end >> 8, 0, ...ascii('                ')],
    { widths: TT, countdown: 9 });
  eq(listed(p), [], 'a nameless header with no data block is not a file');
}
{
  const p = [];
  turboFile(p, ascii('   CENTRED      '));
  eq(listed(p), ['CENTRED'], 'padding in front of the name is padding too');
}

// ── GRL: a name, not a byte that happens to print ────────────────────────────
{
  const p = [];
  grlFile(p, ascii('BIG'));
  eq(listed(p), ['BIG'], 'a GRL name reads');
}
{
  const p = [];
  grlFile(p, ascii('A'));
  eq(listed(p), ['A'], 'and one character is a legal name');
}
{
  // A single graphics byte, which is what the head of a foreign data block looks
  // like — this listed a turbo file a second time as `û`.
  const p = [];
  grlFile(p, [0xFB], { flat: true });
  eq(listed(p), [], 'a graphics byte on its own is not a name');
}
{
  const p = [];
  grlFile(p, [0xFB, 0xA0, 0xE1], { flat: true });
  eq(listed(p), [], 'nor is a run of them');
}

if (failures) {
  console.error(`\n${failures} turbo name assertion(s) failed`);
  process.exit(1);
}
console.log('turbo name spec: PASS');
