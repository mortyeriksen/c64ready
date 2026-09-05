// Spec test for prg2crt (cli/crt.mjs): the container is written the way
// CRT.TXT lays it out, the Magic Desk rules are kept (8K banks at $8000, and
// the register that switches the cartridge out), the machine can find the
// cartridge at reset, and the program comes back out of the banks byte for
// byte. The emulator's own parser reads it back as the last word.
import { prgToCrt } from '../crt.mjs';
import { parseCRT } from '../core.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}
function throws(fn, re, msg) {
  try { fn(); } catch (e) {
    assert(re.test(e.message), `${msg} — said "${e.message}"`);
    return;
  }
  assert(false, `${msg} — did not throw`);
}

// A program of a size that needs three banks of payload, so bank stepping is
// exercised, with a body that is recognisable byte for byte.
const BODY = 8192 * 2 + 100;
const prg = new Uint8Array(2 + BODY);
prg[0] = 0x01; prg[1] = 0x08;                    // $0801
for (let i = 0, seed = 7; i < BODY; i++) { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; prg[2 + i] = seed & 0xFF; }

const { bytes, banks } = prgToCrt(prg, 'TEST CART');
const buf = Buffer.from(bytes);

// ── the 64-byte header, per CRT.TXT ─────────────────────────────────────────
eq(buf.toString('ascii', 0, 16), 'C64 CARTRIDGE   ', 'the header opens with the CRT signature');
eq(buf.readUInt32BE(0x10), 0x40, 'header length is 64 bytes');
eq(buf.readUInt16BE(0x14), 0x0100, 'version 1.0');
eq(buf.readUInt16BE(0x16), 19, 'hardware type 19: Magic Desk');
eq(buf[0x18], 0, 'EXROM is asserted');
eq(buf[0x19], 1, 'GAME is not: an 8K cartridge at $8000');
eq(buf.toString('ascii', 0x20, 0x29), 'TEST CART', 'the name sits in the 32-byte field');

// ── CHIP packets ────────────────────────────────────────────────────────────
const chips = [];
for (let p = 0x40; p < buf.length;) {
  eq(buf.toString('ascii', p, p + 4), 'CHIP', `packet at ${p} is a CHIP packet`);
  const len = buf.readUInt32BE(p + 4);
  chips.push({
    type: buf.readUInt16BE(p + 8), bank: buf.readUInt16BE(p + 10),
    addr: buf.readUInt16BE(p + 12), size: buf.readUInt16BE(p + 14),
    data: buf.subarray(p + 0x10, p + len),
  });
  eq(len, 0x10 + buf.readUInt16BE(p + 14), 'packet length counts its own header');
  p += len;
}
eq(chips.length, banks, 'one packet per bank');
eq(chips.map(c => c.bank), chips.map((_, i) => i), 'banks are numbered from 0 with no gap');
assert(chips.every(c => c.type === 0), 'every packet is ROM');
assert(chips.every(c => c.addr === 0x8000), 'every bank appears at $8000, as Magic Desk maps them');
assert(chips.every(c => c.size === 8192), 'every bank is a whole 8K');

// ── the machine has to find it at reset ─────────────────────────────────────
const boot = chips[0].data;
eq([...boot.subarray(4, 9)], [0xC3, 0xC2, 0xCD, 0x38, 0x30], 'bank 0 carries the CBM80 signature at $8004');
const cold = boot[0] | (boot[1] << 8);
eq(cold, 0x8009, 'the cold start vector points past the signature');
assert(boot[2] === boot[0] && boot[3] === boot[1], 'the NMI vector points at the same code');

// ── the program is in the banks, byte for byte ──────────────────────────────
const payload = Buffer.concat(chips.slice(1).map(c => Buffer.from(c.data)));
assert(payload.subarray(0, BODY).equals(Buffer.from(prg.subarray(2))),
  'the banks after the loader hold the program itself');
assert(payload.subarray(BODY).every(b => b === 0), 'the last bank is padded with zeros, not with the next file');

// The loader has to switch the cartridge out before the program runs, or the
// ROM stands where the program's RAM has to be. $DE00 is where it says so.
const writesRegister = [...boot.subarray(0, 512)].some((_, i) =>
  boot[i] === 0xA9 && boot[i + 1] === 0x80 && boot[i + 2] === 0x8D && boot[i + 3] === 0x00 && boot[i + 4] === 0xDE);
assert(writesRegister, 'the loader writes $80 to $DE00: bit 7 takes the cartridge out of the map');

// ── read back by the emulator's own parser ──────────────────────────────────
{
  const cart = parseCRT(bytes);
  eq(cart.hwType, 19, 'the emulator reads it as a Magic Desk cartridge');
  eq(cart.chips.length, banks, 'and finds every bank');
  eq(cart.name.replace(/\0+$/, ''), 'TEST CART', 'and the name');
}

// ── what it refuses ─────────────────────────────────────────────────────────
{
  const low = new Uint8Array([0x00, 0x01, 1, 2, 3]);   // loads at $0100
  throws(() => prgToCrt(low, 'LOW'), /\$0?100|under the \$0200/i,
    'a program that loads under $0200 is refused: the copier lives there');
}
{
  const huge = new Uint8Array(2 + 8192 * 64);
  huge[0] = 0x01; huge[1] = 0x08;
  throws(() => prgToCrt(huge, 'HUGE'), /banks/, 'more banks than the register can select is refused');
}

if (failures) {
  console.error(`\n${failures} crt assertion(s) failed`);
  process.exit(1);
}
console.log('cli crt spec: PASS');
