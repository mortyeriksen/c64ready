// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// tools/asm6502.mjs — a two-pass 6502 assembler, just big enough for the
// programs this project ships inside a .prg.
//
// Every instruction is a fixed size once its addressing mode is known, and the
// mode is decided by the operand's shape alone, so two passes settle every
// label: the first learns the addresses, the second emits the bytes. The only
// subtlety is zero page — `lda $02` is two bytes and `lda $0802` is three — and
// a forward reference cannot be known to be zero page on the first pass, so a
// symbol that is still unknown is assumed absolute and stays that way.
//
// Directives: `.byte` / `.word` / `.fill count[,value]` / `.scr "TEXT"` (ASCII
// to C64 screen codes) / `.org address`. `NAME = expression` defines a constant,
// `label:` a label, `;` starts a comment.

const IMPLIED = 'imp', IMMEDIATE = 'imm', ZP = 'zp', ZPX = 'zpx', ZPY = 'zpy',
      ABS = 'abs', ABSX = 'absx', ABSY = 'absy', IND = 'ind', INDX = 'indx',
      INDY = 'indy', REL = 'rel', ACC = 'acc';

// Only the instructions the players here use. Adding one is adding a row.
const OPCODES = {
  adc: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6D, absx: 0x7D, absy: 0x79, indx: 0x61, indy: 0x71 },
  and: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2D, absx: 0x3D, absy: 0x39, indx: 0x21, indy: 0x31 },
  asl: { acc: 0x0A, zp: 0x06, zpx: 0x16, abs: 0x0E, absx: 0x1E },
  bcc: { rel: 0x90 }, bcs: { rel: 0xB0 }, beq: { rel: 0xF0 }, bmi: { rel: 0x30 },
  bne: { rel: 0xD0 }, bpl: { rel: 0x10 }, bvc: { rel: 0x50 }, bvs: { rel: 0x70 },
  bit: { zp: 0x24, abs: 0x2C },
  brk: { imp: 0x00 }, clc: { imp: 0x18 }, cld: { imp: 0xD8 }, cli: { imp: 0x58 }, clv: { imp: 0xB8 },
  cmp: { imm: 0xC9, zp: 0xC5, zpx: 0xD5, abs: 0xCD, absx: 0xDD, absy: 0xD9, indx: 0xC1, indy: 0xD1 },
  cpx: { imm: 0xE0, zp: 0xE4, abs: 0xEC },
  cpy: { imm: 0xC0, zp: 0xC4, abs: 0xCC },
  dec: { zp: 0xC6, zpx: 0xD6, abs: 0xCE, absx: 0xDE },
  dex: { imp: 0xCA }, dey: { imp: 0x88 },
  eor: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4D, absx: 0x5D, absy: 0x59, indx: 0x41, indy: 0x51 },
  inc: { zp: 0xE6, zpx: 0xF6, abs: 0xEE, absx: 0xFE },
  inx: { imp: 0xE8 }, iny: { imp: 0xC8 },
  jmp: { abs: 0x4C, ind: 0x6C }, jsr: { abs: 0x20 },
  lda: { imm: 0xA9, zp: 0xA5, zpx: 0xB5, abs: 0xAD, absx: 0xBD, absy: 0xB9, indx: 0xA1, indy: 0xB1 },
  ldx: { imm: 0xA2, zp: 0xA6, zpy: 0xB6, abs: 0xAE, absy: 0xBE },
  ldy: { imm: 0xA0, zp: 0xA4, zpx: 0xB4, abs: 0xAC, absx: 0xBC },
  lsr: { acc: 0x4A, zp: 0x46, zpx: 0x56, abs: 0x4E, absx: 0x5E },
  nop: { imp: 0xEA },
  ora: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0D, absx: 0x1D, absy: 0x19, indx: 0x01, indy: 0x11 },
  pha: { imp: 0x48 }, php: { imp: 0x08 }, pla: { imp: 0x68 }, plp: { imp: 0x28 },
  rol: { acc: 0x2A, zp: 0x26, zpx: 0x36, abs: 0x2E, absx: 0x3E },
  ror: { acc: 0x6A, zp: 0x66, zpx: 0x76, abs: 0x6E, absx: 0x7E },
  rti: { imp: 0x40 }, rts: { imp: 0x60 },
  sbc: { imm: 0xE9, zp: 0xE5, zpx: 0xF5, abs: 0xED, absx: 0xFD, absy: 0xF9, indx: 0xE1, indy: 0xF1 },
  sec: { imp: 0x38 }, sed: { imp: 0xF8 }, sei: { imp: 0x78 },
  sta: { zp: 0x85, zpx: 0x95, abs: 0x8D, absx: 0x9D, absy: 0x99, indx: 0x81, indy: 0x91 },
  stx: { zp: 0x86, zpy: 0x96, abs: 0x8E },
  sty: { zp: 0x84, zpx: 0x94, abs: 0x8C },
  tax: { imp: 0xAA }, tay: { imp: 0xA8 }, tsx: { imp: 0xBA },
  txa: { imp: 0x8A }, txs: { imp: 0x9A }, tya: { imp: 0x98 },
};

