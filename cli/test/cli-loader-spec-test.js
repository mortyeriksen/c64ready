// Spec test for the loader probe's rules (cli/loader.mjs) and the disassembler
// it reads code with (cli/disasm6502.mjs). No machine boots here: what a
// command refuses, and whether a disassembly of known bytes is right, are both
// answered before a ROM is looked for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, unaccountedRuns, twoSymbols } from '../loader.mjs';
import { disasm } from '../disasm6502.mjs';
import { UsageError } from '../args.mjs';
import { setQuiet } from '../report.mjs';

let failures = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
async function throwsUsage(argv, msg) {
  try { await run(argv); } catch (e) {
    assert(e instanceof UsageError, `${msg} — threw ${e.constructor.name}: ${e.message}`);
    return;
  }
  assert(false, `${msg} — did not throw`);
}

setQuiet(true);

// ── What it takes ────────────────────────────────────────────────────────────
// One tape, because it reads the loader of one tape. Not none, and not a shelf.
await throwsUsage([], 'no input is refused');
await throwsUsage(['a.tap', 'b.tap'], 'two tapes are refused');

// ── The disassembler ─────────────────────────────────────────────────────────
// Reading a loader is reading its code, so this is the instrument and it has to
// be right. The bytes below are the first six instructions of the Goonies boot
// block, whose loader is US Gold / Datasoft: it banks the ROMs, points the NMI
// vector at its own reader in the tape buffer, and blanks the screen.
{
  const at = 0x02B0;
  const code = [0x78, 0xA6, 0xBA, 0x9A, 0xA9, 0x37, 0x95, 0x00,
                0x8E, 0x18, 0x03, 0xA9, 0x03, 0x8D, 0x19, 0x03, 0x4E, 0x11, 0xD0];
  const lines = disasm(a => code[a - at] ?? 0, at, 9).split('\n').map(l => l.trim());
  // Indexed by instruction, not by byte: the widths differ, which is the
  // disassembler's whole job.
  eq(lines[0], '$02b0: 78       SEI', 'an implied instruction');
  eq(lines[1], '$02b1: a6 ba    LDX $ba', 'zero page');
  eq(lines[3], '$02b4: a9 37    LDA #$37', 'immediate');
  eq(lines[5], '$02b8: 8e 18 03 STX $0318', 'absolute, and the NMI vector it writes');
  eq(lines[8], '$02c0: 4e 11 d0 LSR $d011', 'and the register it blanks the screen with');
}
{
  // A relative branch names where it lands, not how far it goes: reading a
  // loader means following its loops.
  const code = [0xD0, 0xF7, 0x4C, 0x00, 0xE0];
  const lines = disasm(a => code[a - 0x03E6] ?? 0, 0x03E6, 2).split('\n').map(l => l.trim());
  eq(lines[0], '$03e6: d0 f7    BNE $03df', 'a backward branch gives its target');
  eq(lines[1], '$03e8: 4c 00 e0 JMP $e000', 'and a jump its address');
}
{
  // Loaders use the illegal opcodes, and a byte that is no instruction at all
  // has to say so rather than be guessed at.
  const lines = disasm(a => [0x73, 0x00, 0x02][a] ?? 0, 0, 2).split('\n').map(l => l.trim());
  assert(lines[0].includes('RRA'), `an illegal opcode is named, got ${lines[0]}`);
  assert(disasm(() => 0x02, 0, 1).includes('.byte $02'),
    'and one that is nothing is shown as a byte rather than guessed at');
}

// ── Which stretches are unaccounted for ─────────────────────────────────
// A tape's leader, the pilot between its blocks and its trailer are separate
// stretches, and each must stay separate: they are what a tape read by two
// formats carries two different lead-in widths in.
{
  const f = (leadPulse, endPulse) => ({ leadPulse, endPulse, atPulse: leadPulse });
  eq(JSON.stringify(unaccountedRuns(100, [f(10, 49), f(60, 89)])),
    JSON.stringify([[0, 9], [50, 59], [90, 99]]),
    'the leader, the gap between two files and the trailer are three runs, not one');
  eq(JSON.stringify(unaccountedRuns(100, [f(0, 99)])), JSON.stringify([]),
    'a tape a format reads end to end leaves no run at all');
  eq(JSON.stringify(unaccountedRuns(100, [])), JSON.stringify([[0, 99]]),
    'a tape with no files read is one run of the whole thing');
  // Spans that overlap or nest must not open a run out of nothing.
  eq(JSON.stringify(unaccountedRuns(100, [f(0, 79), f(20, 39)])), JSON.stringify([[80, 99]]),
    'a span inside another span leaves only the tail');
  // A file the listing gave no end for still covers the pulse it sits at, so it
  // cannot swallow the rest of the tape.
  eq(JSON.stringify(unaccountedRuns(50, [{ atPulse: 10 }])),
    JSON.stringify([[0, 9], [11, 49]]),
    'a file with no endPulse covers just where it sits');
}

// ── One width or two ────────────────────────────────────────────────
// One width carries no bits, so calling a lead-in two symbols is an invention.
// The pair a real format writes sits far apart: the closest among the formats
// read so far is Turbo Tape 64's 216 and 328.
{
  eq(JSON.stringify(twoSymbols([[216, 5000], [328, 4000]])), JSON.stringify([216, 328]),
    'the closest pair any format read here writes is still two symbols');
  eq(twoSymbols([[376, 6000], [384, 400], [368, 300]]), null,
    'a single cluster three buckets wide is a lead-in, not an alphabet');
  eq(twoSymbols([[376, 6275], [304, 3925]]), null,
    'two lead-ins a quarter apart are not one format\'s two symbols (Bomb Jack)');
  eq(twoSymbols([[304, 2030]]), null, 'one width alone is never two symbols');
  eq(JSON.stringify(twoSymbols([[264, 349368], [664, 255281], [352, 79]])),
    JSON.stringify([264, 664]),
    'two populous clusters far apart are a format\'s two symbols (Head Over Heels)');
  eq(twoSymbols([[600, 9000], [216, 3]]), null,
    'a stray pulse at some far width is a mis-timed edge, not half an alphabet');
}

console.log(failures ? `cli loader spec: FAIL (${failures})` : 'cli loader spec: PASS');
process.exit(failures ? 1 : 0);
