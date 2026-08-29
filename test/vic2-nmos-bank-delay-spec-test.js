// NMOS DDRA-bit-set bank-delay quirk, opt-in via `vic.nmosBankDelay`.
//
// VIC-Addendum, "Video bank and C64C":
//   "When using the data direction register to change a single bit 0->1
//    (in other words, decreasing the video bank number by 1 or 2), the
//    bank change is delayed by one cycle. This effect is unstable."
//
// Our baseline model already pipelines all bank changes by 1 cycle (a
// CPU phi2 write is first visible to VIC fetches on the next master
// cycle). The flag adds ONE EXTRA cycle of delay specifically for CIA2
// DDRA writes that turn PA0/PA1 from input (0) to output (1), and only
// on the 6569 variant. With the flag OFF, the existing same-cycle
// pipelined behavior is unchanged (cia2-vic-bank-spec-test.js +
// irq-cia2-dd02-bank-cycle-spec-test.js guard that).
//
// This test pins:
//   1. Flag OFF: DDRA 0→1 transition lands at the normal K+1 cycle.
//   2. Flag ON  + 6569 + 0→1 transition: bank visible at K+2 (one
//      extra cycle).
//   3. Flag ON  + 6569 + 1→0 transition (output→input): immediate
//      (delay does NOT apply — only the 0→1 direction is delayed).
//   4. Flag ON  + 8565 variant: no delay (the addendum quirk is
//      6569-specific).
//   5. Flag ON, PRA write (no DDRA change): no delay — the quirk is
//      about DDRA edges, not PRA.
//   6. A pending-delay write followed by an immediate-path write
//      before the delay expires: latest write wins, pending is
//      cancelled (no zombie bank apply on a later cycle).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';
import { CIA } from '../src/cia.js';

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

// Minimal rig: a VIC + a CIA2, with the same writePortA wiring as
// machine.js's NMOS-delay-aware bridge. No CPU — we drive cia.write()
// and vic.clock() by hand.
function makeRig({ nmosBankDelay = false, vicVariant = '6569' } = {}) {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.nmosBankDelay = nmosBankDelay;
  vic.vicVariant = vicVariant;

  const cia = new CIA();
  cia.writePortA = (val, viaDir = false, oldDdra = 0) => {
    const newBank = cia.vicBank;
    if (viaDir
        && vic.nmosBankDelay
        && vic.vicVariant === '6569'
        && ((~oldDdra & cia.portADir) & 0x03) !== 0) {
      vic.noteBankChange(newBank, /*delay=*/ 1);
    } else {
      vic.noteBankChange(newBank);
    }
  };
  return { vic, cia };
}

// Returns the master-cycle offset (relative to the cycle of the write)
// at which currentVicBank first equals `target`. 0 = same-cycle update,
// 1 = visible at the next vic.clock, 2 = two cycles later, etc.
function cyclesUntilBank(vic, target, maxLookahead = 10) {
  if (vic.currentVicBank === target) return 0;
  for (let i = 1; i <= maxLookahead; i++) {
    vic.clock(1);
    if (vic.currentVicBank === target) return i;
  }
  return -1;
}

// ── 1: flag OFF → DDRA 0→1 lands at K+1 (immediate, today's path) ─────
{
  const { vic, cia } = makeRig({ nmosBankDelay: false });
  cia.write(0x00, 0x00);                 // PRA = $00
  expect(vic.currentVicBank === 0x0000, `pre: bank $0000`);
  cia.write(0x02, 0x03);                 // DDRA bit 0,1 → 0→1: pins 00 → bank $C000
  // With the flag off, currentVicBank is updated synchronously inside
  // cia.write() — same as the existing model. cyclesUntilBank returns
  // 0 because the bank is already correct before any vic.clock().
  const c = cyclesUntilBank(vic, 0xC000);
  expect(c === 0, `flag OFF + DDRA 0→1: bank update synchronous (got ${c} cycle lookahead)`);
  ok('flag OFF → DDRA 0→1 transition updates currentVicBank same-cycle');
}