const SIZE = { [IMPLIED]: 1, [ACC]: 1, [IMMEDIATE]: 2, [ZP]: 2, [ZPX]: 2, [ZPY]: 2,
               [REL]: 2, [INDX]: 2, [INDY]: 2, [ABS]: 3, [ABSX]: 3, [ABSY]: 3, [IND]: 3 };

/**
 * ASCII to C64 screen codes, for the labels a program prints. Only the
 * characters a player's own screen uses are mapped; anything else becomes a
 * space rather than a wrong glyph.
 */
export function screenCodes(text) {
  return [...String(text)].map(ch => {
    const c = ch.charCodeAt(0);
    if (ch >= 'A' && ch <= 'Z') return c - 64;          // A–Z → $01–$1A
    if (ch >= 'a' && ch <= 'z') return c - 96;          // folded to upper case
    if (ch >= '0' && ch <= '9') return c;               // digits keep their code
    return { ' ': 0x20, '.': 0x2E, ',': 0x2C, ':': 0x3A, ';': 0x3B, '/': 0x2F, '-': 0x2D,
             '+': 0x2B, '*': 0x2A, '(': 0x28, ')': 0x29, '$': 0x24, '#': 0x23, '!': 0x21,
             '?': 0x3F, '<': 0x3C, '>': 0x3E, '=': 0x3D, '@': 0x00, '[': 0x1B, ']': 0x1D,
             "'": 0x27, '"': 0x22, '_': 0x64 }[ch] ?? 0x20;
  });
}

// ── expressions ─────────────────────────────────────────────────────────────
// Numbers ($hex, %binary, decimal, 'c' as a screen code), symbols, + - * and
// parentheses. Enough to write SCREEN+40*3+2 without reaching for a calculator.
function evaluate(text, symbols, strict) {
  let at = 0;
  const skip = () => { while (at < text.length && text[at] === ' ') at++; };
  function primary() {
    skip();
    if (text[at] === '(') { at++; const v = expression(); skip(); if (text[at] !== ')') throw new Error(`unbalanced ( in "${text}"`); at++; return v; }
    if (text[at] === "'") { const code = screenCodes(text[at + 1])[0]; at += 3; return code; }
    if (text[at] === '$') { at++; const s = at; while (/[0-9a-fA-F]/.test(text[at] || '')) at++; return parseInt(text.slice(s, at), 16); }
    if (text[at] === '%') { at++; const s = at; while (/[01]/.test(text[at] || '')) at++; return parseInt(text.slice(s, at), 2); }
    if (/[0-9]/.test(text[at] || '')) { const s = at; while (/[0-9]/.test(text[at] || '')) at++; return parseInt(text.slice(s, at), 10); }
    const s = at;
    while (/[A-Za-z0-9_]/.test(text[at] || '')) at++;
    const name = text.slice(s, at);
    if (!name) throw new Error(`cannot read an expression from "${text}"`);
    if (Object.hasOwn(symbols, name)) return symbols[name];
    if (strict) throw new Error(`unknown symbol "${name}"`);
    return null;                                        // first pass: not known yet
  }
  function term() {
    let value = primary();
    for (;;) {
      skip();
      if (text[at] !== '*') return value;
      at++;
      const right = primary();
      value = value === null || right === null ? null : value * right;
    }
  }
  function expression() {
    let value = term();
    for (;;) {
      skip();
      const op = text[at];
      if (op !== '+' && op !== '-') return value;
      at++;
      const right = term();
      value = value === null || right === null ? null : (op === '+' ? value + right : value - right);
    }
  }
  const value = expression();
  skip();
  if (at !== text.length) throw new Error(`trailing "${text.slice(at)}" in expression "${text}"`);
  return value;
}

// The operand's shape decides the addressing mode; `known` is false on the first
// pass for a forward reference, which is then assumed absolute.
function operandMode(operand, value, known, table) {
  if (!operand) return table[IMPLIED] !== undefined ? IMPLIED : ACC;
  if (operand === 'a' && table[ACC] !== undefined) return ACC;
  if (operand.startsWith('#')) return IMMEDIATE;
  const indexed = /^(.*),\s*([xy])$/i.exec(operand);
  if (operand.startsWith('(')) {
    if (indexed && indexed[2].toLowerCase() === 'y') return INDY;
    if (/^\(.*,\s*x\s*\)$/i.test(operand)) return INDX;
    return IND;
  }
  const zeroPage = known && value !== null && value >= 0 && value < 256;
  if (indexed) {
    const index = indexed[2].toLowerCase();
    if (index === 'x') return zeroPage && table[ZPX] !== undefined ? ZPX : ABSX;
    return zeroPage && table[ZPY] !== undefined ? ZPY : ABSY;
  }
  if (table[REL] !== undefined) return REL;
  return zeroPage && table[ZP] !== undefined ? ZP : ABS;
}

