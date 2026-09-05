// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/crt.mjs — prg2crt: a program wrapped in a cartridge that starts it.
//
// A cartridge is ROM the machine maps over its own memory, so a program cannot
// simply be laid in one: at $8000 the ROM stands where the program's RAM has to
// be. The way out is a cartridge that can switch itself off — Magic Desk, which
// answers a write to $DE00 with a bank number, or with bit 7 to leave the map
// alone entirely. So what this writes is a Magic Desk image whose first bank
// holds a loader: it initialises the machine the way a reset would, copies the
// program out of the cartridge's other banks into RAM, switches the cartridge
// out, and starts the program — SYS for a program with a BASIC stub, RUN for a
// BASIC program.
//
// The copier cannot run from the cartridge, since the ROM under it changes with
// every bank; it is moved to $0100 first and runs from there.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { sniff, sysTarget } from './formats.mjs';
import { say, fail } from './report.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { prgOverflow } from './core.mjs';

const BANK_SIZE = 8192;
const MAX_BANKS = 64;                            // Magic Desk's register is 6 bits
const ROM_WINDOW = 0x8000;
const COPIER_AT = 0x0100;                        // the stack page's floor, below any program
const MAGIC_DESK = 19;                           // CRT hardware type

// ── the CRT container ────────────────────────────────────────────────────────

function crtHeader(name) {
  const h = Buffer.alloc(0x40);
  h.write('C64 CARTRIDGE   ', 0, 'ascii');
  h.writeUInt32BE(0x40, 0x10);                   // header length
  h.writeUInt16BE(0x0100, 0x14);                 // version 1.0
  h.writeUInt16BE(MAGIC_DESK, 0x16);             // hardware type
  h[0x18] = 0;                                   // EXROM asserted
  h[0x19] = 1;                                   // GAME not asserted: an 8K cartridge
  h.write(name.slice(0, 32), 0x20, 'ascii');
  return h;
}

function chipPacket(bank, data) {
  const c = Buffer.alloc(0x10 + data.length);
  c.write('CHIP', 0, 'ascii');
  c.writeUInt32BE(0x10 + data.length, 4);        // packet length, header included
  c.writeUInt16BE(0, 8);                         // chip type: ROM
  c.writeUInt16BE(bank, 10);
  c.writeUInt16BE(ROM_WINDOW, 12);               // where the bank appears
  c.writeUInt16BE(data.length, 14);
  Buffer.from(data).copy(c, 0x10);
  return c;
}

// ── the loader ───────────────────────────────────────────────────────────────

// KERNAL entry points a reset would call, in the order it calls them.
const IOINIT = 0xFDA3, RAMTAS = 0xFD50, RESTOR = 0xFD15, CINT = 0xFF5B;
// BASIC, for a program with no SYS to jump to.
const INITV = 0xE453, INITBA = 0xE3BF, CLR = 0xA659, RUN = 0xA7AE;

const lo = a => a & 0xFF;
const hi = a => (a >> 8) & 0xFF;

/**
 * The copier, assembled to run at $0100. It walks the payload a page at a time
 * out of the 8K window, stepping to the next bank whenever the window runs out,
 * and switches the cartridge off before it starts the program.
 */
function copier({ dest, length, start, end }) {
  const code = [];
  const at = () => COPIER_AT + code.length;
  const emit = (...b) => code.push(...b);
  const patches = [];
  const branch = to => { patches.push({ at: code.length, to }); emit(0x00); };

  const pages = Math.floor(length / 256);
  const rest = length % 256;

  emit(0xA9, 0x00, 0x85, 0xFD);                  // LDA #$00 : STA $FD   source lo
  emit(0xA9, 0x80, 0x85, 0xFE);                  // LDA #$80 : STA $FE   source hi
  emit(0xA9, lo(dest), 0x85, 0xFB);              // LDA #<dest : STA $FB
  emit(0xA9, hi(dest), 0x85, 0xFC);              // LDA #>dest : STA $FC
  emit(0xA9, 0x01, 0x85, 0x02);                  // LDA #$01 : STA $02   the payload starts in bank 1
  emit(0x8D, 0x00, 0xDE);                        // STA $DE00
  emit(0xA2, pages & 0xFF);                      // LDX #pages
  emit(0xF0); branch('rest');                    // BEQ rest             a payload under a page long

  const pageloop = at();
  emit(0xA0, 0x00);                              // LDY #$00
  const copy = at();
  emit(0xB1, 0xFD, 0x91, 0xFB, 0xC8);            // LDA ($FD),Y : STA ($FB),Y : INY
  emit(0xD0, (copy - (at() + 2)) & 0xFF);        // BNE copy
  emit(0xE6, 0xFE, 0xE6, 0xFC);                  // INC $FE : INC $FC
  // The window is checked before the page count, so a payload that ends on a
  // bank boundary reads its tail from the next bank and not from BASIC ROM.
  emit(0xA5, 0xFE, 0xC9, 0xA0);                  // LDA $FE : CMP #$A0
  emit(0xD0); branch('next');                    // BNE next
  emit(0xA9, 0x80, 0x85, 0xFE);                  // LDA #$80 : STA $FE
  emit(0xE6, 0x02, 0xA5, 0x02, 0x8D, 0x00, 0xDE); // INC $02 : LDA $02 : STA $DE00
  const next = at();
  emit(0xCA);                                    // DEX
  emit(0xD0, (pageloop - (at() + 2)) & 0xFF);    // BNE pageloop

  const restAt = at();
  emit(0xA0, 0x00);                              // LDY #$00
  const tail = at();
  emit(0xC0, rest);                              // CPY #rest
  emit(0xF0); branch('done');                    // BEQ done
  emit(0xB1, 0xFD, 0x91, 0xFB, 0xC8);            // LDA ($FD),Y : STA ($FB),Y : INY
  emit(0x4C, lo(tail), hi(tail));                // JMP tail

  const done = at();
  emit(0xA9, 0x80, 0x8D, 0x00, 0xDE);            // LDA #$80 : STA $DE00   the cartridge steps aside
  if (start !== null) {
    emit(0x58);                                  // CLI
    emit(0x4C, lo(start), hi(start));            // JMP start
  } else {
    // No SYS to jump to, so BASIC runs it: initialise BASIC, point it at the
    // end of the program, and CLR then RUN as a person would.
    emit(0x20, lo(INITV), hi(INITV));            // JSR $E453
    emit(0x20, lo(INITBA), hi(INITBA));          // JSR $E3BF
    emit(0xA9, lo(end), 0x85, 0x2D);             // LDA #<end : STA $2D
    emit(0xA9, hi(end), 0x85, 0x2E);             // LDA #>end : STA $2E
    emit(0x58);                                  // CLI
    emit(0x20, lo(CLR), hi(CLR));                // JSR $A659
    emit(0x4C, lo(RUN), hi(RUN));                // JMP $A7AE
  }

  const label = { rest: restAt, next, done };
  for (const { at: i, to } of patches) code[i] = (label[to] - (COPIER_AT + i + 1)) & 0xFF;
  return Uint8Array.from(code);
}

