// Where a tape file actually lands, settled against the real KERNAL.
//
// A CBM tape header carries a type byte and a pair of addresses, and the two
// program types do not mean the same thing by those addresses. Type 3 is
// absolute: the file loads where the header says. Type 1 is relocatable: a plain
// LOAD puts it at the BASIC start instead, and the header's addresses then
// record only where it was saved from.
//
// src/tap-directory.js lists both as PRG, so it carries `relocatable` beside the
// addresses to say which. This is what that flag has to mean, proved by loading
// such tapes through the ROM rather than by reading the parser back to itself:
// the same file, saved from the same address, under both type bytes and both
// forms of the command.
//
// The tapes are built here from the documented encoding, as the other tape spec
// tests build theirs — nothing outside the repository but the ROMs.
import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';
import { tapDirectory } from '../src/tap-directory.js';

let failures = 0;
function eq(got, want, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL: ${msg} — expected ${b}, got ${a}`); failures++; }
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

function encodeBlock(out, payload, pilot, syncStart) {
  for (let i = 0; i < pilot; i++) out.push(S);
  for (let v = syncStart; v >= syncStart - 8; v--) encodeByte(out, v);
  let checksum = 0;
  for (const b of payload) { checksum ^= b; encodeByte(out, b); }
  encodeByte(out, checksum);
  out.push(L);
  for (let i = 0; i < 60; i++) out.push(S);
}

/** One program on a tape, its header type given. */
function tapeOf({ type, start, body, name }) {
  const end = start + body.length;
  const header = new Uint8Array(192).fill(0x20);
  header[0] = type;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < name.length; i++) header[5 + i] = name.charCodeAt(i);
  const p = [];
  encodeBlock(p, header, 0x6A00, 0x89);
  encodeBlock(p, header, 0x1A00, 0x09);
  encodeBlock(p, body, 0x1A00, 0x89);
  encodeBlock(p, body, 0x1A00, 0x09);
  const tap = new Uint8Array(20 + p.length);
  for (let i = 0; i < 12; i++) tap[i] = 'C64-TAPE-RAW'.charCodeAt(i);
  tap[12] = 1;
  tap[16] = p.length & 0xFF; tap[17] = (p.length >> 8) & 0xFF; tap[18] = (p.length >> 16) & 0xFF;
  tap.set(p, 20);
  return tap;
}

const roms = {
  kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
  basic: new Uint8Array(readFileSync('roms/basic.bin')),
  charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
};

const screen = (m) => {
  let text = '';
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      const c = m.mem.ram[0x0400 + row * 40 + col];
      line += c >= 1 && c <= 26 ? String.fromCharCode(64 + c)
        : c >= 32 && c <= 63 ? String.fromCharCode(c) : ' ';
    }
    // Trimmed, so the last line with anything on it is the prompt rather than
    // forty spaces of an empty row below it.
    text += line.trimEnd() + '\n';
  }
  return text;
};
const type = (m, text) => {
  let left = text;
  while (left) { left = left.slice(m.bufferKeyboardText(left)); m.runFrame(); }
};

// LOAD with no name stops at FOUND and waits for a key, so press the one a
// person would. C= is the KERNAL's own "load it".
function pressGo(m) {
  for (const [col, row] of [[7, 5], [7, 4]]) {
    m.cia1.setKey(col, row, true);
    for (let i = 0; i < 12; i++) m.runFrame();
    m.cia1.setKey(col, row, false);
    for (let i = 0; i < 6; i++) m.runFrame();
    if (m.datasette.motorOn) return;
  }
}

const SAVED_FROM = 0xCC49, BASIC_START = 0x0801, MARK = 0x5A;
const bodyOf = (n) => new Uint8Array(n).fill(MARK);

/**
 * Load one such tape and report where its bytes turned up.
 * @returns {{at: string, endPointer: number}} which address the body landed on
 */
function loadIt(tap, command, size) {
  const m = new C64Machine();
  m.loadROMs(roms);
  for (let i = 0; i < 150; i++) m.runFrame();
  // Both candidate landing sites cleared, so "the marks are here" is the tape's
  // doing and not something left over from the boot.
  m.mem.ram.fill(0, BASIC_START, BASIC_START + size);
  m.mem.ram.fill(0, SAVED_FROM, SAVED_FROM + size);
  m.loadTap(tap);
  m.setTapePlayPressed(true);
  type(m, command);
  let ran = false, prods = 0;
  for (let s = 0; s < 200; s++) {
    for (let k = 0; k < 50; k++) m.runFrame();
    if (m.datasette.motorOn) { ran = true; continue; }
    if (ran && /READY\./.test(screen(m).split('\n').filter(Boolean).slice(-1)[0] || '')) break;
    if (ran && prods < 6) { pressGo(m); prods++; }
  }
  const marks = (at) => {
    let n = 0;
    for (let i = 0; i < size; i++) if (m.mem.ram[at + i] === MARK) n++;
    return n;
  };
  // BASIC relinks a program's line pointers after a LOAD, which rewrites the
  // first couple of bytes of a body that is not really a BASIC program. Most of
  // it arriving is the answer to where it went.
  const most = (n) => n > size * 0.9;
  const here = most(marks(BASIC_START)), there = most(marks(SAVED_FROM));
  return {
    at: here && !there ? 'BASIC start' : there && !here ? 'saved-from address'
      : here && there ? 'both' : 'neither',
    endPointer: m.mem.ram[0xAE] | (m.mem.ram[0xAF] << 8),
  };
}

const SIZE = 176;

// ── Type 3: absolute, and the header's addresses are the whole story ─────────
{
  const tap = tapeOf({ type: 3, start: SAVED_FROM, body: bodyOf(SIZE), name: 'ABSOLUTE' });
  eq(tapDirectory(tap.subarray(20), { version: 1 }).map(f => [f.type, f.relocatable]),
     [['PRG', false]], 'a type 3 header lists as a program that is not relocatable');
  const plain = loadIt(tap, 'LOAD\r', SIZE);
  eq(plain.at, 'saved-from address', 'and a plain LOAD puts it at the address its header carries');
  eq(plain.endPointer, SAVED_FROM + SIZE, 'the KERNAL end pointer agrees');
}

// ── Type 1: relocatable, and they are not ────────────────────────────────────
{
  const tap = tapeOf({ type: 1, start: SAVED_FROM, body: bodyOf(SIZE), name: 'MOVES' });
  eq(tapDirectory(tap.subarray(20), { version: 1 }).map(f => [f.type, f.relocatable, f.start]),
     [['PRG', true, SAVED_FROM]], 'a type 1 header lists the same addresses, flagged relocatable');
  const plain = loadIt(tap, 'LOAD\r', SIZE);
  eq(plain.at, 'BASIC start', 'a plain LOAD puts it at the BASIC start, not where the header says');
  eq(plain.endPointer, BASIC_START + SIZE, 'and the end pointer follows it there');
}

// ── The secondary address is what asks for the header's own place ────────────
{
  // Which is the escape a caller has once it knows the file is relocatable: the
  // addresses are still good, they simply are not what a plain LOAD honours.
  const tap = tapeOf({ type: 1, start: SAVED_FROM, body: bodyOf(SIZE), name: 'MOVES' });
  const absolute = loadIt(tap, 'LOAD"",1,1\r', SIZE);
  eq(absolute.at, 'saved-from address', 'LOAD"",1,1 loads a relocatable file where its header says');
  eq(absolute.endPointer, SAVED_FROM + SIZE, 'and the end pointer with it');
}

console.log(failures ? `kernal tape relocatable spec: FAIL (${failures})` : 'kernal tape relocatable spec: PASS');
process.exit(failures ? 1 : 0);
