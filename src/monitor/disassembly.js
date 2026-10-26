// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { hex } from './memory-sampler.js';

// NMOS 6502 encodings, including undocumented instructions used by demos.
const ROWS = [
  'BRK.i ORA.ix JAM.i SLO.ix NOP.z ORA.z ASL.z SLO.z PHP.i ORA.n ASL.a ANC.n NOP.b ORA.b ASL.b SLO.b',
  'BPL.r ORA.iy JAM.i SLO.iy NOP.zx ORA.zx ASL.zx SLO.zx CLC.i ORA.by NOP.i SLO.by NOP.bx ORA.bx ASL.bx SLO.bx',
  'JSR.b AND.ix JAM.i RLA.ix BIT.z AND.z ROL.z RLA.z PLP.i AND.n ROL.a ANC.n BIT.b AND.b ROL.b RLA.b',
  'BMI.r AND.iy JAM.i RLA.iy NOP.zx AND.zx ROL.zx RLA.zx SEC.i AND.by NOP.i RLA.by NOP.bx AND.bx ROL.bx RLA.bx',
  'RTI.i EOR.ix JAM.i SRE.ix NOP.z EOR.z LSR.z SRE.z PHA.i EOR.n LSR.a ALR.n JMP.b EOR.b LSR.b SRE.b',
  'BVC.r EOR.iy JAM.i SRE.iy NOP.zx EOR.zx LSR.zx SRE.zx CLI.i EOR.by NOP.i SRE.by NOP.bx EOR.bx LSR.bx SRE.bx',
  'RTS.i ADC.ix JAM.i RRA.ix NOP.z ADC.z ROR.z RRA.z PLA.i ADC.n ROR.a ARR.n JMP.j ADC.b ROR.b RRA.b',
  'BVS.r ADC.iy JAM.i RRA.iy NOP.zx ADC.zx ROR.zx RRA.zx SEI.i ADC.by NOP.i RRA.by NOP.bx ADC.bx ROR.bx RRA.bx',
  'NOP.n STA.ix NOP.n SAX.ix STY.z STA.z STX.z SAX.z DEY.i NOP.n TXA.i XAA.n STY.b STA.b STX.b SAX.b',
  'BCC.r STA.iy JAM.i AHX.iy STY.zx STA.zx STX.zy SAX.zy TYA.i STA.by TXS.i TAS.by SHY.bx STA.bx SHX.by AHX.by',
  'LDY.n LDA.ix LDX.n LAX.ix LDY.z LDA.z LDX.z LAX.z TAY.i LDA.n TAX.i LAX.n LDY.b LDA.b LDX.b LAX.b',
  'BCS.r LDA.iy JAM.i LAX.iy LDY.zx LDA.zx LDX.zy LAX.zy CLV.i LDA.by TSX.i LAS.by LDY.bx LDA.bx LDX.by LAX.by',
  'CPY.n CMP.ix NOP.n DCP.ix CPY.z CMP.z DEC.z DCP.z INY.i CMP.n DEX.i AXS.n CPY.b CMP.b DEC.b DCP.b',
  'BNE.r CMP.iy JAM.i DCP.iy NOP.zx CMP.zx DEC.zx DCP.zx CLD.i CMP.by NOP.i DCP.by NOP.bx CMP.bx DEC.bx DCP.bx',
  'CPX.n SBC.ix NOP.n ISC.ix CPX.z SBC.z INC.z ISC.z INX.i SBC.n NOP.i SBC.n CPX.b SBC.b INC.b ISC.b',
  'BEQ.r SBC.iy JAM.i ISC.iy NOP.zx SBC.zx INC.zx ISC.zx SED.i SBC.by NOP.i ISC.by NOP.bx SBC.bx INC.bx ISC.bx',
];
export const OPCODES = ROWS.flatMap(row => row.split(' ').map(entry => {
  const [name, mode] = entry.split('.');
  return { name, mode, size: ['i', 'a'].includes(mode) ? 1 : ['b', 'bx', 'by', 'j'].includes(mode) ? 3 : 2 };
}));
const STORES = new Set(['STA', 'STX', 'STY', 'SAX', 'AHX', 'SHX', 'SHY', 'TAS']);
const RMW = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC', 'SLO', 'RLA', 'SRE', 'RRA', 'DCP', 'ISC']);

