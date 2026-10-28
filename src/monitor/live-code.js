// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { OPCODES } from './disassembly.js';
import { hex } from './memory-sampler.js';

const ACTIONS = {};
for (const [names, action] of [
  ['STA STX STY SAX AHX SHX SHY TAS', 'Storing a value'],
  ['CMP CPX CPY', 'Comparing values'],
  ['BIT', 'Testing bits'],
  ['BPL BMI BVC BVS BCC BCS BNE BEQ', 'Testing a condition'],
  ['JMP', 'Jumping to code'], ['JSR', 'Calling a routine'],
  ['RTS', 'Returning from a routine'], ['RTI', 'Returning from an interrupt'],
  ['BRK', 'Starting an interrupt'], ['JAM', 'Stopping the CPU'],
  ['ADC', 'Adding values'], ['SBC', 'Subtracting values'],
  ['INC INX INY', 'Increasing a value'], ['DEC DEX DEY', 'Decreasing a value'],
  ['AND ORA EOR ANC ALR ARR XAA AXS', 'Combining bits'],
  ['ASL LSR ROL ROR', 'Shifting bits'],
  ['SLO RLA SRE RRA DCP ISC', 'Changing memory'],
  ['TAX TAY TXA TYA TSX TXS', 'Moving a register value'],
  ['PHA PHP', 'Saving on the stack'], ['PLA PLP', 'Reading the stack'],
  ['CLC SEC CLV CLD SED', 'Setting a CPU flag'],
  ['CLI', 'Allowing IRQ requests'], ['SEI', 'Masking IRQ requests'],
  ['NOP', 'Leaving values unchanged'],
]) for (const name of names.split(' ')) ACTIONS[name] = action;

// Instruction identity comes from dispatch, never by decoding a sampled PC
// that may already point to an operand. No operand or target is inferred.
export function liveCodeSummary(state, paused = false) {
  const address = state.instructionAddress, opcode = state.instructionOpcode;
  const valid = Number.isInteger(address) && address >= 0 && address <= 65535 &&
    Number.isInteger(opcode) && opcode >= 0 && opcode < 256;
  const instruction = valid ? OPCODES[opcode] : null;
  let action = 'Instruction unavailable';
  if (instruction) {
    action = ['LDA','LDX','LDY','LAX','LAS'].includes(instruction.name)
      ? instruction.mode === 'n' ? 'Loading a value' : 'Reading memory'
      : ACTIONS[instruction.name];
  }
  return {
    action: state.halted ? 'CPU stopped' : action,
    evidence: instruction ? `${instruction.name} · instruction at $${hex(address)}` : `CPU position $${hex(state.pc)}`,
    sample: paused ? 'Paused sample' : instruction ? state.instructionBoundary ? 'Last instruction · sampled' : 'Sampled instruction' : 'No instruction identity',
    irq: !!state.irq,
    irqAllowed: !(state.p & 4),
  };
}

export function showLiveSampleDetails(rate, paused) {
  return paused || rate <= 10;
}