// ── 2: flag ON + 6569 + DDRA 0→1 → bank visible one extra cycle later ─
{
  const { vic, cia } = makeRig({ nmosBankDelay: true, vicVariant: '6569' });
  cia.write(0x00, 0x00);
  expect(vic.currentVicBank === 0x0000, `pre: bank $0000`);
  cia.write(0x02, 0x03);
  expect(vic.currentVicBank === 0x0000,
    `flag ON + DDRA 0→1: bank NOT yet updated at write time (got $${vic.currentVicBank.toString(16)})`);
  // Pending state is queued. Apply happens at the start of the SECOND
  // subsequent vic.clock(1) — the first clock leaves it deferred, the
  // second applies. (totalCycles+1+delay where delay=1 → +2 from the
  // write moment.)
  vic.clock(1);
  expect(vic.currentVicBank === 0x0000,
    `flag ON: still old bank after 1 cycle (got $${vic.currentVicBank.toString(16)})`);
  vic.clock(1);
  expect(vic.currentVicBank === 0xC000,
    `flag ON: new bank $C000 visible at the 2nd cycle (got $${vic.currentVicBank.toString(16)})`);
  ok('flag ON + 6569 + DDRA 0→1: bank visible one extra cycle later (K+2)');
}

// ── 3: flag ON + DDRA 1→0 (output→input) → immediate (no quirk) ────────
{
  const { vic, cia } = makeRig({ nmosBankDelay: true, vicVariant: '6569' });
  // Start in DDRA=$03 (both outputs) so we can then transition 1→0.
  cia.write(0x02, 0x03);                 // sets bank $C000
  // Drain the pending delay so we're at steady state.
  vic.clock(1); vic.clock(1);
  expect(vic.currentVicBank === 0xC000, `setup: bank $C000`);
  // Now flip both bits back to inputs — pure 1→0 transition.
  cia.write(0x02, 0x00);
  expect(vic.currentVicBank === 0x0000,
    `flag ON: DDRA 1→0 is immediate (no quirk applies to clearing bits), got $${vic.currentVicBank.toString(16)}`);
  ok('flag ON: DDRA 1→0 transitions use the immediate path');
}

// ── 4: flag ON but 8565 variant → no delay ────────────────────────────
{
  const { vic, cia } = makeRig({ nmosBankDelay: true, vicVariant: '8565' });
  cia.write(0x00, 0x00);
  cia.write(0x02, 0x03);                 // DDRA 0→1 — would delay on 6569
  expect(vic.currentVicBank === 0xC000,
    `flag ON + 8565: no delay (the quirk is 6569-specific), got $${vic.currentVicBank.toString(16)}`);
  ok('flag ON + 8565 variant: no extra delay (quirk gated to 6569)');
}

// ── 5: flag ON, PRA write (no DDRA edge) → no delay ────────────────────
{
  const { vic, cia } = makeRig({ nmosBankDelay: true, vicVariant: '6569' });
  cia.write(0x02, 0x03);                 // setup: DDRA outputs (1 delayed write)
  vic.clock(1); vic.clock(1);            // drain the pending delay
  expect(vic.currentVicBank === 0xC000, `setup: bank $C000`);
  // PRA write — no DDRA edge — must apply immediately even with flag on.
  cia.write(0x00, 0x03);                 // PRA = $03 → pins 11 → bank $0000
  expect(vic.currentVicBank === 0x0000,
    `flag ON + PRA write: immediate path (no DDRA edge), got $${vic.currentVicBank.toString(16)}`);
  ok('flag ON + PRA write only: no delay (DDRA edge not involved)');
}

// ── 6: pending delay is cancelled by a subsequent immediate write ─────
//      DDRA 0→1 queues a pending change; PRA write before the delay
//      expires must cancel the pending one (latest CPU intent wins).
{
  const { vic, cia } = makeRig({ nmosBankDelay: true, vicVariant: '6569' });
  cia.write(0x00, 0x00);
  cia.write(0x02, 0x03);                 // DDRA 0→1: pending → $C000 at K+2
  expect(vic.currentVicBank === 0x0000, `bank still $0000 (pending $C000)`);
  expect(vic._pendingBankApplyCycle >= 0, `pending bank queued`);
  // PRA write: changes PRA → pins 11 → bank $0000 (= current). The
  // immediate path also cancels the pending. After this, NO bank change
  // should ever fire — the pending was for $C000 and PRA wiped it.
  cia.write(0x00, 0x03);
  expect(vic.currentVicBank === 0x0000, `PRA write keeps bank at $0000`);
  expect(vic._pendingBankApplyCycle === -1,
    `pending cancelled by the immediate PRA write (got applyCycle=${vic._pendingBankApplyCycle})`);
  vic.clock(1); vic.clock(1); vic.clock(1);
  expect(vic.currentVicBank === 0x0000,
    `bank stays $0000 over the original pending window — pending was successfully cancelled`);
  ok('immediate PRA write cancels a still-pending delayed DDRA bank change');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
