// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { hex } from './memory-sampler.js';
import { registerMeaning } from './disassembly.js';

const COLOURS = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey'];

// Describe register semantics, without inferring the purpose of the program.
export function explainVicWrite(register, value) {
  const result = { group: 'Display', title: 'Write a video register', detail: registerMeaning(0xD000 + register), colour: null };
  if (register === 0x20 || register >= 0x21 && register <= 0x24 || register >= 0x25 && register <= 0x2e) {
    const target = register === 0x20 ? 'border' : register <= 0x24 ? `background ${register === 0x21 ? '' : register - 0x21}`.trim() : register <= 0x26 ? `shared sprite colour ${register - 0x24}` : `sprite ${register - 0x27} colour`;
    result.group = 'Colours'; result.colour = value & 15;
    result.title = `Set ${target} to ${COLOURS[result.colour]}`;
    result.detail = `The VIC-II uses the low four bits: colour ${result.colour}. A write does not prove which pixels use this colour.`;
  } else if (register < 16) {
    result.group = 'Sprites'; result.title = `Set sprite ${register >> 1} ${register & 1 ? 'vertical position' : 'horizontal low byte'}`;
    result.detail = register & 1 ? `Write Y position ${value}. Visibility also depends on sprite timing and enable settings.` : `Write ${value} to the low eight X bits. The ninth bit is stored separately in $D010.`;
  } else if ([0x10, 0x15, 0x17, 0x1b, 0x1c, 0x1d].includes(register)) {
    result.group = 'Sprites'; result.title = {16:'Set sprite X high bits',21:'Choose enabled sprites',23:'Choose vertically expanded sprites',27:'Set sprite priority',28:'Choose multicolour sprites',29:'Choose horizontally expanded sprites'}[register];
    const slots = Array.from({length:8}, (_,i)=>i).filter(i=>value & 1<<i);
    result.detail = `Set bits for sprites ${slots.length ? slots.join(', ') : 'none'}. ${registerMeaning(0xD000 + register)}.`;
  } else if (register === 0x11) {
    result.title = 'Configure vertical display and graphics mode';
    result.detail = `Vertical scroll ${value & 7}, ${value & 8 ? 25 : 24} rows, display-enable bit ${value & 16 ? 'on' : 'off'}, bitmap bit ${value & 32 ? 'on' : 'off'}, extended-colour bit ${value & 64 ? 'on' : 'off'}. Bit 7 sets the raster interrupt target’s high bit. These settings are subject to VIC-II timing.`;
  } else if (register === 0x16) {
    result.title = 'Configure horizontal display';
    result.detail = `Horizontal scroll ${value & 7}, ${value & 8 ? 40 : 38} columns, multicolour bit ${value & 16 ? 'on' : 'off'}. Border effects depend on when this write occurs.`;
  } else if (register === 0x18) {
    result.title = 'Choose screen and graphics memory';
    result.detail = `Screen offset $${hex((value >> 4) * 1024)}, character offset $${hex((value >> 1 & 7) * 2048)}, bitmap offset $${hex(value & 8 ? 8192 : 0)} within the selected VIC bank. The active mode determines which graphics offset is used.`;
  } else if ([0x12,0x19,0x1a].includes(register)) {
    result.group = 'Interrupts';
    result.title = {18:'Set the raster interrupt target low byte',25:'Acknowledge video interrupt flags',26:'Choose enabled video interrupts'}[register];
    result.detail = register === 0x12 ? `Write ${value} to the low eight target bits. The high bit is in $D011. This does not itself enable the interrupt.` : register === 0x19 ? `Clear pending flags selected by $${hex(value & 15,2)}. Writing zero leaves a flag unchanged.` : `Enable mask $${hex(value & 15,2)}: raster, sprite/background collision, sprite/sprite collision and light pen.`;
  } else if (register >= 0x2f || register === 0x13 || register === 0x14 || register === 0x1e || register === 0x1f) {
    result.title = 'Write a read-only or unused video register'; result.detail = 'This recorded write does not change a writable VIC-II setting.';
  }
  return result;
}

export function capturedCodeActions(frame) {
  const actions = [];
  if (!frame) return actions;
  for (let i = 0; i < frame.eventCount; i++) {
    const register = frame.eventKind[i];
    if (register >= 64) continue;
    actions.push({ ...explainVicWrite(register, frame.eventValue[i]), event: i, tick: frame.eventTick[i], address: 0xD000 + register, value: frame.eventValue[i], cpu: !!frame.eventCPU[i], pc: frame.eventPC[i], opcode: frame.eventOpcode[i] });
  }
  return actions;
}

export function capturedCycleBudget(frame) {
  const total = frame.lines * frame.cyclesPerLine, bus = frame.analysis?.bus;
  const budget = { total, available: 0, vic: 0, reu: 0, halted: 0, unknown: 0 };
  for (let tick = 0; tick < total; tick++) {
    const flags = bus?.[tick] ?? 0;
    if (!(flags & 1)) budget.unknown++;
    else if (flags & 8) budget.reu++;
    else if (flags & 16) budget.halted++;
    else if (flags & 4) budget.vic++;
    else budget.available++;
  }
  return budget;
}
