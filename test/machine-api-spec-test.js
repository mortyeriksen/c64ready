// Spec test for the C64Machine surface that main.js drives directly: the
// keyboard-buffer injections and the auto-RUN that follows a trapped LOAD, the
// debug snapshot, the tape / cartridge / drive-9 pass-throughs, and the guards
// on construction and soft reset. The ROM half is skipped when the ROMs are not
// available.
import { existsSync, readFileSync } from 'node:fs';
import { C64Machine } from '../src/machine.js';
import { createPRGDisk } from '../src/d64.js';

let failed = 0;
function expect(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
const ok = (label) => console.log(`ok  - ${label}`);

const KEYBUF = (m) => {
  const n = m.mem.ram[0xC6];
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(m.mem.ram[0x0277 + i]);
  return s;
};

function screenText(m) {
  let s = '';
  for (let i = 0; i < 1000; i++) {
    const c = m.mem.ram[0x0400 + i] & 0x7F;
    s += c < 32 ? String.fromCharCode(c + 64) : c < 64 ? String.fromCharCode(c) : ' ';
    if (i % 40 === 39) s += '\n';
  }
  return s;
}

// ── Guards ───────────────────────────────────────────────────────────────────
{
  const SAB = globalThis.SharedArrayBuffer;
  delete globalThis.SharedArrayBuffer;
  let msg = '';
  try { new C64Machine(); } catch (e) { msg = e.message; }
  globalThis.SharedArrayBuffer = SAB;
  expect(/SharedArrayBuffer/.test(msg) && /COOP|COEP/.test(msg), `without SharedArrayBuffer construction says what is missing (${msg})`);

  const m = new C64Machine();
  let threw = false;
  try { m.softReset(); } catch { threw = true; }
  expect(threw, 'softReset() without allowSoft is refused');
  m.softReset({ allowSoft: true });
  ok('construction and soft reset are guarded');

  // ── Keyboard-buffer injection ──
  m.injectSys(2061);
  expect(KEYBUF(m) === 'SYS2061\r', `injectSys types SYS<addr> and RETURN (${JSON.stringify(KEYBUF(m))})`);
  m.injectRun();
  expect(KEYBUF(m) === 'RUN\r', 'injectRun types RUN and RETURN');
  m.injectLoadAndRun();
  expect(KEYBUF(m) === 'LOAD"*",8,1\r' && m._pendingAutoRun === true,
    'injectLoadAndRun fills the whole 10+ byte buffer and arms the RUN for later');
  m._pendingAutoRun = false;
  ok('keyboard-buffer injections');

  // ── Cartridge pass-throughs with no cartridge ──
  expect(m.setCartridgeFreeze(true) === false && m.setCartridgeFreeze(false) === false, 'no cartridge: nothing to freeze');
  expect(m.resetCartridge() === false, 'no cartridge: nothing to reset');
  m.ejectCartridge();
  expect(m.mem.cartridge == null, 'ejecting nothing leaves no cartridge');
  ok('cartridge pass-throughs are safe with the slot empty');

  // ── Tape pass-throughs ──
  expect(m.setTapeKey('REC') === false, 'RECORD on an empty deck is refused');
  m.newBlankTape();
  expect(m.datasette.hasMedia, 'a blank tape is loaded');
  expect(m.setTapeKey('PLAY') === true && m.datasette.playPressed, 'PLAY goes down');
  m.seekTapeFraction(0.5);
  m.seekTapeSeconds(0);
  m.rewindTape();
  expect(!m.datasette.playPressed, 'REWIND lifts PLAY');
  m.setTapeWriteProtected(true);
  expect(m.datasette.writeProtected === true && m.setTapeKey('REC') === false, 'a protected tape refuses RECORD');
  m.setTapeWriteProtected(false);
  expect(m.setTapeKey('REC') === true, 'unprotected, RECORD goes down');
  m.setTapeKey('STOP');
  m.ejectTape();
  expect(!m.datasette.hasMedia, 'EJECT empties the deck');
  expect(m.hasUnsavedDiskWrites() === false, 'no drive: nothing unsaved');
  ok('tape pass-throughs reach the deck');

  // ── SID write trace (a console tool) ──
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    m.sidTraceStart(3);
    m._sidWrite(0x18, 0x0F);
    m._sidWrite(0x04, 0x11);
    m._sidWrite(0x18, 0x00);
    m._sidWrite(0x18, 0x0F);          // past the count: not recorded
    const all = m.sidTraceDump();
    const vol = m.sidTraceDump(0x18);
    expect(all.length === 3 && vol.length === 2 && vol.every(r => r[1] === 0x18), `the trace keeps n writes and filters by register (${all.length}/${vol.length})`);
    expect(lines.some(l => /capturing next 3/.test(l)) && lines.some(l => /3 events/.test(l)) && lines.some(l => /for reg \$18/.test(l)), 'and reports on the console');
    expect(m.sidTraceDump(0x05).length === 0, 'a register never written yields nothing');
  } finally {
    console.log = realLog;
  }
  ok('SID write trace');

  // ── Snapshot with no ROMs and no drive ──
  const snap = m.snapshot();
  expect(snap.version === 2 && typeof snap.timestamp === 'string', 'snapshot is versioned and stamped');
  expect(typeof snap.memory.ram === 'string' && snap.memory.kernalLoaded === false, 'memory rides along as base64, with the ROM flags');
  expect(Array.isArray(snap.vic2.regs) && Array.isArray(snap.vic2.sprite.mc) && snap.vic2.internal && typeof snap.vic2.internal.fb32 === 'string',
    'VIC registers, sprite state and internals are captured');
  expect(snap.cia1.tod && snap.cia2.tod, 'both CIAs with their clocks');
  expect(snap.drive1541 === null, 'no drive: null');
  expect(snap.vicFrameDebug.traceEnabled === false && Array.isArray(snap.vicFrameDebug.frameTraceD012Writes), 'the frame trace block is present even when off');
  JSON.stringify(snap);   // must be serialisable
  ok('snapshot without ROMs or drive');
}

