// Spec test for reading a tape's contents (src/tap-directory.js).
//
// A .tap is a bare pulse stream with no index, so the only way to say what is on
// it is to decode it the way the KERNAL does and pick out the header blocks.
// These tapes are built here from the documented encoding — the same rules the
// load test uses — so the parser is measured against the format, not against
// itself:
//   short/medium/long = $30/$42/$56 units; 0 = S/M, 1 = M/S
//   byte frame = long/medium marker, 8 bits LSB first, odd parity bit
//   a block is a pilot, the $89…$81 countdown ($09…$01 for the repeat),
//   the payload and its XOR checksum
//   a header block is 192 bytes: type, start lo/hi, end lo/hi, 16-byte name
import { tapDirectory, tapeFacts } from '../src/tap-directory.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const S = 0x30, M = 0x42, L = 0x56;

function encodeByte(out, value) {
  out.push(L, M);
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    out.push(one ? M : S, one ? S : M);
  }
  out.push(parity ? M : S, parity ? S : M);
}

function encodeBlock(out, payload, pilot, syncStart, spoilSum = 0) {
  for (let i = 0; i < pilot; i++) out.push(S);
  for (let v = syncStart; v >= syncStart - 8; v--) encodeByte(out, v);
  let checksum = 0;
  for (const b of payload) { checksum ^= b; encodeByte(out, b); }
  encodeByte(out, checksum ^ spoilSum);
  out.push(L);
  for (let i = 0; i < 60; i++) out.push(S);
}

// One file: header written twice, then its data written twice. `claim` writes an
// end address the body does not reach, which is what a loader stub does when it
// means to fill the rest of the range itself.
function encodeFile(out, { name, start, body, type = 0x03, claim = null,
                          spoilSum = 0, spoilSecondCopy = null }) {
  const header = new Uint8Array(192).fill(0x20);
  const end = claim ?? (start + body.length);
  header[0] = type;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < Math.min(16, name.length); i++) header[5 + i] = name.charCodeAt(i) & 0xFF;
  encodeBlock(out, header, 0x2000, 0x89);
  encodeBlock(out, header, 0x0400, 0x09);
  encodeBlock(out, body, 0x0400, 0x89, spoilSum);
  encodeBlock(out, spoilSecondCopy ?? body, 0x0400, 0x09, spoilSum);
}

const tapOf = pulses => Uint8Array.from(pulses);

// ── One program ──────────────────────────────────────────────────────────────
{
  const p = [];
  encodeFile(p, { name: 'HELLO', start: 0x0801, body: new Uint8Array(40).fill(0xAA) });
  const files = tapDirectory(tapOf(p));
  eq(files.length, 1, 'one file on the tape');
  eq(files[0].name, 'HELLO', 'the name comes back');
  eq(files[0].start, 0x0801, 'and the load address');
  eq(files[0].end, 0x0829, 'and the end address');
  eq(files[0].size, 40, 'so the size is the difference');
  eq(files[0].type, 'PRG', 'a non-relocatable program is a PRG');
  // The header is written twice; the repeat must not show up as a second file.
  assert(files.length === 1, 'the repeat copy is not a second file');
}

// ── Several, in the order they were written ─────────────────────────────────
{
  const p = [];
  encodeFile(p, { name: 'FIRST', start: 0x0801, body: new Uint8Array(16).fill(1) });
  encodeFile(p, { name: 'SECOND ONE', start: 0x1000, body: new Uint8Array(32).fill(2) });
  encodeFile(p, { name: 'THIRD', start: 0xC000, body: new Uint8Array(8).fill(3), type: 0x01 });
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => f.name), ['FIRST', 'SECOND ONE', 'THIRD'], 'every file, in tape order');
  eq(files.map(f => f.start), [0x0801, 0x1000, 0xC000], 'each with its own load address');
  eq(files[2].type, 'PRG', 'a relocatable program is a PRG too');
}

// ── A name that fills the field, and a padded one ───────────────────────────
{
  const p = [];
  encodeFile(p, { name: 'ABCDEFGHIJKLMNOP', start: 0x0801, body: new Uint8Array(4) });
  encodeFile(p, { name: 'A', start: 0x0801, body: new Uint8Array(4) });
  const files = tapDirectory(tapOf(p));
  eq(files[0].name, 'ABCDEFGHIJKLMNOP', 'a 16-character name is not truncated');
  eq(files[1].name, 'A', 'and a short one loses its padding');
}

