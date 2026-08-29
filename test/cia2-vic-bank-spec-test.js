// CIA2 Port A drives the VIC-II bank-select pins (PA0/PA1).
//
//   $DD00 (PRA)  = data register
//   $DD02 (DDRA) = direction register (0 = input/float-high, 1 = output)
//
// Effective pin state: bits with DDR=1 reflect the PRA latch; bits with
// DDR=0 float HIGH (external pull-ups on the C64 PA0-PA1 lines).
//
//   pins   = (PRA & DDRA) | (~DDRA & $FF)
//   bank   = (3 - (pins & $03)) << 14
//
// PA0/PA1 are INVERTED for VIC bank select — 11 → bank 0 ($0000),
// 10 → bank 1 ($4000), 01 → bank 2 ($8000), 00 → bank 3 ($C000).
//
// Critical: the bank must be recomputed on EVERY write to either $DD00
// OR $DD02. Demos with hot IRQ loops like
//
//   DEC $D017 / STX $DD02 / STA $D016 / STY $D011 / LDX #$00 / STX $D018
//
// hammer $DD02 every line and rely on the bank tracking the DDRA changes
// even when $DD00 hasn't changed.

import { C64Machine } from '../src/machine.js';

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

function makeMachine() {
  const m = new C64Machine();
  // Cold reset state: PRA=$00, DDRA=$00 (all inputs).
  return m;
}

// ── 1: cold state — PA0/PA1 float high → bank $0000 ────────────────────
{
  const m = makeMachine();
  expect(m.cia2.portA === 0x00, `cold PRA = $00`);
  expect(m.cia2.portADir === 0x00, `cold DDRA = $00`);
  // pins = (0 & 0) | (~0 & $FF) = $FF, PA0-1 = 11 → bank 0
  expect(m.cia2.vicBank === 0x0000, `cold vicBank = $0000 (got $${m.cia2.vicBank.toString(16)})`);
  expect(m.vic2.currentVicBank === 0x0000, `vic.currentVicBank tracks CIA2 ($0000)`);
  ok('cold reset: PA0/PA1 float high → VIC bank $0000');
}

// ── 2: write $DD00 alone while DDRA=$00 does NOT shift bank ────────────
//      (PRA bits are output-latch values; they're invisible while DDR=0)
{
  const m = makeMachine();
  m.cia2.write(0x00, 0x00);     // PA0=0,PA1=0 — but pins still float high
  expect(m.cia2.vicBank === 0x0000, `DDRA=0: $DD00 write doesn't move bank`);
  m.cia2.write(0x00, 0x03);
  expect(m.cia2.vicBank === 0x0000, `DDRA=0: $DD00=3 still no effect`);
  ok('PRA write with DDRA=0 keeps bank at $0000 (inputs float high)');
}

// ── 3: write $DD02 alone flips the bank (with default PRA=$00) ─────────
{
  const m = makeMachine();
  expect(m.cia2.vicBank === 0x0000, `pre: bank $0000`);
  m.cia2.write(0x02, 0x03);     // PA0/PA1 → output, PRA still $00
  // pins = (0 & 3) | (~3 & $FF) = $FC, PA0-1 = 00 → bank 3 ($C000)
  expect(m.cia2.vicBank === 0xC000, `after $DD02=$03: bank = $C000 (got $${m.cia2.vicBank.toString(16)})`);
  expect(m.vic2.currentVicBank === 0xC000, `vic.currentVicBank updated`);
  ok('$DD02 write alone (DDRA flip) recomputes VIC bank');
}

// ── 4: full bank table ─────────────────────────────────────────────────
{
  const m = makeMachine();
  m.cia2.write(0x02, 0x03);     // PA0/PA1 outputs
  const cases = [
    { pra: 0x03, bank: 0x0000 },   // 11 → bank 0
    { pra: 0x02, bank: 0x4000 },   // 10 → bank 1
    { pra: 0x01, bank: 0x8000 },   // 01 → bank 2
    { pra: 0x00, bank: 0xC000 },   // 00 → bank 3
  ];
  for (const { pra, bank } of cases) {
    m.cia2.write(0x00, pra);
    expect(m.cia2.vicBank === bank,
      `PRA=$${pra.toString(16).padStart(2,'0')} → bank $${bank.toString(16).padStart(4,'0')} (got $${m.cia2.vicBank.toString(16)})`);
    expect(m.vic2.currentVicBank === bank, `vic.currentVicBank = $${bank.toString(16)}`);
  }
  ok('Bank table: PA0/PA1 inverted → $0000/$4000/$8000/$C000');
}

// ── 5: hot IRQ pattern — STX $DD02 between $DD00 writes ───────────────
//      Demo writes pattern: $DD00 stays constant, $DD02 toggles.
{
  const m = makeMachine();
  // Initial: PRA = $01 (bit 0 set = want bank $8000), DDRA = $03 (output).
  m.cia2.write(0x02, 0x03);
  m.cia2.write(0x00, 0x01);
  expect(m.cia2.vicBank === 0x8000, `setup: bank $8000`);
  // Demo toggles DDRA to $00 (inputs) without changing PRA.
  m.cia2.write(0x02, 0x00);
  expect(m.cia2.vicBank === 0x0000, `DDRA→$00 (inputs, float high): bank $0000`);
  // And back to $03 (outputs).
  m.cia2.write(0x02, 0x03);
  expect(m.cia2.vicBank === 0x8000, `DDRA→$03: bank tracks PRA again ($8000)`);
  ok('Hot IRQ pattern: $DD02 toggles drive bank even with $DD00 constant');
}

// ── 6: partial-output DDRA (e.g. only PA0 output) handles correctly ───
{
  const m = makeMachine();
  // DDRA = $01: PA0 is output (PRA bit 0 drives), PA1 is input (floats high).
  m.cia2.write(0x02, 0x01);
  m.cia2.write(0x00, 0x00);
  // pins = (0 & 1) | (~1 & $FF) = $FE, PA0-1 = 10 → bank 1 ($4000)
  expect(m.cia2.vicBank === 0x4000, `DDRA=$01 PRA=$00: bank $4000 (got $${m.cia2.vicBank.toString(16)})`);
  m.cia2.write(0x00, 0x01);
  // pins = (1 & 1) | (~1 & $FF) = $FF, PA0-1 = 11 → bank 0
  expect(m.cia2.vicBank === 0x0000, `DDRA=$01 PRA=$01: bank $0000 (got $${m.cia2.vicBank.toString(16)})`);
  ok('Partial DDRA (PA0 output, PA1 floating): bank tracks correctly');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
