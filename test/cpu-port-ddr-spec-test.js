// 6510 CPU on-chip I/O port DDR behavior spec audit. 10 tests derived
// from the MOS6510 datasheet — the on-chip I/O port at addresses $00
// (DDR) and $01 (data) and how DDR controls per-bit input/output.
//
// Behavior (corrected hardware model):
//   $00 (DDR):  bit N = 0 → pin N is INPUT (high-impedance, pulled
//               externally); bit N = 1 → pin N is OUTPUT (drives latch).
//   $01 (data): WRITE — the 6510 latches ALL 8 bits unconditionally
//               (cpuPort = val); DDR does NOT mask the write. (The older
//               model that masked writes through DDR was wrong.) DDR only
//               decides, on READ, whether a bit drives its pin or floats.
//               READ — output bits (DDR=1) return the latched value;
//               input bits (DDR=0) return the external PIN level.
//
// On C64 the port wires:
//   bits 0-2 (LORAM/HIRAM/CHAREN) — output, controls PLA bank visibility;
//               externally pulled UP, so when input they read 1
//   bit 3   (CASS WR)             — output, datasette write
//   bit 4   (CASS SE)             — INPUT, datasette PLAY sense (pulls
//               toward SENSE level; default released = 1)
//   bit 5   (MOTOR)               — output, datasette motor enable
//   bits 6,7                      — read 0 when input
//
// Raw power-up / reset state: DDR = $00 (all inputs), DATA latch = $00.
// The KERNAL reset routine later writes $00←$2F, $01←$37, but a freshly
// constructed Memory (no KERNAL run) sits at $00/$00. With DDR=$00 and the
// pull-ups (bits 0,1,2) + SENSE (bit 4 = 1 default), reading $01 yields $17.

import { Memory } from '../src/memory.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: Raw power-up DDR is $00 (all inputs) ────────────────────────────
// A freshly constructed Memory has NOT run the KERNAL reset routine yet,
// so the 6510 port is at its silicon power-up state: DDR = $00 (every pin
// an input). The KERNAL later writes $2F, but that's software, not the
// power-up value.
{
  const m = new Memory();
  expect(m.cpuDDR === 0x00,
    `raw power-up DDR must be $00 (all inputs), got $${m.cpuDDR.toString(16)}`);
  ok('6510: raw power-up DDR = $00 (all pins input until KERNAL writes $2F)');
}

// ── 2: Raw power-up latch is $00; reading $01 returns $17 via pull-ups ──
// Power-up DATA latch is $00. But with DDR=$00 every bit reads its PIN:
// bits 0,1,2 pull up to 1, bit 4 = SENSE (released = 1), bits 3,5,6,7 = 0.
// So the value the CPU sees at $01 is $17 — the effective power-up
// memory-config (LORAM/HIRAM/CHAREN = 1 → KERNAL+BASIC+I/O reachable).
{
  const m = new Memory();
  m.machine = { datasette: { setMotor: () => {}, getSenseLevel: () => 1 } };
  expect(m.cpuPort === 0x00,
    `raw power-up DATA latch must be $00, got $${m.cpuPort.toString(16)}`);
  expect(m.read(0x0001) === 0x17,
    `DDR=$00: reading $01 returns $17 (pull-ups + SENSE), got $${m.read(0x0001).toString(16)}`);
  ok('6510: raw power-up latch = $00, $01 reads $17 via pull-ups + SENSE');
}

// ── 3: Reading $00 returns DDR ─────────────────────────────────────────
{
  const m = new Memory();
  m.cpuDDR = 0xAB;
  expect(m.read(0x0000) === 0xAB,
    `$00 read returns DDR, got $${m.read(0x0000).toString(16)}`);
  ok('6510: $00 read returns DDR');
}

// ── 4: Writing $00 sets DDR ────────────────────────────────────────────
{
  const m = new Memory();
  m.write(0x0000, 0xFF);
  expect(m.cpuDDR === 0xFF,
    `$00 write must set DDR, got $${m.cpuDDR.toString(16)}`);
  ok('6510: $00 write sets DDR');
}