/** Bank 0: the reset vectors, the CBM80 signature, and the loader itself. */
function loaderBank(program) {
  const move = copier(program);
  if (move.length > 0xFF) throw new Error('the cartridge loader outgrew a page');
  const bank = new Uint8Array(BANK_SIZE);
  const code = [];
  const emit = (...b) => code.push(...b);
  const start = ROM_WINDOW + 9;                   // vectors and signature come first

  emit(0x78, 0xD8, 0xA2, 0xFF, 0x9A);            // SEI : CLD : LDX #$FF : TXS
  for (const call of [IOINIT, RAMTAS, RESTOR, CINT]) emit(0x20, lo(call), hi(call));
  // The copier is moved into RAM before a bank is ever switched: after that,
  // the ROM under $8000 is the payload and no longer this code.
  emit(0xA2, move.length);                        // LDX #len
  const fromAt = code.length + 1;                 // …reading from an address only known below
  emit(0xBD, 0x00, 0x00);                         // LDA from-1,X
  emit(0x9D, lo(COPIER_AT - 1), hi(COPIER_AT - 1)); // STA $00FF,X
  emit(0xCA, 0xD0, 0xF7);                         // DEX : BNE -9
  emit(0x4C, lo(COPIER_AT), hi(COPIER_AT));       // JMP $0100
  const from = start + code.length;               // the copier's image follows the loader
  code[fromAt] = lo(from - 1);
  code[fromAt + 1] = hi(from - 1);

  bank[0] = lo(start); bank[1] = hi(start);       // cold start
  bank[2] = lo(start); bank[3] = hi(start);       // NMI
  bank.set([0xC3, 0xC2, 0xCD, 0x38, 0x30], 4);    // CBM80
  bank.set(code, 9);
  bank.set(move, from - ROM_WINDOW);
  return bank;
}

/**
 * A .prg turned into a Magic Desk cartridge image.
 * @param {Uint8Array} prg  load address then data
 * @param {string} name     what the cartridge calls itself
 */
export function prgToCrt(prg, name) {
  const dest = prg[0] | (prg[1] << 8);
  const payload = prg.subarray(2);
  if (dest < 0x0200) {
    throw new Error(`loads at $${dest.toString(16).toUpperCase()}, under the $0200 the cartridge's own copier needs`);
  }
  const banks = Math.ceil(payload.length / BANK_SIZE) + 1;
  if (banks > MAX_BANKS) throw new Error(`too big: ${banks} banks, and a Magic Desk cartridge holds ${MAX_BANKS}`);

  const start = sysTarget(prg);
  const parts = [
    crtHeader(name),
    chipPacket(0, loaderBank({ dest, length: payload.length, start, end: dest + payload.length })),
  ];
  for (let b = 1; b < banks; b++) {
    const chunk = payload.subarray((b - 1) * BANK_SIZE, b * BANK_SIZE);
    const full = new Uint8Array(BANK_SIZE);      // padded: every bank is a whole 8K
    full.set(chunk);
    parts.push(chipPacket(b, full));
  }
  return { bytes: Buffer.concat(parts), banks, start, dest };
}

// ── the command ──────────────────────────────────────────────────────────────

export function prg2crt(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy prg2crt <in.prg…> [-o out.crt]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  let failed = false;
  for (const p of files) {
    try {
      const bytes = fs.readFileSync(p);
      if (sniff(bytes, p) !== 'prg') throw new Error('not a .prg file');
      const over = prgOverflow(bytes);
      if (over) {
        throw new Error(over.short ? 'too short to be a .prg'
          : `claims to load past the top of memory ($${over.end.toString(16).toUpperCase()})`);
      }
      const name = path.basename(p).replace(/\.[^.]*$/, '').toUpperCase();
      const cart = prgToCrt(bytes, name);
      const out = outFileFor(p, '.crt', flags, files.length);
      writeOut(out, cart.bytes, flags);
      say(`${path.basename(p)} → ${out}`);
      say(`  Magic Desk, ${cart.banks} banks · loads to $${cart.dest.toString(16).toUpperCase()} · ` +
        (cart.start === null ? 'starts with RUN' : `starts at SYS ${cart.start}`));
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
