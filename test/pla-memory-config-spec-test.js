// test/pla-memory-config-spec-test.js
//
// PLA memory-configuration coverage for the VIC-II char-ROM map, derived from
// "The C64 PLA Dissected" (Giesel) Appendix A. The CPU-side tables (A.1-A.9,
// cartridge and Ultimax included) are in pla-test.js.
//
// Spec basis:
//   A.10 VIC-II sees CHARROM at VIC $1000-$1FFF only when #VA14=1
//        (i.e. in VIC banks 0 and 2, physical $1000 / $9000); RAM otherwise.

import { VIC2 } from '../src/vic2.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function ok(msg) { console.log(`ok  – ${msg}`); }

// ── A.10: VIC-II sees CHARROM at VIC $1000-$1FFF only when #VA14=1 ──────────
// The VIC bank is the physical base (0, $4000, $8000, $C000). CHARROM appears
// at physical $1000-$1FFF and $9000-$9FFF — i.e. VIC banks 0 and 2 (#VA14=1).
{
  const vic = new VIC2();
  vic.ram = new Uint8Array(65536);   for (let i = 0; i < 65536; i++) vic.ram[i] = 0x22;     // RAM marker
  vic.charRom = new Uint8Array(4096); for (let i = 0; i < 4096; i++) vic.charRom[i] = 0xCC; // CHARROM marker

  // Bank 0 (physical $0000): VIC $1000-$1FFF → CHARROM; $0000/$2000 → RAM.
  assert(vic._vicMemRead(0x1000, 0x0000) === 0xCC, 'A.10 bank0: VIC $1000 = CHARROM');
  assert(vic._vicMemRead(0x1FFF, 0x0000) === 0xCC, 'A.10 bank0: VIC $1FFF = CHARROM');
  assert(vic._vicMemRead(0x0000, 0x0000) === 0x22, 'A.10 bank0: VIC $0000 = RAM');
  assert(vic._vicMemRead(0x2000, 0x0000) === 0x22, 'A.10 bank0: VIC $2000 = RAM');

  // Bank 2 (physical $8000): VIC $1000 → physical $9000 → CHARROM.
  assert(vic._vicMemRead(0x1000, 0x8000) === 0xCC, 'A.10 bank2: VIC $1000 (phys $9000) = CHARROM');

  // Bank 1 (physical $4000) and bank 3 ($C000): no CHARROM (#VA14=0) → RAM.
  assert(vic._vicMemRead(0x1000, 0x4000) === 0x22, 'A.10 bank1: VIC $1000 (phys $5000) = RAM');
  assert(vic._vicMemRead(0x1000, 0xC000) === 0x22, 'A.10 bank3: VIC $1000 (phys $D000) = RAM');
  ok('A.10: VIC-II CHARROM visible only in banks 0 & 2 (#VA14=1)');
}

if (failures) { console.error(`\n${failures} PLA memory-config assertion(s) FAILED`); process.exit(1); }
console.log('\nAll PLA memory-config spec tests passed.');