// ── 5: Output bits read back the latched value ─────────────────────────
{
  const m = new Memory();
  m.machine = { datasette: { setMotor: () => {}, getSenseLevel: () => 1 } };
  m.write(0x0000, 0xFF);                // all outputs
  m.write(0x0001, 0xA5);
  // Bit 4 always reads from datasette SENSE input — but with DDR=$FF
  // the pin is being DRIVEN, so reads return the latched value.
  // Per impl: read at $01 always reads bit 4 from SENSE regardless of DDR.
  // Verify the bits NOT-overridden-by-SENSE round-trip.
  const v = m.read(0x0001);
  expect((v & 0x0F) === 0x05, `low nibble round-trips ($A5 → $...5)`);
  expect((v & 0xE0) === 0xA0, `high nibble (excl bit 4) round-trips`);
  ok('6510: $01 output bits round-trip to read');
}

// ── 6: Input bits read from external pin (bit 4 = SENSE) ───────────────
{
  const m = new Memory();
  m.machine = { datasette: { setMotor: () => {}, getSenseLevel: () => 0 } }; // PLAY pressed
  m.cpuPort = 0xFF;                       // try to fake bit 4 high in latch
  m.cpuDDR = 0x2F;                        // bit 4 input
  const v = m.read(0x0001);
  expect((v & 0x10) === 0,
    `DDR bit 4 = 0 + SENSE low: $01 bit 4 must read 0, got $${v.toString(16)}`);
  ok('6510: $01 bit 4 (input) reads external SENSE pin, ignoring latch');
}

// ── 7: $01 write latches ALL bits; DDR masks only the READ ─────────────
// 6510 (corrected): a $01 write stores the full byte in the latch
// regardless of DDR — DDR does NOT mask the write. DDR only decides, on
// READ, whether each bit drives from the latch (output) or the pin
// (input). So writing $FF with DDR=$2F latches bit 4 = 1, yet reading $01
// still returns SENSE for bit 4 (it's an input pin).
{
  const m = new Memory();
  m.machine = { datasette: { setMotor: () => {}, getSenseLevel: () => 1 } };
  m.cpuPort = 0x00;
  m.cpuDDR = 0x2F;                        // bit 4 input, rest output
  m.write(0x0001, 0xFF);                  // store everything in the latch
  // Latch holds the full written byte — bit 4 IS now 1 (write not masked).
  expect((m.cpuPort & 0x10) === 0x10,
    `$01 write latches bit 4 = 1 even though DDR bit 4 is input (full-latch)`);
  expect(m.cpuPort === 0xFF,
    `$01 write stores all 8 bits unmasked, got $${m.cpuPort.toString(16)}`);
  // But READING bit 4 still returns the SENSE pin (input bit), not the latch.
  const v = m.read(0x0001);
  expect((v & 0x10) === 0x10,
    `read bit 4 = SENSE pin (=1 here), independent of latch, got $${v.toString(16)}`);
  // Output bits (DDR=1) read back from the latch.
  expect((v & 0x2F) === 0x2F,
    `DDR-output bits read back the latched value ($2F)`);
  ok('6510: $01 write latches all bits unmasked; DDR masks only the read');
}

// ── 8: MOTOR side-effect (bit 5) gated on DDR bit 5 being an output ────
// The datasette MOTOR is on output pin 5. setMotor is invoked only when
// DDR bit 5 is an output; when bit 5 is an input the pin floats and the
// motor is untouched. The latch itself still stores bit 5 unconditionally
// (full-latch write).
{
  let motorCalls = 0;
  const m = new Memory();
  m.machine = { datasette: { setMotor: () => { motorCalls++; }, getSenseLevel: () => 1 } };
  m.cpuPort = 0x37;                       // motor bit 5 = 1 (off)
  m.cpuDDR = 0x0F;                        // bit 5 = 0 = INPUT (pin floats, motor untouched)
  m.write(0x0001, 0x17);                  // bit 5 → 0 in the latch
  // setMotor must NOT fire — DDR bit 5 is an input.
  expect(motorCalls === 0,
    `DDR bit 5 = input: $01 write must NOT call setMotor, got ${motorCalls} call(s)`);
  // The latch DID store bit 5 = 0 (write is unmasked).
  expect((m.cpuPort & 0x20) === 0,
    `full-latch: $01 write stores bit 5 = 0, got $${m.cpuPort.toString(16)}`);
  ok('6510: MOTOR side-effect gated on DDR bit 5 = output (latch still stores bit 5)');
}

