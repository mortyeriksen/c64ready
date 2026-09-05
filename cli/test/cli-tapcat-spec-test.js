// Spec test for concatTaps (cli/core.mjs): joined tapes read as the sum of
// their parts. The mixtape joined to itself lists every file twice, the second
// half shifted by exactly one tape's length; a v0 tape joining a v1 tape is
// respelled with the deck's own 2048-cycle value for a v0 zero, so it measures
// the same before and after; half-wave v2 refuses to mix. Nothing binary is
// committed — the mixtape is built, the tiny tapes are spelled out by hand.
import { buildMixtape } from './_sibling.mjs';
import { splitTap, concatTaps, tapSeconds, tapDirectory } from '../core.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

// A .tap from bare pulse bytes, for the version-mixing cases.
const mkTap = (version, bytes) => {
  const tap = new Uint8Array(20 + bytes.length);
  'C64-TAPE-RAW'.split('').forEach((c, i) => tap[i] = c.charCodeAt(0));
  tap[12] = version;
  tap[16] = bytes.length & 0xFF;
  tap.set(bytes, 20);
  return tap;
};

// The mixtape joined to itself: every file twice, the second run one tape late.
{
  const side = splitTap(buildMixtape());
  const { tap, version, respelled } = concatTaps([side, side]);
  eq(version, side.version, 'one version throughout is kept');
  eq(respelled, 0, 'and nothing is respelled');
  const { data } = splitTap(tap);
  eq(data.length, side.data.length * 2, 'the data is both tapes, verbatim');
  eq(tap[16] | (tap[17] << 8) | (tap[18] << 16), data.length, 'the header counts the joined data');
  const files = tapDirectory(data, { version });
  const one = tapDirectory(side.data, { version: side.version });
  eq(files.length, one.length * 2, 'every file is listed twice');
  const shift = files[one.length].startSeconds - files[0].startSeconds;
  assert(Math.abs(shift - tapSeconds(side.data, side.version)) < 0.1,
    'the second run starts one tape length in');
  const total = tapSeconds(data, version);
  assert(Math.abs(total - 2 * tapSeconds(side.data, side.version)) < 0.01,
    'the joined tape plays both lengths');
}

// A v0 zero byte is respelled in v1's long form with the value every reader
// here already gives it, so the tape measures the same before and after.
{
  const v0 = splitTap(mkTap(0, Uint8Array.from([0x30, 0x00, 0x30])));
  const v1 = splitTap(mkTap(1, Uint8Array.from([0x40])));
  const { tap, version, respelled } = concatTaps([v0, v1]);
  eq(version, 1, 'a mixed join comes out v1');
  eq(respelled, 1, 'and says one tape was respelled');
  const { data } = splitTap(tap);
  eq([...data].join(), [0x30, 0, 0x00, 0x08, 0x00, 0x30, 0x40].join(),
    'the zero byte becomes the 2048-cycle long form, everything else verbatim');
  const before = tapSeconds(v0.data, 0) + tapSeconds(v1.data, 1);
  assert(Math.abs(tapSeconds(data, 1) - before) < 1e-9, 'the joined tape plays exactly as long');
}

// v2 counts half waves; its bytes mean different tape than v0/v1's.
{
  const v2 = splitTap(mkTap(2, Uint8Array.from([0x20, 0x20])));
  const v1 = splitTap(mkTap(1, Uint8Array.from([0x40])));
  let threw = null;
  try { concatTaps([v2, v1]); } catch (e) { threw = e.message; }
  assert(/half waves/.test(threw ?? ''), 'a v2 + v1 join refuses, naming the reason');
  const same = concatTaps([v2, v2]);
  eq(same.version, 2, 'two v2 tapes join as v2, verbatim');
}

if (failures) {
  console.error(`\n${failures} tapcat assertion(s) failed`);
  process.exit(1);
}
console.log('cli tapcat spec: PASS');
