// Regenerate the terminal examples in cli/USER-GUIDE-CLI.md from real runs.
//
//   node investigation/guide-shots.mjs [filter]
//
// The guide marks a fenced block with an HTML comment naming the command:
//
//   <!-- shot lines=10: c64rdy dir "Tape 2 - Side B.tap" -->
//
// and this runs the command for real — in a sandbox where the media below is
// symlinked in by basename, so the displayed command reads clean — and writes
// `$ command` plus the captured output back into the block. lines=N keeps the
// first N lines and marks the cut with `…`; tail=N keeps the last N the same
// way. Progress lines are resolved the way a terminal resolves them, by
// keeping only what stands after the last carriage return. An optional filter
// argument regenerates only the shots whose command contains it.
//
// The point is the one the guide itself learned the hard way: a quoted example
// nobody can re-run is a lie waiting to happen. These are re-run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(LAB, 'docs/USER-GUIDE-CLI.md');
const CLI = path.join(LAB, 'cli/c64rdy.mjs');
const WORK = path.join(LAB, 'tools/guide-shots-work');

// Where the real media lives on this machine. The sandbox links each by its
// basename, so the guide shows `Bomb_Jack.tap`, not a home directory.
const HOME = process.env.HOME;
const MEDIA = [
  `${HOME}/projects/c64ready-workspace/c64media/tape-wavs/Tape 2 - Side B.tap`,
  `${HOME}/projects/c64ready-workspace/c64media/tape-wavs/Tape 3 - Side A.tap`,
  `${HOME}/projects/c64ready-workspace/c64media/tap/Bomb_Jack.tap`,
  `${HOME}/projects/c64ready-workspace/c64media/tap/BMX_Simulator.tap`,
  `${HOME}/Downloads/Chopper Demo.t64`,
];

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const m of MEDIA) {
  // A missing source must stop the run, not turn into a dangling link whose
  // ENOENT gets captured into the guide as though the tool had said it.
  if (!fs.existsSync(m)) throw new Error(`media not found: ${m}`);
  fs.symlinkSync(m, path.join(WORK, path.basename(m)));
}
fs.symlinkSync(path.join(LAB, 'roms'), path.join(WORK, 'roms'));

// Fixtures the examples lean on: a small BASIC program, and a disk it sits on.
{
  const text = [0x99, 0x20, 0x22, ...[...'HELLO, WORLD.'].map(c => c.charCodeAt(0)), 0x22]; // PRINT "…"
  const line = [0x00, 0x00, 0x0A, 0x00, ...text, 0x00];       // link (patched), line 10, EOL
  const link = 0x0801 + line.length;
  line[0] = link & 0xFF; line[1] = link >> 8;
  const prg = Uint8Array.from([0x01, 0x08, ...line, 0x00, 0x00]);
  fs.writeFileSync(path.join(WORK, 'hello.prg'), prg);
  execFileSync(process.execPath, [CLI, 'disk', 'new', 'disk.d64', '--name', 'TEST DISK'], { cwd: WORK });
  execFileSync(process.execPath, [CLI, 'disk', 'add', 'disk.d64', 'hello.prg'], { cwd: WORK });
}

// Split a marker's command the way a shell would, double quotes only.
const argsOf = (cmd) => {
  const out = [];
  for (const m of cmd.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
};

const scrub = (raw) => raw.split('\n')
  .map(l => l.split('\r').pop())
  .join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');

const guide = fs.readFileSync(GUIDE, 'utf8');
// Opts are words, with or without a value (`lines=10 slow`). The block body is
// matched a line at a time and a line that opens a fence ends it, so a shot can
// never swallow the prose past its own block — which the first version of this
// regex did, straight through the next example.
const marker = /<!-- shot((?:\s+\w+(?:=\d+)?)*): (c64rdy [^>]+?) -->\n([ ]*)```\n((?:(?![ ]*```)[^\n]*\n)*)[ ]*```/g;
const filter = process.argv[2];
let ran = 0;

const next = guide.replace(marker, (whole, opts, cmd, indent, _body) => {
  if (filter && !cmd.includes(filter)) return whole;
  const lines = /lines=(\d+)/.exec(opts)?.[1];
  const tail = /tail=(\d+)/.exec(opts)?.[1];
  process.stderr.write(`shot: ${cmd}\n`);
  let out;
  try {
    out = execFileSync(process.execPath, [CLI, ...argsOf(cmd).slice(1)],
      { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;                // a damaged tape is a result
  }
  let body = scrub(out).split('\n');
  if (lines && body.length > +lines) body = [...body.slice(0, +lines), '…'];
  if (tail && body.length > +tail) body = ['…', ...body.slice(-tail)];
  ran++;
  const pad = indent;
  return `<!-- shot${opts}: ${cmd} -->\n${pad}\`\`\`\n`
    + [`$ ${cmd}`, ...body].map(l => (l ? pad + l : '')).join('\n')
    + `\n${pad}\`\`\``;
});

fs.writeFileSync(GUIDE, next);
console.log(`${ran} shot(s) regenerated into ${path.relative(LAB, GUIDE)}`);
