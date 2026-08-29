// osc3-cycle-test.js — Headless test driving osc3-cycle-test.prg through
// C64Machine. Verifies the PRG produces a varied byte sequence at
// $0400-$043F (proving cycle-exact $D41B reads from the shadow SID),
// not 64 identical bytes (the symptom of the old worklet-snapshot
// latency).

import { C64Machine } from '../src/machine.js';
import fs from 'node:fs';
import path from 'node:path';

const PRG_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'osc3-cycle-test.prg',
);
const prgBytes = new Uint8Array(fs.readFileSync(PRG_PATH));

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

function bootAndLoadPrg(machine) {
  const kernal  = fs.readFileSync('roms/kernal.bin');
  const basic   = fs.readFileSync('roms/basic.bin');
  const charRom = fs.readFileSync('roms/chargen.bin');
  machine.loadROMs({ kernal, basic, charRom });

  // Boot to BASIC ready prompt.
  for (let i = 0; i < 30; i++) machine.runFrame();

  // Load PRG into memory. PRG layout: first 2 bytes = load addr (little-endian),
  // rest = program bytes starting at that address.
  const loadAddr = prgBytes[0] | (prgBytes[1] << 8);
  for (let i = 2; i < prgBytes.length; i++) {
    machine.mem.ram[(loadAddr + i - 2) & 0xFFFF] = prgBytes[i];
  }
  // BASIC pointers $2B-$2C (start of BASIC), $2D-$2E (end of BASIC / start of vars).
  const endAddr = loadAddr + (prgBytes.length - 2);
  machine.mem.ram[0x2D] = endAddr & 0xFF;
  machine.mem.ram[0x2E] = (endAddr >> 8) & 0xFF;
  machine.mem.ram[0x2F] = endAddr & 0xFF;
  machine.mem.ram[0x30] = (endAddr >> 8) & 0xFF;
  machine.mem.ram[0x31] = endAddr & 0xFF;
  machine.mem.ram[0x32] = (endAddr >> 8) & 0xFF;
}

// ── Test: PRG produces varied $D41B reads (cycle-exact shadow SID) ──
{
  const machine = new C64Machine();
  bootAndLoadPrg(machine);

  // Jump directly to the machine code at $080D (SYS 2061 equivalent),
  // bypassing BASIC RUN parsing.
  machine.cpu.pc = 0x080D;

  // Run enough cycles for the PRG to:
  //   - configure V3 (~50 cycles)
  //   - wait loop for envelope (~768 cycles)
  //   - tight read loop (~896 cycles)
  //   - hit JMP $083A halt
  // Total ~2000 cycles plus padding. One PAL frame = 19656 cycles is
  // plenty; the JMP-to-self halt means extra cycles are harmless.
  for (let i = 0; i < 3; i++) machine.runFrame();

  // Inspect the 64 bytes the PRG wrote to $0400-$043F.
  const bytes = [];
  for (let i = 0; i < 64; i++) bytes.push(machine.mem.ram[0x0400 + i]);

  const unique = new Set(bytes);
  // Verify that the write actually happened — we should see non-zero
  // bytes (initial RAM is all 0 or DRAM pattern; KERNAL fills screen
  // with $20 spaces; PRG overwrites with noise bytes).
  const allZero = bytes.every(b => b === 0);
  expect(!allZero, `screen RAM should not be all zeros (the PRG ran)`);

  // With cycle-exact shadow SID + freq=$FFFF: the LFSR shifts every
  // ~256 cycles, the read loop takes ~14 cycles per iter, so reads
  // cluster into 3-4 groups across 64 iterations. Without shadow SID
  // (old latency behavior), all 64 bytes would equal each other.
  expect(unique.size >= 2,
    `screen bytes show variety from cycle-exact reads: ${unique.size} distinct values, sample=${bytes.slice(0,8).map(b=>'$'+b.toString(16).padStart(2,'0')).join(' ')}`);

  ok(`osc3-cycle-test.prg writes ${unique.size} distinct bytes to $0400-$043F (cycle-exact $D41B)`);
}

console.log(`\n${testNo} OSC3 cycle test; ${fails} fail`);
if (fails > 0) process.exit(1);
