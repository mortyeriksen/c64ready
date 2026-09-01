// Spec test for reading Novaload tapes (src/tap-turbo-formats.js).
//
// The format is taken from the loader itself. A Novaload tape boots from an
// ordinary KERNAL block whose 192-byte header is the turbo reader, and the
// resident loader that block installs is read out of the memory image it loads;
// between them they define every rule asserted here. The tapes below are built
// from those rules, so the recogniser is measured against the format rather than
// against itself:
//   one bit per pulse, LSB first, 304 cycles for a 0 and 688 for a 1
//   a pilot of 0 bits, then the single 1 bit the loader syncs on, then $AA
//   bootstrap layout: a seed, then [page, 256 bytes, checksum] to a page of $00,
//     the checksum being the page byte plus its 256
//   resident layout: a name length and that name, then the destination less one
//     page, the end address, the last block's length and the block count, then a
//     checksum; then the blocks, each 256 bytes and a checksum
//   the resident sum runs across everything after the $AA, checksum bytes
//     included, and each checksum is that total taken before itself
import { tapDirectory, tapeFacts } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
}
function near(got, want, tol, msg) {
  if (!(Math.abs(got - want) <= tol)) {
    console.error(`FAIL: ${msg} — expected ${want} ±${tol}, got ${got}`); failures++;
  }
}

const NOVA = { zero: 304, one: 688 };
const PILOT = 2064;                               // what the measured tape writes

const bitsOf = (out, v, w) => { for (let k = 0; k < 8; k++) out.push((v >> k) & 1 ? w.one : w.zero); };
const pilotOf = (out, n, w) => { for (let i = 0; i < n; i++) out.push(w.zero); };

/** Pilot, the bit the loader syncs on, and the $AA that follows it. */
function sync(out, w, pilot = PILOT) {
  pilotOf(out, pilot, w);
  out.push(w.one);
  bitsOf(out, 0xAA, w);
}

const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const body = (n, seed = 0) => Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

/**
 * A file as the resident loader writes it. `spoil` names the block whose
 * checksum is written wrong; `sumsItself` writes each checksum as the total
 * with itself already added, which is the rule the loader does not use.
 */
function residentFile(out, { name = '', start = 0xE000, size, widths = NOVA,
                             pilot = PILOT, spoil = -1, sumsItself = false } = {}) {
  sync(out, widths, pilot);
  let sum = 0;
  const put = v => { bitsOf(out, v, widths); sum = (sum + v) & 0xFF; };
  const dest = (start - 0x0100) & 0xFFFF, end = (start + size) & 0xFFFF;
  put(name.length);
  for (const c of ascii(name)) put(c);
  put(dest & 0xFF); put(dest >> 8);
  put(end & 0xFF); put(end >> 8);
  const tail = size % 256, count = Math.floor(size / 256) + 1;
  put(tail); put(count);
  put(sum);                                       // the header's own total
  for (let b = 0; b < count; b++) {
    const len = b === count - 1 ? tail : 256;
    if (!len) break;
    for (const v of body(len, b)) put(v);
    const want = sum;
    put(sumsItself ? (sum + sum) & 0xFF : b === spoil ? want ^ 0xFF : want);
  }
  pilotOf(out, 400, widths);
  out.push(1000000);                              // the silence before whatever is next
}

