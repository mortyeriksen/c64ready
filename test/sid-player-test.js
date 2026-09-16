// The SID player, run on the machine it was written for.
//
// Everything else about a .sid can be checked by reading bytes; this cannot. The
// only proof that the wrapper works is that the C64 boots the .prg, the driver's
// init and play actually run on the 6510, and the SID ends up with what the
// driver wrote. So this builds a tune whose init and play leave a signature,
// wraps it, runs the machine, and reads the result off the chip and the screen.
import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';
import { sidToPrg, parseSid } from '../src/media/sid.js';

let failures = 0;
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); failures++; } }
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

// A driver small enough to read: init records the song it was handed, play
// counts frames in RAM and puts the count on a SID register.
const DRIVER = [
  0x8D, 0x00, 0xD4,             // $1000 init: sta $d400   (the song number)
  0x60,                         // $1003      rts
  0xEE, 0x40, 0x03,             // $1004 play: inc $0340
  0xAD, 0x40, 0x03,             //             lda $0340
  0x8D, 0x01, 0xD4,             //             sta $d401
  0x60,                         //             rts
];

function makeSid({ format = 'PSID', songs = 3, startSong = 1, flags = (1 << 2) | (2 << 4) } = {}) {
  const bytes = new Uint8Array(0x7C + 2 + DRIVER.length);
  bytes.set([...format].map(c => c.charCodeAt(0)));
  bytes[5] = 2;                               // version 2
  bytes[7] = 0x7C;                            // data offset
  bytes[11] = 0x00; bytes[10] = 0x10;         // init $1000
  bytes[13] = 0x04; bytes[12] = 0x10;         // play $1004
  bytes[15] = songs;
  bytes[17] = startSong;
  for (const [at, text] of [[0x16, 'TEST TUNE'], [0x36, 'A COMPOSER'], [0x56, '1988 SOMEONE']]) {
    bytes.set([...text].map(c => c.charCodeAt(0)), at);
  }
  bytes[0x76] = flags >> 8; bytes[0x77] = flags & 0xFF;
  bytes[0x7C] = 0x00; bytes[0x7D] = 0x10;     // the tune's own load address, $1000
  bytes.set(DRIVER, 0x7E);
  return bytes;
}

function run(prg, frames) {
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
    basic: new Uint8Array(readFileSync('roms/basic.bin')),
    charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
  });
  machine.reset();
  for (let i = 0; i < 200; i++) machine.runFrame();     // boot to READY
  machine.loadPRG(prg);
  machine.injectRun();
  for (let i = 0; i < frames; i++) machine.runFrame();
  return machine;
}

const screenText = (machine, row, col, length) => {
  const codes = [];
  for (let i = 0; i < length; i++) codes.push(machine.mem.ram[0x0400 + row * 40 + col + i]);
  return codes.map(code => {
    if (code >= 1 && code <= 26) return String.fromCharCode(code + 64);
    if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
    return { 0x20: ' ', 0x2F: '/', 0x3A: ':', 0x2E: '.', 0x2D: '-', 0x24: '$', 0xA0: '#', 0x40: '=' }[code] ?? '?';
  }).join('');
};

// ── the file, read ───────────────────────────────────────────────────────────
{
  const tune = parseSid(makeSid());
  eq(tune.format, 'PSID', 'the magic is read');
  eq(tune.loadAddress, 0x1000, 'a zero load address comes from the first two data bytes');
  eq(tune.initAddress, 0x1000, 'init address');
  eq(tune.playAddress, 0x1004, 'play address');
  eq(tune.songs, 3, 'song count');
  eq(tune.clock, 1, 'PAL');
  eq(tune.chip, 2, '8580');
  eq(tune.title, 'TEST TUNE', 'title');
  eq(tune.author, 'A COMPOSER', 'author');
  eq(tune.payload.length, DRIVER.length, 'the payload is the tune alone, load address stripped');
}

// ── the machine, run ─────────────────────────────────────────────────────────
{
  const { data } = sidToPrg(makeSid());
  const machine = run(data, 120);
  const regs = machine.mem.sid.regs;

  assert(regs[1] > 0, 'play ran and reached the SID');
  eq(machine.mem.ram[0x0340] > 50, true, 'play ran once per frame, not once');
  eq(regs[0], 0, 'init was handed song 1 as a zero-based number');

  eq(screenText(machine, 3, 2, 9), 'TEST TUNE', 'the title is on screen');
  eq(screenText(machine, 4, 2, 10), 'A COMPOSER', 'the author is on screen');
  eq(screenText(machine, 7, 2, 4), 'SONG', 'the song label is on screen');
  eq(screenText(machine, 7, 7, 5), '01/03', 'song one of three');
  eq(screenText(machine, 7, 25, 4), '8580', 'the chip the header asks for');
  eq(screenText(machine, 7, 31, 4), 'PAL ', 'and the clock');
  assert(screenText(machine, 7, 16, 5) !== '00:00', 'the clock is running');
}

// ── the tune keeps playing, and the counter keeps up ─────────────────────────
{
  const { data } = sidToPrg(makeSid());
  const machine = run(data, 60);
  const early = machine.mem.ram[0x0340];
  for (let i = 0; i < 60; i++) machine.runFrame();
  assert(machine.mem.ram[0x0340] > early, 'play is still being called sixty frames later');
}

// ── an RSID opens on the safe view, where nothing is intercepted ─────────────
{
  const { data } = sidToPrg(makeSid({ format: 'RSID' }));
  const machine = run(data, 120);
  assert(machine.mem.sid.regs[1] > 0, 'the driver reaches the SID directly');
  eq(screenText(machine, 22, 2, 9), 'F1 VOICES', 'and F1 offers the other view');
}

// ── starting song, and what the wrapper refuses ──────────────────────────────
{
  const { data } = sidToPrg(makeSid({ songs: 9, startSong: 4 }));
  const machine = run(data, 90);
  eq(screenText(machine, 7, 7, 5), '04/09', 'the file names which song starts');
  eq(machine.mem.sid.regs[0], 3, 'and init is handed it zero-based');
}
{
  const over = makeSid();
  over[0x7C] = 0xF0; over[0x7D] = 0xBF;       // loads at $BFF0, running into the player
  let threw = null;
  try { sidToPrg(over); } catch (error) { threw = error.message; }
  assert(/player/.test(threw || ''), `a tune over $C000 is refused, said: ${threw}`);

  const onScreen = makeSid();
  onScreen[0x7C] = 0x00; onScreen[0x7D] = 0x05;
  threw = null;
  try { sidToPrg(onScreen); } catch (error) { threw = error.message; }
  assert(/screen/.test(threw || ''), `a tune over screen memory is refused, said: ${threw}`);

  threw = null;
  try { sidToPrg(new Uint8Array([...'MUS!'].map(c => c.charCodeAt(0)), 200)); } catch (error) { threw = error.message; }
  assert(threw !== null, 'a file that is not a .sid is refused');
}

console.log(failures ? `${failures} failure(s)` : 'sid-player-test: all checks passed');
process.exit(failures ? 1 : 0);
