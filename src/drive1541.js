// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { CPU } from './cpu.js';
import { VIA6522 } from './6522.js';
import { GCRDisk, CYCLES_PER_BYTE } from './gcr.js';
import { switchOn } from './switches.js';

// "No wake scheduled" sentinel for the idle-skip countdown. A large SMI, NOT
// Infinity: Infinity is a double and poisons the idle-wake fields into tagged
// fields that box a HeapNumber on every idle-skip store. Safely larger than any
// VIA countdown (16-bit counters, ≤ 0x10000) and a valid SMI.
export const IDLE_WAKE_NONE = 0x40000000;

// Feature flag for P1-aligned SO delay between bit-8 boundary and
// CPU's V flag setting. Real 6502 samples SO at trailing edge of P1; V is
// updated at next P1. This SO-to-V delay spans 10-25 cy for full
// P1-phase alignment — values >18 cy break our standard sector-read loop
// (BVC+CLV+LDA = 8 cy; zone 3 cadence = 26 cy → max safe 18 cy before next
// bit-8 overwrites lastGCRByte). The 18-cy ceiling was pinned by Sparkle's
// install stream (Aloft disc 1).
export const DRIVE_SO_DELAY_ENABLED = false;

// Mechanical timing models, behind flags (default OFF). These are physical
// delays, not hardware registers — they suppress valid byte framing while the
// drive is not read-stable. The 1541 DOS tolerates instantaneous behavior
// (it waits via its own delay loops), and adding these delays can slow loads
// and perturb cycle-counted fastloaders, so they are opt-in for experiments.
//   - Motor spin-up: ~300 ms after the spindle is energized before the disk
//     reaches stable read speed (~300k drive cycles at 1 MHz).
//   - Head settle: ~10 ms after a half-track step before reads are stable.
// Default OFF (matching the comment above): the 1541 DOS waits via its own delay
// loops, so instantaneous behavior is safe, and modeling these delays perturbs
// cycle-counted fastloaders. Flip to true only for explicit mechanical-timing
// experiments. (Were mistakenly committed as true; restored to off 2026-06-28.)
export const DRIVE_MOTOR_SPINUP_ENABLED = false;
export const DRIVE_HEAD_SETTLE_ENABLED  = false;
const DRIVE_MOTOR_SPINUP_CYCLES = 300000;
const DRIVE_HEAD_SETTLE_CYCLES  = 10000;

// Power-on head position. We rest the 1541 head on the directory track
// (18 = half-track 36) at reset. Real hardware powers on at an undefined
// position and the DOS bumps to the track-1 stop then seeks to 18; using a
// deterministic resting state is the practical choice for demo compatibility.
const DIRECTORY_TRACK_HALFTRACK = 36;   // track 18.0

// A VIA port pin's level: driven to its latch bit when configured as output
// (DDR bit set), else floats high. Module-scope so writePortB (bit-banged on
// every drive-side $1800 write during a load) allocates no per-call closure.
function viaPinHigh(port, ddr, bit) {
  return (ddr & bit) ? ((port & bit) !== 0) : true;
}

// VIA2 PB5-6 speed-zone bits for a track — the value the DOS writes to $1C00,
// indexing CYCLES_PER_BYTE = [32,30,28,26]. NOTE: this is the OPPOSITE
// numbering to gcr.js zoneForTrack() (which numbers zones outer→inner 0..3),
// so reset must use THIS mapping to seed currentSpeedZone correctly.
function speedZoneBitsForTrack(track) {
  if (track <= 17) return 3;   // tracks 1-17  → 26 cy/byte (fastest)
  if (track <= 24) return 2;   // tracks 18-24 → 28 cy/byte
  if (track <= 30) return 1;   // tracks 25-30 → 30 cy/byte
  return 0;                    // tracks 31-35 → 32 cy/byte (slowest)
}

// 1541 Drive Memory Map:
// $0000 - $07FF: 2KB RAM
// $0800 - $17FF: RAM mirror (incomplete address decoding)
// $1800 - $1BFF: VIA1 (Serial Bus / IEC) – mirrors every 16 bytes
// $1C00 - $1FFF: VIA2 (Drive mechanics)  – mirrors every 16 bytes
// $C000 - $FFFF: 16KB DOS ROM

