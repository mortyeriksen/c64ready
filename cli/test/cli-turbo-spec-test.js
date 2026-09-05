// Spec test for the turbo encoder (cli/turbo.mjs), which synthesizes Turbo Tape
// 64. What the encoder writes, the format's own reader in src/tap-turbo-formats.js
// reads back — name, addresses and every payload byte, with the checksum passing
// — so a pass means the bytes frame as a genuine tape's do. It also pins the end
// address as exclusive (start + length), and that a 40K file is ~80 s of tape
// rather than the KERNAL's 13 minutes.
import { encodeTurboTape, TURBO_WRITERS } from '../turbo.mjs';
import { splitTap, tapSeconds } from '../core.mjs';
import { sniff } from '../formats.mjs';
import { TURBO_FORMATS } from '../../src/tap-turbo-formats.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

// A .tap's pulse widths in cycles, the way every reader here takes them.
function pulsesOf(tap) {
  const { data } = splitTap(tap);
  const out = [];
  for (let p = 0; p < data.length;) {
    const b = data[p++];
    if (b !== 0) { out.push(b * 8); continue; }
    out.push(data[p++] | (data[p++] << 8) | (data[p++] << 16));
  }
  return out;
}
const readerFor = name => TURBO_FORMATS.find(f => f.name === name);

const FILES = [
  { name: 'HELLO', start: 0x0801, payload: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) },
  { name: 'BIG PROGRAM X', start: 0x1000, payload: Uint8Array.from({ length: 4000 }, (_, i) => (i * 31) & 0xFF) },
];

// What is written is a .tap, whatever format rode in it.
eq(sniff(encodeTurboTape(FILES)), 'tap', 'the encoder writes a .tap the sniffer knows');

// Each writer's tape reads back through its own real reader: names, addresses,
// bytes — and, for Turbo Tape 64, a checksum that passes.
for (const [key, spec] of Object.entries(TURBO_WRITERS)) {
  const tap = encodeTurboTape(FILES, key);
  const got = readerFor(spec.name).scan(pulsesOf(tap), { payload: true });
  eq(got.length, FILES.length, `${spec.name}: every file written is read back`);
  got.forEach((g, i) => {
    const want = FILES[i];
    eq(g.name.trim(), want.name, `${spec.name}: ${want.name} keeps its name`);
    eq(g.start, want.start, `${spec.name}: ${want.name} keeps its load address`);
    // End is exclusive: start + length, one past the last byte.
    eq(g.end, want.start + want.payload.length, `${spec.name}: ${want.name} ends one past its last byte`);
    assert(g.bytes && g.bytes.length === want.payload.length && g.bytes.every((b, j) => b === want.payload[j]),
      `${spec.name}: ${want.name} reads back byte-identical`);
    assert(g.damage == null, `${spec.name}: ${want.name} reads back sound (${JSON.stringify(g.damage)})`);
  });
}

// The point of the exercise: turbo is fast. A 40K program is well under two
// minutes of tape, where the KERNAL would take past thirteen.
{
  const big = [{ name: 'FORTY K', start: 0x0801, payload: new Uint8Array(40 * 1024) }];
  const { data, version } = splitTap(encodeTurboTape(big));
  const seconds = tapSeconds(data, version);
  assert(seconds > 40 && seconds < 150, `40K is ${seconds.toFixed(0)}s of turbo tape — fast, not the KERNAL's 13 min`);
}

// An unknown format is refused by name, not written wrong.
{
  let threw = null;
  try { encodeTurboTape(FILES, 'novaload'); } catch (e) { threw = e.message; }
  assert(/no turbo writer/.test(threw ?? ''), 'a format with no writer is refused');
}

if (failures) {
  console.error(`\n${failures} turbo assertion(s) failed`);
  process.exit(1);
}
console.log('cli turbo spec: PASS');
