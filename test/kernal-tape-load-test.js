// End-to-end KERNAL tape-load regression.
//
// This test synthesizes a standard CBM tape stream from documented tape
// encoding rules, feeds it as a TAP image through the Datasette, and lets
// the real C64 KERNAL LOAD routine at $FFD5 decode it via CIA1 FLAG IRQs.
//
// Standard CBM tape facts used here:
//   - TAP v1 stores short pulse lengths as byte*N*8 PAL CPU cycles.
//   - Short/medium/long pulse lengths are $30/$42/$56 TAP units.
//   - Pairs encode 0 as S/M, 1 as M/S, byte marker as L/M, end marker as L/S.
//   - A first-copy block sync is $89,$88,...,$81; the backup copy uses
//     $09,$08,...,$01.
//   - A PRG header is 192 bytes: type, start, end, 16-byte name, padding.
//   - The block check byte is XOR of all block payload bytes.

import { readFileSync } from 'fs';
import { C64Machine } from '../src/machine.js';

const S = 0x30;
const M = 0x42;
const L = 0x56;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function encodePair(out, a, b) {
  out.push(a, b);
}

function encodeByte(out, value) {
  encodePair(out, L, M);
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    encodePair(out, one ? M : S, one ? S : M);
  }
  encodePair(out, parity ? M : S, parity ? S : M);
}

function encodeBlockCopy(out, payload, pilotPulses, syncStart) {
  for (let i = 0; i < pilotPulses; i++) out.push(S);

  for (let v = syncStart; v >= (syncStart - 8); v--) encodeByte(out, v);

  let checksum = 0;
  for (const byte of payload) {
    checksum ^= byte;
    encodeByte(out, byte);
  }
  encodeByte(out, checksum);
  encodeInterRecordGap(out);
}

function encodeInterRecordGap(out) {
  out.push(L);
  for (let i = 0; i < 60; i++) out.push(S);
}

function makePrgTap({ start, body, name }) {
  const end = start + body.length;
  const header = new Uint8Array(192).fill(0x20);
  header[0] = 0x03;              // non-relocatable PRG
  header[1] = start & 0xFF;
  header[2] = start >> 8;
  header[3] = end & 0xFF;
  header[4] = end >> 8;
  for (let i = 0; i < Math.min(16, name.length); i++) {
    header[5 + i] = name.charCodeAt(i) & 0xFF;
  }

  const pulses = [];
  encodeBlockCopy(pulses, header, 0x6A00, 0x89);
  encodeBlockCopy(pulses, header, 0x1A00, 0x09);
  encodeBlockCopy(pulses, body, 0x1A00, 0x89);
  encodeBlockCopy(pulses, body, 0x1A00, 0x09);

  const tap = new Uint8Array(20 + pulses.length);
  const magic = 'C64-TAPE-RAW';
  for (let i = 0; i < magic.length; i++) tap[i] = magic.charCodeAt(i);
  tap[12] = 1;
  tap[16] = pulses.length & 0xFF;
  tap[17] = (pulses.length >> 8) & 0xFF;
  tap[18] = (pulses.length >> 16) & 0xFF;
  tap[19] = (pulses.length >> 24) & 0xFF;
  tap.set(pulses, 20);
  return tap;
}

function makeMachine() {
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
    basic: new Uint8Array(readFileSync('roms/basic.bin')),
    charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
  });
  for (let i = 0; i < 100; i++) machine.runFrame();
  return machine;
}

function ramMatches(machine, start, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if (machine.mem.ram[start + i] !== bytes[i]) return false;
  }
  return true;
}

function runPasteAndTapeLoad(machine, command, start, bytes, maxCycles) {
  let pending = command;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if ((cycle % 20_000) === 0 && pending.length > 0) {
      const accepted = machine.bufferKeyboardText(pending);
      pending = pending.slice(accepted);
    }
    C64Machine.prototype._runMasterCycle.call(machine);
    if (
      pending.length === 0
      && ramMatches(machine, start, bytes)
      && machine.datasette._pulseCount > 0
      && !machine.datasette.motorOn
    ) {
      return cycle + 1;
    }
  }
  return -1;
}

{
  const loadAddress = 0x0801;
  const body = new Uint8Array([
    0x0C, 0x08, 0x0A, 0x00, 0x9E, 0x20, 0x32, 0x30,
    0x36, 0x31, 0x00, 0x00, 0x00,
  ]);
  const tap = makePrgTap({ start: loadAddress, body, name: 'E2ELOAD' });
  const machine = makeMachine();
  machine.mem.ram.fill(0, loadAddress, loadAddress + body.length);

  machine.loadTap(tap);
  machine.setTapePlayPressed(true);

  const cycles = runPasteAndTapeLoad(machine, 'LOAD"E2ELOAD",1,1\r', loadAddress, body, 45_000_000);
  assert(cycles > 0,
    `KERNAL LOAD from datasette returns before cycle budget; pc=$${machine.cpu.pc.toString(16)} `
    + `status=$${machine.mem.ram[0x90].toString(16)} pulses=${machine.datasette._pulseCount} `
    + `pos=${machine.datasette.pos}/${machine.datasette.tapData.length} atEnd=${machine.datasette.atEnd} `
    + `motor=${machine.datasette.motorOn} play=${machine.datasette.playPressed} port=$${machine.mem.cpuPort.toString(16)} `
    + `ram=${Array.from(machine.mem.ram.slice(loadAddress, loadAddress + 6)).map(b => b.toString(16).padStart(2, '0')).join(' ')} `
    + `buf=${Array.from(machine.mem.ram.slice(0x033c, 0x0344)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

  for (let i = 0; i < body.length; i++) {
    assert(
      machine.mem.ram[loadAddress + i] === body[i],
      `loaded byte $${(loadAddress + i).toString(16)} matches TAP payload`
    );
  }

  const end = loadAddress + body.length;
  assert(machine.mem.ram[0x90] === 0, `KERNAL status remains OK, got $${machine.mem.ram[0x90].toString(16)}`);
  // The BASIC command path resumes after $FFD5, so CPU registers are no
  // longer a stable LOAD return contract here; the KERNAL end pointer is.
  assert(machine.mem.ram[0xAE] === (end & 0xFF), `KERNAL LOAD end low byte is $${(end & 0xFF).toString(16)}`);
  assert(machine.mem.ram[0xAF] === (end >> 8), `KERNAL LOAD end high byte is $${(end >> 8).toString(16)}`);
  assert(machine.datasette._pulseCount > 0, 'datasette emitted real tape pulses during KERNAL LOAD');

  console.log(`ok  - KERNAL LOAD decodes TAP through Datasette/CIA1 into RAM (${cycles} cycles)`);
}
