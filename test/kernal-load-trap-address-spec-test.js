// Spec test for WHERE a trap-served KERNAL LOAD puts the file, and for VERIFY
// leaving memory alone — the two things $FFD5 decides from its register
// arguments.
//
// The KERNAL LOAD entry takes all three of its arguments in registers:
//   A    $00 = LOAD, $01 = VERIFY
//   X/Y  the address to load at, used when the secondary address is 0
//        (SA != 0 means "use the address in the file's first two bytes")
// and returns the end address in X/Y with carry clear, or an error code in A
// with carry set. The real ROM banks A/X/Y into zero page (VERCK, EAL/EAH) in
// the first three instructions of the routine, before it prints anything.
//
// The trap in machine.js stands in for that whole routine, and it prints the
// SEARCHING FOR / LOADING lines by calling the ROM's own message routines and
// returning to $FFD5 twice before doing the load. Those routines are ordinary
// ROM code: they come back with A/X/Y holding whatever they last worked with.
// So the trap has to bank the arguments on the first pass, exactly as the ROM
// does. Reading the live registers on the third pass reads the message
// routines' leftovers instead — which is a load to a junk address, and a VERIFY
// that overwrites RAM instead of only checking it.
//
// Not covered elsewhere:
//   - kernal-load-wildcard-spec-test.js loads through TDE and the real drive,
//     where this trap does not run at all.
//   - machine-api-spec-test.js drives the trap, but only through LOAD"*",8,1
//     (SA=1, which takes the address from the file) and a missing file.
//   Neither pins SA=0, and neither calls VERIFY.
//
// Observed surface (spec only): the bytes in RAM after the call, the registers
// and carry the KERNAL contract says come back, and the printed messages. The
// call is made the documented way — SETNAM, SETLFS, then LOAD — from a small
// machine-code stub, so BASIC's line relinking never touches the loaded bytes.

import { existsSync, readFileSync } from 'node:fs';
import { C64Machine } from '../src/machine.js';
import { createPRGDisk } from '../src/d64.js';

const ROMS = ['roms/kernal.bin', 'roms/basic.bin', 'roms/chargen.bin'];
if (!ROMS.every(existsSync)) {
  console.log('# SKIP C64 ROMs not available under roms/ (C64_ROM_DIR)');
  process.exit(0);
}
const rom = (f) => new Uint8Array(readFileSync(f));

