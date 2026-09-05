// Spec test for ROM resolution (cli/roms.mjs): a folder of house names is
// taken as-is, a synthesized VICE tree resolves through pickViceRoms even when
// the walk meets VIC20/ before C64/ (the trap: VIC20's basic is 8K too), a
// 16386-byte 1541 ROM loses its 2-byte header, and missing ROMs come back as
// one plain sentence naming the files and the flag.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRoms, roms as romsCmd, readSavedRoms } from '../roms.mjs';
import { setQuiet } from '../report.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-roms-'));
const at = (...p) => path.join(tmp, ...p);
// Each fake ROM carries a marker byte so the assertions can tell WHICH file was
// picked, not just that one of the right size was.
function fakeRom(p, size, marker) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const b = new Uint8Array(size).fill(marker);
  fs.writeFileSync(p, b);
}

// House names, taken directly.
{
  fakeRom(at('house', 'kernal.bin'), 8192, 1);
  fakeRom(at('house', 'basic.bin'), 8192, 2);
  fakeRom(at('house', 'chargen.bin'), 4096, 3);
  const roms = resolveRoms({ dir: at('house') });
  eq([roms.kernal[0], roms.basic[0], roms.charRom[0]], [1, 2, 3], 'house names resolve directly');
  eq(roms.from, at('house'), 'and report where they came from');
}

// A VICE tree — with VIC20/ sorting before C64/, the trap a Chromium-style
// directory listing springs: the VIC20 basic is 8K like the C64's, and only
// the machine-directory scoring keeps it out.
{
  fakeRom(at('vice', 'VIC20', 'basic-901486-01.bin'), 8192, 40);
  fakeRom(at('vice', 'VIC20', 'kernal-901487-01.bin'), 8192, 41);
  fakeRom(at('vice', 'C64', 'kernal-901227-03.bin'), 8192, 50);
  fakeRom(at('vice', 'C64', 'basic-901226-01.bin'), 8192, 51);
  fakeRom(at('vice', 'C64', 'chargen-901225-01.bin'), 4096, 52);
  fakeRom(at('vice', 'DRIVES', 'dos1541ii-251968-03.bin'), 16384, 53);
  const roms = resolveRoms({ dir: at('vice'), need1541: true });
  eq([roms.kernal[0], roms.basic[0], roms.charRom[0], roms.drive1541[0]],
    [50, 51, 52, 53], 'the C64 set wins over VIC20 lookalikes');
}

// A 1541 ROM with the 2-byte header is trimmed to the bare 16K.
{
  fakeRom(at('hdr', 'kernal.bin'), 8192, 1);
  fakeRom(at('hdr', 'basic.bin'), 8192, 2);
  fakeRom(at('hdr', 'chargen.bin'), 4096, 3);
  fakeRom(at('hdr', '1541.bin'), 16386, 4);
  const roms = resolveRoms({ dir: at('hdr'), need1541: true });
  eq(roms.drive1541.length, 16384, 'a headered 1541 ROM is trimmed to 16K');
}

// A wrong-sized file is not a ROM, whatever it is named.
{
  fakeRom(at('bad', 'kernal.bin'), 8000, 9);
  fakeRom(at('bad', 'basic.bin'), 8192, 2);
  fakeRom(at('bad', 'chargen.bin'), 4096, 3);
  let threw = null;
  try { resolveRoms({ dir: at('bad') }); } catch (e) { threw = e; }
  assert(threw, 'a truncated kernal.bin does not resolve');
}

// Missing ROMs are one plain sentence naming the files and the flag.
{
  let threw = null;
  const envBefore = process.env.C64_ROMS;
  process.env.C64_ROMS = at('nowhere');
  const cwdBefore = process.cwd();
  process.chdir(tmp);                       // so ./roms and any VICE install stay out of it
  try { resolveRoms({}); } catch (e) { threw = e; }
  process.chdir(cwdBefore);
  if (envBefore === undefined) delete process.env.C64_ROMS; else process.env.C64_ROMS = envBefore;
  // A machine with VICE installed resolves anyway — that is correct behavior,
  // so the message is only asserted when nothing was found.
  if (threw) {
    assert(/kernal\.bin/.test(threw.message) && /--roms/.test(threw.message) && !/\n\s+at /.test(threw.message),
      `the error names the files and the flag, plainly — got: ${threw.message}`);
  } else {
    console.log('ok - missing-ROM message # SKIP a real VICE install resolved the set');
  }
}

// The saved folder: `roms <dir>` writes it to the config, and resolveRoms then
// finds it with no --roms and no $C64_ROMS.
{
  setQuiet(true);
  process.env.XDG_CONFIG_HOME = at('config');
  const hadEnv = process.env.C64_ROMS;
  delete process.env.C64_ROMS;
  await romsCmd([at('house')]);
  eq(readSavedRoms(), at('house'), 'the folder is written to the config');
  eq(resolveRoms().from, at('house'), 'and resolveRoms finds it with no flag or env var');
  if (hadEnv !== undefined) process.env.C64_ROMS = hadEnv;
  delete process.env.XDG_CONFIG_HOME;
  setQuiet(false);
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} roms assertion(s) failed`);
  process.exit(1);
}
console.log('cli roms spec: PASS');
