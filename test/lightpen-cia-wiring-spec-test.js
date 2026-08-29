// Machine-level wiring of the VIC lightpen (LP) input.
//
// The bare-VIC latch semantics (Bauer §3.11/§3.12 — what value latches at
// which cycle, one-shot-per-frame, IRQ, write-1-to-clear) are covered by
// lightpen-spec-test.js. THIS file covers only the integration that was
// missing and broke VICII/lp-trigger/test1: nothing in the running machine
// ever drove vic2.setLightpenLevel().
//
// Hardware node: the VIC LP pin, CIA1 Port B bit 4, and joystick-port-1
// FIRE are the SAME electrical line. It is pulled high and reads LOW iff
// EITHER the CIA actively drives it low (PB4 = output, latch bit = 0) OR
// joystick-1 FIRE is pressed (joyPort1 bit 4 = 0). machine.js recomputes
// that composite on every CIA1 Port-B ($DC01) and DDRB ($DC03) write and
// feeds it to vic2.setLightpenLevel().
//
// These assertions exercise the wired-AND composite and BOTH write call
// sites; the actual latched X coordinate is taken from a bare reference VIC
// driven to the same beam position (oracle), so this file does not re-encode
// the §3.11 calibration constant.

import { C64Machine } from '../src/machine.js';
import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

function makeMachine() {
  const m = new C64Machine();
  // The VIC needs a char ROM to clock through display lines; the machine
  // only wires this in loadROMs(), which we skip here (no CPU is run).
  m.vic2.charRom = new Uint8Array(0x1000);
  m.vic2.currentVicBank = 0;
  return m;
}

// Bare reference VIC: what X would latch at (raster, cycle) on a direct
// negative edge. This is the oracle for the machine-wired path.
function refLPX(raster, cycle) {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  v._lpInputLevel = 1;
  driveTo(v, raster, cycle);
  v.setLightpenLevel(0);
  return v.regs[0x13];
}

// ── 1: CIA1 PB4 as OUTPUT, driven high→low via $DC01, latches the VIC ──
//      This is exactly the path VICII/lp-trigger/test1 uses (sty $dc01).
//      Before the wiring fix this latched nothing — regs[$13] stayed 0.
{
  const R = 0x55, C = 30;
  const m = makeMachine();
  driveTo(m.vic2, R, C);
  expect(m.vic2.regs[0x13] === 0x00 && !m.vic2._lpLatchedThisFrame,
    `pre-condition: nothing latched yet (LPX=$${m.vic2.regs[0x13].toString(16)})`);

  m.cia1.write(0x01, 0xFF);   // PB latch = $FF (still input — no edge)
  m.cia1.write(0x03, 0xFF);   // DDRB = output → PB4 driven HIGH (no edge)
  expect(!m.vic2._lpLatchedThisFrame, `driving PB4 high must not latch`);

  m.cia1.write(0x01, 0x00);   // PB latch = $00 → PB4 driven LOW → neg edge

  expect(m.vic2._lpLatchedThisFrame, `CIA1 PB4 output-low must reach the VIC LP input`);
  expect(m.vic2.regs[0x14] === (R & 0xFF), `LPY latched raster ($${m.vic2.regs[0x14].toString(16)})`);
  expect(m.vic2.regs[0x13] === refLPX(R, C),
    `LPX latched via CIA equals direct-edge oracle ($${m.vic2.regs[0x13].toString(16)} vs $${refLPX(R,C).toString(16)})`);
  ok('CIA1 PB4 output low ($DC01) drives the VIC LP input and latches LPX/LPY');
}

// ── 2: PB4 as INPUT does NOT pull the line low (DDR gating) ───────────
//      A $00 in the Port B latch with DDR=input leaves PB4 floating high,
//      so no edge and no latch — proves the composite respects DDRB.
{
  const m = makeMachine();
  driveTo(m.vic2, 0x55, 30);
  m.cia1.write(0x03, 0x00);   // DDRB = all input
  m.cia1.write(0x01, 0x00);   // PB latch = $00, but PB4 is INPUT → high
  expect(!m.vic2._lpLatchedThisFrame, `input-mode PB4=0 must not latch`);
  expect(m.vic2.regs[0x13] === 0x00, `LPX untouched ($${m.vic2.regs[0x13].toString(16)})`);
  ok('PB4 as input does not drive the LP line low (DDRB gating)');
}

// ── 3: the $DC03 (DDRB) write path also recomputes the LP line ────────
//      lp-trigger's rastersync flips PB4 to output (stx $dc03) while the
//      latch holds 0, so the negative edge happens on the DDRB write, not
//      a $DC01 write. Both writePortB call sites must be wired.
{
  const R = 0x80, C = 25;
  const m = makeMachine();
  driveTo(m.vic2, R, C);
  m.cia1.write(0x01, 0x00);   // PB latch bit4 = 0 (still input → line high)
  expect(!m.vic2._lpLatchedThisFrame, `latch holds 0 while input: no edge yet`);
  m.cia1.write(0x03, 0x10);   // DDRB bit4 → output → PB4 now driven LOW

  expect(m.vic2._lpLatchedThisFrame, `DDRB write turning PB4 to output-low must latch`);
  expect(m.vic2.regs[0x14] === (R & 0xFF), `LPY latched raster`);
  expect(m.vic2.regs[0x13] === refLPX(R, C), `LPX matches oracle`);
  ok('DDRB ($DC03) write recomputes the LP line (PB4 input→output-low latches)');
}

// ── 4: joystick-port-1 FIRE pulls the shared LP node low (wired-AND) ──
//      FIRE (joyPort1 bit 4 = 0) pulls the line low even with PB4 as input.
{
  const R = 0x55, C = 30;
  const m = makeMachine();
  driveTo(m.vic2, R, C);
  m.cia1.write(0x03, 0x00);   // PB4 input (CIA not driving)
  m.cia1.write(0x01, 0xFF);   // establish HIGH baseline (no edge)
  expect(!m.vic2._lpLatchedThisFrame, `baseline high: no latch`);

  m.joyPort1 = 0xEF;          // FIRE pressed (bit 4 = 0)
  m._updateLightpen();        // recompute composite (port read / poll point)

  expect(m.vic2._lpLatchedThisFrame, `joystick-1 FIRE must pull the LP node low`);
  expect(m.vic2.regs[0x13] === refLPX(R, C), `FIRE-triggered LPX matches oracle`);
  ok('joystick-1 FIRE pulls the LP node low (CIA PB4 ∧ FIRE wired-AND)');
}

// ── 5: composite stays HIGH when neither source pulls (no false latch) ─
{
  const m = makeMachine();
  driveTo(m.vic2, 0x55, 30);
  m.cia1.write(0x01, 0xFF);   // PB latch = $FF first (input, high — no edge)
  m.cia1.write(0x03, 0xFF);   // then DDRB = output → PB4 driven HIGH (no edge)
  m.joyPort1 = 0xFF;          // FIRE released
  m._updateLightpen();
  expect(!m.vic2._lpLatchedThisFrame, `PB4 high + no FIRE → line high → no latch`);
  expect(m.vic2.regs[0x13] === 0x00, `LPX untouched`);
  ok('neither CIA nor FIRE pulling → LP stays high (no spurious latch)');
}

console.log(`\n${testNo} lightpen CIA/joystick wiring spec tests; ${failing} fail`);
process.exit(failing === 0 ? 0 : 1);
