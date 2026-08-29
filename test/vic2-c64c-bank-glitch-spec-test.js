// C64C / 8565 glue-logic bank-transition glitch, opt-in via
// `vic.c64cBankGlitch`.
//
// VIC-Addendum, "Video bank and C64C":
//   "The glue logic on a C64C will generate a glitch during 10 <-> 01
//    generating 00 (in other words, bank 3) for one cycle."
//
// In bank-index terms (= inverted PA1/PA0): bank 1 ($4000) and bank 2
// ($8000) are the 01 and 10 PA-pin patterns. A transition between them
// passes through pin pattern 00 (= bank 3, $C000) for one master cycle.
//
// Gated on:
//   - vic.c64cBankGlitch === true   (opt-in flag, default OFF)
//   - vic.vicVariant === '8565'     (variant-specific quirk)
//   - currentBank/newBank in {$4000, $8000} swap pattern
//
// Trigger source is direction-agnostic — PRA or DDRA writes both
// qualify, what matters is the resulting pin transition.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeVic({ c64cBankGlitch = false, vicVariant = '8565' } = {}) {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.c64cBankGlitch = c64cBankGlitch;
  vic.vicVariant = vicVariant;
  return vic;
}

// ── 1: flag OFF → bank 1 ↔ 2 transitions are immediate ────────────────
{
  const vic = makeVic({ c64cBankGlitch: false, vicVariant: '8565' });
  vic.currentVicBank = 0x4000;
  vic.noteBankChange(0x8000);
  expect(vic.currentVicBank === 0x8000,
    `flag OFF: bank flips $4000→$8000 directly (got $${vic.currentVicBank.toString(16)})`);
  ok('flag OFF: bank 1↔2 transitions are immediate (no glitch model)');
}

// ── 2: flag ON + 8565 + bank 1→2 → blip through bank 3 for 1 cycle ────
{
  const vic = makeVic({ c64cBankGlitch: true, vicVariant: '8565' });
  vic.currentVicBank = 0x4000;
  vic.noteBankChange(0x8000);
  expect(vic.currentVicBank === 0xC000,
    `step 0: bank latches to $C000 (1-cycle blip) immediately (got $${vic.currentVicBank.toString(16)})`);
  expect(vic._pendingBankApplyCycle >= 0,
    `step 0: a deferred apply for the real new bank is queued`);
  expect(vic._pendingBankValue === 0x8000,
    `step 0: deferred value is the actual target $8000 (got $${vic._pendingBankValue.toString(16)})`);
  // One vic.clock(1) advances totalCycles past the apply point.
  vic.clock(1);
  expect(vic.currentVicBank === 0x8000,
    `step 1: bank now at $8000 after one cycle (got $${vic.currentVicBank.toString(16)})`);
  expect(vic._pendingBankApplyCycle === -1,
    `step 1: pending bank consumed`);
  ok('flag ON + 8565 + bank 1→2: 1-cycle blip through bank 3 ($C000), then settles at $8000');
}

// ── 3: bank 2→1 (the other direction) also blips through $C000 ────────
{
  const vic = makeVic({ c64cBankGlitch: true, vicVariant: '8565' });
  vic.currentVicBank = 0x8000;
  vic.noteBankChange(0x4000);
  expect(vic.currentVicBank === 0xC000, `2→1: blip through $C000`);
  vic.clock(1);
  expect(vic.currentVicBank === 0x4000, `2→1: settles at $4000 (got $${vic.currentVicBank.toString(16)})`);
  ok('flag ON + 8565 + bank 2→1: symmetric glitch (same blip pattern)');
}

// ── 4: transitions NOT between bank 1 and bank 2 are immediate ────────
//      bank 0↔3, 0↔1, 0↔2, 1↔3, 2↔3 all bypass the glitch path.
{
  const vic = makeVic({ c64cBankGlitch: true, vicVariant: '8565' });
  const cases = [
    { from: 0x0000, to: 0x4000 },     // 0 → 1
    { from: 0x0000, to: 0x8000 },     // 0 → 2
    { from: 0x0000, to: 0xC000 },     // 0 → 3
    { from: 0x4000, to: 0xC000 },     // 1 → 3
    { from: 0x8000, to: 0xC000 },     // 2 → 3
    { from: 0x4000, to: 0x0000 },     // 1 → 0
  ];
  for (const { from, to } of cases) {
    vic.currentVicBank = from;
    vic._pendingBankApplyCycle = -1;
    vic.noteBankChange(to);
    expect(vic.currentVicBank === to,
      `bank $${from.toString(16)}→$${to.toString(16)}: direct, no glitch (got $${vic.currentVicBank.toString(16)})`);
    expect(vic._pendingBankApplyCycle === -1,
      `bank $${from.toString(16)}→$${to.toString(16)}: no pending state`);
  }
  ok('non-{1↔2} transitions bypass the glitch path');
}

// ── 5: flag ON but 6569 variant → no glitch ────────────────────────────
{
  const vic = makeVic({ c64cBankGlitch: true, vicVariant: '6569' });
  vic.currentVicBank = 0x4000;
  vic.noteBankChange(0x8000);
  expect(vic.currentVicBank === 0x8000,
    `6569 with flag on: still immediate (glitch is 8565-specific), got $${vic.currentVicBank.toString(16)}`);
  ok('glitch gated to 8565 — 6569 ignores the flag');
}

// ── 6: idempotent — noteBankChange to the SAME bank is a no-op ─────────
{
  const vic = makeVic({ c64cBankGlitch: true, vicVariant: '8565' });
  vic.currentVicBank = 0x4000;
  vic.noteBankChange(0x4000);
  expect(vic.currentVicBank === 0x4000, `same-bank noteBankChange: no change`);
  expect(vic._pendingBankApplyCycle === -1, `same-bank: no pending queued`);
  ok('same-bank noteBankChange is a no-op even with glitch flag on');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
