// test/d64-error-table-dos-spec-test.js
//
// End-to-end: an image's error table reaches the REAL 1541 DOS. Boots C64 +
// 1541 with true drive emulation, block-reads sectors of one track through the
// DOS `U1` command, and reads back what the error channel says about each.
//
// Why this test is not a duplicate: test/d64-format-spec-test.js checks the GCR
// bytes the encoder produces for each error code — the read head's view. This
// one checks the consequence, which is the part that matters to a protection
// check: the DOS's own error number, arrived at through its sync hunt, header
// search and checksum verification, over the emulated serial bus.
//
// Spec basis: 1541 DOS error numbering (20 READ ERROR = header block not found,
// 21 = no sync, 23 = data checksum) and the `U1` block-read command, 1541 User's
// Manual; the D64 error-table codes, Peter Schepers' D64 document.
//
// Observed surface: the C64's screen after a BASIC program prints what
// INPUT#15 read from the drive's command channel. Nothing internal is inspected.
//
// Note the two cases. One sector without sync reports 20, not 21: the rest of
// the track still has sync, so the drive finds sync but never that header —
// which is what a real drive does with the same physical damage. A track whose
// every sector is marked 21 (how a tool images a track that had no sync at all,
// and what "killer track" protections look for) is what makes the DOS's
// sync-wait itself time out, and that reports 21.

import { readFileSync, existsSync } from 'fs';
import { C64Machine } from '../src/machine.js';
import { D64, createBlankD64, SPT } from '../src/d64.js';

const ROM_FILES = ['roms/kernal.bin', 'roms/basic.bin', 'roms/chargen.bin', 'roms/1541.bin'];
if (!ROM_FILES.every(existsSync)) { console.log('# SKIP C64/1541 ROMs not available'); process.exit(0); }

const KERNAL  = new Uint8Array(readFileSync('roms/kernal.bin'));
const BASIC   = new Uint8Array(readFileSync('roms/basic.bin'));
const CHARGEN = new Uint8Array(readFileSync('roms/chargen.bin'));
const ROM1541 = new Uint8Array(readFileSync('roms/1541.bin'));

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// ── a BASIC tokenizer, enough for the program below ───────────────────────────
const TOKENS = [['PRINT#', 0x98], ['INPUT#', 0x84], ['PRINT', 0x99], ['OPEN', 0x9F], ['CLOSE', 0xA0]];
function tokenize(text) {
  const out = [];
  let i = 0, inQuote = false;
  while (i < text.length) {
    if (text[i] === '"') { inQuote = !inQuote; out.push(0x22); i++; continue; }
    const kw = inQuote ? null : TOKENS.find(([k]) => text.startsWith(k, i));
    if (kw) { out.push(kw[1]); i += kw[0].length; continue; }
    out.push(text.charCodeAt(i) & 0xFF); i++;
  }
  return out;
}
function basicProgram(lines) {
  const bytes = [0x01, 0x08];
  let addr = 0x0801;
  for (const [num, text] of lines) {
    const body = tokenize(text);
    addr += 4 + body.length + 1;
    bytes.push(addr & 0xFF, addr >> 8, num & 0xFF, num >> 8, ...body, 0x00);
  }
  bytes.push(0, 0);
  return new Uint8Array(bytes);
}

function screenText(m) {
  let s = '';
  for (let i = 0; i < 1000; i++) {
    const c = m.mem.ram[0x0400 + i] & 0x7F;
    s += c < 32 ? String.fromCharCode(c + 64) : c < 64 ? String.fromCharCode(c) : ' ';
    if (i % 40 === 39) s += '\n';
  }
  return s;
}

function sectorOffset(track, sector) {
  let off = 0;
  for (let t = 1; t < track; t++) off += SPT[t];
  return (off + sector) * 256;
}

/** A 35-track image with an error table, `codes` = {"track/sector": code}. */
function imageWithErrors(codes) {
  const src = createBlankD64('ERROR TEST', 'E1');
  const img = new Uint8Array(175531);
  img.set(src.img, 0);
  img.fill(1, 174848);
  for (const [where, code] of Object.entries(codes)) {
    const [t, s] = where.split('/').map(Number);
    img[174848 + sectorOffset(t, s) / 256] = code;
  }
  return new D64(img);
}

const ready = (m) => { const r = m.mem.ram; return r[0xC6] === 0 && r[0xCC] === 0 && r[0x2C] === 0x08; };

/** Boot, mount `disk`, U1-read sectors 5/6/7 of track 20, return the screen. */
function readErrorChannel(disk) {
  const m = new C64Machine();
  m.loadROMs({ kernal: KERNAL, basic: BASIC, charRom: CHARGEN });
  m.attachDrive(ROM1541);
  m.setTrueDrive(true);
  m.setD64(disk);
  for (let f = 0; f < 500 && !ready(m); f++) m.runFrame();
  assert(ready(m), 'C64 reached the READY prompt');

  m.loadPRG(basicProgram([
    [10, 'OPEN15,8,15:OPEN2,8,2,"#"'],
    [20, 'PRINT#15,"U1 2 0 20 7":INPUT#15,A,B$,C,D:PRINT"S7 ERR"A'],
    [30, 'PRINT#15,"U1 2 0 20 6":INPUT#15,A,B$,C,D:PRINT"S6 ERR"A'],
    [40, 'PRINT#15,"U1 2 0 20 5":INPUT#15,A,B$,C,D:PRINT"S5 ERR"A'],
    [50, 'CLOSE2:CLOSE15:PRINT"DONE"'],
  ]));
  const run = 'RUN\r';
  for (let i = 0; i < run.length; i++) m.mem.ram[0x0277 + i] = run.charCodeAt(i);
  m.mem.ram[0xC6] = run.length;
  for (let f = 0; f < 4000; f++) {
    m.runFrame();
    if (f > 60 && screenText(m).includes('DONE')) break;
  }
  const text = screenText(m);
  assert(text.includes('DONE'), 'the block-read program ran to completion');
  return text;
}

// ── 1. one bad sector each, the rest of the track intact ─────────────────────
{
  const text = readErrorChannel(imageWithErrors({ '20/5': 3, '20/6': 5 }));
  assert(/S7 ERR\s+0\b/.test(text), 'a sector with no recorded error reads with error 0');
  assert(/S6 ERR\s+23\b/.test(text), 'a sector recorded as 23 reports 23 (data checksum)');
  assert(/S5 ERR\s+20\b/.test(text),
    'a lone sector whose sync is gone reports 20 — the drive finds sync elsewhere on the track, never that header');
  if (failed) console.error(text);
}

// ── 2. a whole track marked 21: the DOS's sync-wait is what fails ────────────
{
  const codes = {};
  for (let s = 0; s < SPT[20]; s++) codes[`20/${s}`] = 3;
  const text = readErrorChannel(imageWithErrors(codes));
  assert(/S7 ERR\s+21\b/.test(text) && /S6 ERR\s+21\b/.test(text) && /S5 ERR\s+21\b/.test(text),
    'every sector of a track with no sync at all reports 21');
  if (failed) console.error(text);
}

if (failed > 0) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS – D64 error-table codes reach the real 1541 DOS (20 / 21 / 23 as recorded)');
