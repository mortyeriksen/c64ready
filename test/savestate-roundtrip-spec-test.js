// Save-state round-trip + deterministic-resume regression test.
//
// Exercises machine.serializeState() / restoreState() (the engine behind the
// Save State / Load State buttons). Three properties are asserted:
//   1. Restore is EXACT — RAM, color RAM, CPU registers, VIC + CIA state all
//      return to the captured values.
//   2. Resume is DETERMINISTIC — running N frames from a restored state
//      reproduces the same RAM as running N frames from the original (this is
//      what would catch a piece of execution-relevant state that we forgot to
//      serialize).
//   3. restoreState() rejects a foreign/newer payload.
//
// Runs headless in node (no IndexedDB / audio worklet needed — those are the
// statelibrary.js storage layer, exercised manually in the browser).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { C64Machine } from '../src/machine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function taEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function makeMachine() {
  const m = new C64Machine();
  m.loadROMs({
    kernal:  new Uint8Array(fs.readFileSync(path.join(repoRoot, 'roms/kernal.bin'))),
    basic:   new Uint8Array(fs.readFileSync(path.join(repoRoot, 'roms/basic.bin'))),
    charRom: new Uint8Array(fs.readFileSync(path.join(repoRoot, 'roms/chargen.bin'))),
  });
  return m;
}
function runFrames(m, n) { for (let i = 0; i < n; i++) m.runFrame(); }

// ── Boot to a settled state ───────────────────────────────────────────────────
const m = makeMachine();
runFrames(m, 150);   // past the cold-boot RAM test, sitting at the READY prompt

// Poke distinctive values so the restore assertions are meaningful.
m.mem.ram[0x4000] = 0xA5;
m.mem.ram[0x4001] = 0x5A;
m.mem.colorRam[0x100] = 0x0B;
m.vic2.regs[0x20] = 0x07;   // border colour = yellow
m.vic2.regs[0x21] = 0x00;   // background = black

// ── Capture ───────────────────────────────────────────────────────────────────
const st = m.serializeState();   // quiesces to an instruction boundary, then snapshots
const ram0     = m.mem.ram.slice();
const color0   = m.mem.colorRam.slice();
const cpu0     = { a: m.cpu.a, x: m.cpu.x, y: m.cpu.y, pc: m.cpu.pc, sp: m.cpu.sp,
                   p: m.cpu.getP() };
const vic0     = m.vic2.regs.slice();
const cia0     = { ta: m.cia1.timerA, tb: m.cia1.timerB, cra: m.cia1.cra,
                   icr: m.cia1.icrStatus, ta2: m.cia2.timerA };

// ── Advance, then restore ───────────────────────────────────────────────────--
const K = 12;
runFrames(m, K);
const ramK1 = m.mem.ram.slice();

// Mutate further so restore has something to undo.
m.mem.ram[0x4000] = 0x00;
m.mem.ram[0x4001] = 0x00;

m.restoreState(st);

// 1) RAM restored exactly.
{
  const d = firstDiff(m.mem.ram, ram0);
  expect(d === -1, `RAM mismatch after restore at $${(d).toString(16)} (got $${m.mem.ram[d]?.toString(16)}, want $${ram0[d]?.toString(16)})`);
  ok('RAM restored byte-exact');
}

// 2) Color RAM restored.
expect(taEqual(m.mem.colorRam, color0), 'color RAM mismatch after restore');
ok('color RAM restored byte-exact');

// 3) CPU registers restored.
expect(m.cpu.a === cpu0.a && m.cpu.x === cpu0.x && m.cpu.y === cpu0.y, 'CPU A/X/Y mismatch');
expect(m.cpu.pc === cpu0.pc, `CPU PC mismatch: $${m.cpu.pc.toString(16)} vs $${cpu0.pc.toString(16)}`);
expect(m.cpu.sp === cpu0.sp, 'CPU SP mismatch');
expect(m.cpu.getP() === cpu0.p, 'CPU status flags mismatch');
ok('CPU registers + flags restored');

// 4) VIC registers restored (incl. the poked $D020/$D021).
expect(taEqual(m.vic2.regs, vic0), 'VIC register file mismatch after restore');
expect(m.vic2.regs[0x20] === 0x07, '$D020 border colour not restored');
ok('VIC register file restored');

// 5) CIA timers / control / ICR restored.
expect(m.cia1.timerA === cia0.ta && m.cia1.timerB === cia0.tb, 'CIA1 timer A/B mismatch');
expect(m.cia1.cra === cia0.cra, 'CIA1 CRA mismatch');
expect(m.cia1.icrStatus === cia0.icr, 'CIA1 ICR status mismatch');
expect(m.cia2.timerA === cia0.ta2, 'CIA2 timer A mismatch');
ok('CIA timers + control restored');

