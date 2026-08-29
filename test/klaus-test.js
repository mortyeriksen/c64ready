// Klaus Dormann 6502/65C02 functional-test harness.
// Loads a 64K binary, runs CPU cycle-by-cycle from PC=$0400, detects trap.
// "Trap" = PC stops advancing (test uses branch-to-self as both success and failure markers).
// At end we print the trap PC; the caller/reader checks the test-source map to
// tell success from failure.
//
// Usage:  node test/klaus-test.js [rom-file]
// Default rom: the 'klaus-6502-functional-bin' entry in test/external-assets.json
// (success at $3469).
// Known success addresses:
//   6502_functional_test.bin          → $3469
//   65C02_extended_opcodes_test.bin   → $24F1 (varies — check test source)

import { readFileSync } from 'node:fs';
import { CPU } from '../src/cpu.js';
import { assetPath, missingNote } from './external-assets.js';

const romArg = process.argv[2];
const ROM_PATH = romArg ? new URL(`../${romArg}`, import.meta.url)
                        : assetPath('klaus-6502-functional-bin');
if (!ROM_PATH) {
  console.log(`# SKIP Klaus 6502 functional test — ${missingNote('klaus-6502-functional-bin')}`);
  process.exit(0);
}
const romLabel = romArg || String(ROM_PATH);
const START_PC = 0x0400;
const MAX_CYCLES = 200_000_000;

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

const mem = new FlatMemory();
const rom = readFileSync(ROM_PATH);
if (rom.length !== 0x10000) {
  console.error(`Expected 64K ROM, got ${rom.length} bytes`);
  process.exit(1);
}
mem.ram.set(rom);

const cpu = new CPU(mem);
cpu.pc = START_PC;
cpu.sp = 0xFF;
cpu.setP(0x24); // I=1, default

let cycles = 0;
let lastPc = -1;
let samePcCount = 0;
const history = new Array(16).fill(0); // ring buffer of recent PCs

const hex = (v, w) => v.toString(16).toUpperCase().padStart(w, '0');

while (cycles < MAX_CYCLES) {
  // Only inspect PC at instruction boundaries — inside a micro-op sequence the
  // PC can be transiently stale, which would false-trigger the trap detector.
  if (cpu.atInstructionBoundary()) {
    if (cpu.pc === lastPc) {
      samePcCount++;
      if (samePcCount > 4) break; // branch-to-self trap reached
    } else {
      samePcCount = 0;
      lastPc = cpu.pc;
      history.shift();
      history.push(cpu.pc);
    }
  }
  cpu.clock();
  cycles++;
}

const knownSuccess = {
  '6502_functional_test.bin': 0x3469,
  '65C02_extended_opcodes_test.bin': 0x24F1,
};
const romBasename = romLabel.split('/').pop();
const successPc = knownSuccess[romBasename];
const outcome = (cycles >= MAX_CYCLES) ? `TIMEOUT after ${cycles} cycles` :
  (successPc !== undefined && cpu.pc === successPc) ? 'PASS' :
    'TRAP (check PC against test source map)';

console.log(`=== Klaus test: ${romLabel} ===`);
console.log(`Result: ${outcome}`);
console.log(`Trap PC: $${hex(cpu.pc, 4)}`);
console.log(`Cycles executed: ${cycles}`);
console.log(`A=$${hex(cpu.a, 2)} X=$${hex(cpu.x, 2)} Y=$${hex(cpu.y, 2)} SP=$${hex(cpu.sp, 2)} P=$${hex(cpu.getP(), 2)}`);
console.log(`Recent instruction-boundary PCs (oldest→newest):`);
for (const pc of history) console.log(`  $${hex(pc, 4)}`);

// Dump a few bytes around the trap PC so we can disassemble if needed
const dumpStart = Math.max(0, cpu.pc - 8);
const dumpEnd = Math.min(0xFFFF, cpu.pc + 16);
const bytes = [];
for (let a = dumpStart; a <= dumpEnd; a++) {
  bytes.push(`${a === cpu.pc ? '[' : ''}${hex(mem.ram[a], 2)}${a === cpu.pc ? ']' : ''}`);
}
console.log(`Bytes around trap PC ($${hex(dumpStart, 4)}..$${hex(dumpEnd, 4)}): ${bytes.join(' ')}`);

process.exit(outcome === 'PASS' ? 0 : 1);