// ── GRL-Supertape, the first turbo format ───────────────────────────────────
// Its own encoding, measured off tapes it wrote: one bit per pulse, ~170 cycles
// for a 0 and ~445 for a 1, MSB first, blocks introduced by a countdown from 32
// to 1, and a header of start/end addresses followed by the name. What follows
// the name is whatever the tape buffer held, which is why the name has to end
// itself — $8B here, as on a real one.
const GRL_0 = 0x15, GRL_1 = 0x37;                     // 168 and 440 cycles

function grlByte(out, value) {
  for (let bit = 7; bit >= 0; bit--) out.push((value >> bit) & 1 ? GRL_1 : GRL_0);
}
function grlBlock(out, payload) {
  for (let i = 0; i < 200; i++) out.push(GRL_0);      // lead-in
  for (let v = 32; v >= 1; v--) grlByte(out, v);
  for (const b of payload) grlByte(out, b);
}
function grlFile(out, { name, start, body }) {
  const end = start + body.length;
  const header = [start & 0xFF, start >> 8, end & 0xFF, end >> 8];
  for (const ch of name) header.push(ch.charCodeAt(0) & 0xFF);
  header.push(0x8B, 0xE3, 0x83, 0xA4, 0x7C, 0xA5);    // the buffer remains
  grlBlock(out, header);
  grlBlock(out, body);
}

{
  const p = [];
  grlFile(p, { name: 'BIG', start: 0x0801, body: new Uint8Array(600).fill(0x5A) });
  const files = tapDirectory(tapOf(p));
  eq(files.length, 1, 'a GRL tape lists its file');
  eq(files[0].name, 'BIG', 'with the name it was saved under');
  eq(files[0].start, 0x0801, 'the load address');
  eq(files[0].size, 600, 'and the size from the address pair');
  eq(files[0].format, 'GRL-Supertape', 'tagged with the format it came from');
}

{
  // Names of every length: nothing pads them, so the end has to be found.
  const p = [];
  grlFile(p, { name: 'A', start: 0x0801, body: new Uint8Array(64).fill(1) });
  grlFile(p, { name: 'ABCD', start: 0x1000, body: new Uint8Array(64).fill(2) });
  grlFile(p, { name: 'ABCDEFGHIJKLMNOP', start: 0xC000, body: new Uint8Array(64).fill(3) });
  eq(tapDirectory(tapOf(p)).map(f => f.name), ['A', 'ABCD', 'ABCDEFGHIJKLMNOP'],
    'one, four and sixteen characters all come back whole');
}

{
  // The data block is not a second file, however its bytes happen to read.
  const p = [];
  const body = new Uint8Array(64);
  for (let i = 0; i < 64; i++) body[i] = 0x41 + (i % 26);   // data that looks like a name
  grlFile(p, { name: 'ONLYONE', start: 0x0801, body });
  eq(tapDirectory(tapOf(p)).map(f => f.name), ['ONLYONE'], 'the data block names nothing');
}

{
  // Both kinds on one tape, in the order they were written.
  const p = [];
  encodeFile(p, { name: 'KERNAL ONE', start: 0x0801, body: new Uint8Array(16).fill(7) });
  grlFile(p, { name: 'TURBO', start: 0x1000, body: new Uint8Array(64).fill(8) });
  encodeFile(p, { name: 'KERNAL TWO', start: 0x2000, body: new Uint8Array(16).fill(9) });
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => f.name), ['KERNAL ONE', 'TURBO', 'KERNAL TWO'],
    'a mixed tape lists both kinds in tape order');
  eq(files.map(f => f.format), ['CBM', 'GRL-Supertape', 'CBM'], 'each tagged with its own format');
}

// ── Turbo Tape 64, which six of these programs turned out to write ──────────
// Measured off tapes written by GRL-Turbotape II/V2/V.3, M.J-Turbotape, Flash
// Turbo-Tape ABC and Super Tape Turbo (CCS), and matching the format's own
// published description: 216 cycles for a 0 and 328 for a 1, no parity, a
// countdown from 9, and the CBM header with a spare byte before a 16-byte name
// padded with spaces — where GRL's Supertape a year later pads nothing.
let TT_0v = 0x1B, TT_1v = 0x29;                       // 216 and 328 cycles

