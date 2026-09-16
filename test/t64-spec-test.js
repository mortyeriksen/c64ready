// Spec test for the .t64 archive reader (src/media/t64.js).
//
// A .t64 is an archive of decoded programs, not a tape: a 64-byte header, 32-
// byte directory entries, and each file's bytes at the offset its entry names.
// Every expectation below comes from that layout and from the two ways real
// archives break it — a used-entries count of zero on an archive that holds a
// file, and an end address the container cannot honour. Archives are built here
// byte by byte; nothing binary is committed.
import { t64Files, isT64 } from '../src/media/t64.js';

let failures = 0;
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); failures++; } }
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

function mkT64({ magic = 'C64 tape image file', label = 'ARCHIVE', capacity = null, entries = [] }) {
  const dataAt = 64 + entries.length * 32;
  let data = [];
  const dir = [];
  for (const e of entries) {
    const at = e.offset ?? (dataAt + data.length);
    const row = new Uint8Array(32);
    row[0] = e.type ?? 1;
    row[2] = e.start & 0xFF; row[3] = e.start >> 8;
    const end = e.claimEnd ?? (e.start + (e.bytes?.length ?? 0));
    row[4] = end & 0xFF; row[5] = end >> 8;
    row[8] = at & 0xFF; row[9] = (at >> 8) & 0xFF; row[10] = (at >> 16) & 0xFF;
    const name = (e.name ?? '').padEnd(16, ' ');
    for (let i = 0; i < 16; i++) row[16 + i] = name.charCodeAt(i);
    dir.push(row);
    data = data.concat([...(e.bytes ?? [])]);
  }
  const head = new Uint8Array(64);
  for (let i = 0; i < magic.length; i++) head[i] = magic.charCodeAt(i);
  const cap = capacity ?? entries.length;
  head[34] = cap & 0xFF; head[35] = cap >> 8;
  const lab = label.padEnd(24, ' ');
  for (let i = 0; i < 24; i++) head[40 + i] = lab.charCodeAt(i);
  const out = new Uint8Array(dataAt + data.length);
  out.set(head, 0);
  dir.forEach((row, i) => out.set(row, 64 + i * 32));
  out.set(Uint8Array.from(data), dataAt);
  return out;
}
const one = { name: 'GAME', start: 0x0801, bytes: [9, 8, 7] };

// ── What counts as an archive ───────────────────────────────────────────────
// The signature is prose and its wordings vary, so the prefix plus a directory
// with room in it is the test. Two other C64 formats open with the same three
// letters, and reading either as an archive would hand back nonsense.
{
  assert(isT64(mkT64({ entries: [one] })), 'the usual signature is an archive');
  assert(isT64(mkT64({ magic: 'C64S tape file', entries: [one] })), 'so is the C64S wording');
  const magic = (text) => { const b = new Uint8Array(128); for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i); b[34] = 4; return b; };
  assert(!isT64(magic('C64-TAPE-RAW')), 'a .tap is not an archive, though it starts the same');
  assert(!isT64(magic('C64 CARTRIDGE   ')), 'and neither is a cartridge');
  assert(!isT64(new Uint8Array(32)), 'nor is a file too short to hold a directory');
  let threw = false;
  try { t64Files(new Uint8Array(128)); } catch { threw = true; }
  assert(threw, 'reading something that is not an archive says so rather than guessing');
}

// ── A file comes back ready to load ─────────────────────────────────────────
{
  const t = t64Files(mkT64({ label: 'MY TAPE', entries: [one] }));
  eq(t.name, 'MY TAPE', 'the archive keeps its label');
  eq(t.files.length, 1, 'and holds one file');
  eq(t.files[0].name, 'GAME', 'named as the directory names it');
  eq(t.files[0].start, 0x0801, 'loading where the entry says');
  eq(t.files[0].end, 0x0804, 'and ending three bytes later');
  eq(String(t.files[0].bytes), String(Uint8Array.from([0x01, 0x08, 9, 8, 7])),
    'the bytes are a .prg: load address first, then the file');
}

// ── The count in the header is not believed; the entries are ────────────────
// Archives holding one file routinely say they hold none, so a slot whose type
// says a file is there is a file.
{
  const t = t64Files(mkT64({ capacity: 4, entries: [one] }));
  eq(t.files.length, 1, 'a directory with room to spare still yields its file');
}

// ── Slots that are not files ────────────────────────────────────────────────
{
  const t = t64Files(mkT64({ entries: [
    { type: 0, name: 'FREED', start: 0x0801, bytes: [1] },
    one,
    { type: 3, name: 'SNAPSHOT', start: 0x0801, bytes: [2] },
  ] }));
  eq(t.files.length, 1, 'only the file is a file');
  eq(t.skipped.length, 1, 'a freed slot is nothing and goes unmentioned');
  eq(t.skipped[0].name, 'SNAPSHOT', 'while a memory snapshot is named');
  assert(/snapshot/.test(t.skipped[0].why), `and says what it is, got "${t.skipped[0].why}"`);
}

// ── An end address the container cannot honour ──────────────────────────────
// The commonest damage in the wild. The container decides the length, and the
// entry carries a note rather than a size the archive never held.
{
  const t = t64Files(mkT64({ entries: [{ ...one, claimEnd: 0x0901 }] }));
  eq(t.files[0].end, 0x0804, 'the file is as long as the archive actually holds');
  eq(t.files[0].bytes.length, 5, 'so its .prg is the address and the three bytes');
  assert(t.files[0].note, 'and the disagreement is noted rather than silently taken');
}
{
  // A zero end address claims nothing at all, which is the other broken form.
  const t = t64Files(mkT64({ entries: [{ ...one, claimEnd: 0 }] }));
  eq(t.files[0].bytes.length, 5, 'a claim of nothing leaves the container to decide');
}

// ── Two files, and a directory written out of order ─────────────────────────
// Each file runs to wherever the next one begins, so the order the directory
// happens to be in cannot change how long a file is.
{
  const straight = t64Files(mkT64({ entries: [
    { name: 'FIRST', start: 0x0801, bytes: [1, 2] },
    { name: 'SECOND', start: 0xC000, bytes: [3, 4, 5] },
  ] }));
  eq(straight.files.map(f => f.name).join(','), 'FIRST,SECOND', 'both files, in directory order');
  eq(straight.files[0].bytes.length, 4, 'the first stops where the second starts');
  eq(straight.files[1].bytes.length, 5, 'and the second runs to the end of the archive');

  // The same two files with the directory written the other way round: the
  // entry listed first sits later in the container. The one that sits earlier
  // claims ten bytes and can hold only two, and it is the container that says
  // so — which it can only do if the offsets, not the directory order, decide
  // where a file ends.
  const dataAt = 64 + 2 * 32;
  const swapped = t64Files(mkT64({ entries: [
    { name: 'LATER', start: 0x0801, bytes: [1, 2], offset: dataAt + 2 },
    { name: 'EARLIER', start: 0xC000, bytes: [3, 4], offset: dataAt, claimEnd: 0xC00A },
  ] }));
  eq(swapped.files.length, 2, 'an out-of-order directory still lists both');
  eq(swapped.files[1].bytes.length, 4, 'and the earlier one stops where the later one starts');
  assert(swapped.files[1].note, 'its overreaching claim being noted, not taken');
}

console.log(failures ? `\n${failures} t64 assertion(s) failed` : 't64 archive spec: PASS');
process.exit(failures ? 1 : 0);
