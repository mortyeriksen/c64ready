// VICE ROM pick spec: choosing the C64 ROM images out of a picked VICE folder.
//
// Behaviour pinned here:
//   • The PAL C64 filenames VICE ships are matched in C64/ and DRIVES/
//   • Same-name, same-size ROMs belonging to other machines are not taken
//     (VIC20's basic-901486-01.bin is 8 KiB, like the C64's)
//   • The exact part-numbered name wins over its siblings in the same folder
//   • Older bare VICE names and plain dumps (kernal.bin) still match
//   • Wrong sizes never match, and an empty pick yields nothing

const { pickViceRoms } = await import('../src/roms.js');

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// A stand-in for the File objects an <input webkitdirectory> hands over: only
// name, size and webkitRelativePath are read.
const f = (relPath, size) => ({
  name: relPath.slice(relPath.lastIndexOf('/') + 1),
  size,
  webkitRelativePath: relPath,
});

// The C64, DRIVES and VIC20 parts of a real VICE 3.10 tree.
const VICE_TREE = [
  f('vice-3.10/C64/basic-901226-01.bin', 8192),
  f('vice-3.10/C64/chargen-901225-01.bin', 4096),
  f('vice-3.10/C64/chargen-906143-02.bin', 4096),
  f('vice-3.10/C64/kernal-251104-04.bin', 8192),
  f('vice-3.10/C64/kernal-901227-01.bin', 8192),
  f('vice-3.10/C64/kernal-901227-03.bin', 8192),
  f('vice-3.10/C64/c64mem.sym', 8817),
  f('vice-3.10/C64/colodore.vpl', 443),
  f('vice-3.10/DRIVES/dos1541-325302-01+901229-05.bin', 16384),
  f('vice-3.10/DRIVES/dos1541ii-251968-03.bin', 16384),
  f('vice-3.10/DRIVES/dos1581-318045-02.bin', 32768),
  f('vice-3.10/VIC20/basic-901486-01.bin', 8192),
  f('vice-3.10/VIC20/chargen-901460-03.bin', 4096),
  f('vice-3.10/VIC20/kernal.901486-07.bin', 8192),
];

// ── 1: a whole VICE tree yields the four C64 slots ──────────────────────
{
  const p = pickViceRoms(VICE_TREE);
  expect(p.kernal?.name === 'kernal-901227-03.bin', `kernal: got ${p.kernal?.name}`);
  expect(p.basic?.name === 'basic-901226-01.bin', `basic: got ${p.basic?.name}`);
  expect(p.charRom?.name === 'chargen-901225-01.bin', `charRom: got ${p.charRom?.name}`);
  expect(p.drive1541?.name === 'dos1541ii-251968-03.bin', `drive1541: got ${p.drive1541?.name}`);
  ok('vice-pick: the PAL C64 part numbers win across a full VICE tree');
}

// ── 2: every pick comes from C64/ or DRIVES/, never another machine ──────
{
  const p = pickViceRoms(VICE_TREE);
  for (const [key, file] of Object.entries(p)) {
    expect(!file.webkitRelativePath.includes('/VIC20/'),
      `${key} must not come from VIC20/, got ${file.webkitRelativePath}`);
  }
  ok('vice-pick: another machine\'s same-size ROMs are not taken');
}

// ── 3: a VIC20-only pick yields nothing ─────────────────────────────────
{
  const p = pickViceRoms(VICE_TREE.filter(x => x.webkitRelativePath.includes('/VIC20/')));
  expect(Object.keys(p).length === 0, `expected no picks, got ${Object.keys(p).join(', ')}`);
  ok('vice-pick: a VIC20-only folder yields no C64 ROMs');
}

// ── 4: older bare VICE names still match ────────────────────────────────
{
  const p = pickViceRoms([
    f('vice-3.5/C64/kernal', 8192),
    f('vice-3.5/C64/basic', 8192),
    f('vice-3.5/C64/chargen', 4096),
    f('vice-3.5/DRIVES/dos1541', 16384),
  ]);
  expect(p.kernal?.name === 'kernal' && p.basic?.name === 'basic', 'bare kernal/basic must match');
  expect(p.charRom?.name === 'chargen', 'bare chargen must match');
  expect(p.drive1541?.name === 'dos1541', 'bare dos1541 must match');
  ok('vice-pick: pre-3.7 bare filenames still match');
}

// ── 5: a plain folder of dumps matches too ──────────────────────────────
{
  const p = pickViceRoms([
    f('roms/kernal.bin', 8192),
    f('roms/basic.bin', 8192),
    f('roms/chargen.bin', 4096),
    f('roms/1541.bin', 16384),
    f('roms/characters.901225-01.bin', 4096),
  ]);
  expect(p.kernal?.name === 'kernal.bin', `kernal: got ${p.kernal?.name}`);
  expect(p.basic?.name === 'basic.bin', `basic: got ${p.basic?.name}`);
  expect(p.charRom !== undefined, 'a chargen must be picked');
  expect(p.drive1541?.name === '1541.bin', `drive1541: got ${p.drive1541?.name}`);
  ok('vice-pick: a plain folder of dumps matches by name');
}

// ── 6: the 1541 ROM's 2-byte-header variant is accepted ─────────────────
{
  const p = pickViceRoms([f('vice/DRIVES/dos1541ii-251968-03.bin', 16386)]);
  expect(p.drive1541?.size === 16386, 'a 16386-byte 1541 ROM must be accepted');
  ok('vice-pick: the 16386-byte (2-byte header) 1541 image is accepted');
}

// ── 7: wrong sizes and an empty pick yield nothing ──────────────────────
{
  const p = pickViceRoms([
    f('vice/C64/kernal-901227-03.bin', 4096),   // truncated
    f('vice/C64/basic-901226-01.bin', 16384),   // too big
    f('vice/C64/chargen-901225-01.bin', 2048),  // PET-sized
  ]);
  expect(Object.keys(p).length === 0, `expected no picks, got ${Object.keys(p).join(', ')}`);
  expect(Object.keys(pickViceRoms([])).length === 0, 'an empty pick must yield nothing');
  ok('vice-pick: wrong-sized files never match');
}

// ── 8: the pick does not depend on enumeration order ────────────────────
// Browsers hand the folder over in their own order: Chromium walks VIC20/
// before C64/, WebKit and Firefox the other way round.
{
  const reversed = [...VICE_TREE].reverse();
  const a = pickViceRoms(VICE_TREE), b = pickViceRoms(reversed);
  for (const key of ['kernal', 'basic', 'charRom', 'drive1541']) {
    expect(a[key]?.name === b[key]?.name,
      `${key}: ${a[key]?.name} forwards vs ${b[key]?.name} reversed`);
  }
  ok('vice-pick: the same files are chosen whatever order the browser lists them in');
}

console.log(`\n${testNo} vice-rom-pick spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