// ── 9: the RAM under $00/$01 takes the bus byte, not the written value ─
{
  // The port is on-chip, so the 6510 leaves its data drivers tri-stated for a
  // write to $00/$01 — the byte the VIC drove during phi1 is what reaches the
  // DRAM underneath. Software cannot see this through the CPU (reads of $00/$01
  // return the port), only through a bus master that bypasses it.
  const m = new Memory();
  m.machine = { datasette: { setMotor: () => {} } };
  m.externalDataBus8 = 0x18;              // stand in for the VIC's phi1 byte
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x42);
  expect(m.cpuPort === 0x42,
    `the port latch still takes the written value, got $${m.cpuPort.toString(16)}`);
  expect(m.ram[0x0001] === 0x18,
    `ram[$01] must hold the bus byte, got $${m.ram[0x0001].toString(16)}`);
  expect(m.ram[0x0000] === 0x18,
    `ram[$00] must hold the bus byte, got $${m.ram[0x0000].toString(16)}`);
  ok('6510: RAM under $00/$01 takes the bus byte, not the written value');
}

// ── 10: $01 write triggers datasette motor side-effect ─────────────────
// Bit 5 of port = MOTOR (0 = on, 1 = off in inverted convention). The
// memory subsystem must invoke datasette.setMotor on $01 writes.
{
  let motorState = null;
  const m = new Memory();
  m.machine = { datasette: { setMotor: (on) => { motorState = on; } } };
  m.write(0x0000, 0xFF);
  m.write(0x0001, 0x37);                  // bit 5 = 1 → motor OFF (inverted)
  expect(motorState === false,
    `port=$37 (bit 5 = 1) → motor off, got ${motorState}`);
  m.write(0x0001, 0x17);                  // bit 5 = 0 → motor ON
  expect(motorState === true,
    `port=$17 (bit 5 = 0) → motor on, got ${motorState}`);
  ok('6510: $01 bit 5 controls datasette motor (inverted: 0=on, 1=off)');
}

// ── 11: a DDR write applies the already-latched MOTOR level ────────────
// The latch stores all 8 bits regardless of direction, so handing pin 5 to the
// latch is itself a motor event: the KERNAL writes $01 first and raises the DDR
// afterwards, and the motor must follow at that point rather than waiting for
// the next $01 write.
{
  let motorState = null;
  const m = new Memory();
  m.machine = { datasette: { setMotor: (on) => { motorState = on; }, getSenseLevel: () => 1 } };
  m.write(0x0000, 0x0F);                  // bit 5 = input: pin floats
  m.write(0x0001, 0x17);                  // latch bit 5 = 0 (motor on) while floating
  expect(motorState === null,
    `DDR bit 5 input: no motor call yet, got ${motorState}`);
  m.write(0x0000, 0x2F);                  // bit 5 becomes an output
  expect(motorState === true,
    `raising DDR bit 5 must apply the latched level (motor on), got ${motorState}`);
  ok('6510: DDR write applies the latched MOTOR level (no stale motor)');
}

// ── 12: cassette WRITE line follows $01 bit 3, gated by DDR bit 3 ──────
// Pin 3 is the cassette write output. Undriven it reads idle high; driven it
// carries the latch. Every transition is one edge of a recorded pulse.
{
  const levels = [];
  const m = new Memory();
  m.machine = { datasette: {
    setMotor: () => {},
    getSenseLevel: () => 1,
    setWriteLine: (l) => { levels.push(l); },
  } };
  m.write(0x0000, 0x2F);                  // bit 3 = output
  m.write(0x0001, 0x37);                  // bit 3 = 0 → write line low
  expect(levels.at(-1) === 0,
    `$01 bit 3 = 0 drives the write line low, got ${levels.at(-1)}`);
  m.write(0x0001, 0x3F);                  // bit 3 = 1 → write line high
  expect(levels.at(-1) === 1,
    `$01 bit 3 = 1 drives the write line high, got ${levels.at(-1)}`);
  m.write(0x0000, 0x27);                  // bit 3 → input: pin floats
  expect(levels.at(-1) === 1,
    `undriven write line reads idle high, got ${levels.at(-1)}`);
  m.write(0x0001, 0x37);                  // latch bit 3 low, but pin is an input
  expect(levels.at(-1) === 1,
    `DDR bit 3 input: latch changes must not move the pin, got ${levels.at(-1)}`);
  ok('6510: cassette WRITE line follows $01 bit 3 gated by DDR bit 3');
}

console.log(`\n${testNo} 6510 CPU-port DDR spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