export function decodeInstruction(bytes, offset, address) {
  const opcode = bytes[offset], { name, mode, size } = OPCODES[opcode];
  const lo = bytes[offset + 1] ?? 0, word = lo | ((bytes[offset + 2] ?? 0) << 8);
  let operand = '', target = null;
  if (mode === 'a') operand = 'A';
  else if (mode === 'n') operand = `#$${hex(lo, 2)}`;
  else if (mode === 'r') { target = (address + 2 + (lo < 128 ? lo : lo - 256)) & 65535; operand = `$${hex(target)}`; }
  else if (mode === 'j') operand = `($${hex(word)})`;
  else if (mode === 'ix') operand = `($${hex(lo, 2)},X)`;
  else if (mode === 'iy') operand = `($${hex(lo, 2)}),Y`;
  else if (mode[0] === 'z') { operand = `$${hex(lo, 2)}${mode.length > 1 ? ',' + mode[1].toUpperCase() : ''}`; if (mode === 'z') target = lo; }
  else if (mode[0] === 'b') { operand = `$${hex(word)}${mode.length > 1 ? ',' + mode[1].toUpperCase() : ''}`; if (mode === 'b') target = word; }
  const kind = ['JMP', 'JSR'].includes(name) || mode === 'r' ? 'flow' : STORES.has(name) ? 'write' : RMW.has(name) && mode !== 'a' ? 'modify' : target !== null ? 'read' : 'cpu';
  return { address, name, operand, size, target, kind, opcode };
}

export function registerMeaning(address, sid2Address = 0) {
  if (sid2Address && address >= sid2Address && address < sid2Address + 32) {
    return registerMeaning(0xD400 + address - sid2Address).replace('SID', 'SID 2');
  }
  if (address >= 0xD000 && address < 0xD400) {
    const reg = address & 63;
    if (reg < 16) return `Sprite ${reg >>> 1} ${reg & 1 ? 'Y' : 'X'}`;
    return ({ 16: 'Sprite X high bits', 17: 'VIC mode / scroll Y', 18: 'Raster / IRQ line', 21: 'Sprite enable', 22: 'VIC mode / scroll X', 23: 'Sprite height', 24: 'Screen / graphics pointers', 25: 'VIC IRQ status', 26: 'VIC IRQ mask', 27: 'Sprite priority', 28: 'Sprite multicolour', 29: 'Sprite width', 32: 'Border colour', 33: 'Background colour', 34: 'Background 1', 35: 'Background 2', 36: 'Background 3', 37: 'Shared sprite colour 1', 38: 'Shared sprite colour 2' })[reg] || (reg >= 39 && reg <= 46 ? `Sprite ${reg - 39} colour` : 'VIC register');
  }
  if (address >= 0xD400 && address < 0xD800) {
    const reg = address & 31;
    return reg < 21 ? `SID voice ${((reg / 7) | 0) + 1} ${['frequency low', 'frequency high', 'pulse low', 'pulse high', 'wave / gate', 'attack / decay', 'sustain / release'][reg % 7]}` : 'SID filter / control';
  }
  if (address >= 0xD800 && address < 0xDC00) return 'Colour RAM';
  if (address >= 0xDC00 && address < 0xDD00) return 'CIA 1 · keyboard / timers';
  if (address >= 0xDD00 && address < 0xDE00) return (address & 15) === 0 ? 'CIA 2 · VIC bank / serial bus' : 'CIA 2 · timers / serial bus';
  return 'Expansion I/O';
}
