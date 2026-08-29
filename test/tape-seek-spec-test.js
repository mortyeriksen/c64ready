// Winding the tape to a file, and finding that file there.
//
// Two things this pins, both of them regressions that happened:
//
//  1. A tape's byte stream and its clock are different scales — a single gap
//     entry can be twenty seconds — so a seek asked for in seconds cannot be
//     applied as a fraction of the bytes. It once was, and clicking a file in
//     the listing wound the head past it, loading whichever file came next.
//  2. A file starts at the head of its lead-in, not at its block. Winding to two
//     seconds before the block was measured to be too little on a real tape: the
//     KERNAL searched past the whole file and never found it.
//
// So the test winds to what the listing offers — `startSeconds` — and lets the
// real KERNAL LOAD prove which file it landed on.
import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
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

function encodeBlock(out, payload, pilot, sync) {
  for (let i = 0; i < pilot; i++) out.push(S);
  for (let v = sync; v >= sync - 8; v--) encodeByte(out, v);
  let sum = 0;
  for (const b of payload) { sum ^= b; encodeByte(out, b); }
  encodeByte(out, sum);
  out.push(L);
  for (let i = 0; i < 60; i++) out.push(S);
}

function encodeFile(out, { name, start, body }) {
  const header = new Uint8Array(192).fill(0x20);
  const end = start + body.length;
  header[0] = 0x03;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < name.length; i++) header[5 + i] = name.charCodeAt(i);
  encodeBlock(out, header, 2400, 0x89);
  encodeBlock(out, header, 200, 0x09);
  encodeBlock(out, body, 800, 0x89);
  encodeBlock(out, body, 200, 0x09);
}

const ALPHA = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
const BETA = new Uint8Array([0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6, 0x07, 0x18]);
const LOAD_AT = 0x0801;

// Two files with a long silence between them — which is what makes the byte
// stream and the clock disagree: forty seconds of tape here cost twelve bytes,
// so a position measured in bytes and one measured in seconds are far apart.
const stream = [];
encodeFile(stream, { name: 'ALPHA', start: LOAD_AT, body: ALPHA });
const gap = c => [0, c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF];
stream.push(...gap(13_000_000), ...gap(13_000_000), ...gap(13_000_000));   // ~40s
encodeFile(stream, { name: 'BETA', start: LOAD_AT, body: BETA });

const tap = new Uint8Array(20 + stream.length);
for (let i = 0; i < 12; i++) tap[i] = 'C64-TAPE-RAW'.charCodeAt(i);
tap[12] = 1;
tap[16] = stream.length & 0xFF;
tap[17] = (stream.length >> 8) & 0xFF;
tap[18] = (stream.length >> 16) & 0xFF;
tap.set(stream, 20);

const files = tapDirectory(tap.subarray(20), { version: 1 });

// ── The listing knows both files, and where each of them begins ──────────────
{
  assert(files.length === 2, `both files listed (${files.length})`);
  assert(files.map(f => f.name.trim()).join(',') === 'ALPHA,BETA',
    `in tape order (${files.map(f => f.name.trim()).join(',')})`);
  for (const f of files) {
    assert(f.startSeconds < f.atSeconds, `${f.name.trim()} starts before its block`);
    assert(f.atSeconds - f.startSeconds > 0.5,
      `${f.name.trim()} keeps its whole lead-in (${(f.atSeconds - f.startSeconds).toFixed(2)}s)`);
  }
  assert(files[1].startSeconds > files[0].atSeconds,
    'and the second one does not reach back into the first');
}

function makeMachine() {
  const m = new C64Machine();
  m.loadROMs({
    kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
    basic: new Uint8Array(readFileSync('roms/basic.bin')),
    charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
  });
  for (let i = 0; i < 150; i++) m.runFrame();
  m.loadTap(tap);
  return m;
}

// ── A seek in seconds lands at that second, not at that share of the bytes ───
{
  const m = makeMachine();
  const ds = m.datasette;
  const target = files[1].startSeconds;
  ds.seekToSeconds(target);
  const landed = ds.secondsAtFraction(ds.pos / ds.tapData.length);
  assert(Math.abs(landed - target) < 0.05,
    `seeking to ${target.toFixed(2)}s lands there (${landed.toFixed(2)}s)`);

  // The same number applied to the bytes lands somewhere else entirely — which
  // is the bug this guards, so the test is only meaningful while that is true.
  ds.seekToFraction(target / ds.durationSeconds);
  const wrong = ds.secondsAtFraction(ds.pos / ds.tapData.length);
  assert(Math.abs(wrong - target) > 1,
    `the byte scale is a different one (${wrong.toFixed(2)}s vs ${target.toFixed(2)}s)`);
}

// ── Wound to the second file, the KERNAL loads the second file ───────────────
{
  const m = makeMachine();
  m.mem.ram.fill(0, LOAD_AT, LOAD_AT + 16);
  m.datasette.seekToSeconds(files[1].startSeconds);
  m.setTapeKey('PLAY');
  let left = 'LOAD\r';
  while (left) { left = left.slice(m.bufferKeyboardText(left)); m.runFrame(); }

  let loaded = false;
  for (let s = 0; s < 60 && !loaded; s++) {
    for (let k = 0; k < 50; k++) m.runFrame();
    loaded = BETA.every((b, i) => m.mem.ram[LOAD_AT + i] === b);
  }
  assert(loaded, 'the file the head was wound to is the one that loads');
  assert(!ALPHA.every((b, i) => m.mem.ram[LOAD_AT + i] === b), 'and not the one before it');
}

if (failures) {
  console.error(`\n${failures} tape seek assertion(s) failed`);
  process.exit(1);
}
console.log('tape seek spec: PASS');