export class Drive1541 {
  constructor(romBuffer, d64) {
    // 1541.bin often has a 2-byte PRG header (load address) that shifts everything.
    // Standard 1541-II 16KB ROM starts with copyright header at offset 2 in many dumps.
    // ROM map: 16KB bank $C000-$FFFF
    let data = new Uint8Array(romBuffer);
    this.rom = new Uint8Array(16384);
    if (data && data.length >= 16384) {
      // If the file is 16386 bytes, it includes a 2-byte PRG load address ($00 $C0)
      const offset = (data.length === 16386) ? 2 : 0;
      this.rom.set(data.subarray(offset, offset + 16384));
    }

    this._atna_pin        = 1;  // PB4
    this.busSyncCallback  = null;
    this._manualDataOut_pin = 1; // PB1
    this.clkOut_pin       = 1;  // PB3
    this.atnIn            = 1;  // 1 = High/Released
    this.clkIn            = 1;
    this.dataIn           = 1;
    this.dataOut          = 1;

    this.via1 = new VIA6522('VIA1');
    this.via2 = new VIA6522('VIA2');
    this.cpu = new CPU(this);
    this.ram = new Uint8Array(2048);
    this.totalCycles = 0;

    this._lastDevNum      = -1;
    this._lastLogPc       = -1;
    this._traceSteps      = 0;

    // Drive-mechanics state must be defined before any VIA callback can read it.
    // _syncBit=0x80 ("no SYNC") avoids a phantom sync latch during self-test.
    this.currentHalfTrack = DIRECTORY_TRACK_HALFTRACK;   // track 18 (VICE reset position)
    this.motorOn          = false;
    this.bitCycleAccum    = 0;
    this.trackDirty       = true;
    this.trackStream      = null;
    this.trackBitPos      = 0;
    this._lastPortBOut    = 0x00;
    // Seed the phase consistently with the starting half-track so the DOS's
    // first $1C00 phase write doesn't compute a spurious step (halftrack 2 =
    // phase 0; each inward half-track advances the phase by 1).
    this._lastStepperPhase = (this.currentHalfTrack - 2) & 0x03;
    this._syncBit         = 0x80;
    this.writeProtected   = true;
    this.lastGCRByte      = 0x55;
    this._shiftReg        = 0;
    this._shiftBits       = 0;
    this._inSync          = false;
    this._onesInRow       = 0;
    // Write head (mirror of the read shifter). `_lastWrittenByte` is latched from
    // VIA2 Port A whenever the drive CPU stores $1C01; `_writeShiftReg` shifts it
    // onto the surface MSB-first; `_writeBits` counts the 8-bit byte boundary;
    // `_wasWriting` primes the shifter on each read→write transition.
    this._writeEnabled    = switchOn('driveWrite');
    this._lastWrittenByte = 0x55;
    this._writeShiftReg   = 0;
    this._writeBits       = 0;
    this._wasWriting      = false;
    this._soPendingCycles      = 0;
    this._motorSpinupRemaining = 0;
    this._headSettleRemaining  = 0;
    this._lastReportedDataOut = 1;
    this._lastReportedClkOut  = 1;
    // Seed the spindle speed-zone to the PB5-6 bit value for the start track
    // (track 18 → bits %10 = 2 = 28 cy/byte). Must use speedZoneBitsForTrack,
    // NOT gcr.js zoneForTrack (opposite numbering).
    this.currentSpeedZone = speedZoneBitsForTrack(this.currentHalfTrack >> 1);

    this._dbgSyncBytesSeen = 0;
    this._dbgPhaseWrites   = 0;

    this._devNum          = 8;
    this._wireCallbacks();
    this._initCpu();

    if (d64) this.setDisk(d64);
  }

