// Spec test for the flag parser (cli/args.mjs), the output-path rule
// (cli/tape.mjs outFileFor) and the entry's global flags: flags parse by long
// name and alias, unknown flags are refused by name, a number that has to be
// whole or positive is checked as such, -o with several inputs is a usage
// error, and a `--` ends the flags for everyone — the rules a batch user hits
// first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, numberFlag, countFlag, positiveFlag, inputFiles, UsageError } from '../args.mjs';
import { outFileFor, oneOutputOnly, writeOut } from '../tape.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}
function throwsUsage(fn, msg) {
  try { fn(); } catch (e) {
    assert(e instanceof UsageError, `${msg} — threw ${e.constructor.name} instead of UsageError`);
    return;
  }
  assert(false, `${msg} — did not throw`);
}

// Positionals and flags separate, in any order.
{
  const { args, flags } = parseArgs(['a.wav', '-o', 'out.tap', 'b.wav', '--ntsc'],
    { out: { value: true, alias: 'o' }, ntsc: {} });
  eq(args, ['a.wav', 'b.wav'], 'positionals survive interleaved flags');
  eq(flags.out, 'out.tap', 'alias -o fills the long name');
  eq(flags.ntsc, true, 'boolean flag is true when present');
}

// --flag=value spelling.
{
  const { flags } = parseArgs(['--channel=mix'], { channel: { value: true } });
  eq(flags.channel, 'mix', '--flag=value parses');
}

// Unknown flags are refused by name, not ignored.
throwsUsage(() => parseArgs(['--nope']), 'unknown long flag is refused');
throwsUsage(() => parseArgs(['-z'], {}), 'unknown alias is refused');

// A value flag with nothing after it says so.
throwsUsage(() => parseArgs(['--out'], { out: { value: true } }), 'missing value is refused');

// A boolean flag given a value says so.
throwsUsage(() => parseArgs(['--ntsc=1'], { ntsc: {} }), 'value on a boolean flag is refused');

// Global flags parse on every command without being declared.
{
  const { flags } = parseArgs(['--quiet', 'x.tap']);
  eq(flags.quiet, true, '--quiet is accepted everywhere');
}

// -- ends flag parsing, so a file named like a flag is reachable.
{
  const { args } = parseArgs(['--', '--weird-name.tap']);
  eq(args, ['--weird-name.tap'], '-- passes the rest through as positionals');
}

// Numbers are checked where a number is required.
{
  const { flags } = parseArgs(['--frames', '90'], { frames: { value: true } });
  eq(numberFlag(flags, 'frames'), 90, 'numberFlag parses a number');
}
throwsUsage(() => {
  const { flags } = parseArgs(['--frames', 'many'], { frames: { value: true } });
  numberFlag(flags, 'frames');
}, 'a non-number where a number is needed is refused');

// A count is whole and at least one: a run of -1 frames, or of 1.5, is a
// wrong invocation and not a photograph of the boot screen.
{
  const { flags } = parseArgs(['--frames', '90'], { frames: { value: true } });
  eq(countFlag(flags, 'frames'), 90, 'a whole count passes');
}
for (const bad of ['-1', '0', '1.5']) {
  throwsUsage(() => {
    const { flags } = parseArgs([`--frames=${bad}`], { frames: { value: true } });
    countFlag(flags, 'frames');
  }, `--frames ${bad} is refused: a count is whole and at least 1`);
}
// A measure may be fractional but never zero or below: a rate of 0 measures
// nothing.
{
  const { flags } = parseArgs(['--speed', '0.5'], { speed: { value: true } });
  eq(positiveFlag(flags, 'speed'), 0.5, 'a fraction above zero passes');
}
for (const bad of ['0', '-2']) {
  throwsUsage(() => {
    const { flags } = parseArgs([`--speed=${bad}`], { speed: { value: true } });
    positiveFlag(flags, 'speed');
  }, `--speed ${bad} is refused: a measure is above 0`);
}

// -o names one file: with several inputs it is a usage error, not a silent
// overwrite of the same output twice — asked before any work, and again at
// the moment of writing.
throwsUsage(() => oneOutputOnly({ out: 'x.tap' }, 2), '-o with multiple inputs is refused up front');
oneOutputOnly({ out: 'x.tap' }, 1);
oneOutputOnly({ 'out-dir': 'd' }, 5);
throwsUsage(() => outFileFor('b.wav', '.tap', { out: 'x.tap' }, 2), '-o with multiple inputs is refused');
eq(outFileFor('/tapes/a.wav', '.tap', {}, 1), 'a.tap',
  'the default output lands where the command is run, never in the input\'s folder');
{
  // --out-dir also creates the directory, so a batch never dies on its first write.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-args-')), 'deeper');
  eq(outFileFor('/tapes/a.wav', '.tap', { 'out-dir': dir }, 3), path.join(dir, 'a.tap'), '--out-dir moves it');
  assert(fs.existsSync(dir), '--out-dir is created when missing');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}
