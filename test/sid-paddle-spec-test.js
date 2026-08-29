// sid-paddle-spec-test.js — Locks down the POTX/POTY ($D419/$D41A)
// sample-and-hold timing. Real SID samples the paddle pins via an
// internal 512-cycle RC-discharge ADC; software reading $D419/$D41A
// always sees the LATCHED sample, not the live paddle pin voltage.
// Paddle-driven games (Arkanoid clones, paddle-control demos) poll
// these registers tightly and expect the same byte for ~512 cycles
// between samples.

import { C64Machine } from '../src/machine.js';
import fs from 'node:fs';

let testNo = 0, fails = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (current.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    fails++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// Read $D419 / $D41A through the SIDProxy. The Memory class wires the
// SID at $D400-$D7FF; we can read directly via mem.read.
function readPotX(machine) { return machine.mem.sid.read(0x19); }
function readPotY(machine) { return machine.mem.sid.read(0x1A); }

function step(machine, n) {
  for (let i = 0; i < n; i++) machine._runMasterCycle();
}

// A machine with a paddle plugged into a control port. Without this the pot
// lines are open and read $FF (test 1) — input.js sets potConnected from the
// selected devices, so headless tests have to say so explicitly.
function withPaddle() {
  const m = new C64Machine();
  m.potConnected = true;
  return m;
}

// ── 1: nothing on the pot lines reads $FF, a connected paddle reads mid-range ─
// $FF is how real hardware and VICE report open pot pins, and how software
// detects "no paddle present" (e.g. the Final Cartridge 3 mouse probe).
{
  const m = new C64Machine();
  expect(readPotX(m) === 0xFF, `POTX with nothing connected reads $ff, got $${readPotX(m).toString(16)}`);
  expect(readPotY(m) === 0xFF, `POTY with nothing connected reads $ff, got $${readPotY(m).toString(16)}`);
  m.potConnected = true;
  expect(readPotX(m) === 0x80, `POTX with a paddle connected reads $80 (mid-range), got $${readPotX(m).toString(16)}`);
  expect(readPotY(m) === 0x80, `POTY with a paddle connected reads $80 (mid-range), got $${readPotY(m).toString(16)}`);
  ok('POTX/POTY read $ff when open, $80 mid-range once a paddle is connected');
}

// ── 2: Mouse motion does NOT update the SID-readable register immediately ──
// The sample-and-hold means software sees the previous sampled value
// until the next 512-cycle boundary.
{
  const m = withPaddle();
  // Move "mouse" to extreme positions.
  m.paddleX = 0x00;
  m.paddleY = 0xFF;
  // Without running any cycles, the latched register hasn't been updated.
  expect(readPotX(m) === 0x80,
    `POTX still shows pre-motion sample ($80), got $${readPotX(m).toString(16)}`);
  expect(readPotY(m) === 0x80,
    `POTY still shows pre-motion sample ($80), got $${readPotY(m).toString(16)}`);
  ok('POTX/POTY do not update on live paddle move (sample-and-hold gates the change)');
}

// ── 3: After ≥ 512 master cycles, the sample-and-hold latches the new value ─
{
  const m = withPaddle();
  m.paddleX = 0x42;
  m.paddleY = 0xAB;
  // Step exactly 512 cycles — should trigger one sample-and-hold latch.
  step(m, 512);
  expect(readPotX(m) === 0x42,
    `POTX latched after 512 cycles: expected $42, got $${readPotX(m).toString(16)}`);
  expect(readPotY(m) === 0xAB,
    `POTY latched after 512 cycles: expected $ab, got $${readPotY(m).toString(16)}`);
  ok('POTX/POTY latch the live paddle value after 512 master cycles');
}

// ── 4: Sample-and-hold gates mid-period mouse motion ──────────────────
// Move the mouse, run 511 cycles (one short of the latch), check the
// previous value is still readable. Then run 1 more — latch fires.
{
  const m = withPaddle();
  m.paddleX = 0x10;
  step(m, 512);                            // latch at cycle 512: potX=$10
  expect(readPotX(m) === 0x10, `POTX latched $10 at cycle 512`);

  m.paddleX = 0x90;                        // mouse moved
  step(m, 511);                            // 511 cycles after the previous latch
  expect(readPotX(m) === 0x10,
    `POTX still $10 at +511 cycles (sample-and-hold gates the new value), got $${readPotX(m).toString(16)}`);

  step(m, 1);                              // crosses the 512-cycle boundary
  expect(readPotX(m) === 0x90,
    `POTX latches $90 at +512 cycles, got $${readPotX(m).toString(16)}`);
  ok('POTX held for 511 cycles, latched at exactly cycle 512 of the period');
}

// ── 5: Sample-and-hold survives KERNAL boot ───────────────────────────
// Real software does the paddle read after machine has booted. Verify
// the sample-and-hold runs throughout boot and a paddle write before
// boot is reflected after.
{
  const m = withPaddle();
  const kernal  = fs.readFileSync('roms/kernal.bin');
  const basic   = fs.readFileSync('roms/basic.bin');
  const charRom = fs.readFileSync('roms/chargen.bin');
  m.loadROMs({ kernal, basic, charRom });

  m.paddleX = 0xCC;
  m.paddleY = 0x33;

  // Run 30 frames (≈ 590k master cycles). Sample-and-hold will fire
  // ~1150 times, all latching the same paddleX/paddleY values.
  for (let i = 0; i < 30; i++) m.runFrame();

  expect(readPotX(m) === 0xCC,
    `POTX reflects $cc after boot, got $${readPotX(m).toString(16)}`);
  expect(readPotY(m) === 0x33,
    `POTY reflects $33 after boot, got $${readPotY(m).toString(16)}`);
  ok('POTX/POTY converge to the live paddle value through KERNAL boot');
}

// ── 6: potXOverride wins on $D419 and leaves $D41A open ────────────────
// A NEOS mouse reports its right button on POTX as a whole byte and connects
// nothing to POTY, so the override takes POTX regardless of potConnected while
// POTY keeps reading the open-pin value.
{
  const m = new C64Machine();
  m.potConnected = false;
  m.potXOverride = 0xFF;                       // right button down
  expect(readPotX(m) === 0xFF, `override drives POTX, got $${readPotX(m).toString(16)}`);
  expect(readPotY(m) === 0xFF, `POTY stays open ($ff), got $${readPotY(m).toString(16)}`);
  m.potXOverride = 0x00;                       // released
  expect(readPotX(m) === 0x00, `override of $00 must read $00, not the open-pin $ff`);

  // The override beats a connected paddle too, and clearing it hands POTX back.
  m.potConnected = true;
  m.paddleX = 0x42;
  step(m, 512);
  expect(readPotX(m) === 0x00, `override still wins over a latched paddle sample`);
  m.potXOverride = null;
  expect(readPotX(m) === 0x42,
    `clearing the override restores the paddle sample, got $${readPotX(m).toString(16)}`);
  ok('POTX override wins over paddle and open-pin, restores on clear; POTY unaffected');
}

// ── 7: the pot gates survive a state round-trip ─────────────────────────
// Both gates sit in the snapshot's sid block alongside paddleX/Y and the
// sample-and-hold, so a restored machine reproduces the same $D419/$D41A reads
// without an input layer running. Snapshots predating them load as "open".
{
  const a = new C64Machine();
  a.potConnected = true;
  a.potXOverride = 0xFF;
  a.paddleX = 0x42; a.paddleY = 0x7E;
  step(a, 512);
  const snap = JSON.parse(JSON.stringify(a.serializeState()));

  const b = new C64Machine();
  b.restoreState(snap);
  expect(b.potConnected === true, `potConnected must round-trip`);
  expect(b.potXOverride === 0xFF, `potXOverride must round-trip, got ${b.potXOverride}`);
  expect(readPotX(b) === 0xFF, `restored override drives POTX`);
  expect(readPotY(b) === 0x7E, `restored POTY serves the latched sample, got $${readPotY(b).toString(16)}`);

  // An older snapshot has neither field: default to open pins, no override.
  const old = JSON.parse(JSON.stringify(snap));
  delete old.sid.potConnected; delete old.sid.potXOverride;
  const c = new C64Machine();
  c.restoreState(old);
  expect(c.potConnected === false, `a snapshot without the gates loads as not connected`);
  expect(c.potXOverride === null, `a snapshot without the gates loads with no override`);
  expect(readPotX(c) === 0xFF && readPotY(c) === 0xFF, `and both pins read open`);
  ok('pot gates round-trip through save state; older snapshots default to open');
}

console.log(`\n${testNo} paddle/POT tests; ${fails} fail`);
if (fails > 0) process.exit(1);
