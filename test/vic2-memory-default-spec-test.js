// A freshly-constructed VIC2 must be safe to clock() without first
// having Machine wire ram/colorRam/charRom. Previously these were null,
// and _fetchScreenRowColumn dereferenced colorRam unconditionally —
// any clock() that hit a c-access cycle would NPE.
//
// The constructor now provisions empty placeholder backing stores;
// Machine still replaces them with the real shared buffers.

import { VIC2 } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: ram/colorRam/charRom are non-null after construction ────────────
{
  const vic = new VIC2();
  expect(vic.ram instanceof Uint8Array, `ram is a Uint8Array`);
  expect(vic.ram.length === 0x10000, `ram length 64K (got ${vic.ram.length})`);
  expect(vic.colorRam instanceof Uint8Array, `colorRam is a Uint8Array`);
  expect(vic.colorRam.length === 0x0400, `colorRam length 1K (got ${vic.colorRam.length})`);
  expect(vic.charRom instanceof Uint8Array, `charRom is a Uint8Array`);
  expect(vic.charRom.length === 0x1000, `charRom length 4K (got ${vic.charRom.length})`);
  ok('Constructor provisions ram/colorRam/charRom placeholders');
}

// ── 2: clocking through a full frame doesn't throw on a bare VIC ───────
{
  const vic = new VIC2();
  // No ram/colorRam/charRom assignments — defaults only.
  // Drive a few full lines (covers c-access, g-access, refresh, sprite
  // p/s-accesses, bad-line evaluation paths). 64 cycles × 312 lines is
  // a full PAL frame.
  let threw = null;
  try {
    for (let i = 0; i < 312 * 64; i++) vic.clock(1);
  } catch (e) {
    threw = e;
  }
  expect(threw === null, `full PAL frame did not throw (got ${threw && threw.message})`);
  ok('Bare-construction VIC survives a full PAL frame of clock()s');
}

// ── 3: Machine replacing the backing stores still works ────────────────
{
  const vic = new VIC2();
  const sharedRam = new Uint8Array(0x10000);
  const sharedColorRam = new Uint8Array(0x0400);
  vic.ram = sharedRam;
  vic.colorRam = sharedColorRam;
  vic.ram[0x0400] = 0xAB;
  vic.colorRam[0x000] = 0x07;
  // VIC reads at $0400 should now reflect sharedRam.
  const v = vic._vicReadWithBank(0x0400, 0x0000);
  expect(v === 0xAB, `vic reads $AB from shared ram (got $${v.toString(16)})`);
  ok('Machine-supplied buffers replace placeholders cleanly');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