  // ── Port / IRQ wiring — extracted so reset() can re-apply after VIA recreate
  _wireCallbacks() {
    // Each callback field is assigned exactly once per wiring pass: handing a
    // field a second function value costs V8 every optimised function compiled
    // against it.
    this.via1.irqHandler = (state) => this._updateIrq();
    this.via2.irqHandler = (state) => this._updateIrq();

    // VIA1 Port B (IEC Bus). A 7406 inverter sits between the IEC lines and
    // PB0/PB2/PB7, so PB=1 corresponds to line LOW (asserted). The bus is
    // VIA1 Port B — IEC serial bus interface
    //  Bit 0: DATA IN   Bit 1: DATA OUT (0=low)
    //  Bit 2: CLOCK IN  Bit 3: CLOCK OUT (0=low)
    //  Bit 4: ATN ACK   Bit 5/6: device-# jumpers (dev 8 → 00)
    //  Bit 7: ATN IN
    this.via1.readPortB = () => {
      // Pull the live bus state before sampling. The drive can spin in a tight
      // poll of $1800 without ever writing, so caching `dataIn`/`clkIn` purely
      // in response to output changes lets a transient C64-side pulse latch
      // the wrong value and deadlock the handshake.
      if (this.busSyncCallback) this.busSyncCallback();
      const ddr = this.via1.regs[0x02];
      let b = (this._devNum - 8) << 5; // Jumpers for Device #
      // The serial output pins have pull-ups at the inverter input. If a
      // fastloader flips PB1/PB3/PB4 to inputs, those pins read high and the
      // corresponding 7406/ATNA logic sees a high input.
      b |= (~ddr) & 0x1A; // PB1 DATA OUT, PB3 CLK OUT, PB4 ATNA
      if (this.dataIn === 0) b |= 0x01; // PB0 Data In
      if (this.clkIn  === 0) b |= 0x04; // PB2 Clk In
      if (this.atnIn  === 0) b |= 0x80; // PB7 ATN In
      return b;
    };
    this.via1.writePortB = (val) => {
      const port = this.via1.portB;
      const ddr = this.via1.regs[0x02];
      this._manualDataOut_pin = viaPinHigh(port, ddr, 0x02) ? 0 : 1;
      this.clkOut_pin         = viaPinHigh(port, ddr, 0x08) ? 0 : 1;
      this._atna_pin          = viaPinHigh(port, ddr, 0x10) ? 0 : 1;
      this._refreshIecOutputs();
    };

    // VIA2 Port A — GCR byte from read head
    this.via2.readPortA = () => this.lastGCRByte;
    // VIA2 Port A write — the drive CPU stores the outgoing GCR byte here ($1C01)
    // during a disk write. Latch it; the spindle shifts it onto the surface at the
    // byte boundary (see _advanceSpindle write branch). The value already has DDRA
    // applied by the VIA, which the DOS sets to $FF (all output) while writing.
    this.via2.writePortA = (val) => { this._lastWrittenByte = val; };

    // VIA2 Port B — drive mechanics
    //  Bit 0-1: stepper motor phases (lower 2 bits of 4-phase pattern)
    //  Bit 2:   motor on (active high)
    //  Bit 3:   LED
    //  Bit 4:   write protect (input; ACTIVE LOW — 0 = protected, 1 = write enabled),
    //           per the 1541 schematic's write-protect sense line. The DOS reads PB4
    //           low as "write protect on" (error 26), so a writable disk must drive
    //           PB4 HIGH. (Latent while disks were force-protected; a writable disk
    //           exposed the inverted sense.)
    //  Bit 5-6: bit-rate select (speed zone)
    //  Bit 7:   SYNC detect (input, 0 = sync found)
    this.via2.readPortB = () => {
      let pins = 0xFF;
      if (this.writeProtected) pins &= ~0x10;  // protected → PB4 low; writable → high
      if (this._syncBit === 0x00) pins &= ~0x80;
      return pins;
    };

    this.via2.writePortB = (val) => {
      this._lastPortBOut = val;
      const newMotorOn = (val & 0x04) !== 0;
      // When motor stops, cancel any pending SO countdown — real 1541 ROM
      // never relies on byte-ready firing after the spindle halts.
      if (!newMotorOn && this.motorOn) this._soPendingCycles = 0;
      // Motor 0→1: begin the spin-up window during which the disk is not yet
      // at stable read speed (flag-gated; default off).
      if (newMotorOn && !this.motorOn && DRIVE_MOTOR_SPINUP_ENABLED) {
        this._motorSpinupRemaining = DRIVE_MOTOR_SPINUP_CYCLES;
      }
      this.motorOn = newMotorOn;
      this.currentSpeedZone = (val >> 5) & 0x03;
      // Stepper phase is driven by the PB0/PB1 OUTPUT register (ORB), not
      // the masked pin value. Otherwise a DDR write would synthesise a
      // spurious phase transition every time PB0/PB1's direction changes
      // (since the initial ORB-default of $FF would mask in as phase=3 the
      // moment DOS init writes DDRB). Track the ORB-derived phase directly
      // so DDR-only writes are inert.
      const newPhase = this.via2.regs[0x00] & 0x03;
      const oldPhase = this._lastStepperPhase;
      if (oldPhase !== newPhase) {
        this._lastStepperPhase = newPhase;
        this._dbgPhaseWrites++;
        this._stepHeadByPhase(oldPhase, newPhase);
      }
    };
  }

  _initCpu() {
    // Standard 6502 reset: fetch program counter from vectors at $FFFC/$FFFD
    const lo = this.read(0xFFFC);
    const hi = this.read(0xFFFD);
    this.cpu.pc = (hi << 8) | lo;
    this.cpu.sp = 0xFF;
    this.cpu.I  = 1; 
  }

  _getActiveJobIndex() {
    for (let i = 0; i < 6; i++) {
      if (this.ram[i] & 0x80) return i;
    }
    return -1;
  }

  _stepHeadByPhase(oldPhase, newPhase) {
    // Real 1541 stepper: 4-phase (Gray-coded) drive. Each phase transition
    // moves the head by one half-track. Direction is encoded in the
    // transition pattern:
    //   step in  (toward higher tracks): 0→1, 1→2, 2→3, 3→0
    //   step out (toward lower tracks):  0→3, 3→2, 2→1, 1→0
    // Fastloaders write phases directly without the DOS ROM job queue, so
    // physical stepping must be driven by the phase pattern itself rather
    // than a target-track shortcut.
    const delta = ((newPhase - oldPhase) & 0x03);
    if (delta === 1) {
      this.currentHalfTrack = Math.min(this.currentHalfTrack + 1, 84);
    } else if (delta === 3) {
      this.currentHalfTrack = Math.max(this.currentHalfTrack - 1, 2);
    } else {
      return; // 2-step (illegal/skipped phase) — head doesn't move reliably
    }
    // Physical head position is not memory-mapped; custom loaders reuse zero
    // page freely, so stepper motion must not patch drive RAM.
    this.trackDirty = true;
    // A half-track step needs settling time before reads are stable
    // (flag-gated; default off).
    if (DRIVE_HEAD_SETTLE_ENABLED) this._headSettleRemaining = DRIVE_HEAD_SETTLE_CYCLES;
  }