eq(outFileFor('a.wav', '.tap', { out: 'named.tap' }, 1), 'named.tap', '-o names it');
// A suffix rather than a bare extension: tapfix's mended tape goes the same
// route as every other output, so --out-dir is created for it too.
eq(outFileFor('/tapes/side-a.tap', '-mended.tap', {}, 1), 'side-a-mended.tap',
  'an ext that carries a suffix renames rather than just swaps');

// ── writing over what is already there ──────────────────────────────────────
// A tape, a disk or a cartridge costs minutes of machine to make, so a second
// run does not quietly replace the first one's work.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-write-'));
  const out = path.join(dir, 'side-a.tap');
  writeOut(out, Buffer.from('first'), {});
  eq(fs.readFileSync(out, 'utf8'), 'first', 'a new output is written');
  try {
    writeOut(out, Buffer.from('second'), {});
    assert(false, 'a second write over the same path is refused');
  } catch (e) {
    assert(/already there/.test(e.message), `refused for the right reason, said "${e.message}"`);
    assert(!(e instanceof UsageError), 'and as a failed input, not wrong usage: the command line was fine');
  }
  eq(fs.readFileSync(out, 'utf8'), 'first', 'and the first one is still there');
  writeOut(out, Buffer.from('second'), { force: true });
  eq(fs.readFileSync(out, 'utf8'), 'second', '--force writes over it');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── wildcards in the inputs ─────────────────────────────────────────────────
// A Unix shell expands these before the tool sees them; a quoted pattern and a
// Windows shell do not, so the tool expands what is left — and never touches an
// argument that names a file which exists.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-glob-'));
  for (const n of ['b.tap', 'a.tap', 'c.wav']) fs.writeFileSync(path.join(dir, n), 'x');
  const names = list => list.map(p => path.basename(p));

  eq(names(inputFiles([path.join(dir, '*.tap')])), ['a.tap', 'b.tap'],
    'a wildcard expands to what it matches, sorted, so a batch runs in one order everywhere');
  eq(names(inputFiles([path.join(dir, '?.wav')])), ['c.wav'], '? matches one character');
  eq(names(inputFiles([path.join(dir, '[ab].tap')])), ['a.tap', 'b.tap'], '[ab] is a set of characters');
  eq(names(inputFiles([path.join(dir, '[!a].tap')])), ['b.tap'], '[!a] is anything but');
  eq(names(inputFiles([path.join(dir, '[a-b].tap')])), ['a.tap', 'b.tap'], '[a-b] is a range');
  eq(names(inputFiles([path.join(dir, 'a.tap'), path.join(dir, 'c.wav')])), ['a.tap', 'c.wav'],
    'plain paths — what a shell hands over — pass through untouched');

  // A file whose name really holds a wildcard is a file, not a pattern.
  const odd = path.join(dir, 'we*rd.tap');
  fs.writeFileSync(odd, 'x');
  eq(names(inputFiles([odd])), ['we*rd.tap'], 'a file that exists wins over reading it as a pattern');

  throwsUsage(() => inputFiles([path.join(dir, '*.d64')]), 'a pattern matching nothing is a usage error');
  throwsUsage(() => inputFiles([path.join(dir, '*', 'x.tap')]), 'a wildcard in the folder is refused, not half-supported');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── the entry's global flags ─────────────────────────────────────────────────
// They mean the same before the command as after it, and a `--` ends them:
// past it, a word that looks like a flag is a filename.
const CLI = fileURLToPath(new URL('../c64rdy.mjs', import.meta.url));
const cli = (...argv) => {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-cli-'));
  const file = path.join(tmp, 'small.prg');
  fs.writeFileSync(file, Buffer.from([0x01, 0x08, 0, 0]));

  eq(cli('--quiet', 'info', file).code, 0, 'a global flag may stand before the command');
  eq(cli('--version').out.trim(), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version,
    '--version alone answers with the version');
  assert(cli('--help').out.includes('C64 READY. CLI'), '--help alone answers with the command list');
  assert(cli().out.includes('C64 READY. CLI'), 'no arguments at all answers with the command list');

  const past = cli('info', '--', '--help');
  assert(!past.out.includes('Exit codes:'), 'past a `--`, --help is a filename and not the help page');
  eq(past.code, 1, 'and it fails as a missing file: an input that failed outright');
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} args assertion(s) failed`);
  process.exit(1);
}
console.log('cli args spec: PASS');
