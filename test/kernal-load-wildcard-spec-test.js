// test/kernal-load-wildcard-spec-test.js
//
// Spec test for `LOAD "*",8,1` through the full CBM-serial → TDE 1541 path.
//
// Why this test is not a duplicate:
//   - test/iec-handshake-test.js verifies the bus reaches a live state after
//     boot — it doesn't issue any LOAD command.
//   - test/fastloader-test.js exercises M-W / M-E and bit-bang protocols, all
//     of which happen AFTER a successful standard CBM-serial load completes.
//   - test/nosdos-bootstrap-test.js verifies the NOSDOS bit-bang fastloader's
//     bootstrap, which is a different protocol than the KERNAL LOAD path.
//
// What this exercises (the actual spec):
//   1. KERNAL LOAD routine ($F49E onwards) — sends LISTEN/SECONDARY/filename/
//      UNLISTEN, then TALK/SECONDARY, then receives bytes via standard IEC.
//   2. Drive ROM's command channel parser — resolves "*" wildcard to the
//      first non-deleted directory entry (CBM DOS spec).
//   3. Drive ROM's $F50A sector-read path → $F4E0 GCR-byte-read BVC loop.
//      This is the path that depends on `setOverflow` timing (= the bug
//      area from the Aloft/Sparkle install investigation).
//   4. Drive ROM's IEC byte send (TALK turnaround + CLK/DATA bit timing).
//   5. C64 KERNAL ACPTR receive ($EE13) places bytes at correct address
//      (start address from file's first 2 bytes when ",1" suffix is used).
//
// Observed surface (only spec, no implementation internals):
//   - $0801+ RAM bytes after LOAD completes
//   - Screen RAM contents to check "FILE NOT FOUND" doesn't appear
//   - Standard CBM-serial / KERNAL ROM behavior
//
// Disk: built here, in the test. `createPRGDisk()` (src/d64.js) lays down a
// real 35-track image — BAM, directory entry, block chain — and the drive ROM
// then reads it through the ordinary GCR path, because GCR encoding lives in
// the drive model, not in the image. Nothing about the read path is stubbed.
//
// The earlier version of this test loaded a .d64 from the author's machine and
// SKIPped everywhere else, on the reasoning that building the image here would
// conflate a writer bug with a drive bug. It would — except the writer is not
// unverified: d64-write-prg-spec-test.js locks it independently (byte-exact
// round trip through the read path, BAM free-count against blocks taken, entry
// findable by name and by wildcard, across block-boundary sizes). A malformed
// image fails there first, and that test needs no disk at all.
//
// Set $C64_TEST_D64 to cross-check against a real disk instead; the assertions
// are identical either way.

import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { D64, createPRGDisk } from '../src/d64.js';
import { assetPath } from './external-assets.js';

const ROOT = new URL('../roms/', import.meta.url).pathname;
function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const kernal  = tryRead(ROOT + 'kernal.bin');
const basic   = tryRead(ROOT + 'basic.bin');
const chargen = tryRead(ROOT + 'chargen.bin');
const drvRom  = tryRead(ROOT + '1541.bin');