  _setDeviceNumber(unit) {
    this._devNum = unit;
    // Re-wire VIA1 read callback to reflect NEW jumper settings
    this._wireCallbacks();
  }

  // ── Disk attach/detach ────────────────────────────────────────────────────
  setDisk(d64) {
    // Fold any pending head writes on the OUTGOING disk back into its image
    // before its GCR cache is dropped, so eject / disk-swap / reset (which
    // re-attaches through here) never loses a save.
    if (this._writeEnabled && this.gcrDisk) this.gcrDisk.commitDirtyTracks();
    this.gcrDisk = d64 ? new GCRDisk(d64) : null;
    // No disk ⇒ not protected (nothing to protect). With a disk: honor its own
    // write-protect (a session attribute on the D64) when write support is on —
    // absent or true ⇒ protected, so only an explicit `writeProtected === false`
    // (createBlankD64 / the UI unlock) opens it, and disk-like mocks stay
    // protected; legacy always-protected when write support is switched off.
    this.writeProtected = !d64 ? false
      : this._writeEnabled ? (d64.writeProtected !== false)
      : true;
    // Disk insertion is a hardware media change, not a DOS RAM patch. The
    // ROM and fastloader code own zero page state; clobbering it while the
    // drive is live can desynchronise custom loaders.
    this.trackDirty = true;
    this.trackStream = null;
    this.trackBitPos = 0;
    this._shiftReg = 0;
    this._shiftBits = 0;
    this._inSync = false;
    this._onesInRow = 0;
    this._wasWriting = false;
    this._writeBits = 0;
  }

  /** Runtime write-protect toggle (UI unlock). Records the state on the mounted
   *  D64 so it survives a re-attach (reset / state restore). No effect on the
   *  drive gate while global write support is switched off. */
  setWriteProtect(protectedOn) {
    const p = !!protectedOn;
    if (this.gcrDisk) this.gcrDisk.d64.writeProtected = p;
    this.writeProtected = (this._writeEnabled && this.gcrDisk) ? p : !!this.gcrDisk;
  }

  /** Fold any pending head writes back into the D64 image (decode-on-demand).
   *  Returns the number of sectors written. Safe to call anytime. */
  commitWrites() {
    return this.gcrDisk ? this.gcrDisk.commitDirtyTracks() : 0;
  }

  /** Whether the drive has UNCOMMITTED head writes (raw GCR not yet decoded back
   *  into the D64 image). This is the auto-save trigger; it is distinct from
   *  D64.dirty (= image modified since the last export). */
  hasUnsavedWrites() {
    return !!(this.gcrDisk && this.gcrDisk.hasDirtyTracks());
  }

  /** True when the drive CPU has switched the head to WRITE. Per the 1541 schematic
   *  VIA2 CB2 selects the head R/W amplifier: the DOS drives it manual-output-LOW
   *  (PCR bits 5-7 = 110 → PCR & $E0 === $C0) with Port A all output (DDRA=$FF) to
   *  write a data block; read mode drives CB2 high (bits 5-7 = 111 → $E0). */
  _isWriteMode() {
    return (this.via2.regs[0x0C] & 0xE0) === 0xC0 && this.via2.regs[0x03] === 0xFF;
  }

  // ── IEC bus (host pushes line state) ──────────────────────────────────────
  // Lines are Active Low (0 = Asserted/0V, 1 = Released/High)
  setIecLines(atn, clk, data) {
    const atnEdge = (atn === 0 && this.atnIn !== 0); 
    
    this.atnIn  = atn;
    this.clkIn  = clk;
    this.dataIn = data;

    if (atnEdge) {
      this.via1.triggerIrq(1); // CA1 Interrupt on Falling Edge
    }

    // Hardware XOR Acknowledgment is updated automatically in clock() or writePortB
    // but we should refresh the composite DATA state immediately for the C64 to see it.
    this._refreshIecOutputs();
  }

  _refreshIecOutputs() {
    // 1541-II Logic: DATA_pin is pulled low (0) if (PB1 == 0) OR (PB4_pin XOR ATN_bus)
    //   PB4_pin is 1/High when the register bit is 0 (Transparent/Enable).
    //   ATN_bus is 0/Low when Asserted by C64.
    //   So if PB4_pin=1 and ATN_bus=0, 1^0 = 1 -> PULL DATA.
    this.dataOut = (this._manualDataOut_pin === 0 || (this._atna_pin ^ this.atnIn)) ? 0 : 1;
    // Only notify the bus if one of our outputs actually changed; otherwise
    // setIecLines() → _refreshIecOutputs() → busSyncCallback would recurse.
    if (this.busSyncCallback &&
        (this.dataOut !== this._lastReportedDataOut ||
         this.clkOut_pin !== this._lastReportedClkOut)) {
      this._lastReportedDataOut = this.dataOut;
      this._lastReportedClkOut  = this.clkOut_pin;
      this.busSyncCallback();
    }
  }