// The bare expression inside whatever punctuation the mode used.
function operandExpression(operand, mode) {
  if (!operand) return null;
  if (mode === IMMEDIATE) return operand.slice(1);
  if (mode === INDY) return /^\((.*)\)\s*,\s*y$/i.exec(operand)[1];
  if (mode === INDX) return /^\((.*),\s*x\s*\)$/i.exec(operand)[1];
  if (mode === IND) return /^\((.*)\)$/.exec(operand)[1];
  if ([ZPX, ZPY, ABSX, ABSY].includes(mode)) return /^(.*),\s*[xy]$/i.exec(operand)[1];
  return operand;
}

function immediateValue(text, symbols, strict) {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) { const v = evaluate(trimmed.slice(1), symbols, strict); return v === null ? null : v & 0xFF; }
  if (trimmed.startsWith('>')) { const v = evaluate(trimmed.slice(1), symbols, strict); return v === null ? null : (v >> 8) & 0xFF; }
  return evaluate(trimmed, symbols, strict);
}

/**
 * @param {string} source  the program
 * @param {object} [predefined]  constants the caller already knows
 * @returns {{bytes: Uint8Array, origin: number, symbols: object}}
 */
export function assemble(source, predefined = {}) {
  const lines = source.split('\n').map((text, index) => ({ text, index }));
  // Symbols carry from one pass to the next, so a forward reference resolves on
  // the second. `backward` holds only what this pass has already defined, and
  // decides zero page: judging that on a symbol the pass has not reached yet
  // would size an instruction differently in each pass and shift every label
  // after it. A forward reference is therefore always absolute.
  const symbols = { ...predefined };
  let bytes = [], origin = null;

  for (let pass = 0; pass < 2; pass++) {
    const strict = pass === 1;
    const backward = { ...predefined };
    bytes = [];
    let pc = origin ?? 0;
    let started = origin !== null;
    for (const { text, index } of lines) {
      const where = `line ${index + 1}: ${text.trim()}`;
      try {
        let line = text.replace(/;.*$/, '').trim();
        if (!line) continue;
        const labelled = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
        if (labelled) { symbols[labelled[1]] = backward[labelled[1]] = pc; line = line.slice(labelled[0].length).trim(); }
        if (!line) continue;
        const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
        if (assigned) { symbols[assigned[1]] = backward[assigned[1]] = evaluate(assigned[2].trim(), symbols, strict); continue; }

        // The operand is the rest of the line, not a re-joined split: a `.scr`
        // string's own spacing is part of what it prints, and splitting on
        // whitespace would quietly collapse it.
        const [, word, operand] = /^(\S+)\s*([\s\S]*)$/.exec(line);
        const directive = word.toLowerCase();
        if (directive === '.org') {
          pc = evaluate(operand, symbols, true);
          if (!started) { origin = pc; started = true; }
          continue;
        }
        if (directive === '.byte' || directive === '.word') {
          for (const part of operand.split(',')) {
            const value = immediateValue(part, symbols, strict) ?? 0;
            bytes.push(value & 0xFF);
            if (directive === '.word') bytes.push((value >> 8) & 0xFF);
            pc += directive === '.word' ? 2 : 1;
          }
          continue;
        }
        if (directive === '.fill') {
          const [countText, valueText = '0'] = operand.split(',');
          const count = evaluate(countText.trim(), symbols, true);
          const value = evaluate(valueText.trim(), symbols, strict) ?? 0;
          for (let i = 0; i < count; i++) bytes.push(value & 0xFF);
          pc += count;
          continue;
        }
        if (directive === '.scr') {
          const quoted = /^"(.*)"$/.exec(operand);
          if (!quoted) throw new Error('.scr needs a quoted string');
          const codes = screenCodes(quoted[1]);
          bytes.push(...codes); pc += codes.length;
          continue;
        }

        const table = OPCODES[directive];
        if (!table) throw new Error(`unknown instruction "${word}"`);
        const expression = operandExpression(operand, operandMode(operand, null, false, table));
        const probe = expression === null ? null : immediateValue(expression, backward, false);
        const mode = operandMode(operand, probe, probe !== null, table);
        const opcode = table[mode];
        if (opcode === undefined) throw new Error(`"${word}" has no ${mode} addressing mode`);
        const size = SIZE[mode];
        let value = expression === null ? 0 : (immediateValue(operandExpression(operand, mode), symbols, strict) ?? 0);
        bytes.push(opcode);
        if (mode === REL) {
          const offset = value - (pc + 2);
          if (strict && (offset < -128 || offset > 127)) throw new Error(`branch out of range (${offset})`);
          bytes.push(offset & 0xFF);
        } else if (size === 2) {
          if (strict && (value < -128 || value > 255)) throw new Error(`value $${value.toString(16)} does not fit in one byte`);
          bytes.push(value & 0xFF);
        } else if (size === 3) {
          bytes.push(value & 0xFF, (value >> 8) & 0xFF);
        }
        pc += size;
      } catch (error) {
        throw new Error(`${where}\n  ${error.message}`);
      }
    }
  }
  return { bytes: Uint8Array.from(bytes), origin: origin ?? 0, symbols };
}
