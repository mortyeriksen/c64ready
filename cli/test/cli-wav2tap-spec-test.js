// Spec test for the wav2tap path, as a full round trip with zero committed
// binaries: the mixtape rendered to audio (tapToPcm → pcmToWav), then read back
// through the same import the command uses (importWavSync) — the seven files
// must return with their names and formats, and the one deliberately damaged
// file must still be flagged.
import { buildMixtape } from './_sibling.mjs';
import { splitTap, tapToPcm, pcmToWav, tapSeconds, importWavSync } from '../core.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const mix = buildMixtape();
const { data, version } = splitTap(mix);
const length = tapSeconds(data, version);

// The recording: the tape's own length rules, not tapToPcm's 900 s default —
// the same rule tap2wav applies.
const { pcm, truncated } = tapToPcm(data, { version, maxSeconds: Math.ceil(length) + 1 });
assert(!truncated, 'the whole tape fits when its own length sets the cap');
const wav = pcmToWav(pcm);

const got = importWavSync(wav, {});

const NAMES = ['BOULDER DASH', 'SUMMER GAMES', 'WIZBALL', 'GHOSTS N GOBLIN',
  'PARADROID', 'MONTY ON THE RUN', 'LAST NINJA'];
eq(got.files.map(f => f.name.trim()), NAMES, 'all seven files return, in tape order');

eq(got.files.map(f => f.format),
  ['CBM', 'Turbo Tape 64', 'Turbo Tape 64', 'Turbo Tape 64', 'Turbo Tape 64', 'Turbo Tape 64', 'CBM'],
  'each file keeps its format through the round trip');

const damaged = got.files.filter(f => f.damaged).map(f => f.name.trim());
eq(damaged, ['GHOSTS N GOBLIN'], 'the deliberately damaged file is still flagged, and only it');

// The .tap that comes back is a valid container the rest of the tool accepts.
const back = splitTap(got.tap);
assert(back.data.length > 0, 'the round-tripped tap has pulse data');
const backLength = tapSeconds(back.data, back.version);
assert(Math.abs(backLength - length) < length * 0.1,
  `the round-tripped tape plays about as long as the original (${backLength.toFixed(0)}s vs ${length.toFixed(0)}s)`);

if (failures) {
  console.error(`\n${failures} wav2tap assertion(s) failed`);
  process.exit(1);
}
console.log('cli wav2tap spec: PASS');