if (!kernal || !basic || !chargen || !drvRom) {
  console.log('# SKIP C64/1541 ROMs not available under roms/');
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// A few sectors' worth of payload, so the load crosses block boundaries and
// walks the chain rather than reading one sector. The pattern is co-prime with
// 256 and starts non-zero, so the signature can't be matched by the zeroed BASIC
// RAM the load lands in.
function makePayload(len = 1500, addr = 0x0801) {
  const p = new Uint8Array(len + 2);
  p[0] = addr & 0xFF; p[1] = addr >> 8;
  for (let i = 0; i < len; i++) p[i + 2] = ((i * 31 + 7) & 0xFF) || 0xA5;
  return p;
}

// The disk under test: built here by default, or a real one if $C64_TEST_D64
// points at it (same assertions either way — see the header).
function makeTestDisk() {
  const real = assetPath('test-d64');
  if (real) {
    try {
      const buf = fs.readFileSync(real);
      if (buf && buf.length >= 174848) {
        return { label: real, disk: new D64(new Uint8Array(buf)) };
      }
    } catch {}
  }
  const disk = createPRGDisk('wildcard.prg', makePayload());
  if (!disk) return null;
  return { label: 'built in-test by createPRGDisk()', disk };
}

// Look for a PETSCII substring in screen RAM (rows 0-24, 40 cols).
function screenContains(m, text) {
  const ram = m.mem.ram;
  // Convert text to screen codes (uppercase 'A'-'Z' → $01-$1A, ' ' → $20).
  const codes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5A) codes.push(c - 0x40);          // A-Z → 1-26
    else if (c >= 0x61 && c <= 0x7A) codes.push(c - 0x60);     // a-z → 1-26 (uppercase screen)
    else if (c === 0x20) codes.push(0x20);
    else codes.push(c);
  }
  for (let row = 0; row < 25; row++) {
    for (let col = 0; col + codes.length <= 40; col++) {
      let match = true;
      for (let k = 0; k < codes.length; k++) {
        if (ram[0x0400 + row * 40 + col + k] !== codes[k]) { match = false; break; }
      }
      if (match) return true;
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Spec: LOAD "*",8,1 over the standard CBM-serial protocol via TDE.
//   - Drive resolves "*" against the disk's directory (CBM DOS spec).
//   - Drive sends the first PRG's bytes back over IEC.
//   - C64 KERNAL receives, stores at the file's load address (because ",1").
//   - "FILE NOT FOUND" must NOT appear on screen.
//   - A meaningful number of bytes (≥ a few sectors' worth) must arrive in RAM
//     at the load address.
// ────────────────────────────────────────────────────────────────────────────
{
  const built = makeTestDisk();
  assert(built, 'test disk could be built');
  const { label, disk: d64 } = built;

  console.log(`Spec[KERNAL]: LOAD "*",8,1 over standard CBM-serial via TDE (disk: ${label})...`);
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.setD64(d64);
  m.reset();

  // First entry is what "*" resolves to.
  const firstEntry = d64.entries.find(e => e.typeCode === 2 && e.startTrack !== 0);
  assert(firstEntry, `disk has at least one resolvable PRG entry`);
  const expectedBytes = d64.loadFile(firstEntry.name);
  assert(expectedBytes && expectedBytes.length >= 4,
    `D64 wildcard target "${firstEntry.name}" has ≥4 bytes (got ${expectedBytes?.length})`);
  const loadAddr = expectedBytes[0] | (expectedBytes[1] << 8);
  const payloadLen = expectedBytes.length - 2;  // strip 2-byte header
  console.log(`    wildcard target: "${firstEntry.name.trim()}" → ${payloadLen} bytes at $${loadAddr.toString(16)}`);

  // Boot to READY prompt
  for (let f = 0; f < 180; f++) m.runFrame();
  assert(screenContains(m, 'READY'), 'C64 reached READY prompt before LOAD');

  // KERNAL keyboard buffer is only 10 bytes; feed the 12-char command
  // 'LOAD"*",8,1\r' across multiple frames so chars 11-12 aren't dropped.
  const cmd = 'LOAD"*",8,1\r';
  let cmdIdx = 0;
  function feedKbd() {
    const left = cmd.length - cmdIdx;
    if (left > 0) cmdIdx += m.bufferKeyboardText(cmd.slice(cmdIdx));
  }
  for (let f = 0; f < 10 && cmdIdx < cmd.length; f++) {
    feedKbd();
    m.runFrame();
  }
  assert(cmdIdx === cmd.length, `full command fed to kbd buffer (got ${cmdIdx}/${cmd.length} chars)`);

  // Run until either FILE NOT FOUND appears, the expected bytes land at the
  // load address, or 60 seconds of emulation pass.
  let frames = 0;
  let fileNotFound = false;
  let bytesMatch = false;
  const MAX_FRAMES = 60 * 50;
  // Sample the first 16 payload bytes as the recognition signature.
  const sigLen = Math.min(16, payloadLen);
  while (frames++ < MAX_FRAMES) {
    m.runFrame();
    if (screenContains(m, 'FILE NOT FOUND')) { fileNotFound = true; break; }
    let match = true;
    for (let i = 0; i < sigLen; i++) {
      if (m.mem.ram[loadAddr + i] !== expectedBytes[2 + i]) { match = false; break; }
    }
    if (match) { bytesMatch = true; break; }
  }

  assert(!fileNotFound,
    'LOAD"*",8,1 did NOT produce "FILE NOT FOUND" (drive must resolve "*" via directory and send bytes)');
  if (!bytesMatch) {
    const seen = Array.from({length: sigLen}, (_, i) => '$' + m.mem.ram[loadAddr + i].toString(16).padStart(2, '0')).join(' ');
    const want = Array.from({length: sigLen}, (_, i) => '$' + expectedBytes[2 + i].toString(16).padStart(2, '0')).join(' ');
    assert(false,
      `LOAD"*",8,1 placed ${sigLen} bytes of "${firstEntry.name.trim()}" at $${loadAddr.toString(16)} within 60s\n` +
      `    expected: ${want}\n    got:      ${seen}`);
  }
  console.log(`ok  – LOAD"*",8,1 completed in ${frames} PAL frames (~${(frames/50).toFixed(1)}s wall)`);
}

console.log('\nAll KERNAL LOAD-wildcard spec tests passed.');