// 6) Deterministic resume: K frames from the restored state reproduce the RAM
//    that the same K frames produced from the original capture point.
runFrames(m, K);
const ramK2 = m.mem.ram.slice();
{
  const d = firstDiff(ramK2, ramK1);
  expect(d === -1, `non-deterministic resume: RAM diverges at $${(d).toString(16)} after ${K} frames`);
  ok(`deterministic resume (${K} frames reproduce identical RAM)`);
}

// 7) Repeated restore is stable: re-restoring the original snapshot reproduces
//    the captured RAM again (and the captured snapshot wasn't mutated by use).
{
  m.restoreState(st);
  expect(taEqual(m.mem.ram, ram0), 'second restore did not reproduce RAM');
  ok('repeated restore is stable');
}

// 9) Restore must not change any object's hidden shape. Assigning a field that
//    the constructor never initialized adds a property post-construction, which
//    deoptimizes the shared prototype methods PROCESS-WIDE (this was a real 3×
//    slowdown after loading a sprite-heavy demo — a phantom VIC field). Build a
//    fresh machine (what the UI's _createAndWireMachine produces) and confirm
//    restoreState adds zero own-properties to the machine or any chip.
{
  const fresh = makeMachine();
  const targets = () => {
    const t = { machine: fresh, mem: fresh.mem, cpu: fresh.cpu, vic2: fresh.vic2,
                cia1: fresh.cia1, cia2: fresh.cia2, datasette: fresh.datasette };
    fresh.shadowVoices.forEach((v, i) => { t['shadowV' + (i + 1)] = v; });
    return t;
  };
  const before = {};
  for (const [k, o] of Object.entries(targets())) before[k] = new Set(Object.getOwnPropertyNames(o));
  fresh.restoreState(st);
  const grew = [];
  for (const [k, o] of Object.entries(targets())) {
    const added = Object.getOwnPropertyNames(o).filter(p => !before[k].has(p));
    if (added.length) grew.push(`${k}: +[${added.join(', ')}]`);
  }
  expect(grew.length === 0, `restore changed object shape (V8 deopt risk): ${grew.join(' | ')}`);
  ok('restore adds no new properties (no shared-method deopt)');
}

// 10) Bad payloads are rejected.
{
  let threwForeign = false, threwNewer = false;
  try { m.restoreState({ format: 'not-a-c64-state' }); } catch { threwForeign = true; }
  try { m.restoreState({ format: 'c64state', version: 999 }); } catch { threwNewer = true; }
  expect(threwForeign, 'restoreState accepted a foreign payload');
  expect(threwNewer, 'restoreState accepted a newer-version payload');
  ok('restoreState rejects foreign / newer payloads');
}

// 11) A tape being recorded survives the round trip.
// The recorded pulses live in the datasette's buffer until RECORD is released,
// so the caller bundles machine.exportTapBytes() as the media and the datasette
// state puts the head at the end of those bytes.
{
  const rec = makeMachine();
  rec.newBlankTape();
  expect(rec.setTapeKey('REC') === true, 'RECORD engaged on the blank tape');
  const ds = rec.datasette;
  ds.setMotor(true);
  // Five 384-cycle waves → four closed pulses (the first rising edge only opens
  // the measurement).
  ds.setWriteLine(0);
  for (let i = 0; i < 5; i++) {
    ds.setWriteLine(1); ds.clock(192);
    ds.setWriteLine(0); ds.clock(192);
  }
  const media = rec.exportTapBytes();
  const state = rec.serializeState();
  expect(media.length === 20 + 4, `four pulses recorded, got ${media.length - 20}`);
  // serializeState() quiesces to an instruction boundary, and with the motor
  // running that moves tape, so the still-open pulse is 384 cycles plus however
  // far it ran. Measure it rather than assume.
  const openUnits = Math.round((rec.datasette._tapeCycles - rec.datasette._lastEdgeCycle) / 8);

  const back = makeMachine();
  back.loadTap(media);
  back.restoreState(state);
  expect(taEqual(back.exportTapBytes(), media), 'restored tape holds the recorded pulses');
  expect(back.datasette.key === 'REC', 'the RECORD key is restored');
  expect(back.datasette.recording === true, 'the record session reopens');

  // Recording continues from the restored edge clock rather than re-arming it:
  // the tape sits a known distance past the last rising edge, so the very next
  // rising edge must close that pulse instead of silently starting over.
  const d2 = back.datasette;
  d2.setWriteLine(1);
  const grown = back.exportTapBytes();
  expect(grown.length === media.length + 1,
    `one rising edge closes one pulse (got ${grown.length - 20} pulses)`);
  expect(grown[grown.length - 1] === openUnits,
    `the reopened pulse measures the distance travelled: expected ${openUnits} units, `
    + `got ${grown[grown.length - 1]}`);
  expect(openUnits >= 48, `the open pulse is at least the 384 cycles written, got ${openUnits * 8}`);
  ok('save-state round trip keeps an in-progress tape recording');
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (testsFailing > 0) {
  console.log(`\n${testsFailing} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\nAll ${testNo} tests passed`);
}