  get iecClk()  { return this.clkOut_pin; }
  get iecData() { return this.dataOut; }
  get ledOn()   { return (this._lastPortBOut & 0x08) !== 0; }

  canIdleSkip() {
    // The ROM idle scheduler and common fastloader idle loops wait with the
    // spindle stopped and all serial lines released. The machine may skip the
    // CPU part of these cycles, while batched idle settling keeps VIA time
    // moving and setIecLines() still latches the next C64 ATN edge.
    const pc = this.cpu.pc & 0xFFFF;
    const inRomIdleLoop = pc >= 0xEC12 && pc <= 0xEC2F;
    const inFastloaderIdleLoop = pc >= 0x04A7 && pc <= 0x04AC;
    return (inRomIdleLoop || inFastloaderIdleLoop) &&
      this.cpu.atInstructionBoundary() &&
      !this.cpu.irqLine &&
      !this.motorOn &&
      !this.ledOn &&
      this.atnIn === 1 &&
      (inRomIdleLoop || this.clkIn === 1) &&
      this.dataIn === 1 &&
      this.clkOut_pin === 1 &&
      this.dataOut === 1 &&
      !this.via1.irqState &&
      !this.via2.irqState;
  }

  _viaIdleWakeCycles(via) {
    if (via.irqState) return 0;
    let cycles = IDLE_WAKE_NONE;
    if (via.t1_active && (via.ier & 0x40)) {
      cycles = Math.min(cycles, via.t1c + 1);
    }
    if (via.t2_active && (via.ier & 0x20)) {
      cycles = Math.min(cycles, via.t2c + 1);
    }
    return cycles;
  }

  idleSkipWakeCycles() {
    return Math.min(this._viaIdleWakeCycles(this.via1), this._viaIdleWakeCycles(this.via2));
  }

  deferIdleCycle(cycles) {
    this.totalCycles += cycles;
  }

  settleIdleCycles(cycles) {
    if (cycles <= 0) return !this.cpu.irqLine;
    this.via1.clock(cycles);
    this.via2.clock(cycles);
    return !this.cpu.irqLine;
  }

