// Spec test for run's argument rules and its tape file choice (cli/run.mjs):
// which inputs each flag belongs to, which numbers a flag will take, and — with
// no --file — which program a tape runs. No machine boots here: every rule
// below is answered before a ROM is looked for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, firstProgram, tap2prg, prgNameFor, prgFromBytes } from '../run.mjs';
import { UsageError } from '../args.mjs';
import { setQuiet } from '../report.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}
async function throwsUsage(argv, msg) {
  try { await run(argv); } catch (e) {
    assert(e instanceof UsageError, `${msg} — threw ${e.constructor.name}: ${e.message}`);
    return;
  }
  assert(false, `${msg} — did not throw`);
}

async function cmdThrowsUsage(cmd, argv, msg) {
  try { await cmd(argv); } catch (e) {
    assert(e instanceof UsageError, `${msg} — threw ${e.constructor.name}: ${e.message}`);
    return;
  }
  assert(false, `${msg} — did not throw`);
}

setQuiet(true);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-run-'));
const prg = path.join(tmp, 'game.prg');
fs.writeFileSync(prg, Buffer.from([0x01, 0x08, 0x0B, 0x08, 0x0A, 0x00, 0x9E, 0x32, 0x30, 0x36, 0x31, 0, 0, 0]));

// A flag belongs to the inputs it can mean something for. A .prg is one
// program and boots as itself, so neither picker applies to it.
await throwsUsage([prg, '--all'], '--all is refused on a .prg');
await throwsUsage([prg, '--file', 'GAME'], '--file is refused on a .prg');
// One PNG per program cannot be one named output.
await throwsUsage([prg, '--all', '-o', 'x.png'], '--all with -o is refused');
// Numbers: frames count, the film rates measure, and the machine's own 50
// frames a second is the ceiling on filming — none can be filmed twice.
await throwsUsage([prg, '--frames', '0'], '--frames 0 is refused');
await throwsUsage([prg, '--frames', '2.5'], '--frames 2.5 is refused');
await throwsUsage([prg, '--fps', '0'], '--fps 0 is refused');
await throwsUsage([prg, '--fps', '60'], '--fps above 50 is refused');
await throwsUsage([prg, '--speed', '-1'], '--speed -1 is refused');
fs.rmSync(tmp, { recursive: true, force: true });

// Without --file, a tape runs its first program. A turbo tape carries the
// loader its files need as an ordinary KERNAL file at the front — running that
// would photograph the loader, not a program, so it is passed over.
const file = (name, format, damaged = false) => ({ name, format, damaged });
{
  const kernalOnly = [file('HEMAN', 'CBM'), file('SECOND', 'CBM')];
  eq(firstProgram(kernalOnly).name, 'HEMAN', 'a KERNAL-only tape runs its first file');

  const turbo = [file('TURBO 250', 'CBM'), file('TRAILBLAZER', 'Turbo Tape 64'), file('FEUD', 'Turbo Tape 64')];
  eq(firstProgram(turbo).name, 'TRAILBLAZER', "a turbo tape passes over the loader it needs");

  const noLoader = [file('TRAILBLAZER', 'Turbo Tape 64'), file('FEUD', 'Turbo Tape 64')];
  eq(firstProgram(noLoader).name, 'TRAILBLAZER', 'a tape with no loader on it runs its first file');

  // A damaged installer is no installer: it cannot serve the turbo files, so
  // nothing is passed over on its account.
  const broken = [file('TURBO 250', 'CBM', true), file('TRAILBLAZER', 'Turbo Tape 64')];
  eq(firstProgram(broken).name, 'TURBO 250', 'a damaged KERNAL file is not the loader to skip');
}


// ── tap2prg ──────────────────────────────────────────────────────────────────
// What a kept file is called on disk. A tape names few of its files — most
// turbo files and every self-driving one are anonymous — and a name is not
// unique either, so neither branch may quietly drop a program.
{
  const named = n => ({ name: n, start: 0x0801 });

  eq(prgNameFor(named('OLYMPIA'), 0, new Set()), 'OLYMPIA.prg',
    'a file with a name of its own keeps it');
  eq(prgNameFor(named('SPY VS SPY'), 0, new Set()), 'SPY VS SPY.prg',
    'a space is legal in a host filename and is kept');
  eq(prgNameFor(named('A/B:C'), 0, new Set()), 'A_B_C.prg',
    'a character no filesystem takes becomes an underscore, not a lost file');

  // An anonymous file is identified the way the listing identifies it: where it
  // sits on the tape, and where it loads.
  eq(prgNameFor({ name: '', start: 0x0810 }, 2, new Set()), '03-0810.prg',
    'a file with no name is named by its place on the tape and its load address');
  eq(prgNameFor({ name: '   ', start: 0xC000 }, 0, new Set()), '01-c000.prg',
    'a name of nothing but spaces is no name');

  // Two files called the same thing are two files.
  {
    const taken = new Set();
    eq(prgNameFor(named('GAME'), 0, taken), 'GAME.prg', 'the first of a name gets it plain');
    eq(prgNameFor(named('GAME'), 1, taken), 'GAME-2.prg',
      'the second is numbered rather than overwriting the first');
    eq(prgNameFor(named('GAME'), 2, taken), 'GAME-3.prg', 'and so is the third');
  }
  // Case cannot be what separates two names: a filesystem may not agree.
  {
    const taken = new Set();
    prgNameFor(named('Game'), 0, taken);
    eq(prgNameFor(named('GAME'), 1, taken), 'GAME-2.prg',
      'two names differing only in case are still two files');
  }
}


// A .prg is its load address, little end first, and then exactly the payload.
// The length is the payload's own: start and end say what the tape claims, and
// a format whose end address is inclusive rather than exclusive makes that
// arithmetic off by one while the bytes are still right.
{
  const prg = prgFromBytes({ start: 0x0801, end: 0x0805, bytes: Uint8Array.from([1, 2, 3, 4]) });
  eq([...prg].join(), [0x01, 0x08, 1, 2, 3, 4].join(),
    'the address goes low byte first, then the bytes');
  eq(prg.length, 6, 'two bytes of address and four of payload');

  // The payload is the authority, not end - start.
  const odd = prgFromBytes({ start: 0x1000, end: 0x1002, bytes: Uint8Array.from([9, 9, 9, 9, 9]) });
  eq(odd.length, 7, 'a payload longer than end - start is still written whole');
  eq([...odd.subarray(0, 2)].join(), [0x00, 0x10].join(), 'and its address is unaffected');

  const high = prgFromBytes({ start: 0xC000, end: 0xC001, bytes: Uint8Array.from([0xAB]) });
  eq([...high].join(), [0x00, 0xC0, 0xAB].join(), 'an address above $8000 keeps its high byte');
}

// It reads tapes, so it needs at least one.
await cmdThrowsUsage(tap2prg, [], 'tap2prg with no tape is refused');

if (failures) {
  console.error(`\n${failures} run assertion(s) failed`);
  process.exit(1);
}
console.log('cli run spec: PASS');