function ttByte(out, value) {
  for (let bit = 7; bit >= 0; bit--) out.push((value >> bit) & 1 ? TT_1v : TT_0v);
}
function ttBlock(out, payload) {
  for (let i = 0; i < 200; i++) out.push(TT_0v);
  for (let v = 9; v >= 1; v--) ttByte(out, v);
  for (const b of payload) ttByte(out, b);
}
function ttFile(out, { name, start, body }) {
  const end = start + body.length;
  const header = [1, start & 0xFF, start >> 8, end & 0xFF, end >> 8, 0];
  for (let i = 0; i < 16; i++) header.push(i < name.length ? name.charCodeAt(i) & 0xFF : 0x20);
  ttBlock(out, header);
  ttBlock(out, body);
}

{
  const p = [];
  ttFile(p, { name: 'GAMMA', start: 0x0801, body: new Uint8Array(600).fill(0x33) });
  const files = tapDirectory(tapOf(p));
  eq(files.length, 1, 'a Turbo Tape 64 tape lists its file');
  eq(files[0].name, 'GAMMA', 'with the padding trimmed off the name');
  eq(files[0].size, 600, 'and the size from its addresses');
  eq(files[0].format, 'Turbo Tape 64', 'tagged as Turbo Tape 64');
}

{
  // Clones retime the format: GWC Turbo 2 writes 232 and 344 cycles where the
  // others write 216 and 328. Both sides of that have to read, which is what
  // keeps the threshold where it is.
  for (const [zero, one, who] of [[0x1B, 0x29, 'the original timing'],
                                  [0x1D, 0x2B, "GWC Turbo 2's wider pulses"]]) {
    const p = [];
    const save0 = TT_0v, save1 = TT_1v;
    TT_0v = zero; TT_1v = one;
    ttFile(p, { name: 'RETIMED', start: 0x0801, body: new Uint8Array(64).fill(4) });
    TT_0v = save0; TT_1v = save1;
    eq(tapDirectory(tapOf(p)).map(f => f.name), ['RETIMED'], `${who} reads`);
  }
}

{
  // Three formats on one tape, each recognised by its own entry and none by
  // another's — the widths and countdowns differ, which is what keeps them apart.
  const p = [];
  encodeFile(p, { name: 'KERNAL', start: 0x0801, body: new Uint8Array(16).fill(7) });
  grlFile(p, { name: 'SUPER', start: 0x1000, body: new Uint8Array(64).fill(8) });
  ttFile(p, { name: 'TURBO', start: 0x2000, body: new Uint8Array(64).fill(9) });
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => f.name), ['KERNAL', 'SUPER', 'TURBO'], 'all three list, in tape order');
  eq(files.map(f => f.format), ['CBM', 'GRL-Supertape', 'Turbo Tape 64'],
    'and no format claims another\'s blocks');
}

// ── Nothing to find ─────────────────────────────────────────────────────────
{
  eq(tapDirectory(new Uint8Array(0)), [], 'an empty tape has no files');
  eq(tapDirectory(null), [], 'and neither does no tape at all');
  // A format nobody here knows must still read as nothing rather than as
  // garbage files.
  const unknown = [];
  for (let i = 0; i < 20000; i++) unknown.push(i % 2 ? 0x1D : 0x31);
  eq(tapDirectory(tapOf(unknown)), [], 'an unknown turbo format lists nothing');
  // Nor is pure noise.
  const noise = [];
  let seed = 12345;
  for (let i = 0; i < 20000; i++) { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; noise.push(0x20 + (seed % 0x60)); }
  eq(tapDirectory(tapOf(noise)), [], 'and noise names nothing');
}