/** The block that carries the loader: pages in any order, ended by a page of $00. */
function bootstrapBlock(out, pages, { widths = NOVA, seed = 0x55, spoil = -1, runOut = true } = {}) {
  sync(out, widths, PILOT);
  bitsOf(out, seed, widths);
  pages.forEach((page, i) => {
    bitsOf(out, page, widths);
    let sum = page;
    for (const v of body(256, page)) { bitsOf(out, v, widths); sum = (sum + v) & 0xFF; }
    bitsOf(out, i === spoil ? sum ^ 0xFF : sum, widths);
  });
  if (!runOut) return;                            // a tape cut off after its last block
  pilotOf(out, 400, widths);                      // the run-out that reads as page $00
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
const listing = (pulses) => tapDirectory(tapOf(pulses));
const nova = (pulses) => listing(pulses).filter(f => f.format === 'Novaload');

// ── A named file ─────────────────────────────────────────────────────────────
{
  const p = [];
  residentFile(p, { name: 'BOMB JACK', start: 0x0900, size: 2000 });
  const files = nova(p);
  eq(files.length, 1, 'one Novaload file on the tape');
  eq(files[0].name, 'BOMB JACK', 'the name the header carries');
  eq(files[0].size, 2000, 'the size its block count and tail give');
  eq(files[0].damaged, false, 'and it adds up');
}

// ── The destination is written one page low ──────────────────────────────────
{
  // The loader steps the destination page on before every block, the first one
  // included, so a header saying $08 loads at $0900. Reading it as written puts
  // every Novaload file a page below where it goes.
  const p = [];
  residentFile(p, { name: 'PAGES', start: 0x0900, size: 512 });
  eq(nova(p)[0].start, 0x0900, 'the file starts one page above what the header states');
}

// ── A tape need not name its files ───────────────────────────────────────────
{
  const p = [];
  residentFile(p, { name: '', start: 0xE000, size: 8176 });
  const files = nova(p);
  eq(files.map(f => f.name), [''], 'a name length of zero is a file with no name');
  eq(files[0].size, 8176, 'sized from the header all the same');
  eq(files[0].damaged, false, 'and sound');
}

// ── Whole blocks with no tail ────────────────────────────────────────────────
{
  // A tail of 0 means the file ended on the block before, so the count is one
  // more than the blocks that carry bytes.
  const p = [];
  residentFile(p, { name: 'ROUND', start: 0x4000, size: 1024 });
  eq(nova(p).map(f => f.size), [1024], 'a file that is whole blocks');
}

// ── The checksum is the total before itself ──────────────────────────────────
{
  const p = [];
  residentFile(p, { name: 'WRONGSUM', start: 0x4000, size: 600, sumsItself: true });
  eq(nova(p).map(f => f.damaged), [true],
     'a block summed with its own checksum byte does not add up');
}

// ── A damaged file is listed, not dropped ────────────────────────────────────
{
  const p = [];
  residentFile(p, { name: 'HOLED', start: 0x4000, size: 800, spoil: 1 });
  const files = nova(p);
  eq(files.map(f => f.name), ['HOLED'], 'a file whose block fails is still listed');
  eq(files.map(f => f.damaged), [true], 'and marked damaged');
}

// ── The header has to prove itself ───────────────────────────────────────────
{
  // $AA after a pilot is two bytes of coincidence, which a tape's worth of
  // candidates supplies. Nothing is claimed without the header's own total.
  const p = [];
  residentFile(p, { name: 'PROOF', start: 0x4000, size: 300 });
  eq(nova(p).map(f => f.name), ['PROOF'], 'the file reads before the header is touched');
  const at = p.indexOf(NOVA.one, PILOT);          // the sync bit
  const csAt = at + 1 + 8 * (1 + 1 + 'PROOF'.length + 6);   // its header checksum
  p[csAt] = p[csAt] === NOVA.one ? NOVA.zero : NOVA.one;    // one bit of it
  eq(nova(p), [], 'and is no file at all once its total is wrong');
}

// ── The block that carries the loader ────────────────────────────────────────
{
  // Pages in the order Bomb Jack writes its first ones, which is not ascending:
  // the layout says nothing about a start address beyond the span it covers.
  const p = [];
  bootstrapBlock(p, [0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xEF, 0xF0]);
  const files = nova(p);
  eq(files.length, 1, 'the bootstrap block is one file');
  eq(files[0].name, '', 'it has no name to give');
  eq(files[0].size, 8 * 256, 'sized by the pages it carries');
  eq([files[0].start, files[0].end], [0xE000, 0xF100], 'spanning lowest page to highest');
  eq(files[0].damaged, false, 'and every block adds up');
}
{
  const p = [];
  bootstrapBlock(p, [0x08, 0x09, 0x0A, 0x0B, 0x0C], { spoil: 3 });
  eq(nova(p).map(f => f.damaged), [true], 'a bootstrap block that fails is struck through');
}
{
  // No run-out, so nothing says the file ended — what was read is still what is
  // on the tape, and dropping it would leave the whole recording unexplained.
  const p = [];
  bootstrapBlock(p, [0xE0, 0xE1, 0xE2, 0xE3], { runOut: false });
  const files = nova(p);
  eq(files.map(f => [f.size, f.damaged]), [[4 * 256, true]],
     'a tape cut off after its last block lists what it carries');
  eq(files[0].damage.kind, 'short', 'and says the file is not whole on it');
}

// ── Both layouts on one tape, in tape order ──────────────────────────────────
{
  const p = [];
  bootstrapBlock(p, [0xE0, 0xE1, 0xE2]);
  residentFile(p, { name: 'PART TWO', start: 0x0800, size: 3000 });
  const files = nova(p);
  eq(files.map(f => f.name), ['', 'PART TWO'], 'the loader block first, then the file it loads');
  eq(files.map(f => f.size), [768, 3000], 'each sized in its own terms');
  eq(files.every(f => !f.damaged), true, 'both sound');
}

// ── A deck off speed ─────────────────────────────────────────────────────────
{
  // The loader's boundary is the 500-cycle band edge its CIA timer crosses, and
  // 304 and 688 sit far enough either side of it that no measuring of the tape's
  // own widths is needed — which Turbo Tape 64's 216 and 328 do need. 20% slow
  // and 40% fast is more drift than a deck has.
  for (const rate of [0.8, 1.4]) {
    const widths = { zero: Math.round(NOVA.zero * rate), one: Math.round(NOVA.one * rate) };
    const p = [];
    residentFile(p, { name: 'RETIMED', start: 0x4000, size: 2000, widths });
    eq(nova(p).map(f => [f.name, f.size, f.damaged]), [['RETIMED', 2000, false]],
       `a deck running at ${rate}x still reads`);
  }
}
{
  // And how far off it was is worth saying: a listing full of struck-through
  // rows means something different when the deck was the fault.
  const rate = 1.06;
  const widths = { zero: Math.round(NOVA.zero * rate), one: Math.round(NOVA.one * rate) };
  const p = [];
  residentFile(p, { name: 'SLOW', start: 0x4000, size: 2000, widths });
  const facts = tapeFacts(tapOf(p).subarray(20), { version: 1 });
  eq(facts.formats, ['Novaload'], 'the tape says what it carries');
  // Within half a per cent: a .tap holds pulse lengths in steps of eight cycles,
  // so the widths written are not exactly the ones asked for.
  near(facts.speed.percent, 6, 0.5, 'and how far off speed the deck that wrote it ran');
}

console.log(failures ? `novaload spec: FAIL (${failures})` : 'novaload spec: PASS');
process.exit(failures ? 1 : 0);
