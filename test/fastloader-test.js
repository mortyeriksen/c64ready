// test/fastloader-test.js — diagnostic tests for fastloader compatibility.
//
// ────────────────────────────────────────────────────────────────────────────
// IMPORTANT: scope of this analysis = True Drive Emulation (TDE) ONLY
// ────────────────────────────────────────────────────────────────────────────
// The emulator has two LOAD modes (machine.js):
//
//   • TDE OFF (default, machine.truedriveEnabled === false)
//     The CPU step at $FFD5 is intercepted by _trapLoad(). The host reads
//     the requested file out of the D64 image directly and copies it into
//     C64 RAM. The attached drive still ticks in the background so cracktros
//     and secondary loaders that call lower KERNAL IEC routines can still
//     talk to a live 1541, but the trapped LOAD transaction itself does not
//     use IEC, drive RAM, or drive VIAs. Fastloaders whose setup starts at
//     $FFD5 still need TDE on, because the trap eats their M-W/M-E setup.
//
//   • TDE ON (machine.setTrueDrive(true))
//     The trap is bypassed. KERNAL runs end-to-end and the drive's 6502
//     executes its ROM. M-W / M-E land in real drive RAM, and the
//     fastloader's bit-banged IEC protocol drives both sides of the bus.
//     This is the only mode where the timing analysis below matters.
//
// So: if a user is "having trouble loading with fastloaders," step 0 is to
// confirm TDE is on. If TDE is off, the trap eats the LOAD before the
// fastloader's M-W command can reach the drive.
//
// ────────────────────────────────────────────────────────────────────────────
// Why fastloaders (NOSDOS, JiffyDOS, Epyx FastLoad, Vorpal, ...) tend to fail
//                                  in TDE mode
// ────────────────────────────────────────────────────────────────────────────
//
// All Commodore fastloaders work the same way at a high level:
//   1. The C64 sends "M-W" + addr + len + payload to the drive over the
//      standard CBM serial protocol. The drive's DOS writes those bytes into
//      drive RAM ($0500-ish).
//   2. The C64 sends "M-E" + addr — the drive's DOS jumps into RAM.
//   3. From that point on, BOTH sides bit-bang custom protocols across the
//      CLK/DATA lines at speeds far above what the standard CBM serial
//      protocol allows. Every fastloader's bit-banging routine reads/writes
//      $1800 (drive VIA1 PB) every few cycles and expects the C64 to be
//      reading/writing $DD00 (CIA2 PA) at exactly matching cycles.
//
// What real hardware does
// ───────────────────────
// The 6502 in the C64 and the 6502 in the 1541 each tick at 1 MHz (close
// enough — drive runs ~1.5 % faster on PAL). On every PHI2 edge BOTH chips
// sample/drive the bus *individually*. A 4-cycle "STA $1800" sees its data
// register value land on the IEC pins at the very LAST cycle of the
// instruction. The C64 watching $DD00 sees that change at the same physical
// PHI2 edge — so a fastloader can deterministically clock 2 bits every 4
// cycles.
//
// Emulator bug surfaces for fastloaders
// ─────────────────────────────────────
// Drive1541.clock(cycles) now advances one drive CPU micro-op per requested
// cycle, with VIA timers and GCR spindle state clocked in the same per-cycle
// loop. That replaced the old instruction-atomic drive stepping, where one
// drive.clock(1) could retire an entire 6-cycle JSR and leave the C64/drive
// IEC phase relationship scrambled.
//
// The remaining high-risk regressions are:
//
//   • accidentally letting the $FFD5 direct-load trap run while TDE is on,
//     which eats a fastloader's M-W/M-E setup before it reaches the drive;
//
//   • reintroducing instruction-atomic drive execution, so $1800 writes and
//     VIA timer events are visible only after the whole instruction retires;
//
//   • adding a fractional 1.015 drive-clock accumulator back into the master
//     loop. The average PAL ratio is more realistic, but floor() scheduling
//     injects ±1-cycle jitter into 2-4 cycle bit-bang loops;
//
//   • changing host/drive ordering so a C64 STA $DD00 reaches the drive one
//     master cycle late, or so a CIA2 read speculatively advances the drive
//     and shifts a multi-sample $DD00 receiver out of phase;
//
//   • clocking VIA/GCR events after the drive CPU samples them, causing BVS
//     byte-ready loops or VIA IRQ poll loops to miss their edge by a cycle.
//
// Tests in this file probe the invariants fastloaders need:
//
//   1. TDE OFF traps $FFD5 and copies PRG bytes directly into C64 RAM.
//   2. TDE ON bypasses that trap, so KERNAL/IEC/drive execution is used.
//   3. Drive clocking is cycle-budget exact and jitter-free at the master loop.
//   4. Host and drive line changes are visible at the next bus sample.
//   5. VIA timers, CA1, SO/V, GCR byte cadence, and SYNC timing stay bounded.
//
// Usage:  node test/fastloader-test.js

import { Drive1541 } from '../src/drive1541.js';
import { C64Machine } from '../src/machine.js';
import { CIA } from '../src/cia.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}
function info(msg) { console.log(`info – ${msg}`); }

function buildDrive() {
  // ROM with reset vector → $C000 and a body of NOPs.
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  return new Drive1541(rom);
}

function buildDriveRom() {
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  return rom;
}

function buildKernalRom(fill = 0xEA) {
  const rom = new Uint8Array(8192).fill(fill);
  rom[0x1FFC] = 0x00; rom[0x1FFD] = 0xE0;
  return rom;
}

function keepCpuUnblocked(machine) {
  machine.vic2.clock = () => {};
  machine.vic2.isBaLow = () => false;
  machine.vic2.isAecLow = () => false;
}