// ── What the listing could not account for ───────────────────────────────────
{
  const p = [];
  encodeFile(p, { name: 'HELLO', start: 0x0801, body: new Uint8Array(400).fill(0xAA) });
  const clean = tapeFacts(tapOf(p));
  assert(clean.unread < 1, `a tape whose every file is listed has nothing unread, got ${clean.unread}`);

  // The same tape with a loader nobody here knows written after it. The file is
  // still listed, and the stretch that could not be read is reported rather than
  // passed over — which is what lets a listing that seems to stop halfway
  // through explain itself instead of looking broken.
  const withOther = p.slice();
  for (let i = 0; i < 200000; i++) withOther.push(i % 2 ? 0x1D : 0x31);
  const facts = tapeFacts(tapOf(withOther));
  eq(facts.files, 1, 'the unknown stretch adds no files');
  assert(facts.unread > 50, `and is reported as unread, got ${facts.unread.toFixed(1)} s`);
}
{
  // A stub that claims a range far past what it wrote — Head Over Heels claims
  // 713 bytes and carries 636. A file stops where its bytes stop being
  // consecutive on the tape, not where its header says: counting the claimed
  // length off a short block ran into whatever followed and swallowed it, which
  // hid three unread minutes of another loader inside a 3 KB KERNAL file.
  const p = [];
  encodeFile(p, { name: 'STUB', start: 0x0801, body: new Uint8Array(100).fill(0x55), claim: 0x1601 });
  // The loader's own format, as one of the tapes here writes it: two widths that
  // read as short and long, with the odd pulse landing in the middle band. Those
  // stray ones frame the occasional byte, which is what carried the byte stream
  // on past the stub and let it claim the rest of the tape.
  let seed = 7;
  for (let i = 0; i < 200000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    p.push((seed >> 7) % 19 === 0 ? 0x45 : ((seed >> 3) & 1 ? 0x26 : 0x57));
  }
  // And a KERNAL file after it. This is what made the fault bite: nothing in the
  // stretch between decodes, so counting the stub's claimed length through the
  // byte stream skipped it entirely and landed in *this* file's blocks — putting
  // the whole unread stretch inside the stub.
  encodeFile(p, { name: 'NEXT', start: 0x0801, body: new Uint8Array(200).fill(0x33) });
  const facts = tapeFacts(tapOf(p));
  eq(facts.files, 2, 'the stub and the file past the stretch');
  assert(facts.unread > 50,
    `and does not claim the tape after it, got ${facts.unread.toFixed(1)} s unread`);
}

// ── One stretch of tape, one file ────────────────────────────────────────────
{
  // Six formats are asked the same question and they read the same bits: Turbo
  // Tape 64 splits at 272 cycles and GRL-Supertape at 300, so 216 and 328 mean
  // the same to both. A descending run inside one format's data is therefore
  // the other's countdown, and what follows it can look like a header. Measured
  // on a real tape: Tape 2 Side B listed a nineteenth file, a GRL-Supertape
  // claim named from four bytes of a Turbo Tape 64 payload, and said the tape
  // carried a format it does not.
  //
  // Comparing where two claims begin cannot see that, since the phantom starts
  // well inside the real file. Comparing what they cover can.
  const ZERO = 27, ONE = 41;                        // 216 and 328 cycles, in TAP units
  const bits = (out, v) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? ONE : ZERO); };
  const p = [];
  const turbo = (payload) => {
    for (let i = 0; i < 200; i++) bits(p, 0x02);
    for (let v = 9; v >= 1; v--) bits(p, v);
    let x = 0;
    for (const b of payload) { x ^= b; bits(p, b); }
    bits(p, x);
    for (let i = 0; i < 40; i++) p.push(255);
  };
  const start = 0x0801, size = 400, end = start + size - 1;
  const name = [...'REAL            '].map(c => c.charCodeAt(0));
  turbo([1, start & 255, start >> 8, end & 255, end >> 8, 0, ...name]);
  // A whole GRL-Supertape block, written into the middle of this one's payload:
  // its countdown from 32, an address pair that runs forwards, and a name.
  const grl = [];
  for (let v = 32; v >= 1; v--) grl.push(v);
  grl.push(0x00, 0x10, 0x00, 0x20, ...[...'FAKE'].map(c => c.charCodeAt(0)), 0x8B);
  const payload = Array.from({ length: size + 1 }, (_, i) => (i * 7) & 0xFF);
  payload.splice(80, grl.length, ...grl);
  turbo(payload);
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => [f.format, f.name]), [['Turbo Tape 64', 'REAL']],
     'a block misread by another format does not become a second file');
  eq(tapeFacts(tapOf(p)).formats, ['Turbo Tape 64'],
     'and the tape does not claim a format it only appears to carry');
}
{
  // And the rule does not merge files that merely follow one another. Two
  // KERNAL files back to back stay two.
  const p = [];
  encodeFile(p, { name: 'FIRST', start: 0x0801, body: new Uint8Array(60).fill(0x11) });
  encodeFile(p, { name: 'SECOND', start: 0x0801, body: new Uint8Array(60).fill(0x22) });
  eq(tapDirectory(tapOf(p)).map(f => f.name), ['FIRST', 'SECOND'],
     'files that abut are not one file');
}

