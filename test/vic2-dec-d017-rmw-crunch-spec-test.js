// DEC $D017 RMW + sprite-crunch integration.
//
// NMOS 6502 RMW absolute is 6 cycles ending in TWO writes: a "fake"
// write of the OLD value, then a write of the modified value. The CPU
// must route both writes through vic.write() — many emulators drop the
// dummy write, which silently changes the timing window for effects
// that rely on it (Bauer §3.8.1 rule 7a sprite-crunch, $D019 W1C
// ghost-clear, $DD0D ICR-ack RMW, etc.).
//
// For DEC $D017 specifically:
//   - First write: regs[$D017] = oldVal. cleared = 0 → no crunch trigger.
//   - Second write: regs[$D017] = oldVal - 1. cleared bit → crunch
//     trigger IF the second write lands on vic.cycleInLine === 15.
//
// This pins both ends:
//   (a) The CPU emits two write micro-ops for DEC abs to an I/O addr.
//   (b) Their VIC-side effect on _spriteCrunchPending matches the
//       transition semantics: only the second write can trigger.

import { CPU } from '../src/cpu.js';
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

// Build a CPU with a minimal memory adaptor that captures writes per
// address. Reads return either a tiny code stream we set up or 0.
function makeRig({ code, code_at = 0x1000, vic }) {
  const ram = new Uint8Array(0x10000);
  for (let i = 0; i < code.length; i++) ram[code_at + i] = code[i];
  const writes = [];
  const mem = {
    read(addr) {
      // VIC reads route through vic.read so the bus latch matches reality.
      if (addr >= 0xD000 && addr <= 0xD3FF) return vic.read(addr & 0x3F);
      return ram[addr];
    },
    write(addr, val) {
      writes.push({ addr, val });
      if (addr >= 0xD000 && addr <= 0xD3FF) { vic.write(addr & 0x3F, val); return; }
      ram[addr] = val;
    },
  };
  const cpu = new CPU(mem);
  cpu.reset();
  // The reset queues 7 internal ops (the post-reset internal cycle
  // padding). Drain those before pointing PC at our code so the next
  // instruction-fetch reads our test opcode.
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.pc = code_at;
  return { cpu, mem, ram, writes };
}

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  return vic;
}

// ── 1: DEC $D017 emits TWO vic.write() calls ───────────────────────────
{
  const vic = makeVic();
  // Stage MxYE = $FF so DEC gives $FE (bit 0 clears).
  vic.regs[0x17] = 0xFF;
  const writeCalls = [];
  const origWrite = vic.write.bind(vic);
  vic.write = function(reg, val) { writeCalls.push({ reg, val, cycleInLine: vic.cycleInLine }); origWrite(reg, val); };

  // DEC $D017 = $CE $17 $D0
  const { cpu } = makeRig({ code: [0xCE, 0x17, 0xD0], vic });
  // Run until instruction completes (DEC abs = 6 cycles).
  for (let i = 0; i < 6; i++) cpu.clock();

  const d017Writes = writeCalls.filter(w => w.reg === 0x17);
  expect(d017Writes.length === 2, `DEC $D017 produces 2 vic.write($17) calls (got ${d017Writes.length})`);
  expect(d017Writes[0].val === 0xFF, `first (dummy) write echoes old value $FF (got $${d017Writes[0].val.toString(16)})`);
  expect(d017Writes[1].val === 0xFE, `second write delivers DEC result $FE (got $${d017Writes[1].val.toString(16)})`);
  ok('DEC $D017: CPU emits both fake-write-old + write-new via vic.write()');
}

// ── 2: Only the second write of DEC $D017 can trigger crunch ──────────
//      (first is a no-op transition, second is the real 1→0)
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;       // bit 0 set, FF=0 → crunch-eligible
  vic.spriteYExpandFF[0] = 0;
  // Manipulate to cycle 15 directly — exercising the RMW pattern at the
  // crunch window without standing up a full machine timing rig.
  vic.cycleInLine = 15;

  // Simulate DEC $D017 by hand: vic.write(0x17, 0x01) then vic.write(0x17, 0x00).
  // After the dummy write, _spriteCrunchPending must still be 0.
  vic.write(0x17, 0x01);
  expect(vic._spriteCrunchPending[0] === 0,
    `dummy write of old value ($01 → $01): cleared = 0, no crunch latch (got pending=${vic._spriteCrunchPending[0]})`);
  // The real write — DEC's result $00 — clears bit 0 from 1, transition fires.
  vic.write(0x17, 0x00);
  expect(vic._spriteCrunchPending[0] === 1,
    `real DEC write of new value ($01 → $00): cleared bit 0, crunch latched (got pending=${vic._spriteCrunchPending[0]})`);
  ok('DEC $D017 RMW pattern: dummy write inert, real write latches crunch');
}

// ── 3: INC $D017 (sets bits) never triggers crunch ────────────────────
{
  const vic = makeVic();
  vic.regs[0x17] = 0x00;
  vic.spriteYExpandFF[0] = 0;
  vic.cycleInLine = 15;

  // INC $D017: dummy write of old $00, then real write of $01.
  vic.write(0x17, 0x00);
  expect(vic._spriteCrunchPending[0] === 0, `dummy write: no transition, no crunch`);
  vic.write(0x17, 0x01);
  expect(vic._spriteCrunchPending[0] === 0,
    `INC: bit 0 went 0→1 (set, not cleared) → no crunch even on cycle 15`);
  ok('INC $D017 RMW: bit-set transitions never latch crunch');
}

// ── 4: DEC $D017 at cycle ≠ 15 doesn't trigger crunch ─────────────────
{
  const vic = makeVic();
  vic.regs[0x17] = 0x01;
  vic.spriteYExpandFF[0] = 0;

  for (const c of [13, 14, 16, 17, 0, 30]) {
    vic.regs[0x17] = 0x01;
    vic.spriteYExpandFF[0] = 0;
    vic._spriteCrunchPending[0] = 0;
    vic.cycleInLine = c;
    vic.write(0x17, 0x01);       // dummy
    vic.write(0x17, 0x00);       // real
    expect(vic._spriteCrunchPending[0] === 0,
      `DEC $D017 at cycle ${c}: no crunch (cycle 15 is the only trigger window)`);
  }
  ok('DEC $D017 outside cycle 15: never triggers crunch');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
