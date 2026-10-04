// Spec test for the UI facade (src/machine-facade.js) and the NEOS mouse that
// the machine runs itself.
//
//   1. state.js rebuilds `c64` with every setMachine, and it forwards to the
//      machine it was built for: keyboard matrix, RESTORE, joystick bytes,
//      paddles, pot lines, char ROM.
//   2. Each call looks its chip up afresh, so a rewrapped cia1.setKey (the
//      browser keyboard check does this) is the one reached.
//   3. NEOS: the machine advances the strobe sequencer on CIA1 port writes and
//      drives the port byte and POTX itself, for both ports.
//   4. Device views (tape, drives, REU) read live and are read-only; the debug
//      namespace reaches VIC flags, traces and bus latches.
//   5. Guard: UI modules moved onto the facade do not reach into the raw
//      machine or its chips.
import { readFileSync } from 'node:fs';
import { C64Machine } from '../src/machine.js';
import { machine, c64, setMachine } from '../src/state.js';
import { MachineFacade } from '../src/machine-facade.js';

let failed = 0;
function expect(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
const ok = (label) => console.log(`ok  - ${label}`);

// ── 1. Rebuilt with the machine, forwards to it ─────────────────────────────
{
  const m = new C64Machine();
  setMachine(m);
  expect(c64 instanceof MachineFacade && c64.machine === m && machine === m,
    'setMachine builds a facade over the new machine');

  c64.setKey(3, 5, true);
  expect(m.cia1.isKeyDown(3, 5) && c64.isKeyDown(3, 5), 'setKey presses the matrix key');
  c64.setKey(1, 7, true);
  c64.releaseAllKeys();
  expect(!c64.isKeyDown(3, 5) && !c64.isKeyDown(1, 7), 'releaseAllKeys clears the matrix');

  c64.setRestore(true);
  expect(m._nmiSources.restore === true, 'setRestore asserts the RESTORE NMI source');
  c64.setRestore(false);
  expect(m._nmiSources.restore === false, 'setRestore releases it');

  c64.setJoystick(1, 0xEF);
  c64.setJoystick(2, 0xFE);
  expect(m.joyPort1 === 0xEF && m.joyPort2 === 0xFE, 'setJoystick writes each port byte');

  c64.setPaddles(0x12, 0x34);
  expect(m.paddleX === 0x12 && m.paddleY === 0x34 && c64.paddleX === 0x12 && c64.paddleY === 0x34,
    'setPaddles writes POTX/POTY and the getters read them back');
  c64.setPotConnected(true);
  expect(m.potConnected === true, 'setPotConnected wires the pot lines');

  expect(c64.charRom() === null, 'charRom is null before the ROMs are loaded');
  const chargen = new Uint8Array(4096);
  m.mem.charRom = chargen;
  expect(c64.charRom() === chargen, 'charRom returns the loaded ROM');

  const prev = c64;
  setMachine(new C64Machine());
  expect(c64 !== prev && c64.machine === machine, 'a new machine gets a new facade');
  setMachine(null);
  expect(c64 === null, 'no machine, no facade');
  ok('facade forwards to the machine and is rebuilt with it');
}

// ── 2. Chips are looked up per call ─────────────────────────────────────────
{
  const m = new C64Machine();
  setMachine(m);
  const calls = [];
  const original = m.cia1.setKey;
  m.cia1.setKey = function (...args) { calls.push(args); return original.apply(this, args); };
  c64.setKey(2, 2, true);
  expect(calls.length === 1 && calls[0][0] === 2 && calls[0][1] === 2 && calls[0][2] === true,
    'a rewrapped cia1.setKey is reached through the facade');
  ok('facade looks chips up on every call');
}

// ── 3. NEOS mouse in the machine ────────────────────────────────────────────
// Strobe mode: DDR bit 4 output, bits 0-3 input. Each FIRE-bit edge steps the
// readout Xhi → Xlo → Yhi → Ylo; the wrap to Xhi snapshots the pending motion.
function neosReadout(m, port) {
  const cia = m.cia1;
  const ddrReg = port === 2 ? 0x02 : 0x03;
  const dataReg = port === 2 ? 0x00 : 0x01;
  const joy = () => (port === 2 ? m.joyPort2 : m.joyPort1);
  cia.write(ddrReg, 0x10);
  const nibbles = [];
  let level = 0x10;
  for (let i = 0; i < 4; i++) {
    level ^= 0x10;
    cia.write(dataReg, level);
    nibbles.push(joy() & 0x0F);
    expect((joy() & 0xF0) === 0xF0, `port ${port} strobe byte keeps bits 4-7 high`);
  }
  const x = ((nibbles[0] << 4) | nibbles[1]) << 24 >> 24;
  const y = ((nibbles[2] << 4) | nibbles[3]) << 24 >> 24;
  return { x, y };
}

for (const port of [2, 1]) {
  const m = new C64Machine();
  setMachine(m);
  const joy = () => (port === 2 ? m.joyPort2 : m.joyPort1);

  m.cia1.write(port === 2 ? 0x00 : 0x01, 0x10);
  expect(joy() === 0xFF, `port ${port}: with no NEOS plugged in, port writes leave the joystick byte alone`);
  expect(m.potXOverride === null, `port ${port}: no NEOS, no POTX override`);

  c64.setNeosPort(port, true);
  expect(m.potXOverride === 0x00, `port ${port}: a plugged-in NEOS drives POTX released ($00)`);
  c64.neosMove(port, 5, -3);
  const r = neosReadout(m, port);
  expect(r.x === -5 && r.y === 3, `port ${port}: host motion (5,-3) reads back inverted as (${r.x},${r.y})`);
  expect(c64.neosPortByte(port) === joy(), `port ${port}: neosPortByte matches the driven byte`);

  c64.neosMove(port, 200, 0);
  expect(neosReadout(m, port).x === -128, `port ${port}: the snapshot clamps to -128`);

  m.cia1.write(port === 2 ? 0x02 : 0x03, 0x00);    // button-read mode
  c64.setNeosButtons(port, true, false);
  expect(c64.neosPortByte(port) === 0xEF && c64.neosButtonsDown(port), `port ${port}: left button on FIRE`);
  c64.setNeosButtons(port, false, true);
  expect(m.potXOverride === 0xFF && c64.neosButtonsDown(port), `port ${port}: right button drives POTX to $FF`);

  c64.neosResetPort(port);
  expect(!c64.neosButtonsDown(port) && m.potXOverride === 0x00, `port ${port}: reset drops the buttons`);

  c64.setNeosPort(port, false);
  expect(m.potXOverride === null && c64.neosPortByte(port) === 0xFF, `port ${port}: unplugging clears POTX and the port`);
  ok(`NEOS on port ${port} runs in the machine`);
}

// A restored state carries its own POTX override; the per-frame re-assert
// (input.js updateJoyPorts -> applyNeosPotX) hands POTX back to the mouse that
// is plugged in now, in both directions.
{
  const plain = new C64Machine();
  const stateNoNeos = plain.serializeState();
  const m = new C64Machine();
  setMachine(m);
  c64.setNeosPort(2, true);
  m.restoreState(stateNoNeos);
  expect(m.potXOverride === null, 'restore brings back the saved (absent) override');
  c64.applyNeosPotX();
  expect(m.potXOverride === 0x00, 'the re-assert reports the plugged-in NEOS, right button up');

  c64.setNeosButtons(2, false, true);
  const stateRmb = m.serializeState();
  const fresh = new C64Machine();
  setMachine(fresh);
  fresh.restoreState(stateRmb);
  expect(fresh.potXOverride === 0xFF, 'restore brings back the saved right-button override');
  c64.applyNeosPotX();
  expect(fresh.potXOverride === null, 'with no NEOS plugged in, the re-assert clears it');
  ok('NEOS POTX re-assert after a state restore');
}

// Port 1's CIA register is also the lightpen line: the NEOS hook must not
// replace that wiring.
{
  const m = new C64Machine();
  setMachine(m);
  c64.setNeosPort(1, true);
  const levels = [];
  const orig = m.vic2.setLightpenLevel.bind(m.vic2);
  m.vic2.setLightpenLevel = (lvl) => { levels.push(lvl); orig(lvl); };
  m.cia1.write(0x03, 0x10);
  m.cia1.write(0x01, 0x00);
  expect(levels.length === 2 && levels[1] === 0, 'CIA1 port B writes still drive the lightpen line');
  ok('NEOS on port 1 keeps the lightpen wiring');
}

// ── 4. Device views and debug namespace ─────────────────────────────────────
{
  const m = new C64Machine();
  setMachine(m);
  const tape = c64.tape;
  expect(tape.hasMedia === false && tape.key === m.datasette.key, 'tape view reads the deck');
  m.datasette.dirty = true;
  expect(tape.dirty === true, 'tape view reads live state');
  tape.markSaved();
  expect(m.datasette.dirty === false, 'markSaved clears dirty');
  let threw = false;
  try { tape.dirty = true; } catch { threw = true; }
  expect(threw && m.datasette.dirty === false, 'tape view is read-only');
  c64.newBlankTape();
  expect(tape.hasMedia && c64.tape === tape, 'the same tape view follows a newly inserted tape');

  expect(c64.drive(8) === null && c64.drive(9) === null, 'no drive attached, no drive view');
  expect(c64.reu === null, 'no REU fitted, no REU view');
  c64.attachReu();
  const reu = c64.reu;
  expect(reu && reu.ram === m.reu.ram && reu.activityTick === m.reu.activityTick, 'REU view reads the fitted unit');
  reu.ram[0] = 0x5A;
  reu.clearRam();
  expect(m.reu.ram[0] === 0, 'clearRam wipes expansion RAM');
  c64.detachReu();
  expect(c64.reu === null && reu.ram === null, 'detaching the REU empties its view');

  expect(c64.ram() === m.mem.ram, 'ram() is the machine RAM');
  expect(c64.cartridgeInserted === false, 'no cartridge inserted');
  expect(c64.frameBuffer() === m.vic2.frameBuffer, 'frameBuffer() is the VIC frame');
  c64.vicVariant = '8565';
  expect(m.vic2.vicVariant === '8565' && c64.vicVariant === '8565', 'vicVariant reads and writes the VIC model');

  const before = Atomics.load(m.sidCtrl, 0);
  c64.writeSid(0x18, 0x0F);
  expect(Atomics.load(m.sidCtrl, 0) !== before, 'writeSid queues a write on the SID ring');

  c64.debug.setVicFlag('nmosBankDelay', true);
  expect(m.vic2.nmosBankDelay === true && c64.debug.getVicFlag('nmosBankDelay'), 'debug VIC flags read and write the VIC');
  threw = false;
  try { c64.debug.getVicFlag('raster'); } catch { threw = true; }
  expect(threw, 'unknown VIC flags are refused');
  c64.debug.enableBusTrace(64);
  expect(c64.debug.busTraceEnabled && c64.debug.busTraceDepth === 64, 'debug bus trace toggles');
  c64.debug.disableBusTrace();
  const latches = c64.debug.busLatches();
  expect(typeof latches.externalDataBus8 === 'number' && typeof latches.vicInternalBus === 'number', 'busLatches reports both latches');
  ok('device views and debug namespace');
}

// ── 5. Migrated modules stay on the facade ──────────────────────────────────
// Strings are blanked first (template ${...} expressions are kept), so status
// text and labels that mention the machine don't count.
{
  const RAW = /\bmachine\s*\??\.|window\.machine\b|(?<!\b(?:loader|roms)\??)\.(cia1|cia2|vic2|cpu|mem|datasette|drive1541b?)\b|\b(joyPort[12]|potXOverride|sidCycleCounter|_sidWrite)\b/;
  const stripStrings = code => code
    .replace(/`(?:\\.|[^`\\])*`/g, t => (t.match(/\$\{[^}]*\}/g) || []).join(' '))
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  // loader.drive1541 / roms.drive1541 are the 1541 ROM image, not the drive.
  // main.js builds the machine and exposes it to the DevTools console.
  const ALLOWED = [/^\s*machine, c64, loader,/, /window\.machine = machine;/];
  const FILES = [
    'src/input.js', 'src/vibes/keycap-press.js', 'src/media.js', 'src/main.js',
    'src/debug.js', 'src/ui/tape-scope.js', 'src/av-marker.js',
  ];
  for (const file of FILES) {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || ALLOWED.some(re => re.test(line))) return;
      const code = stripStrings(line).replace(/\/\/.*$/, '');
      expect(!RAW.test(code), `${file}:${i + 1} reaches past the facade: ${line.trim()}`);
    });
  }
  ok('UI modules use only the facade');
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall machine-facade checks passed');
