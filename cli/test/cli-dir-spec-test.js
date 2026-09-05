// Spec test for the dir listing: the seven mixtape files come back in tape
// order with both formats named and the damaged one carrying its reason, and —
// the rule that is easy to get backwards and invisible afterwards — WIND TO is
// startSeconds, the head of the lead-in, and sits EARLIER than STARTS for every
// file. Plus m:ss past the hour, and a zero-file tape.
import { buildMixtape } from './_sibling.mjs';
import { splitTap, tapDirectory, tapeFacts, tapSeconds } from '../core.mjs';
import { tapeListing } from '../listing.mjs';
import { mss } from '../report.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

// The renderer prints; the assertions read what it printed.
function rendered(input) {
  const lines = [];
  const real = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try { tapeListing(input); } finally { console.log = real; }
  return lines;
}

const { data, version } = splitTap(buildMixtape());
const files = tapDirectory(data, { version });
const facts = tapeFacts(data, { version });

// The mixtape's manifest, in tape order.
const NAMES = ['BOULDER DASH', 'SUMMER GAMES', 'WIZBALL', 'GHOSTS N GOBLIN',
  'PARADROID', 'MONTY ON THE RUN', 'LAST NINJA'];

eq(files.map(f => f.name.trim()), NAMES, 'seven files, in tape order');

// WIND TO is the head of the lead-in — earlier than the block, every time.
for (const f of files) {
  assert(f.startSeconds < f.atSeconds,
    `${f.name.trim()}: WIND TO (${f.startSeconds.toFixed(2)}) must be earlier than STARTS (${f.atSeconds.toFixed(2)})`);
}

// What the renderer shows: both formats under their listing names, the damaged
// row saying what is wrong, sound rows saying ok.
{
  const lines = rendered({ name: 'mix.tap', files, facts, seconds: tapSeconds(data, version) });
  const text = lines.join('\n');
  assert(/KERNAL \+ Turbo Tape 64/.test(text), 'header names both formats in full');
  assert(/7 files, 6 readable/.test(text), 'header counts files and readable ones');
  const damagedRow = lines.find(l => l.includes('GHOSTS N GOBLIN'));
  assert(/\d+ drops?/.test(damagedRow) && /bytes lost/.test(damagedRow),
    `the damaged row carries its reason, got: ${damagedRow}`);
  const soundRow = lines.find(l => l.includes('LAST NINJA'));
  assert(/ok$/.test(soundRow), `a sound row ends in ok, got: ${soundRow}`);
  assert(lines.find(l => /#\s+WIND TO\s+STARTS/.test(l)), 'the two time columns are labeled');
}

// --damaged narrows the table to the broken rows without touching the header.
{
  const lines = rendered({ name: 'mix.tap', files, facts, flags: { damaged: true } });
  const rows = lines.filter(l => /\$0801/.test(l));
  eq(rows.length, 1, '--damaged lists only the damaged row');
  assert(rows[0].includes('GHOSTS N GOBLIN'), 'and it is the damaged file');
}

// m:ss keeps counting minutes past the hour — a deck counter has no hours.
eq(mss(3674), '61:14', 'm:ss past the hour');
eq(mss(59.6), '1:00', 'm:ss rounds to the second');
eq(mss(0), '0:00', 'm:ss of zero');

// A tape with nothing on it says so instead of printing an empty table.
{
  const lines = rendered({ name: 'blank.tap', files: [], facts: { formats: [], files: 0, sound: 0 } });
  assert(lines.some(l => /No files found/.test(l)), 'a zero-file tape says so');
}

if (failures) {
  console.error(`\n${failures} dir assertion(s) failed`);
  process.exit(1);
}
console.log('cli dir spec: PASS');