// ── With the ROMs: a trapped LOAD prints what the KERNAL prints, then RUNs ──
const ROMS = ['roms/kernal.bin', 'roms/basic.bin', 'roms/chargen.bin', 'roms/1541.bin'];
if (!ROMS.every(existsSync)) {
  console.log('ok  - LOAD-trap and drive checks # SKIP C64/1541 ROMs not available');
} else {
  const rom = (f) => new Uint8Array(readFileSync(f));
  const m = new C64Machine();
  m.loadROMs({ kernal: rom(ROMS[0]), basic: rom(ROMS[1]), charRom: rom(ROMS[2]) });
  m.attachDrive(rom(ROMS[3]));
  m.setTrueDrive(false);                 // the $FFD5 trap serves device 8
  // 10 PRINT "HI"
  const prg = Uint8Array.from([0x01, 0x08, 0x0B, 0x08, 0x0A, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
  const disk = createPRGDisk('HI', prg);
  expect(disk, 'the one-file disk is built');
  m.setD64(disk);

  const ready = () => { const r = m.mem.ram; return r[0xC6] === 0 && r[0xCC] === 0 && r[0x2C] === 0x08; };
  for (let f = 0; f < 500 && !ready(); f++) m.runFrame();
  expect(ready(), 'the C64 reaches READY');

  m.injectLoadAndRun();
  let text = '';
  for (let f = 0; f < 800; f++) {
    m.runFrame();
    if (f > 30 && !m._pendingAutoRun && ready()) { text = screenText(m); if (/^HI\s*$/m.test(text)) break; }
  }
  text = screenText(m);
  expect(/SEARCHING FOR \*/.test(text), 'the KERNAL\'s own SEARCHING FOR line is printed');
  expect(/\nLOADING\s*\n/.test(text), 'and LOADING');
  expect(/^HI\s*$/m.test(text), `the armed RUN ran the program (screen:\n${text.trimEnd()})`);
  expect(m._pendingAutoRun === false, 'the RUN is used once');
  ok('LOAD"*",8,1 through the trap prints the messages and auto-runs');

  // A missing file comes back as FILE NOT FOUND through the same trap.
  const cmd = 'LOAD"NOPE",8\r';
  for (let i = 0; i < cmd.length; i++) m.mem.ram[0x0277 + i] = cmd.charCodeAt(i);
  m.mem.ram[0xC6] = cmd.length;
  for (let f = 0; f < 300; f++) { m.runFrame(); if (f > 30 && ready() && /FILE NOT FOUND/.test(screenText(m))) break; }
  expect(/FILE NOT FOUND/.test(screenText(m)), 'a name the disk does not hold ends in FILE NOT FOUND');
  ok('trap-served LOAD of a missing file');

  // ── Snapshot with the drive attached ──
  const snap = m.snapshot();
  expect(snap.drive1541 && typeof snap.drive1541.ram === 'string' && snap.drive1541.cpu && Array.isArray(snap.drive1541.via1Regs),
    'the drive state rides along');
  expect(snap.memory.kernalLoaded && snap.memory.basicLoaded && snap.memory.charRomLoaded, 'the ROM flags read true');
  expect(snap.drive1541.enabled === false, 'and says whether true drive emulation is on');
  ok('snapshot with a drive');

  // ── Drive 9 on and off the bus ──
  m.attachDrive9(rom(ROMS[3]));
  expect(m.drive1541b && m.drive1541b !== m.drive1541, 'a second drive is connected');
  const second = m.drive1541b;
  m.attachDrive9(rom(ROMS[3]));
  expect(m.drive1541b === second, 'connecting again is a no-op');
  m.detachDrive9();
  expect(m.drive1541b === null, 'and it can be taken off the bus');
  m.detachDrive9();
  expect(m.hasUnsavedDiskWrites() === false, 'a write-protected PRG disk has nothing unsaved');
  ok('drive 9 attach / detach');

  // ── Settling both CPUs on an instruction boundary under TDE ──
  m.setTrueDrive(true);
  m._quiesceToBoundary();
  expect(m.cpu.atInstructionBoundary() && m.drive1541.cpu.atInstructionBoundary(),
    'with true drive emulation on, both CPUs come to rest between instructions');
  ok('quiesce to a joint instruction boundary');
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('machine api spec: PASS');
