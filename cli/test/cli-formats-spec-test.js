// Spec test for the format sniffer (cli/formats.mjs): every kind is recognised
// by its own magic or, for .d64, by exact byte length — and a small .prg must
// never be taken for a short .d64, nor a renamed file for its extension.
import { sniff } from '../formats.mjs';

let failures = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
const padded = (s, len) => { const b = new Uint8Array(len); b.set(ascii(s)); return b; };

eq(sniff(padded('C64-TAPE-RAW', 40)), 'tap', 'TAP magic at offset 0');
eq(sniff(padded('DC2N-TAP-RAW', 40)), 'dmp', 'DC2N magic at offset 0');
eq(sniff(padded('C64 CARTRIDGE   ', 80)), 'crt', 'CRT magic, trailing spaces included');

{
  const wav = new Uint8Array(64);
  wav.set(ascii('RIFF'), 0);
  wav.set(ascii('WAVE'), 8);
  eq(sniff(wav), 'wav', 'RIFF at 0 plus WAVE at 8');
}

// Every real D64 length is a disk; a byte more or less is not.
for (const bytes of [174848, 175531, 196608, 197376, 205312, 206114]) {
  eq(sniff(new Uint8Array(bytes)), 'd64', `${bytes} bytes is a D64 variant`);
}
eq(sniff(new Uint8Array(174849)), 'unknown', 'one byte past a D64 variant is not a disk');

// A .prg is a load address and data that fits below $10000 — and never a short
// or truncated .d64, whatever its size looks like.
{
  const prg = new Uint8Array(100);
  prg[0] = 0x01; prg[1] = 0x08;
  eq(sniff(prg), 'prg', 'load address + small body is a prg');
}
{
  // Claims to load at $FFFF with 100 bytes: past the top of memory.
  const bad = new Uint8Array(100);
  bad[0] = 0xFF; bad[1] = 0xFF;
  eq(sniff(bad), 'unknown', 'a "prg" loading past $FFFF is not a prg');
}
eq(sniff(new Uint8Array(70000)), 'unknown', 'too big for a C64 memory image is not a prg');
eq(sniff(new Uint8Array(1)), 'unknown', 'one byte is nothing');

// The extension only speaks when every magic has failed — and then it does.
eq(sniff(new Uint8Array([0xFF, 0xFF, 0]), 'game.prg'), 'prg', 'a .prg extension is believed when nothing contradicts it');
eq(sniff(padded('C64-TAPE-RAW', 40), 'renamed.prg'), 'tap', 'a magic outranks the extension');

if (failures) {
  console.error(`\n${failures} formats assertion(s) failed`);
  process.exit(1);
}
console.log('cli formats spec: PASS');