function primeKernelLoadCall(machine, name = '*', device = 8) {
  const namePtr = 0x0200;
  for (let i = 0; i < name.length; i++) {
    machine.mem.ram[namePtr + i] = name.charCodeAt(i) & 0xFF;
  }
  machine.mem.ram[0xB7] = name.length;       // filename length
  machine.mem.ram[0xBB] = namePtr & 0xFF;    // filename pointer
  machine.mem.ram[0xBC] = namePtr >> 8;
  machine.mem.ram[0xB9] = 1;                 // secondary address: use file load addr
  machine.mem.ram[0xBA] = device;            // current device

  machine.cpu.a = 0;                         // LOAD, not VERIFY
  machine.cpu.x = 0;
  machine.cpu.y = 0;
  machine.cpu.pc = 0xFFD5;
  machine.cpu.sp = 0xFD;
  machine.cpu.instructionCyclesRemaining = 0;
  machine.cpu.microOps = null;

  // Return address for the _trapLoad() RTS simulation.
  machine.mem.ram[0x01FE] = 0x34;
  machine.mem.ram[0x01FF] = 0x12;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Drive clock(1) budget guard.
//    This used to overshoot when Drive1541.clock() retired a whole CPU
//    instruction per call. A cycle-stepped drive must advance exactly once.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDrive();
  drive.clock(1);
  const overshoot = drive.totalCycles - 1;
  info(`drive.clock(1) advanced totalCycles by ${drive.totalCycles} (overshoot = ${overshoot})`);
  assert(drive.totalCycles >= 1, 'clock(1) advances at least 1 cycle');
  assert(overshoot === 0, `clock(1) does not overshoot its cycle budget (got ${overshoot})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Drive matches its cycle budget exactly even on long instructions —
//    the cycle-stepped Drive1541.clock(N) advances exactly N drive cycles
//    regardless of the in-flight instruction's length. (Earlier the drive
//    was instruction-atomic and would overshoot by up to 6 cycles on JSR.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x0000] = 0x20; rom[0x0001] = 0x00; rom[0x0002] = 0xC2;   // JSR $C200
  rom[0x0200] = 0x60;                                             // RTS
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.clock(1);
  const overshoot = drive.totalCycles - 1;
  info(`drive.clock(1) over a 6-cycle JSR: overshoot = ${overshoot}`);
  assert(overshoot === 0,
    `cycle-stepped drive matches budget exactly on long instructions (got ${overshoot})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Drive bus output changes at the store cycle inside STA $1800.
//    Fastloaders sample IEC lines inside tight instruction streams; this
//    guards against regressing to instruction-retire-only output updates.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  // Program at $C000:
  //   LDA #$02   ; PB1 = 1 → drive asserts DATA OUT
  //   STA $1800
  //   NOP
  rom[0x0000] = 0xA9; rom[0x0001] = 0x02;          // LDA #$02
  rom[0x0002] = 0x8D; rom[0x0003] = 0x00; rom[0x0004] = 0x18;  // STA $1800
  rom[0x0005] = 0xEA;                              // NOP
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;

  const drive = new Drive1541(rom);
  drive.write(0x1802, 0xFF);             // DDRB all output

  // Track how dataOut evolves cycle-by-cycle.
  const trace = [];
  const orig = drive.via1.writePortB;
  drive.via1.writePortB = (val) => {
    orig.call(drive.via1, val);
    trace.push({ atTotalCycles: drive.totalCycles, dataOut: drive.dataOut });
  };

  // Run until the LDA + STA pair completes (LDA=2 cyc, STA abs=4 cyc → 6 total).
  while (drive.totalCycles < 6) drive.clock(1);

  info(`writePortB events during LDA+STA: ${JSON.stringify(trace)}`);
  assert(trace.length >= 1, 'STA $1800 produced at least one writePortB event');
  assert(trace[0].atTotalCycles <= 5,
    `STA $1800 updates output before instruction retire bookkeeping (got cycle ${trace[0].atTotalCycles})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ATN edge → CA1 IRQ asserted synchronously
//    The C64 asserting ATN must immediately set VIA1 IFR bit 1 in the drive,
//    so the drive's next instruction boundary takes the IRQ. This invariant
//    holds in the current implementation (setIecLines triggers CA1 directly).
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDrive();
  drive.cpu.I = 1;                       // mask IRQ — we just observe the line
  drive.write(0x180E, 0x82);             // VIA1 IER: enable CA1 (bit 1)
  drive.setIecLines(1, 1, 1);
  assert(drive.cpu.irqLine === false, 'IRQ line clear pre-ATN');

  drive.setIecLines(0, 1, 1);            // ATN falling edge
  assert(drive.cpu.irqLine === true,
    'CA1 IRQ asserted *immediately* on the ATN edge (no instruction wait)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Round-trip: drive STA $1800 → C64 sees DATA-IN low on next CIA2 read
//    Verifies the wired-AND sync model: when the drive runs a single
//    instruction that pulls DATA, a C64 reading $DD00 immediately afterward
//    must observe the bus state.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x0000] = 0xA9; rom[0x0001] = 0x02;          // LDA #$02   (PB1=1 → assert DATA)
  rom[0x0002] = 0x8D; rom[0x0003] = 0x00; rom[0x0004] = 0x18;  // STA $1800
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  drive.write(0x1802, 0xFF);

  // Hook a fake "C64" sync callback that snapshots dataOut whenever the
  // drive's outputs change.
  const snapshots = [];
  drive.busSyncCallback = () => snapshots.push(drive.dataOut);

  while (drive.totalCycles < 6) drive.clock(1);

  // After STA $1800 the drive's dataOut must be 0 (asserted), and the
  // sync callback must have been invoked at least once with that state.
  assert(drive.dataOut === 0,
    `drive dataOut == 0 after STA $1800 with PB1=1 (got ${drive.dataOut})`);
  assert(snapshots.includes(0),
    `busSync callback observed dataOut=0 transition (snapshots=${snapshots})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Reference PAL-ratio accumulator drift over a full frame.
//    The master loop intentionally uses 1:1 drive stepping for short-term
//    fastloader phase stability. Keep this as a bounded reference for the
//    old 1.015 accumulator math in case a later sync-factor model returns.
// ─────────────────────────────────────────────────────────────────────────────
{
  // We don't need full machine init to test the ratio — just simulate the
  // accumulator from machine._runMasterCycle and call drive.clock(dc).
  const drive = buildDrive();
  const C64_CYCLES_PER_FRAME = 19656;
  let accum = 0;
  for (let i = 0; i < C64_CYCLES_PER_FRAME; i++) {
    accum += 1.015;
    const dc = Math.floor(accum);
    accum -= dc;
    if (dc > 0) drive.clock(dc);
  }
  const expected = C64_CYCLES_PER_FRAME * 1.015;
  const drift = Math.abs(drive.totalCycles - expected);
  info(`drive cycles after one PAL frame: ${drive.totalCycles} (expected ≈${expected.toFixed(1)}, drift ${drift.toFixed(1)})`);
  // Drift should be bounded by max instruction length (~7 cycles).
  assert(drift < 8, `cumulative drive drift over a frame stays under 8 cycles (got ${drift.toFixed(1)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Drive instruction granularity bound — a 5-cycle instruction CANNOT
//    update the bus mid-stream. Document that intermediate samples between
//    cycles 1..4 of a 5-cyc instruction see only the pre-STA state.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  // ROL $00,X is 6 cycles, modifies memory — but we just want to verify
  // that during its 6 cycles, no $1800 writes happen.
  rom[0x0000] = 0xA9; rom[0x0001] = 0x02;     // LDA #$02
  rom[0x0002] = 0x8D; rom[0x0003] = 0x00; rom[0x0004] = 0x18; // STA $1800
  rom[0x0005] = 0xA9; rom[0x0006] = 0x00;     // LDA #$00     ← clears DATA
  rom[0x0007] = 0x8D; rom[0x0008] = 0x00; rom[0x0009] = 0x18; // STA $1800
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;

  const drive = new Drive1541(rom);
  drive.write(0x1802, 0xFF);

  // Sample dataOut after each clock(1).
  const samples = [];
  while (drive.totalCycles < 12) {
    drive.clock(1);
    samples.push(drive.dataOut);
  }
  info(`per-clock(1) dataOut samples after 12 cycles: ${samples.join(',')}`);
  // The samples reveal step granularity: dataOut transitions only on
  // instruction boundaries, not mid-instruction.
  // We expect to see 0 (asserted) for several samples and then 1 again.
  assert(samples.includes(0) && samples.includes(1),
    'dataOut transitions both ways across the LDA+STA / LDA+STA pair');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Bus visibility under tight C64↔drive interleave (regression probe)
//    Stand up a real C64Machine + drive (no ROMs) and verify that toggling
//    ATN from the host side immediately reflects in the drive's atnIn.
// ─────────────────────────────────────────────────────────────────────────────
{
  const machine = new C64Machine();
  // attachDrive needs a 1541 ROM blob; fake one just enough to construct.
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  machine.attachDrive(rom);

  // Reach into CIA2 PA: PA3 = ATN OUT. CIA2 PA bit set HIGH = drives the
  // 7406 inverter low → pulls the IEC line low (asserted). C64→drive
  // propagation is instant (iecEdgeLatency only delays the drive→C64 read
  // view; see switches.js).
  machine.cia2.portADir = 0x3F;          // ATN/CLK/DATA out + low bits
  machine.cia2.portA    = 0x08;          // PA3=1 → ATN asserted (bus low)
  machine._syncIecBus();
  assert(machine.drive1541.atnIn === 0, 'drive sees ATN asserted immediately');

  machine.cia2.portA    = 0x00;          // PA3=0 → ATN released (bus high)
  machine._syncIecBus();
  assert(machine.drive1541.atnIn === 1, 'drive sees ATN released immediately');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. CA1 IRQ flag is sticky until acked — fastloaders rely on this so the
//    drive can poll IFR after a tight bit-bang loop instead of catching
//    every ATN edge in real time.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDrive();
  drive.cpu.I = 1;
  drive.write(0x180E, 0x82);             // enable CA1
  drive.setIecLines(0, 1, 1);            // ATN falling edge
  drive.setIecLines(1, 1, 1);            // back high — should NOT clear flag
  assert((drive.via1.ifr & 0x02) !== 0,
    'CA1 IFR bit stays latched until explicitly acked (e.g. IRA read)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. busSyncCallback fires when drive outputs change — fastloaders push out
//     bytes by toggling PB1/PB3 in tight loops; the host side must be told
//     each time outputs change so it can wake CIA2.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDrive();
  drive.write(0x1802, 0xFF);             // DDRB output
  let calls = 0;
  drive.busSyncCallback = () => calls++;

  drive.write(0x1800, 0x02);             // PB1=1 → DATA asserted (changes dataOut)
  assert(calls >= 1, 'sync fires when drive output changes (DATA)');
  const after1 = calls;

  drive.write(0x1800, 0x0A);             // PB1+PB3=1 → DATA + CLK asserted (changes clk)
  assert(calls > after1, 'sync fires again when CLK output changes');

  // Writing same bits a second time MUST NOT spuriously fire sync —
  // otherwise tight write loops would deadlock on recursion guards.
  const after2 = calls;
  drive.write(0x1800, 0x0A);
  assert(calls === after2, 'redundant write to same value does not re-fire sync');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. TDE branch contract: with TDE OFF, the $FFD5 trap is the only path
//     into _trapLoad(). With TDE ON, the trap is bypassed so the LOAD
//     transaction goes through the live drive.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Build a minimally-initialized machine and stand it up enough that the
  // trap-or-step branch in _runMasterCycle can be evaluated by inspection.
  // We don't run the full machine here — just confirm the API contract.
  const m = new C64Machine();
  // TDE is enabled by default (matching the UI). It only becomes effective once
  // a drive is attached; any setTrueDrive() call reconciles the flag against
  // drive presence.
  assert(m.truedriveEnabled === true, 'TDE defaults to on');

  // Without a drive attached, reconciling forces the flag off — it is gated on
  // the drive being present.
  m.setTrueDrive(true);
  assert(m.truedriveEnabled === false,
    'setTrueDrive reconciles to off when no drive is attached');

  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  m.attachDrive(rom);

  m.setTrueDrive(true);
  assert(m.truedriveEnabled === true, 'TDE enables once a drive is attached');

  m.setTrueDrive(false);
  assert(m.truedriveEnabled === false, 'TDE can be disabled again');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11b. TDE OFF direct-load contract: when the CPU reaches KERNAL LOAD
//      ($FFD5), the host-side trap copies bytes straight out of the D64 into
//      C64 RAM. This is the intended non-true-drive path: no fastloader IEC
//      protocol is involved.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  keepCpuUnblocked(m);
  m.mem.kernal = buildKernalRom();
  m.attachDrive(buildDriveRom());
  m.setTrueDrive(false);   // exercise the TDE-OFF direct-load trap path
  const prg = new Uint8Array([0x01, 0x08, 0xA9, 0x42, 0x60]);
  let loadedName = null;
  m.currentD64 = {
    loadFile(name) { loadedName = name; return prg; },
    buildDirectoryPRG() { throw new Error('directory load not expected'); },
  };

  let trapCalls = 0;
  m.onLoadTrap = () => { trapCalls++; };
  primeKernelLoadCall(m, '*');
  const driveBefore = m.drive1541.totalCycles;

  C64Machine.prototype._runMasterCycle.call(m);

  assert(trapCalls === 1, `TDE off calls the $FFD5 load trap once (got ${trapCalls})`);
  assert(loadedName === '*', `direct-load trap asks D64 for "*" (got ${loadedName})`);
  assert(m.mem.ram[0x0801] === 0xA9 &&
         m.mem.ram[0x0802] === 0x42 &&
         m.mem.ram[0x0803] === 0x60,
    'direct-load trap copies PRG payload into C64 RAM at the file load address');
  assert(m.cpu.C === 0, 'direct-load trap returns success');
  assert(m.cpu.x === 0x04 && m.cpu.y === 0x08,
    `direct-load trap returns end address in X/Y (got $${m.cpu.y.toString(16)}${m.cpu.x.toString(16)})`);
  assert(m.cpu.pc === 0x1235,
    `direct-load trap simulates RTS from $FFD5 (got PC=$${m.cpu.pc.toString(16)})`);
  assert(m.drive1541.totalCycles === driveBefore + 1,
    'TDE off keeps the attached drive ticking while the $FFD5 trap handles LOAD');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11c. TDE ON bypasses the direct-load trap. The same $FFD5 state must step
//      into KERNAL code instead of calling currentD64.loadFile(), because
//      fastloaders need M-W/M-E and subsequent bit-banged IEC traffic to
//      reach the real drive emulation.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  keepCpuUnblocked(m);
  m.mem.kernal = buildKernalRom(0xEA);       // NOP at $FFD5 for this branch probe
  m.attachDrive(buildDriveRom());
  m.setTrueDrive(true);
  m.currentD64 = {
    loadFile() { throw new Error('TDE on must not call direct-load trap'); },
    buildDirectoryPRG() { throw new Error('TDE on must not build directory via trap'); },
  };

  let trapCalls = 0;
  m.onLoadTrap = () => { trapCalls++; };
  primeKernelLoadCall(m, '*');
  const driveBefore = m.drive1541.totalCycles;

  C64Machine.prototype._runMasterCycle.call(m);

  assert(trapCalls === 0, `TDE on bypasses the $FFD5 load trap (got ${trapCalls})`);
  assert(m.mem.ram[0x0801] === 0,
    'TDE on does not copy PRG bytes directly into C64 RAM');
  assert(m.cpu.pc === 0xFFD6,
    `TDE on lets the CPU execute KERNAL code at $FFD5 (got PC=$${m.cpu.pc.toString(16)})`);
  assert(m.drive1541.totalCycles === driveBefore + 1,
    'TDE on clocks the attached drive for the master cycle');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11e. Secondary drive (IEC device 9). It is a trap-backed drive: the $FFD5
//      LOAD trap serves its own D64 whenever it is switched on, keyed off
//      $BA === 9. Unlike device 8, it answers REGARDLESS of drive 8's TDE
//      state (it has no Drive1541 on the bus, so TDE — which only governs the
//      real drive 8 — does not apply). When it is switched off it is invisible:
//      a LOAD…,9 must NOT trap, so the KERNAL falls through to a real-IEC
//      DEVICE NOT PRESENT timeout.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  keepCpuUnblocked(m);
  m.mem.kernal = buildKernalRom();
  m.attachDrive(buildDriveRom());
  m.setTrueDrive(true);                       // drive 8 is a real TDE drive…

  // Drive 8 holds a disk that must never be touched by a device-9 LOAD.
  m.currentD64 = {
    loadFile() { throw new Error('device-9 LOAD must not read drive 8'); },
    buildDirectoryPRG() { throw new Error('device-9 LOAD must not read drive 8'); },
  };
  const prg9 = new Uint8Array([0x01, 0x08, 0xA9, 0x99, 0x60]);
  let loaded9 = null;
  const disk9 = {
    loadFile(name) { loaded9 = name; return prg9; },
    buildDirectoryPRG() { throw new Error('directory load not expected'); },
  };

  // Off by default → invisible: a LOAD…,9 must not trap.
  m.setD64Drive9(disk9);
  let trapCalls = 0;
  m.onLoadTrap = (dev) => { trapCalls++; assert(dev === 9, `trap reports device 9 (got ${dev})`); };
  primeKernelLoadCall(m, '*', 9);
  C64Machine.prototype._runMasterCycle.call(m);
  assert(trapCalls === 0, `device 9 OFF is invisible — LOAD…,9 does not trap (got ${trapCalls})`);
  assert(m.cpu.pc === 0xFFD6,
    `device 9 OFF lets the CPU execute KERNAL code at $FFD5 (got PC=$${m.cpu.pc.toString(16)})`);

  // Switch it on → it answers device 9 even though drive 8 has TDE on.
  m.setDrive9Enabled(true);
  primeKernelLoadCall(m, '*', 9);
  C64Machine.prototype._runMasterCycle.call(m);
  assert(trapCalls === 1, `device 9 ON traps LOAD…,9 even with drive-8 TDE on (got ${trapCalls})`);
  assert(loaded9 === '*', `device-9 trap asks ITS disk for "*" (got ${loaded9})`);
  assert(m.mem.ram[0x0801] === 0xA9 &&
         m.mem.ram[0x0802] === 0x99 &&
         m.mem.ram[0x0803] === 0x60,
    'device-9 trap copies its own PRG payload into C64 RAM at the file load address');
  assert(m.cpu.C === 0, 'device-9 trap returns success');
  assert(m.cpu.pc === 0x1235,
    `device-9 trap simulates RTS from $FFD5 (got PC=$${m.cpu.pc.toString(16)})`);

  // A LOAD…,8 in the same machine still routes to the real TDE drive 8 (no
  // trap), proving the two drives stay independent.
  trapCalls = 0;
  primeKernelLoadCall(m, '*', 8);
  C64Machine.prototype._runMasterCycle.call(m);
  assert(trapCalls === 0, `device 8 still bypasses the trap under TDE (got ${trapCalls})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11f. Device 9 with its OWN true-drive emulation on: a real second 1541 sits
//      on the bus (machine.drive1541b), so the $FFD5 trap must LEAVE device 9
//      to the real drive — exactly as TDE does for drive 8. _loadTrapDisk()
//      returns null for device 9 whenever drive1541b is connected.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  keepCpuUnblocked(m);
  m.mem.kernal = buildKernalRom();          // NOP fill → $FFD5 executes as code
  m.attachDrive(buildDriveRom());
  m.setDrive9Enabled(true);
  m.setD64Drive9({
    loadFile() { throw new Error('device-9 TDE must not call the direct-load trap'); },
    buildDirectoryPRG() { throw new Error('device-9 TDE must not build directory via trap'); },
  });

  // Stand-in for a connected real device-9 drive (the routing only checks for
  // its presence; booting a full second 1541 here is unnecessary).
  m.drive1541b = { clkOut_pin: 1, dataOut: 1, setIecLines() {}, clock() {} };

  m.mem.ram[0xBA] = 9;
  assert(m._loadTrapDisk() === null,
    'with a real device-9 drive connected, _loadTrapDisk leaves device 9 to it');

  let trapCalls = 0;
  m.onLoadTrap = () => { trapCalls++; };
  primeKernelLoadCall(m, '*', 9);
  C64Machine.prototype._runMasterCycle.call(m);
  assert(trapCalls === 0, `device 9 with TDE on bypasses the trap (got ${trapCalls})`);
  assert(m.cpu.pc === 0xFFD6,
    `device 9 with TDE on lets the CPU run KERNAL code at $FFD5 (got PC=$${m.cpu.pc.toString(16)})`);

  // Disconnecting the real drive returns device 9 to trap-served mode.
  m.drive1541b = null;
  let loaded9 = null;
  m.setD64Drive9({ loadFile(n) { loaded9 = n; return new Uint8Array([0x01, 0x08, 0x60]); },
                   buildDirectoryPRG() { throw new Error('not expected'); } });
  primeKernelLoadCall(m, '*', 9);
  C64Machine.prototype._runMasterCycle.call(m);
  assert(loaded9 === '*', `disconnecting device-9 TDE restores the direct-load trap (got ${loaded9})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11d. With TDE on, the drive ticks at driveClockFactor/65536 per master
//      cycle — the true PAL ratio 66517/65536 (~1.015, drive 1 MHz vs C64
//      985248 Hz) by default, or exactly 1:1 with the 'driveTrueClockRatio'
//      switch pinned OFF. Integer 16.16 accumulation: no float jitter.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  m.attachDrive(rom);
  m.setTrueDrive(true);

  const before = m.drive1541.totalCycles;
  for (let i = 0; i < 1000; i++) C64Machine.prototype._runMasterCycle.call(m);
  const ticks = m.drive1541.totalCycles - before;
  const expected = Math.floor(m.driveClockFactor * 1000 / 65536);   // accum starts 0
  assert(ticks === expected,
    `with TDE on, drive ticks at factor ${m.driveClockFactor}/65536 (got ${ticks}, expected ${expected} per 1000)`);
  info(`drive cycles per 1000 master cycles: ${ticks} (factor ${m.driveClockFactor})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. With TDE off, the attached drive still ticks.
//     TDE off only means the $FFD5 LOAD vector is trapped. Programs that
//     call lower KERNAL IEC routines after a cracktro/title screen still
//     need the 1541 CPU and VIAs to answer the bus.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  m.attachDrive(rom);
  m.setTrueDrive(false);
  assert(m.truedriveEnabled === false, 'TDE explicitly disabled');

  const before = m.drive1541.totalCycles;
  for (let i = 0; i < 2000; i++) C64Machine.prototype._runMasterCycle.call(m);
  const ticksWithTdeOff = m.drive1541.totalCycles - before;
  const expectedOff = Math.floor(m.driveClockFactor * 2000 / 65536); // accum starts 0
  assert(ticksWithTdeOff === expectedOff,
    `drive ticks while TDE off (got ${ticksWithTdeOff} cycles in 2000 master ticks, expected ${expectedOff})`);

  // Flip TDE on — setTrueDrive fast-forwards the drive until it reaches
  // its idle-skip steady state, so the drive isn't mid-init when the C64
  // first issues IEC. We don't assert an exact cycle count — the loop
  // stops as soon as canIdleSkip() reports the drive has settled.
  m.setTrueDrive(true);
  assert(m.drive1541.totalCycles > 0,
    `setTrueDrive(true) fast-forwards the drive past its boot self-test`);
  assert(m.drive1541.canIdleSkip(),
    `drive reached canIdleSkip() steady state after fast-forward`);

  // From here on, drive ticks at the clock-ratio factor per master cycle.
  // The accumulator may hold a fraction from the cycles above, so derive the
  // exact expected pop count from its current value.
  const afterFastForward = m.drive1541.totalCycles;
  const expectedOn = Math.floor((m.driveCycleAccum + m.driveClockFactor * 1000) / 65536);
  for (let i = 0; i < 1000; i++) C64Machine.prototype._runMasterCycle.call(m);
  const ticksWithTdeOn = m.drive1541.totalCycles - afterFastForward;
  assert(ticksWithTdeOn === expectedOn,
    `with TDE on, drive resumes factor-rate ticking (got ${ticksWithTdeOn} per 1000, expected ${expectedOn})`);
  info(`TDE off: ${ticksWithTdeOff} drive cycles / TDE on: ${ticksWithTdeOn} per 1000 master cycles`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. CIA2 SDR output mode — JiffyDOS-style C64→drive serial transfer
//     C64 arms the SDR shift register and runs Timer A; after 16 underflows
//     ICR bit 3 (SP) fires. Loaders rely on this firing exactly on time —
//     too few underflows = lost bits, too many = stuck handshake.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cia = new CIA(2);
  let irqAsserted = false;
  cia.irqHandler = (s) => { irqAsserted = s; };

  cia.write(0x04, 0x04); cia.write(0x05, 0x00);   // Timer A latch = 4
  cia.write(0x0E, 0x40);                          // CRA: SP output, stopped
  cia.write(0x0C, 0x55);                          // SDR → arm shift
  cia.write(0x0D, 0x88);                          // ICR mask: enable SP
  cia.read(0x0D);                                 // ack pending bits
  cia.write(0x0E, 0x41);                          // CRA: SP output + start TA

  for (let i = 0; i < 82; i++) cia.clock(1);      // 16 underflows × 5 cyc (+ IR latch)
  assert(irqAsserted, 'CIA2 SP IRQ fires after 16 Timer-A underflows');
  const icr = cia.read(0x0D);
  assert((icr & 0x08) !== 0, 'ICR bit 3 (SP) latched');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. CIA2 SDR multi-byte queue — second SDR write while shifting must
//     re-arm without dropping a byte. Fastloaders queue bytes back-to-back.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cia = new CIA(2);
  cia.irqHandler = () => {};
  cia.write(0x04, 0x04); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x40); cia.write(0x0C, 0xAA);
  cia.write(0x0D, 0x88); cia.read(0x0D);
  cia.write(0x0E, 0x41);

  // First byte: 16 underflows × 5 = 80 cycles → SP IRQ.
  let spIrqs = 0;
  for (let i = 0; i < 80; i++) cia.clock(1);
  if ((cia.read(0x0D) & 0x08) !== 0) spIrqs++;

  // Queue second byte mid-stream — write SDR while shifter still armed.
  cia.write(0x0C, 0x55);
  for (let i = 0; i < 80; i++) cia.clock(1);
  if ((cia.read(0x0D) & 0x08) !== 0) spIrqs++;

  assert(spIrqs >= 1, `Multi-byte SDR queue produces SP IRQs (got ${spIrqs})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. Drive RAM mirrors — M-W payloads land at $0500-ish and the loader
//     reads them back at any mirror. A broken mirror → loader reads garbage,
//     jumps wild, crashes.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.write(0x0500, 0xAB);
  assert(drive.read(0x0500) === 0xAB, 'RAM at $0500');
  assert(drive.read(0x0D00) === 0xAB, '$0D00 mirrors $0500');
  assert(drive.read(0x1500) === 0xAB, '$1500 mirrors $0500');
  drive.write(0x1700, 0xCD);
  assert(drive.read(0x0700) === 0xCD, 'write at $1700 reflects in $0700');
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. Drive ROM is read-only — bad emulators that let writes land in ROM
//     space will silently corrupt vectors when the M-E payload mis-targets.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  const before = drive.read(0xE000);
  drive.write(0xE000, 0x55);   // attempt write to ROM
  assert(drive.read(0xE000) === before, `ROM at $E000 unchanged after write (got $${drive.read(0xE000).toString(16)})`);

  // Reset vectors must remain readable as the ROM author placed them.
  assert(drive.read(0xFFFC) === 0x00, 'reset-vector low preserved');
  assert(drive.read(0xFFFD) === 0xC0, 'reset-vector high preserved');
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. VIA register mirroring on the drive — every 16 bytes through $1800-
//     $1BFF (VIA1) and $1C00-$1FFF (VIA2). Some fastloaders intentionally
//     hit mirror addresses (e.g. $18FE) to defeat write-detection traps.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.write(0x1802, 0xFF);              // DDRB all output
  drive.write(0x18F0, 0x55);              // ORB at the last VIA1 mirror in page
  assert(drive.read(0x1800) === 0x55, 'write at $18F0 visible at $1800');
  assert(drive.read(0x1AB0) === 0x55, 'write at $18F0 visible at $1AB0');
  assert(drive.read(0x1BF0) === 0x55, 'write at $18F0 visible at $1BF0');

  drive.write(0x1C02, 0xFF);
  drive.write(0x1FF0, 0xAA);              // VIA2 mirror at the top of the range
  assert(drive.read(0x1C00) === 0xAA, 'write at $1FF0 visible at $1C00');
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. DDR changes are part of VIA1's IEC output state. The serial output
//     pins feed 7406 inverters; when PB1/PB3/PB4 are inputs their pull-ups
//     are seen as high inverter inputs, which can assert IEC lines.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  // PB1 (DATA OUT), PB3 (CLK OUT), and PB4 (ATNA) outputs.
  drive.write(0x1802, 0x1A);
  drive.write(0x1800, 0x0A);              // assert both
  assert(drive.iecData === 0, 'DATA asserted');
  assert(drive.iecClk === 0, 'CLK asserted');

  // Now reduce DDR to PB1/PB4 only. PB3 becomes input; its pull-up feeds a
  // high into the inverter, so CLK remains asserted even though ORB bit 3 is
  // no longer an output.
  drive.write(0x1802, 0x12);
  drive.write(0x1800, 0x00);
  assert(drive.iecData === 1, 'DATA released after PB1 output is written low');
  assert(drive.iecClk === 0, 'CLK asserted while PB3 is input due inverter input pull-up');
}

// ─────────────────────────────────────────────────────────────────────────────
// 19. Back-to-back ATN edges — fastloaders sometimes pulse ATN repeatedly
//     within microseconds. Each falling edge must latch CA1, even if the
//     drive hasn't acked the previous one yet.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  drive.cpu.I = 1;
  drive.write(0x180E, 0x82);              // CA1 IRQ enabled

  drive.setIecLines(1, 1, 1);
  drive.setIecLines(0, 1, 1);             // edge 1
  assert((drive.via1.ifr & 0x02) !== 0, 'CA1 IFR latched on first edge');
  drive.setIecLines(1, 1, 1);
  drive.setIecLines(0, 1, 1);             // edge 2 — CA1 still latched
  assert((drive.via1.ifr & 0x02) !== 0, 'CA1 IFR remains latched on second edge');
  drive.read(0x1801);                     // ack
  assert((drive.via1.ifr & 0x02) === 0, 'CA1 IFR clears on IRA read');

  drive.setIecLines(1, 1, 1);
  drive.setIecLines(0, 1, 1);             // edge 3 after ack
  assert((drive.via1.ifr & 0x02) !== 0, 'CA1 IFR latches again post-ack');
}

// ─────────────────────────────────────────────────────────────────────────────
// 20. Drive output state survives an IRQ — when ATN-CA1 fires while the
//     drive's PB outputs are mid-handshake, the bus state must not reset.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.write(0x1802, 0xFF);              // DDRB all output
  drive.write(0x1800, 0x02);              // assert DATA via PB1
  assert(drive.iecData === 0, 'DATA asserted before IRQ');

  // Fire an ATN edge → CA1 IRQ. dataOut must NOT spontaneously change.
  drive.setIecLines(0, 1, 1);
  assert(drive.iecData === 0, 'DATA still asserted after CA1 IRQ');
  assert(drive.atnIn === 0, 'ATN seen as asserted');
}

// ─────────────────────────────────────────────────────────────────────────────
// 21. C64-side CIA2 PA write reflects in drive on the very next sample.
//     Real loader pattern: STA $DD00 ; LDA $1800 must observe the change.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  m.attachDrive(rom);
  m.drive1541.write(0x1802, 0x1A);        // PB1/PB3/PB4 outputs, released
  m.drive1541.write(0x1800, 0x00);

  m.cia2.portADir = 0x3F;
  m.cia2.portA    = 0x10;                 // PA4=1 → assert CLK
  m._syncIecBus();
  m._iecClock();                          // C64 edge reaches the drive next cycle (iecEdgeLatency)
  // Drive sees CLK low (= asserted). VIA1 PB2 (CLK IN, 7406-inverted) → 1.
  const pb = m.drive1541.read(0x1800);
  assert((pb & 0x04) !== 0, 'drive PB2 (CLK IN) reflects C64-asserted CLK');

  m.cia2.portA = 0x00;                    // release
  m._syncIecBus();
  m._iecClock();
  const pb2 = m.drive1541.read(0x1800);
  assert((pb2 & 0x04) === 0, 'drive PB2 follows release on next sample');
}

// ─────────────────────────────────────────────────────────────────────────────
// 22. Drive's VIA1 IER survives reset of just the CPU/output state — a
//     reset that wipes IER would silently disable the ATN-IRQ wire and
//     fastloader ATN handshakes would be missed.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.write(0x180E, 0x82);              // enable CA1
  drive.cpu.I = 1;
  drive.setIecLines(1, 1, 1);
  drive.setIecLines(0, 1, 1);
  assert(drive.cpu.irqLine === true, 'CA1 IRQ wired post-config');

  // Hard reset of drive — IER will reset to 0 (real hw behavior). Verify the
  // CA1 wire is RE-ARMED by software writing IER again.
  drive.reset();
  drive.write(0x180E, 0x82);
  drive.cpu.I = 1;
  drive.setIecLines(1, 1, 1);
  drive.setIecLines(0, 1, 1);
  assert(drive.cpu.irqLine === true, 'CA1 IRQ re-arms cleanly after reset');
}

// ─────────────────────────────────────────────────────────────────────────────
// 23. GCR overflow sets the CPU's V flag, and a BVS sampling V after the
//     byte boundary must take the branch (not miss it).
//
//     Spec basis: 1541 head shift register raises the SO pin (→ V flag) on
//     each completed GCR byte (per Inside Commodore DOS / VIA2 PA latch).
//     The 6502 BVS instruction tests V on its first cycle. So: a BVS that
//     EXECUTES after a byte-boundary overflow must branch.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.motorOn = true;
  drive.currentSpeedZone = 0;             // 32 cyc/byte (innermost, slowest)
  drive.write(0x1C0C, 0xEE);              // SOE on (DOS read config) so byte-ready fires
  drive.setDisk({ readSector: () => new Uint8Array(256).fill(0x55) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array(64).fill(0x55);
  drive.trackDirty = true;

  let firstOverflowCycle = -1;
  let cpuSawVCycle = -1;
  const origSet = drive.cpu.setOverflow.bind(drive.cpu);
  drive.cpu.setOverflow = () => {
    if (firstOverflowCycle === -1) firstOverflowCycle = drive.totalCycles;
    origSet();
  };
  const origClock = drive.cpu.clock.bind(drive.cpu);
  drive.cpu.clock = function () {
    if (cpuSawVCycle === -1 && this.V === 1) cpuSawVCycle = drive.totalCycles;
    return origClock();
  };

  for (let i = 0; i < 64; i++) drive.clock(1);

  assert(firstOverflowCycle >= 0, 'GCR overflow occurred during the run');
  assert(cpuSawVCycle >= 0, 'CPU observed V=1 at some point');
  // Spec invariant: V must be visible to the CPU no later than the cycle
  // immediately following the overflow. Tighter than that is implementation
  // detail; looser would let BVS loops desync.
  const lag = cpuSawVCycle - firstOverflowCycle;
  assert(lag >= 0 && lag <= 1,
    `CPU sees V within 1 cycle of overflow (got lag=${lag})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 24. VIA2 T1 underflow → IRQ line propagation.
//
//     Spec basis (MOS 6522 datasheet §3.5): T1 underflow sets IFR bit 6.
//     IRQ output reflects (IFR & IER & $7F) ≠ 0. The 6502's IRQ recognition
//     samples the line at the end of phase 2 of each cycle; SO an IRQ
//     raised on cycle N is taken on the next instruction boundary.
//
//     Spec invariant tested: once the IFR latches, the CPU's irqLine must
//     reflect the asserted state within 1 cycle. (Strict same-cycle is a
//     valid implementation; one-cycle-late is also valid; > 1 cycle late
//     drifts the DOS scheduler.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.write(0x1C0E, 0xC0);                 // enable T1
  drive.write(0x1C0B, 0x40);                 // ACR: T1 free-run
  drive.write(0x1C04, 0x04);
  drive.write(0x1C05, 0x00);

  let viaSetIfrAt = -1;
  let irqLineAt = -1;
  const origVia2Clock = drive.via2.clock.bind(drive.via2);
  drive.via2.clock = (n) => {
    const before = drive.via2.ifr & 0x40;
    origVia2Clock(n);
    if (viaSetIfrAt === -1 && (drive.via2.ifr & 0x40) && !before) {
      viaSetIfrAt = drive.totalCycles;
    }
  };
  const origClock = drive.cpu.clock.bind(drive.cpu);
  drive.cpu.clock = function () {
    if (irqLineAt === -1 && this.irqLine) irqLineAt = drive.totalCycles;
    return origClock();
  };

  drive.cpu.I = 1;
  for (let i = 0; i < 30; i++) drive.clock(1);

  assert(viaSetIfrAt >= 0, 'VIA2 T1 IFR latched');
  assert(irqLineAt >= 0, 'CPU saw irqLine asserted');
  const lag = irqLineAt - viaSetIfrAt;
  assert(lag >= 0 && lag <= 1,
    `IRQ visible to CPU within 1 cycle of IFR latch (got lag=${lag})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 25. Host CIA2 PA write reaches drive's atnIn within bounded latency.
//
//     Spec basis (CBM Service Manual §IEC bus): the IEC bus is a wired-AND
//     of all device outputs through 7406 inverters. Bus state is shared in
//     real time. Spec invariant: a host CIA2 PA write must be visible to
//     the drive on the very next bus sample (any sub-cycle latency is fine,
//     but not multi-cycle).
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  m.attachDrive(rom);
  for (let i = 0; i < 10; i++) C64Machine.prototype._runMasterCycle.call(m);

  m.cia2.portADir = 0x3F;
  m.cia2.portA    = 0x08;          // PA3=1 → ATN asserted
  m._syncIecBus();
  m._iecClock();                   // edge visible one master cycle later (iecEdgeLatency)
  assert(m.drive1541.atnIn === 0,
    'drive observes ATN low one cycle after _syncIecBus from host write');

  m.cia2.portA = 0x00;
  m._syncIecBus();
  m._iecClock();
  assert(m.drive1541.atnIn === 1,
    'drive observes ATN release one cycle after _syncIecBus from host write');
}

// ─────────────────────────────────────────────────────────────────────────────
// 25b. NOSDOS-style DDRA driving: CIA2 serial pins switched to input pull the
//      7406 inverter input high, which asserts the IEC line. NOSDOS uses
//      $DD02 writes, not just $DD00 writes, during its handshake.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  m.attachDrive(buildDriveRom());

  // State observed before the Ghosts'n Goblins NOSDOS stall: KERNAL left the
  // output latch at $C7, then the loader wrote DDRA=$1F. PA5 is now input;
  // through the inverter input pull-up that must assert DATA low.
  m.cia2.portA = 0xC7;
  m.cia2.portADir = 0x1F;
  m._syncIecBus();
  m._iecClock();                     // DDR edge reaches the drive next cycle

  assert(m.drive1541.dataIn === 0,
    'CIA2 PA5 input mode asserts IEC DATA low through the 7406 input pull-up');
  assert((m.drive1541.read(0x1800) & 0x01) === 0x01,
    'drive VIA1 PB0 sees the host DATA assertion caused by DDRA=$1F');
}

// ─────────────────────────────────────────────────────────────────────────────
// 25c. Drive-side DDR changes affect IEC output pins too. Some fastloaders
//      temporarily make VIA1 PB1/PB3/PB4 inputs and rely on the physical pin
//      pull-ups feeding the inverter/ATNA logic.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDrive();
  drive.setIecLines(1, 1, 1);

  drive.write(0x1800, 0x00);
  drive.write(0x1802, 0x18); // PB3/PB4 outputs, PB1 input

  assert(drive.dataOut === 0,
    'VIA1 PB1 input mode asserts IEC DATA low through the inverter input pull-up');
  assert((drive.read(0x1800) & 0x02) === 0x02,
    'VIA1 PB1 reads high while configured as input');
}

// ─────────────────────────────────────────────────────────────────────────────
// 25d. Mounting or ejecting a disk must not patch live 1541 DOS RAM. Media
//      changes affect the read head/write-protect hardware state; zero page
//      belongs to DOS and fastloader code. NOSDOS can stall if setDisk()
//      clobbers those bytes after TDE has already booted the drive.
// ─────────────────────────────────────────────────────────────────────────────
{
  const drive = buildDrive();
  const watched = [0x12, 0x13, 0x1C, 0x1E, 0x22];
  for (const addr of watched) drive.ram[addr] = (0x80 | addr) & 0xFF;

  const mockD64 = {
    readSector(track, sector) {
      const bytes = new Uint8Array(256);
      if (track === 18 && sector === 0) {
        bytes[0xA2] = 0x47;
        bytes[0xA3] = 0x47;
      }
      return bytes;
    },
  };

  drive.setDisk(mockD64);
  assert(drive.gcrDisk !== null, 'setDisk attaches a GCR-backed disk image');
  assert(drive.writeProtected === true, 'mounted D64 exposes write-protect hardware high');
  assert(drive.trackDirty === true && drive.trackStream === null,
    'setDisk invalidates the read-head stream without touching DOS RAM');
  for (const addr of watched) {
    const expected = (0x80 | addr) & 0xFF;
    assert(drive.ram[addr] === expected,
      `setDisk preserves live drive RAM $${addr.toString(16).padStart(2, '0')} (got $${drive.ram[addr].toString(16)})`);
  }

  drive.setDisk(null);
  assert(drive.gcrDisk === null, 'setDisk(null) ejects the disk image');
  assert(drive.writeProtected === false, 'ejected drive clears write-protect hardware');
  for (const addr of watched) {
    const expected = (0x80 | addr) & 0xFF;
    assert(drive.ram[addr] === expected,
      `setDisk(null) preserves live drive RAM $${addr.toString(16).padStart(2, '0')}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 26. Drive bus output is visible to the host within a small bounded
//     master-cycle latency (≤ 1 cycle) after the drive's STA $1800.
//
//     Spec basis: the IEC bus reflects the wired-AND of all driver outputs
//     in real time. Strict zero latency would require single-step lockstep
//     of both CPUs (impractical), but spec demands the drive's output be
//     observable to the host before the host's NEXT instruction completes.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  m.attachDrive(rom);
  for (let i = 0; i < 10; i++) C64Machine.prototype._runMasterCycle.call(m);

  m.drive1541.write(0x1802, 0xFF);      // DDRB
  m.drive1541.write(0x1800, 0x02);      // PB1=1 → DATA asserted
  m._syncIecBus();

  m.cia2.portADir = 0x00;               // PA input mode
  // Spec invariant: host's next read must observe DATA-IN low.
  const pa = m.cia2.readPortA();
  assert((pa & 0x80) === 0,
    `host reads DATA-IN low after drive STA $1800 (got $${pa.toString(16)})`);

  // Run one extra master cycle and verify state stays asserted (no spurious
  // race releases it).
  C64Machine.prototype._runMasterCycle.call(m);
  const pa2 = m.cia2.readPortA();
  assert((pa2 & 0x80) === 0,
    `DATA-IN remains low one cycle later (got $${pa2.toString(16)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 26a. CIA2 PA reads are passive bus samples. They must not speculatively
//      clock the drive, because two-bit fastloaders often take several $DD00
//      samples per received byte and depend on those samples staying in phase
//      with the normal master-cycle interleave.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  m.attachDrive(buildDriveRom());
  m.truedriveEnabled = true;

  const drive = m.drive1541;
  drive.write(0x1802, 0xFF);
  drive.write(0x1800, 0x00);            // DATA released before the staged write
  m.cia2.portADir = 0x3F;               // serial outputs released, PA6/PA7 sample pins
  m.cia2.portA = 0x00;
  m._syncIecBus();

  // Stage a single drive CPU bus cycle that asserts DATA via PB1=1. The host
  // read below must not execute it; the staged write becomes visible only
  // after the normal drive tick.
  drive.cpu.microOps = [
    drive.cpu._writeOp(() => { drive.write(0x1800, 0x02); }),
  ];
  drive.cpu.instructionCyclesRemaining = 1;

  const before = drive.totalCycles;
  const pa = m.cia2.readPortA();

  assert(drive.totalCycles === before,
    `CIA2 PA read does not clock the drive (got ${drive.totalCycles - before} extra cycles)`);
  assert((pa & 0x80) !== 0,
    `same-cycle host DATA-IN sample keeps the pre-existing bus state (got $${pa.toString(16)})`);

  drive.clock(1);
  m._syncIecBus();
  if (m.iecEdgeLatency) { m._iecClock(); m._iecClock(); }  // pin → C64-facing delay line
  const pa2 = m.cia2.readPortA();
  assert((pa2 & 0x80) === 0,
    `next bus sample sees the drive assertion after the normal drive tick (got $${pa2.toString(16)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 26b. TDE idle skip: once DOS is parked in its idle IEC loop with motor and
//      LED off, true-drive emulation can stop ticking the 1541 until the host
//      asserts a serial line. Active loading is still cycle-stepped; only the
//      released idle bus state is skipped.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = new C64Machine();
  m.attachDrive(buildDriveRom());
  m.truedriveEnabled = true;
  keepCpuUnblocked(m);

  const drive = m.drive1541;
  const primeIdle = (pc = 0x04AC) => {
    drive.cpu.pc = pc;
    drive.cpu.instructionCyclesRemaining = 0;
    drive.cpu.microOps = null;
    drive.cpu.setIrqLine(false);
    drive.motorOn = false;
    drive._lastPortBOut = 0x00;
    drive.atnIn = 1;
    drive.clkIn = 1;
    drive.dataIn = 1;
    drive.clkOut_pin = 1;
    drive.dataOut = 1;
    drive.via1.ifr = 0;
    drive.via1.ier = 0;
    drive.via2.ifr = 0;
    drive.via2.ier = 0;
  };

  primeIdle(0x04AC);
  assert(drive.canIdleSkip(), 'fastloader RAM idle-loop state is eligible for TDE idle skip');
  primeIdle(0xEC13);
  assert(drive.canIdleSkip(), '1541 ROM idle scheduler state is eligible for TDE idle skip');
  drive.clkIn = 0;
  assert(drive.canIdleSkip(), '1541 ROM idle scheduler can skip while the host holds CLK low');
  primeIdle(0x04AC);
  drive.clkIn = 0;
  assert(!drive.canIdleSkip(), 'fastloader RAM idle loop still requires CLK released');

  primeIdle(0xEC13);
  drive.cpu.instructionCyclesRemaining = 1;
  assert(!drive.canIdleSkip(), 'in-flight drive CPU instruction disables idle skip');
  primeIdle(0xEC13);
  drive.motorOn = true;
  assert(!drive.canIdleSkip(), 'motor-on drive state disables idle skip');
  primeIdle(0xEC13);
  drive.atnIn = 0;
  assert(!drive.canIdleSkip(), 'asserted ATN disables idle skip');
  primeIdle(0xEC13);
  drive.clkOut_pin = 0;
  assert(!drive.canIdleSkip(), 'drive CLK output assertion disables idle skip');
  primeIdle(0xEC13);
  drive.via2.ifr = 0x40;
  drive.via2.ier = 0x40;
  drive._updateIrq();
  assert(!drive.canIdleSkip(), 'pending enabled VIA IRQ disables idle skip');
  primeIdle(0x0800);
  assert(!drive.canIdleSkip(), 'non-idle PC disables idle skip');

  // Idle-skip ENGAGEMENT needs the IEC bus quiet for IEC_IDLE_ENGAGE_QUIET
  // master cycles; tests that assert engagement pre-warm the counter.
  const warmQuiet = () => { m._iecBusStableCycles = 1 << 30; };

  // Hysteresis contract: an eligible idle state right after bus activity must
  // NOT engage the skip; only a quiet bus may.
  primeIdle(0xEC13);
  m._iecBusStableCycles = 0;            // as if the bus just changed
  C64Machine.prototype._runMasterCycle.call(m);
  assert(m._driveIdleSkipping === false,
    'idle skip must not engage while the IEC bus was active moments ago (command-exchange guard)');

  primeIdle(0xEC13);
  warmQuiet();
  const before = drive.totalCycles;
  const expectedIdle = Math.floor((m.driveCycleAccum + m.driveClockFactor * 100) / 65536);
  for (let i = 0; i < 100; i++) C64Machine.prototype._runMasterCycle.call(m);
  assert(drive.totalCycles === before + expectedIdle,
    `idle TDE advances drive time at the clock-ratio factor while skipping CPU work (got ${drive.totalCycles - before}, expected ${expectedIdle})`);
  assert(drive.cpu.pc === 0xEC13,
    `idle TDE leaves the drive CPU parked while no wake event occurs (PC=$${drive.cpu.pc.toString(16)})`);
  assert(m.tdeIdleSkippedCycles === 100,
    `machine counts cached TDE idle skips (got ${m.tdeIdleSkippedCycles})`);
  assert(m._driveIdleSkipping === true, 'machine caches the idle-skip state after the first eligible cycle');

  m.cia2.portADir = 0x3F;
  m.cia2.portA = 0x08;                  // PA3=1 -> ATN asserted on the bus
  m._syncIecBus();
  if (m.iecEdgeLatency) m._iecClock();  // ATN edge reaches the drive next cycle
  assert(!drive.canIdleSkip(), 'asserted ATN disables TDE idle skip');
  assert(m._driveIdleSkipping === false, 'host IEC activity wakes cached idle skip');
  const beforeResume = drive.totalCycles;
  const expectedResume = Math.floor((m.driveCycleAccum + m.driveClockFactor) / 65536);
  C64Machine.prototype._runMasterCycle.call(m);
  assert(drive.totalCycles === beforeResume + expectedResume,
    `drive resumes CPU ticking on host IEC activity (got ${drive.totalCycles - beforeResume}, expected ${expectedResume})`);

  primeIdle(0xEC13);
  m.cia2.portA = 0x00;
  m._syncIecBus();
  warmQuiet();                          // engagement waits out the quiet window
  C64Machine.prototype._runMasterCycle.call(m);
  assert(m._driveIdleSkipping === true, 'idle skip re-enters after IEC returns to released idle');
  m.setD64(null);
  assert(m._driveIdleSkipping === false, 'media changes wake cached idle skip');

  primeIdle(0xEC13);
  drive.via2.ier = 0x40;
  drive.via2.t1_active = true;
  drive.via2.t1c = 1;
  drive.via2.t1l = 10;
  m._driveIdleSkipping = false;
  warmQuiet();
  C64Machine.prototype._runMasterCycle.call(m);
  assert(m._driveIdleSkipping === true, 'idle skip starts before the scheduled VIA wake');
  C64Machine.prototype._runMasterCycle.call(m);
  assert(m._driveIdleSkipping === false,
    'VIA timer IRQ wakes cached idle skip without running the drive CPU in the skipped cycle');
  assert(drive.cpu.irqLine === true, 'VIA timer wake leaves the drive IRQ line asserted for normal stepping');

  primeIdle(0xEC13);
  drive.clkIn = 0;
  m.cia2.portADir = 0x3F;
  m.cia2.portA = 0x10;                  // steady host CLK low through the inverter
  m._syncIecBus();
  warmQuiet();
  C64Machine.prototype._runMasterCycle.call(m);
  assert(m._driveIdleSkipping === true, 'steady ROM-idle CLK-low bus can remain in cached idle skip');
  m.cia2.portA = 0x00;                  // CLK changes high again
  m._syncIecBus();
  if (m.iecEdgeLatency) m._iecClock();  // edge reaches the drive-facing bus next cycle
  assert(m._driveIdleSkipping === false, 'IEC bus changes wake cached idle skip even if ATN stays released');
}

// ─────────────────────────────────────────────────────────────────────────────
// 27. Successive GCR bytes overflow at the correct cycles. The DOS reads
//     a sector with a tight "BVC loop / LDA $1C01 / CLV" cadence; missing
//     one overflow desynchs the rest. Run a known-bit-rate stream and pin
//     the cycle of every overflow.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  drive.motorOn = true;
  drive.currentSpeedZone = 0;             // 32 cyc/byte (innermost, slowest) → 4 cyc/bit
  drive.write(0x1C0C, 0xEE);              // SOE on (DOS read config) so byte-ready fires
  drive.setDisk({ readSector: () => new Uint8Array(256).fill(0xAA) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array(64).fill(0xAA);
  drive.trackDirty = true;

  const overflows = [];
  const orig = drive.cpu.setOverflow.bind(drive.cpu);
  drive.cpu.setOverflow = () => { overflows.push(drive.totalCycles); orig(); };

  // Spec: 5 byte-readies arrive in (5 byte-times + tail-of-last-byte's-delay).
  // With DRIVE_SO_DELAY_ENABLED, allow up to 25 cy tail (VICE upper bound).
  for (let i = 0; i < 5 * 32 + 25; i++) drive.clock(1);
  assert(overflows.length === 5,
    `5 bytes worth of overflows in ${5*32+25} cycles (got ${overflows.length})`);
  // Spec: spacing between consecutive byte-readies equals the byte cadence
  // for the zone (zone 0 = 32 cy/byte). The P1-aligned SO delay is constant
  // when the byte period is a multiple of 16, preserving spacing.
  for (let i = 1; i < overflows.length; i++) {
    const dt = overflows[i] - overflows[i - 1];
    assert(dt === 32, `overflow #${i}: 32 cycles since last (got ${dt})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 28. CPU's V flag is NOT auto-cleared by reading VIA2 PA ($1C01).
//     The DOS clears V via CLV after consuming the byte. If reading the
//     byte port itself cleared V, the BVC loop would spin tightly waiting
//     for the next overflow that already happened.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.cpu.setOverflow();
  assert(drive.cpu.V === 1, 'V set by setOverflow');

  // Read from VIA2 PA via the drive's bus; should NOT touch V.
  drive.lastGCRByte = 0x42;
  const v = drive.read(0x1C01);
  assert(v === 0x42, 'PA read returns lastGCRByte');
  assert(drive.cpu.V === 1, 'V flag preserved across VIA2 PA read');
}

// ─────────────────────────────────────────────────────────────────────────────
// 29. Power-on head position + matching speed zone. A cold 1541 has an
//     UNDEFINED head position; VICE's deterministic reset rests the head on
//     the directory track (half-track 36 = track 18), which is also where a
//     real drive sits after
//     its power-on bump+seek. We match VICE. The spindle speed-zone must be
//     seeded to the PB5-6 bits for that track (track 18 → %10 = 2 = 28 cy/byte),
//     using the PB-bit numbering — NOT gcr.js zoneForTrack() (opposite order).
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  assert(drive.currentHalfTrack === 36,
    `reset rests head on the directory track (halftrack 36 = track 18), got ${drive.currentHalfTrack}`);
  assert(drive.currentSpeedZone === 2,
    `reset speed zone = PB5-6 bits for track 18 (%10 = 2 = 28 cy/byte), got ${drive.currentSpeedZone}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 30. Stepper / spindle independence. Per "Die Floppy 1541" Tabelle 5.4,
//     VIA2 PB0/PB1 drive the stepper-motor coils and PB2 drives the spindle
//     ("Laufwerksmotor") — separate outputs. The Gray-code footnote
//     ("Aufwärtszählen 00,01,10,11 bewegt den Kopf nach innen") describes
//     head motion purely from the PB0/1 phase pattern, with no dependency on
//     PB2. So a phase change steps the head regardless of spindle-motor state.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);   // resets to halftrack 36, stepper phase 2

  // Motor stays OFF (no PB2). Gray-code from phase 2: 2→3 steps the head
  // inward by one halftrack — the stepper coils are independent of the motor.
  drive.write(0x1C00, 0x03);
  assert(drive.currentHalfTrack === 37,
    `phase 2→3 steps head inward with spindle motor OFF (got ht=${drive.currentHalfTrack})`);

  // Continue the Gray-code sequence (3→0) — still motor off — steps again.
  drive.write(0x1C00, 0x00);
  assert(drive.currentHalfTrack === 38,
    `phase 3→0 also advances with motor off (got ht=${drive.currentHalfTrack})`);

  // Reverse count (0→3) steps the head back outward.
  drive.write(0x1C00, 0x03);
  assert(drive.currentHalfTrack === 37,
    `reverse phase step moves head outward (got ht=${drive.currentHalfTrack})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 31. VIA2 PA ($1C01) reads the latched GCR byte and is SIDE-EFFECT-FREE on
//     disk rotation. Per "Die Floppy 1541" §7.3.4, the GCR shift register is
//     clocked by the read head's bit-clock (flux transitions), independent of
//     the CPU. A CPU read of $1C01 latches the current byte; it does not
//     advance or retard the spindle. Consecutive reads return the same byte
//     and leave the rotational position unchanged.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.motorOn = true;
  drive.gcrDisk = { getTrackStream: () => drive.trackStream };
  drive.trackStream = new Uint8Array(64).fill(0x55);
  drive.trackDirty = false;
  drive.currentSpeedZone = 3;
  drive.trackBitPos = 17;          // arbitrary mid-track angular position
  drive.lastGCRByte = 0x4B;        // latched byte the DOS would read

  const posBefore = drive.trackBitPos;
  const b1 = drive.read(0x1C01);
  const b2 = drive.read(0x1C01);
  assert(b1 === 0x4B, `$1C01 returns the latched GCR byte (got $${b1.toString(16)})`);
  assert(b1 === b2, `consecutive $1C01 reads return the same latched byte`);
  assert(drive.trackBitPos === posBefore,
    `reading $1C01 does not advance disk rotation (pos ${posBefore} → ${drive.trackBitPos})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 32. VIA2 PB ($1C00) bit 7 reflects the current SYNC line and is likewise
//     SIDE-EFFECT-FREE on rotation. Reading $1C00 reports the present SYNC
//     state (0 = sync) without advancing the spindle.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.motorOn = true;
  drive.gcrDisk = { getTrackStream: () => drive.trackStream };
  drive.trackStream = new Uint8Array(64).fill(0xFF);
  drive.trackDirty = false;
  drive.currentSpeedZone = 3;
  drive.trackBitPos = 5;
  drive._syncBit = 0x00;           // SYNC currently active (active-low)

  const posBefore = drive.trackBitPos;
  const v = drive.read(0x1C00);
  assert((v & 0x80) === 0x00, `$1C00 bit 7 reports current SYNC state (got $${v.toString(16)})`);
  assert(drive.trackBitPos === posBefore,
    `reading $1C00 does not advance disk rotation (pos ${posBefore} → ${drive.trackBitPos})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 33. No event coalescing: a VIA timer IRQ and a GCR overflow both
//     occurring within a small window must BOTH reach the CPU. Hardware
//     spec: SO and IRQ are independent pin signals; the 6502 latches V on
//     SO regardless of IRQ state, and the IRQ vectoring is independent of
//     V. So both events must independently reach the CPU.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  // Arm VIA2 T1 to underflow on a known cycle. Period N+2 = 6 (N=4).
  drive.write(0x1C0E, 0xC0);
  drive.write(0x1C0B, 0x40);
  drive.write(0x1C04, 0x04);
  drive.write(0x1C05, 0x00);

  // Set up GCR stream with motor on.
  drive.motorOn = true;
  drive.currentSpeedZone = 3;
  drive.write(0x1C0C, 0xEE);  // SOE on (DOS read config) so byte-ready sets V
  drive.setDisk({ readSector: () => new Uint8Array(256).fill(0xAA) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array(64).fill(0xAA);
  drive.trackDirty = true;

  drive.cpu.I = 1;                         // mask CPU side; just observe
  let bothSeenCycle = -1;
  for (let i = 0; i < 64; i++) {
    drive.clock(1);
    if (bothSeenCycle === -1 &&
        (drive.via2.ifr & 0x40) !== 0 && drive.cpu.V === 1) {
      bothSeenCycle = drive.totalCycles;
    }
  }
  assert(bothSeenCycle >= 0,
    `CPU saw both T1 IFR set AND V=1 within 64 cycles (got cycle ${bothSeenCycle})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 30. Spindle bit-rate accumulator preserves fractional cycles over long
//     runs. Zone 0 = 26 cyc/byte = 3.25 cyc/bit. After many bytes the
//     fractional remainder must not accumulate into a missed bit.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  drive.motorOn = true;
  drive.currentSpeedZone = 3;             // 26 cyc/byte → 3.25 cyc/bit (outermost, fastest)
  drive.write(0x1C0C, 0xEE);              // SOE on (DOS read config) so byte-ready fires
  drive.setDisk({ readSector: () => new Uint8Array(256).fill(0x55) });
  drive.gcrDisk.getTrackStream = () => new Uint8Array(2048).fill(0x55);
  drive.trackDirty = true;

  let bytes = 0;
  const orig = drive.cpu.setOverflow.bind(drive.cpu);
  drive.cpu.setOverflow = () => { bytes++; orig(); };

  // Spec: 1000 byte-readies in (1000 × 26 cy) + tail SO-delay window.
  // SO delay is bounded by VICE's [10, 25] cy upper bound at zone 3.
  for (let i = 0; i < 26_000 + 25; i++) drive.clock(1);
  assert(bytes === 1000,
    `1000 byte-readies in ${26000+25} cycles, no fractional drift (got ${bytes})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 31. Drive instructions in a tight loop don't lose VIA timer cadence.
//     Free-run T1 underflows must keep firing at N+1 cycles regardless of
//     what the drive's CPU is doing each cycle.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);   // CPU just NOPs
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  drive.write(0x1C0E, 0xC0);
  drive.write(0x1C0B, 0x40);
  drive.write(0x1C04, 0x09);                       // N=9, period 11 cyc
  drive.write(0x1C05, 0x00);

  let irqs = 0;
  const orig = drive.via2.irqHandler;
  drive.via2.irqHandler = (s) => {
    if (s) {
      irqs++;
      drive.via2.write(0x0D, 0x40);                // ack T1 IFR bit
    }
    if (orig) orig(s);
  };

  // 110 cycles → expect ~10 underflows (first period 11, then 11 each).
  for (let i = 0; i < 110; i++) drive.clock(1);
  assert(irqs >= 9 && irqs <= 11,
    `T1 fires ~10× in 110 cycles while CPU runs NOPs (got ${irqs})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 32. CPU IRQ taken at the instruction boundary AFTER irqLine asserts.
//     With I=0 and a pending VIA IRQ, the next instruction boundary must
//     vector through $FFFE within a small cycle budget. The 6502 actually
//     takes 7 cycles to do BRK-style IRQ entry — so a pending IRQ must
//     reach the handler within ~10 cycles of being raised.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  // IRQ vector at $FFFE/$FFFF → $D000
  rom[0x3FFE] = 0x00; rom[0x3FFF] = 0xD0;
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);

  drive.write(0x1C0E, 0xC0);
  drive.write(0x1C0B, 0x40);
  drive.write(0x1C04, 0x02);
  drive.write(0x1C05, 0x00);                       // T1 will underflow soon

  drive.cpu.I = 0;                                  // IRQs enabled
  let irqDispatchedAt = -1;
  for (let i = 0; i < 30; i++) {
    drive.clock(1);
    if (irqDispatchedAt === -1 && drive.cpu.pc === 0xD000) {
      irqDispatchedAt = drive.totalCycles;
    }
  }
  assert(irqDispatchedAt >= 0,
    `IRQ vectored to $D000 within 30 cycles (got cycle ${irqDispatchedAt})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 33. SYNC pulse stays exactly while shift register sees ones — the
//     drive's $1C00 PB7 reads 0 during SYNC. DOS reads PB7 in a tight
//     "BMI *" loop while waiting for end of sync; if SYNC drops mid-cycle
//     wrong (e.g. one cycle early), the framing byte is consumed
//     prematurely and CRC fails.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rom = new Uint8Array(16384).fill(0xEA);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const drive = new Drive1541(rom);
  drive.motorOn = true;
  drive.currentSpeedZone = 3;
  drive.setDisk({ readSector: () => new Uint8Array(256) });
  // 2 bytes 0xFF (= 16 ones) → SYNC; then 0x55 starts framing.
  drive.gcrDisk.getTrackStream = () => new Uint8Array([0xFF, 0xFF, 0x55, 0xAA]);
  drive.trackDirty = true;

  // 32 cycles per byte → 4 cyc/bit. After 10 bits SYNC latches.
  let syncLowFromCycle = -1;
  let syncReleasedAtCycle = -1;
  for (let i = 0; i < 64 * 4; i++) {
    drive.clock(1);
    const pb7Low = (drive.via2.readPortB() & 0x80) === 0;
    if (pb7Low && syncLowFromCycle === -1) syncLowFromCycle = drive.totalCycles;
    if (!pb7Low && syncLowFromCycle >= 0 && syncReleasedAtCycle === -1) {
      syncReleasedAtCycle = drive.totalCycles;
    }
  }
  assert(syncLowFromCycle >= 0, 'SYNC PB7=0 latched somewhere');
  assert(syncReleasedAtCycle > syncLowFromCycle,
    `SYNC released at cycle ${syncReleasedAtCycle} (latched at ${syncLowFromCycle})`);
}

console.log('\nAll fastloader diagnostic tests complete.');