  _updateIrq() {
    this.cpu.setIrqLine(this.via1.irqState || this.via2.irqState);
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  reset() {
    this.ram.fill(0);
    this.via1 = new VIA6522('VIA1');
    this.via2 = new VIA6522('VIA2');
    this._wireCallbacks();
    this.currentHalfTrack = DIRECTORY_TRACK_HALFTRACK;   // track 18 (VICE reset position)
    this.motorOn = false;
    this.bitCycleAccum = 0;
    this.trackDirty = true;
    this.trackStream = null;
    this.trackBitPos = 0;
    this._lastPortBOut = 0x00;
    // Phase consistent with the start half-track (see constructor note).
    this._lastStepperPhase = (this.currentHalfTrack - 2) & 0x03;
    this._syncBit = 0x80;
    // Honor the inserted disk's write-protect (a session attribute on the D64);
    // with write support off, fall back to the legacy always-protected behavior.
    this.writeProtected = !this.gcrDisk ? false
      : this._writeEnabled ? (this.gcrDisk.d64.writeProtected !== false)
      : true;
    this.lastGCRByte = 0x55;
    this._shiftReg = 0;
    this._shiftBits = 0;
    this._inSync = false;
    this._onesInRow = 0;
    this._lastWrittenByte = 0x55;
    this._writeShiftReg = 0;
    this._writeBits = 0;
    this._wasWriting = false;
    this._soPendingCycles = 0;
    this._motorSpinupRemaining = 0;
    this._headSettleRemaining = 0;
    this._lastReportedDataOut = 1;
    this._lastReportedClkOut  = 1;
    // PB5-6 bits for the start track (track 18 → 2 = 28 cy/byte), not zoneForTrack.
    this.currentSpeedZone = speedZoneBitsForTrack(this.currentHalfTrack >> 1);
    this._readyLogged = false;
    
    // Clear IEC bus trackers to prevent stale states across resets
    this.atnIn = 1;
    this.clkIn = 1;
    this.dataIn = 1;
    this.dataOut = 1;
    this.clkOut_pin = 1;
    this._atna_pin = 1;
    this._manualDataOut_pin = 1;

    this._lastDevNum = -1;
    this._traceSteps = 0;
    this._initCpu();
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // Captures the full drive sub-emulator: 6502 CPU, both VIAs, 2K RAM, and
  // the mechanical/GCR + IEC-pin state. The attached disk image (GCRDisk) is
  // re-created by setDisk() (driven by the bundled media) BEFORE deserialize
  // runs; the track stream is reloaded lazily. Callbacks are re-wired by the
  // owning machine via attachDrive().
  serialize() {
    return {
      ram: this.ram.slice(),
      cpu: this.cpu.serialize(),
      via1: this.via1.serialize(),
      via2: this.via2.serialize(),
      totalCycles: this.totalCycles,
      currentHalfTrack: this.currentHalfTrack,
      motorOn: this.motorOn,
      _lastStepperPhase: this._lastStepperPhase,
      currentSpeedZone: this.currentSpeedZone,
      bitCycleAccum: this.bitCycleAccum / 8,   // store whole cycles (÷8) — save-state format unchanged
      lastGCRByte: this.lastGCRByte,
      _shiftReg: this._shiftReg, _shiftBits: this._shiftBits,
      _inSync: this._inSync, _onesInRow: this._onesInRow, _syncBit: this._syncBit,
      writeProtected: this.writeProtected,
      _lastWrittenByte: this._lastWrittenByte,
      _writeShiftReg: this._writeShiftReg, _writeBits: this._writeBits, _wasWriting: this._wasWriting,
      _lastPortBOut: this._lastPortBOut,
      _soPendingCycles: this._soPendingCycles,
      _motorSpinupRemaining: this._motorSpinupRemaining,
      _headSettleRemaining: this._headSettleRemaining,
      atnIn: this.atnIn, clkIn: this.clkIn, dataIn: this.dataIn, dataOut: this.dataOut,
      clkOut_pin: this.clkOut_pin, _atna_pin: this._atna_pin, _manualDataOut_pin: this._manualDataOut_pin,
      _lastReportedDataOut: this._lastReportedDataOut, _lastReportedClkOut: this._lastReportedClkOut,
    };
  }

  deserialize(s) {
    this.ram.set(s.ram);
    this.cpu.deserialize(s.cpu);
    this.via1.deserialize(s.via1);
    this.via2.deserialize(s.via2);
    this.totalCycles = s.totalCycles | 0;
    this.currentHalfTrack = s.currentHalfTrack | 0;
    this.motorOn = !!s.motorOn;
    this._lastStepperPhase = s._lastStepperPhase | 0;
    this.currentSpeedZone = s.currentSpeedZone | 0;
    this.bitCycleAccum = (+s.bitCycleAccum || 0) * 8;   // whole cycles → eighths
    this.lastGCRByte = s.lastGCRByte & 0xFF;
    this._shiftReg = s._shiftReg | 0; this._shiftBits = s._shiftBits | 0;
    this._inSync = !!s._inSync; this._onesInRow = s._onesInRow | 0; this._syncBit = s._syncBit;
    this.writeProtected = !!s.writeProtected;
    this._lastWrittenByte = (s._lastWrittenByte ?? 0x55) & 0xFF;
    this._writeShiftReg = s._writeShiftReg | 0; this._writeBits = s._writeBits | 0;
    this._wasWriting = !!s._wasWriting;
    this._lastPortBOut = s._lastPortBOut & 0xFF;
    this._soPendingCycles = s._soPendingCycles | 0;
    this._motorSpinupRemaining = s._motorSpinupRemaining | 0;
    this._headSettleRemaining = s._headSettleRemaining | 0;
    this.atnIn = s.atnIn; this.clkIn = s.clkIn; this.dataIn = s.dataIn; this.dataOut = s.dataOut;
    this.clkOut_pin = s.clkOut_pin; this._atna_pin = s._atna_pin; this._manualDataOut_pin = s._manualDataOut_pin;
    this._lastReportedDataOut = s._lastReportedDataOut; this._lastReportedClkOut = s._lastReportedClkOut;
    // Force a track-stream reload at the restored half-track; rotational
    // position resyncs on the next SYNC mark (as it does after a head step).
    this.trackDirty = true; this.trackStream = null; this.trackBitPos = 0;
  }

  // ── Spindle / GCR stream ──────────────────────────────────────────────────
  _advanceSpindle(cycles) {
    // Motor halted → cancel any pending byte-ready. The 1541 ROM never
    // relies on SO firing after the spindle stops.
    if (!this.motorOn) this._soPendingCycles = 0;

    // SO delay countdown (gated by DRIVE_SO_DELAY_ENABLED, see header).
    // When byte-ready was scheduled below, fire setOverflow() after the
    // countdown elapses. Real hardware delays SO assertion N cycles after
    // bit-8 boundary to align with the CPU's P1 phase.
    if (DRIVE_SO_DELAY_ENABLED && this._soPendingCycles > 0) {
      this._soPendingCycles -= cycles;
      if (this._soPendingCycles <= 0) {
        this._soPendingCycles = 0;
        this.cpu.setOverflow();
      }
    }

    // Mechanical not-ready windows: while the spindle spins up or the head
    // settles after a step, the disk turns but the read path can't frame
    // valid bytes. Decrement the timers and suppress framing while active
    // (flag-gated; default off — the DOS tolerates instantaneous behavior).
    let readsSuppressed = false;
    if (DRIVE_MOTOR_SPINUP_ENABLED && this._motorSpinupRemaining > 0) {
      this._motorSpinupRemaining -= cycles;
      readsSuppressed = true;
    }
    if (DRIVE_HEAD_SETTLE_ENABLED && this._headSettleRemaining > 0) {
      this._headSettleRemaining -= cycles;
      readsSuppressed = true;
    }

    // Pace in EIGHTHS of a cycle (fixed-point ×8): CYCLES_PER_BYTE/8 is
    // fractional for most zones (26/8 = 3.25 …), and a fractional accumulator
    // poisons this SMI field into a tagged double that boxes a HeapNumber every
    // drive cycle. Multiplying the whole domain by 8 keeps it integer — the ratio,
    // and thus bit pacing, is identical. serialize()/deserialize() convert to and
    // from whole cycles so the save-state format is unchanged.
    this.bitCycleAccum += cycles * 8;
    const cyclesPerBit8 = CYCLES_PER_BYTE[this.currentSpeedZone & 0x03];

    while (this.bitCycleAccum >= cyclesPerBit8) {
      this.bitCycleAccum -= cyclesPerBit8;

      if (!this.motorOn || !this.gcrDisk) {
        this._syncBit = 0x80; // No SYNC when motor is off or no disk
        this._inSync = false;
        this._onesInRow = 0;
        this._shiftReg = 0;
        this._shiftBits = 0;
        continue;
      }
      
      if (this.trackDirty) {
        const oldBits = this.trackStream ? this.trackStream.length * 8 : 0;
        const oldPos = this.trackBitPos;
        this.trackStream = this.gcrDisk.getTrackStream(this.currentHalfTrack >> 1);
        this.trackDirty = false;
        this._shiftReg = 0;
        this._shiftBits = 0;
        this._inSync = false;
        this._onesInRow = 0;
        if (this.trackStream && oldBits > 0) {
          const phase = oldPos / oldBits;
          this.trackBitPos = Math.floor(phase * this.trackStream.length * 8) % (this.trackStream.length * 8);
        } else {
          this.trackBitPos = 0;
        }
      }

      if (this.trackStream) {
        const totalBits = this.trackStream.length * 8;
        const bitPos = this.trackBitPos % totalBits;

        // ── WRITE head ──────────────────────────────────────────────────────
        // When the DOS selects write mode (VIA2 CB2 low + Port A output), the
        // head lays bits DOWN onto the track buffer instead of reading them, and
        // byte-ready free-runs at /8 to pace the CPU's write loop — the exact
        // mirror of the read handshake below. Sync ($FF) and header/data blocks
        // are just the bytes the DOS emits; commitDirtyTracks() later decodes the
        // mutated buffer back into the D64 image.
        if (this._writeEnabled && this._isWriteMode()) {
          if (!this._wasWriting) {
            // Read→write transition: prime the shifter from the latched Port A byte.
            this._wasWriting = true;
            this._writeShiftReg = this._lastWrittenByte;
            this._writeBits = 0;
          }
          const idx = bitPos >> 3;
          const mask = 1 << (7 - (bitPos & 7));
          if ((this._writeShiftReg & 0x80) !== 0) this.trackStream[idx] |= mask;
          else this.trackStream[idx] &= ~mask;
          this._writeShiftReg = (this._writeShiftReg << 1) & 0xFF;
          this.trackBitPos = (bitPos + 1) % totalBits;
          if (++this._writeBits >= 8) {
            this._writeBits = 0;
            // Byte boundary: the surface changed; load the next byte the DOS
            // parked in Port A (it had a full byte-time to set it) and pulse
            // byte-ready (CA1 + SO, SOE-gated) just like a read.
            this.gcrDisk.markTrackDirty(this.currentHalfTrack >> 1);
            this.gcrDisk.d64.dirty = true;
            this._writeShiftReg = this._lastWrittenByte;
            this.via2.triggerIrq(1);
            if ((this.via2.regs[0x0C] & 0x0E) === 0x0E) {
              if (DRIVE_SO_DELAY_ENABLED) this._soPendingCycles = 4;
              else this.cpu.setOverflow();
            }
          }
          // No read framing / SYNC detection while writing.
          this._syncBit = 0x80;
          this._inSync = false;
          this._onesInRow = 0;
          continue;
        }
        this._wasWriting = false;

        const byteVal = this.trackStream[bitPos >> 3];
        const bit = (byteVal >> (7 - (bitPos & 7))) & 1;
        this.trackBitPos = (bitPos + 1) % totalBits;

        // Spin-up / head-settle: the disk keeps turning (bit position advances
        // above) but no valid byte framing or SYNC is produced until stable.
        if (readsSuppressed) {
          this._syncBit = 0x80;
          this._inSync = false;
          this._onesInRow = 0;
          this._shiftReg = 0;
          this._shiftBits = 0;
          continue;
        }

        if (bit) this._onesInRow++;
        else this._onesInRow = 0;

        // Sync is a run of 10+ one bits. While in sync there is no valid
        // byte framing; the first following zero re-establishes byte alignment.
        if (this._inSync) {
          this._syncBit = 0x00;
          if (bit === 1) continue;
          this._inSync = false;
          this._syncBit = 0x80;
          this._shiftReg = 0;
          this._shiftBits = 0;
          this._onesInRow = 0;
        } else if (this._onesInRow >= 10) {
          this._inSync = true;
          this._syncBit = 0x00;
          this._shiftReg = 0;
          this._shiftBits = 0;
          this._dbgSyncBytesSeen++;
          continue;
        } else {
          this._syncBit = 0x80;
        }

        this._shiftReg = ((this._shiftReg << 1) | bit) & 0xFF;
        this._shiftBits++;
        if (this._shiftBits === 8) {
          this.lastGCRByte = this._shiftReg;
          this._shiftBits = 0;
          // BYTE-READY feeds VIA2 CA1 → latches IFR bit 1, INDEPENDENT of SOE
          // ("Die Floppy 1571" §8.2: byte-ready is wired to both CA1 and the
          // SO pin). The DOS read loop polls the SO pin (BVC), but the CA1
          // flag exists for code that reads $1C0D. Reading $1C01 (VIA2 Port A)
          // clears it (handshake). It only raises an IRQ if VIA2 IER bit 1 is enabled.
          this.via2.triggerIrq(1);
          // BYTE-READY reaches the 6502 SO pin only while SOE (Serial Output
          // Enable = VIA2 CA2) is high. CA2 control = PCR bits 1-3; value 111
          // (i.e. PCR & $0E === $0E) drives CA2 high. The 1541 DOS writes
          // PCR=$EE during sector reads (CA2=111) so reads fire byte-ready;
          // seek/gap phases with CA2≠111 suppress it. Per the 1541
          // byte-ready wiring ("Die Floppy 1571" §8.2).
          if ((this.via2.regs[0x0C] & 0x0E) === 0x0E) {
            if (DRIVE_SO_DELAY_ENABLED) {
              // 4 cy fixed: nudges tight fastloader read loops off the
              // pre-delay byte boundary, well below the 18 cy threshold
              // where the next bit-8 would overwrite lastGCRByte.
              this._soPendingCycles = 4;
            } else {
              this.cpu.setOverflow();
            }
          }
        }
      }
    }
  }

  // ── Clock (called from host machine) ──────────────────────────────────────
  // Cycle-accurate: advance the drive CPU one micro-op per master tick, with
  // VIAs and spindle clocked alongside. Fastloaders (NOSDOS, JiffyDOS, Epyx,
  // Vorpal, ...) sample CLK/DATA every 2-4 cycles within a STA $1800; an
  // instruction-atomic drive would put bus updates on the wrong PHI2 edge
  // and the loader would mis-read bits.
  //
  // Order within a cycle: peripherals tick BEFORE the CPU so a GCR-overflow
  // V-flag latch and any VIA timer underflow IRQ that occurred during this
  // cycle are visible to the CPU's micro-op when it samples them. Reversed
  // ordering caused BVS / IRQ-poll loops to miss events by 1 cycle, which
  // looks like a GCR read error and makes the 1541 LED blink during a
  // SEARCHING-then-error.
  clock(cycles) {
    for (let i = 0; i < cycles; i++) {
      this.via1.clock(1);
      this.via2.clock(1);
      if (this.motorOn) this._advanceSpindle(1);
      this.cpu.clock();
      this.totalCycles++;
    }
  }

  get diagnosticStatus() {
    const hasDisk = this.gcrDisk ? 'Y' : 'N';
    const streamLen = this.trackStream ? this.trackStream.length : 0;
    return `atn=${this.atnIn} clk=${this.clkIn} dat=${this.dataIn} [out: clk=${this.clkOut_pin} dat=${this.dataOut}] ATNA=${this._atna_pin} ` +
           `IFR1=$${this.via1.ifr.toString(16)} IER1=$${this.via1.ier.toString(16)} ` +
           `IFR2=$${this.via2.ifr.toString(16)} IER2=$${this.via2.ier.toString(16)} ` +
           `disk=${hasDisk} strm=${streamLen} syncs=${this._dbgSyncBytesSeen} phWr=${this._dbgPhaseWrites} ht=${this.currentHalfTrack}`;
  }

  // ── CPU memory interface ─────────────────────────────────────────────────
  read(addr) {
    if (addr < 0x1800)       return this.ram[addr & 0x07FF];  // 2KB RAM + mirrors
    if (addr < 0x1C00)       return this.via1.read(addr & 0x0F); // VIA1 mirrors
    if (addr < 0x2000)       return this.via2.read(addr & 0x0F); // VIA2 mirrors
    if (addr >= 0xC000)      return this.rom[addr - 0xC000];
    return 0xFF;
  }

  peekForCpu(addr) {
    if (addr < 0x1800)       return this.ram[addr & 0x07FF];
    if (addr < 0x1C00)       return this.via1.peek?.(addr & 0x0F) ?? this.via1.read(addr & 0x0F);
    if (addr < 0x2000)       return this.via2.peek?.(addr & 0x0F) ?? this.via2.read(addr & 0x0F);
    if (addr >= 0xC000)      return this.rom[addr - 0xC000];
    return 0xFF;
  }

  write(addr, val) {
    if (addr < 0x1800) {
      this.ram[addr & 0x07FF] = val;
    } else if (addr < 0x1C00) {
      this.via1.write(addr & 0x0F, val);
    } else if (addr < 0x2000) {
      this.via2.write(addr & 0x0F, val);
    }
  }
}
