// CPU writes to VIC read-only / unconnected registers must not stash a
// value into regs[]. Bauer §3.2:
//   - $D01E (sprite-sprite collision)  : read clears, no write path
//   - $D01F (sprite-data  collision)   : read clears, no write path
//   - $D02F-$D03F (unconnected)        : always read $FF
//
// The CPU still drives the data bus during these writes — so the VIC's
// internal-bus latch (vicInternalBus) MUST update so the byte can leak
// into a sprite idle fetch. This test pins both halves.

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

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

// ── 1: write to $D01E does not poison the collision register ──────────
{
  const vic = makeVic();
  // Pre-seed the latch so we can prove the read-clear semantics still
  // work and only the write was suppressed.
  vic.regs[0x1E] = 0x12;
  vic.write(0x1E, 0xAA);
  expect(vic.regs[0x1E] === 0x12, `$D01E latch not overwritten by CPU write (got $${vic.regs[0x1E].toString(16)})`);
  // Read clears.
  const v = vic.read(0x1E);
  expect(v === 0x12, `read $D01E returns prior latch ($12), got $${v.toString(16)}`);
  expect(vic.regs[0x1E] === 0x00, `read $D01E clears latch`);
  // The aborted CPU write still updated the bus latch.
  // (Re-write to verify the bus path independent of read clearing.)
  vic.write(0x1E, 0xBB);
  expect(vic.vicInternalBus === 0xBB, `aborted $D01E write still drives bus latch ($BB), got $${vic.vicInternalBus.toString(16)}`);
  ok('write $D01E: register untouched, bus latch still updates');
}

// ── 2: same for $D01F ──────────────────────────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x1F] = 0x34;
  vic.write(0x1F, 0xCC);
  expect(vic.regs[0x1F] === 0x34, `$D01F latch not overwritten`);
  const v = vic.read(0x1F);
  expect(v === 0x34, `read $D01F returns prior latch`);
  expect(vic.regs[0x1F] === 0x00, `read $D01F clears latch`);
  vic.write(0x1F, 0xDD);
  expect(vic.vicInternalBus === 0xDD, `aborted $D01F write still drives bus latch`);
  ok('write $D01F: register untouched, bus latch still updates');
}

// ── 3: writes to $D02F..$D03F are ignored, reads always return $FF ─────
for (let r = 0x2F; r <= 0x3F; r++) {
  const vic = makeVic();
  // Pre-seed regs[] to confirm write doesn't change it.
  vic.regs[r] = 0x77;
  vic.write(r, 0x11);
  expect(vic.regs[r] === 0x77, `regs[$D0${r.toString(16)}] not overwritten (got $${vic.regs[r].toString(16)})`);
  const v = vic.read(r);
  expect(v === 0xFF, `read $D0${r.toString(16)} returns $FF (got $${v.toString(16)})`);
  // Bus latch still updates from the write.
  vic.write(r, 0x99);
  expect(vic.vicInternalBus === 0x99, `aborted write to $D0${r.toString(16)} still drives bus latch (got $${vic.vicInternalBus.toString(16)})`);
}
ok('writes to $D02F-$D03F ignored; reads return $FF; bus latch still updates');

// ── 4: aborted write to $D01E leaks into sprite idle fetch ─────────────
// Per VICE testprogs/VICII/sb_sprite_fetch: when DMA off, byte 0 = p-cycle
// phi2 bus, byte 1 = $3FFF ghost-byte, byte 2 = s-cycle phi2 bus. A CPU
// write to $D01E (read-only) at s-cycle phi2 lands in byte 2 even though
// the write is otherwise discarded.
{
  const vic = makeVic();
  // Seed distinguishable ghost byte + p-cycle phi2 bus so we can verify
  // that byte 2 picks up the aborted $D01E write.
  vic.ram[0x3FFF] = 0x88;
  vic.spriteDmaOn[2] = 0;
  vic.spriteDisplayOn[2] = 1;
  vic.spritePointerFresh[2] = 0;
  vic._spritePCyclePhi2Bus[2] = 0x33;
  vic._spritePCyclePhi2BusValid[2] = 1;
  vic.spriteRowData[2].fill(0);
  vic.spriteShiftReg[2] = 0;
  vic.write(0x1E, 0x5A);                 // s-cycle phi2 — bus = $5A
  vic._spriteSequencerRowAccessIdle(63); // sp2 s-access (idle path)
  expect(vic.spriteRowData[2][0] === 0x33, `sprite 2 idle byte0 = $33 (pre-recorded p-cycle phi2 bus)`);
  expect(vic.spriteRowData[2][1] === 0x88, `sprite 2 idle byte1 = $88 (ghost byte $3FFF)`);
  expect(vic.spriteRowData[2][2] === 0x5A, `sprite 2 idle byte2 = $5A (s-cycle phi2 bus from aborted $D01E write)`);
  ok('Aborted $D01E write leaks into sprite idle fetch byte2 via bus latch');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