let failed = 0;
function expect(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
const ok = (label) => console.log(`ok  - ${label}`);

// Where the stub and its results live: $C000-$CFFF is plain RAM on every
// banking configuration, and neither BASIC nor the KERNAL uses it.
const STUB     = 0xC000;
const PARK     = 0xC02A;   // JMP * at the end of the stub — the test polls for it
const RESULT   = 0xCF00;   // A, X, Y, carry as the call returned them
const NAME     = 0xCF10;
const TARGET   = 0xC800;   // the X/Y address a SA=0 call must honour

// The file: its own load address is $0801, so a load that lands there instead
// of at X/Y is taking the file's address when the spec says to take X/Y. The
// payload is co-prime with 256 and never zero, so it cannot be matched by the
// RAM it is loaded into.
const FILE_ADDR = 0x0801;
const PAYLOAD_LEN = 300;
function makeFile() {
  const p = new Uint8Array(PAYLOAD_LEN + 2);
  p[0] = FILE_ADDR & 0xFF; p[1] = FILE_ADDR >> 8;
  for (let i = 0; i < PAYLOAD_LEN; i++) p[i + 2] = ((i * 31 + 7) & 0xFF) || 0xA5;
  return p;
}
const FILE = makeFile();

// SETNAM ($FFBD), SETLFS ($FFBA), LOAD ($FFD5) — the documented calling
// sequence — then record what came back and park.
function poke(m, addr, bytes) { bytes.forEach((b, i) => { m.mem.ram[addr + i] = b; }); }
function buildStub(m, { name, sa, verb, loadAddr }) {
  for (let i = 0; i < name.length; i++) m.mem.ram[NAME + i] = name.charCodeAt(i);
  poke(m, STUB, [
    0xA9, name.length,                    // LDA #len
    0xA2, NAME & 0xFF, 0xA0, NAME >> 8,   // LDX #<name  LDY #>name
    0x20, 0xBD, 0xFF,                     // JSR SETNAM
    0xA9, 0x01,                           // LDA #1        logical file 1
    0xA2, 0x08,                           // LDX #8        device 8
    0xA0, sa,                             // LDY #sa       secondary address
    0x20, 0xBA, 0xFF,                     // JSR SETLFS
    0xA9, verb,                           // LDA #verb     0 = LOAD, 1 = VERIFY
    0xA2, loadAddr & 0xFF,                // LDX #<addr
    0xA0, loadAddr >> 8,                  // LDY #>addr
    0x20, 0xD5, 0xFF,                     // JSR LOAD
    0x8D, RESULT & 0xFF, RESULT >> 8,     // STA result+0  error code
    0x8E, (RESULT + 1) & 0xFF, RESULT >> 8, // STX result+1  end address low
    0x8C, (RESULT + 2) & 0xFF, RESULT >> 8, // STY result+2  end address high
    0xA9, 0x00, 0x2A,                     // LDA #0  ROL A   carry -> bit 0
    0x8D, (RESULT + 3) & 0xFF, RESULT >> 8, // STA result+3
    0x4C, PARK & 0xFF, PARK >> 8,         // JMP *
  ]);
}

const basicReady = (m) => m.mem.ram[0xC6] === 0 && m.mem.ram[0xCC] === 0 && m.mem.ram[0x2C] === 0x08;

function screenText(m) {
  let s = '';
  for (let i = 0; i < 1000; i++) {
    const c = m.mem.ram[0x0400 + i] & 0x7F;
    s += c < 32 ? String.fromCharCode(c + 64) : c < 64 ? String.fromCharCode(c) : ' ';
    if (i % 40 === 39) s += '\n';
  }
  return s;
}

// Boot to READY, poke the stub, run it to its parking loop, and report what the
// KERNAL call returned.
function callLoad({ name = 'TARGET', sa = 0, verb = 0, loadAddr = TARGET, prefill = null } = {}) {
  const m = new C64Machine();
  m.loadROMs({ kernal: rom(ROMS[0]), basic: rom(ROMS[1]), charRom: rom(ROMS[2]) });
  m.setTrueDrive(false);                 // no drive on the bus: the $FFD5 trap serves device 8
  m.setD64(createPRGDisk('TARGET', FILE));
  m.reset();
  for (let f = 0; f < 500 && !basicReady(m); f++) m.runFrame();
  if (!basicReady(m)) throw new Error('the C64 never reached READY');

  // Messages ON (MSGFLG bit 7 = direct mode). This is the state BASIC's own
  // LOAD runs in, and the one where the ROM message routines run in full and
  // clobber the registers — the case the banking exists for.
  m.mem.ram[0x9D] = 0xC0;
  if (prefill !== null) m.mem.ram.fill(prefill, loadAddr, loadAddr + PAYLOAD_LEN);
  buildStub(m, { name, sa, verb, loadAddr });
  m.cpu.pc = STUB;

  for (let f = 0; f < 120 && m.cpu.pc !== PARK; f++) m.runFrame();
  if (m.cpu.pc !== PARK) throw new Error(`the stub never reached its parking loop (PC=$${m.cpu.pc.toString(16)})`);

  return {
    m,
    a: m.mem.ram[RESULT],
    end: m.mem.ram[RESULT + 1] | (m.mem.ram[RESULT + 2] << 8),
    carry: m.mem.ram[RESULT + 3] & 1,
    at: (addr) => Array.from(m.mem.ram.subarray(addr, addr + PAYLOAD_LEN)),
  };
}

const payload = Array.from(FILE.subarray(2));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const first = (bytes) => bytes.slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join(' ');

// Where in the whole 64K the payload ended up, or -1 for nowhere. A test that
// only inspects the address the call asked for would pass a load that stored
// the file at some other address entirely, which is the failure being pinned.
function payloadAddress(m) {
  const sig = payload.slice(0, 16);
  outer:
  for (let addr = 0; addr <= 0x10000 - sig.length; addr++) {
    for (let i = 0; i < sig.length; i++) if (m.mem.ram[addr + i] !== sig[i]) continue outer;
    return addr;
  }
  return -1;
}
const hex4 = (n) => (n < 0 ? 'nowhere' : `$${n.toString(16).toUpperCase().padStart(4, '0')}`);

// ── Rule: with a secondary address of 0, LOAD uses the address in X/Y ────────
{
  const r = callLoad({ sa: 0, loadAddr: TARGET });
  expect(same(r.at(TARGET), payload),
    `LOAD with SA=0 puts the file at the X/Y address $${TARGET.toString(16).toUpperCase()} ` +
    `(got ${first(r.at(TARGET))}, want ${first(payload)}; the file is at ${hex4(payloadAddress(r.m))})`);
  expect(!same(r.at(FILE_ADDR), payload),
    `LOAD with SA=0 does NOT use the file's own load address $${FILE_ADDR.toString(16).toUpperCase()}`);
  expect(r.carry === 0, 'a successful LOAD returns with carry clear');
  expect(r.end === TARGET + PAYLOAD_LEN,
    `LOAD returns the end address in X/Y ($${(TARGET + PAYLOAD_LEN).toString(16).toUpperCase()}, got $${r.end.toString(16).toUpperCase()})`);
  const text = screenText(r.m);
  expect(/SEARCHING FOR TARGET/.test(text) && /\nLOADING\s*\n/.test(text),
    'and it still prints the KERNAL\'s SEARCHING FOR / LOADING lines');
  ok('SA=0 loads at the address passed in X/Y');
}

// ── Rule: with a non-zero secondary address, the file's own address wins ─────
{
  const r = callLoad({ sa: 1, loadAddr: TARGET });
  expect(same(r.at(FILE_ADDR), payload),
    `LOAD with SA=1 puts the file at its own load address $${FILE_ADDR.toString(16).toUpperCase()} ` +
    `(got ${first(r.at(FILE_ADDR))}, want ${first(payload)})`);
  expect(!same(r.at(TARGET), payload), 'LOAD with SA=1 ignores the X/Y address');
  expect(r.end === FILE_ADDR + PAYLOAD_LEN,
    `and returns that file's end address ($${(FILE_ADDR + PAYLOAD_LEN).toString(16).toUpperCase()}, got $${r.end.toString(16).toUpperCase()})`);
  ok('SA=1 loads at the address in the file');
}

// ── Rule: VERIFY (A=1) checks the file, it does not store it ────────────────
{
  const SENTINEL = 0x5A;
  const r = callLoad({ sa: 0, verb: 1, loadAddr: TARGET, prefill: SENTINEL });
  expect(r.at(TARGET).every((b) => b === SENTINEL),
    `VERIFY leaves the address it was given alone (got ${first(r.at(TARGET))}, want ${SENTINEL.toString(16)} throughout)`);
  // Anywhere at all, not just at the target: a VERIFY that reads its verb from
  // a clobbered A stores the file, and the address it stores at is clobbered too.
  expect(payloadAddress(r.m) === -1,
    `VERIFY stores the file nowhere in memory (found it at ${hex4(payloadAddress(r.m))})`);
  ok('VERIFY does not write to memory');
}

// ── Rule: a name the disk does not hold comes back as FILE NOT FOUND ────────
{
  const r = callLoad({ name: 'ABSENT', sa: 0, loadAddr: TARGET, prefill: 0x00 });
  expect(r.carry === 1, 'a failed LOAD returns with carry set');
  expect(r.a === 4, `and FILE NOT FOUND ($04) in A (got $${r.a.toString(16).padStart(2, '0')})`);
  expect(r.at(TARGET).every((b) => b === 0), 'and stores nothing');
  ok('a missing file reports FILE NOT FOUND and loads nothing');
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('kernal load-trap address spec: PASS');