// ── A checksum the tape itself got wrong ─────────────────────────────────────
{
  // The KERNAL writes every block twice, and tape damage does not fall in the
  // same place on both. So two copies agreeing to the byte is a stronger
  // statement about what the tape carries than its one checksum byte is, and a
  // stored checksum that disagrees with both of them is the master's arithmetic
  // being wrong rather than the oxide. The Goonies is such a tape: identical
  // copies, both XOR to $F9 against a stored $F7, and the real KERNAL loads it
  // with no ?LOAD ERROR.
  const p = [];
  encodeFile(p, { name: 'MASTERED', start: 0x02A7, body: new Uint8Array(168).fill(0x77),
                  spoilSum: 0x0E });
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => f.name), ['MASTERED'], 'the file lists');
  eq(files.map(f => f.damaged), [false],
     'two copies that agree are not a damaged file, whatever the checksum says');
}
{
  // And the rule does not blunt the real one: copies that disagree, neither of
  // which adds up, is damage and still reads as damage.
  const body = new Uint8Array(168).fill(0x77);
  const other = Uint8Array.from(body); other[40] ^= 0xFF;
  const p = [];
  encodeFile(p, { name: 'TORN', start: 0x02A7, body, spoilSum: 0x0E, spoilSecondCopy: other });
  eq(tapDirectory(tapOf(p)).map(f => f.damaged), [true],
     'copies that differ and do not add up are still damaged');
}

// ── Relocatable and absolute programs ────────────────────────────────────────
{
  // Header type 1 and type 3 are both programs and both list as PRG, but only a
  // type 3 lands at the address its header carries. A type 1 is relocatable: a
  // plain LOAD puts it at the BASIC start, and its addresses then say where it
  // was saved from and nothing about where it goes. Since the listing states
  // those addresses either way, the difference has to ride along beside them —
  // test/kernal-tape-relocatable-spec-test.js is where the real ROM settles what
  // the flag means.
  const p = [];
  encodeFile(p, { name: 'ABSOLUTE', start: 0xCC49, body: new Uint8Array(64).fill(0x11), type: 0x03 });
  encodeFile(p, { name: 'MOVES', start: 0xCC49, body: new Uint8Array(64).fill(0x22), type: 0x01 });
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => f.name), ['ABSOLUTE', 'MOVES'], 'both headers list');
  eq(files.map(f => f.type), ['PRG', 'PRG'], 'and both are programs');
  eq(files.map(f => f.relocatable), [false, true], 'only the type 1 is relocatable');
  eq(files.map(f => f.start), [0xCC49, 0xCC49], 'the listing states the header addresses either way');
}
{
  // Every other format on a tape writes to the address its own header names, so
  // the field is answered for all of them rather than left missing on most.
  const p = [];
  encodeFile(p, { name: 'KERNAL', start: 0x0801, body: new Uint8Array(40).fill(0xAA), type: 0x01 });
  // Turbo Tape 64's 216 and 328 cycles, in the TAP units this file builds in.
  const ZERO = 27, ONE = 41;
  const bits = (out, v) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? ONE : ZERO); };
  const turbo = (payload) => {
    for (let i = 0; i < 200; i++) bits(p, 0x02);
    for (let v = 9; v >= 1; v--) bits(p, v);
    let x = 0;
    for (const b of payload) { x ^= b; bits(p, b); }
    bits(p, x);
    for (let i = 0; i < 40; i++) p.push(255);        // silence, at 2040 cycles a pulse
  };
  const name = [...'TURBO           '].map(c => c.charCodeAt(0));
  turbo([1, 0x01, 0x08, 0x28, 0x08, 0, ...name]);
  turbo(Array.from({ length: 40 }, (_, i) => (i * 7) & 0xFF));
  const files = tapDirectory(tapOf(p));
  eq(files.map(f => f.format), ['CBM', 'Turbo Tape 64'], 'a tape of both kinds');
  eq(files.map(f => f.relocatable), [true, false], 'a turbo file is never relocatable');
}

if (failures) {
  console.error(`\n${failures} tape directory assertion(s) failed`);
  process.exit(1);
}
console.log('tap directory spec: PASS');
