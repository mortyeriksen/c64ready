// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/machine.js – C64 machine orchestrator
// Wires CPU, CIA1, CIA2, VIC-II, Memory together.
// Main loop runs one PAL frame worth of cycles per call (called from rAF).
// SID register writes are forwarded to the audio worklet via a SharedArrayBuffer ring buffer.

import { CPU } from './cpu.js';
import { CIA } from './cia.js';
import { VIC2, CYCLES_PER_FRAME, CANVAS_W, CANVAS_H } from './vic2.js';
import { Memory } from './memory.js';
import { Drive1541, IDLE_WAKE_NONE } from './drive1541.js';
import { Datasette } from './datasette.js';
import { REU, REU_DEFAULT_MODEL } from './reu.js';
import { parseCRT } from './crt.js';
import { createCartridgeFromCRT } from './cartridges/registry.js';
import { makeVoiceTrio, computeSyncPulses } from './sid-voice.js';
import { switchOn } from './switches.js';

// SharedArrayBuffer ring buffer layout:
// SharedArrayBuffer layout (Int32-indexed):
//   [0]   = write index (ring)
//   [1]   = read index (ring)
//   [2]   = OSC3 byte (worklet → main; updated each audio block)
//   [3]   = ENV3 byte (worklet → main; updated each audio block)
//   bytes 16+ = ring entries: 8 bytes each [cycle:u32, packed:u32(reg|val<<8)]
const RING_CAPACITY = 131072; // must be power of 2
const SID_EVENT_SIZE = 8;
const SHARED_HEADER_BYTES = 16;  // 4 × Int32
const SHARED_BUF_SIZE = SHARED_HEADER_BYTES + RING_CAPACITY * SID_EVENT_SIZE;

// A C64 CIA port pin as an IEC line level (0 = high/released, 1 = low/asserted).
// Open-collector 7406: an output-low pin (DDR bit set, latch bit clear) — or an
// input pin (DDR bit clear) whose pull-up leaves the inverter input high —
// pulls the line low. Module-scope so _syncIecBus (the hottest IEC call, ~2.4k×
// per frame mid serial-load) allocates no per-call closure.
function c64IecLineLow(portA, ddr, bit) {
  const pinHigh = (ddr & bit) ? ((portA & bit) !== 0) : true;
  return pinHigh ? 0 : 1;
}

// 1541 drive-CPU cycles per C64 master cycle, 16.16 fixed point. True PAL
// ratio = drive 1 MHz (16 MHz crystal / 16) against C64 phi2 985248 Hz;
// the constant is floor(65536 * 1e6 / 985248).
const DRIVE_CLOCK_FACTOR_TRUE = Math.floor(65536 * 1000000 / 985248); // 66517
const DRIVE_CLOCK_FACTOR_1TO1 = 65536; // legacy lockstep: exactly 1 per cycle

// Master cycles the IEC bus must stay quiet before drive idle-skip may ENGAGE
// (waking stays instant). Spindle command bits arrive every ~26-40 cycles, so
// this keeps the skip out of in-flight C64→drive exchanges; real idle periods
// are millions of cycles, so the perf win is untouched. 256 ≈ 0.26 ms.
// See canIdleSkip() (The Ghost flip deadlock).
const IEC_IDLE_ENGAGE_QUIET = 256;

// SID write forwarder (the "sid" object seen by Memory).
// Reads:
//   $D419 / $D41A → paddle X/Y (from main thread's mouse-position tracker)
//   $D41B / $D41C → OSC3 / ENV3 (from worklet, via shared buffer)
//   other          → last value written (= SID register shadow on the
//                    C64 data bus; close enough for most demo tricks)
class SIDProxy {
  constructor(machine) {
    this.machine = machine;
    this.regs = new Uint8Array(0x20);
    // SID data-bus value. Reading a write-only register returns the last
    // byte that crossed the SID's data bus — the last write to ANY register,
    // or the value returned by a readable-register read — and that value
    // fades to 0 after a model-dependent TTL (reSID sid.cc, measured on
    // real chips via bitfade/delayfrq0.prg: 6581 ≈ $1D00 cycles, 8580 ≈
    // $A2000). Modeled lazily: stamp bus activity with sidCycleCounter and
    // compare on read — no per-cycle cost. `regs[]` stays as the current
    // register-value record (save-state / debugging), but CPU
    // reads of write-only registers no longer serve from it.
    this.busValue = 0;
    this.busValueCycle = 0;
  }
  _setBus(val) {
    this.busValue = val & 0xFF;
    this.busValueCycle = this.machine.sidCycleCounter;
    return this.busValue;
  }
  write(reg, val) {
    reg &= 0x1F;
    val &= 0xFF;
    this.regs[reg] = val;
    this._setBus(val);
    this.machine._sidWrite(reg, val);
  }
  read(reg) {
    reg &= 0x1F;
    switch (reg) {
      // POTX/POTY return the LATCHED sample, refreshed every 512 master
      // cycles. The live paddleX/paddleY (set by mouse input) feeds
      // into the sample-and-hold in _runMasterCycle. Readable-register
      // reads also load the returned byte onto the SID data bus.
      // With nothing on the pot lines they float high and read $FF — that is
      // how software detects "no paddle present" (the Final Cartridge 3 mouse
      // probe and VICE's paddle testprog both rely on it). Only report a
      // position when a pot-using device is actually selected on a port.
      case 0x19: { // POTX
        const ov = this.machine.potXOverride;
        if (ov !== null) return this._setBus(ov & 0xFF);
        return this._setBus(this.machine.potConnected ? this.machine.potXSampled : 0xFF);
      }
      case 0x1A: return this._setBus(this.machine.potConnected ? this.machine.potYSampled : 0xFF); // POTY
      // $D41B / $D41C — voice 3 oscillator + envelope readback. Served
      // from the main-thread "shadow" SID voices which are clocked in
      // lockstep with the CPU, so reads are cycle-exact (vs. the audio
      // worklet's ~3 ms latency that would smear cycle-precise raster
      // tricks like demo RNG loops that read $D41B every few cycles).
      case 0x1B: return this._setBus(this.machine.shadowV3.readOsc3());
      case 0x1C: return this._setBus(this.machine.shadowV3.env3);
      default: {
        // Write-only register: the decaying shared bus value. Reads here
        // do NOT refresh the TTL (reSID sid.cc read()).
        const age = this.machine.sidCycleCounter - this.busValueCycle;
        const ttl = this.machine.sidIs8580 ? 0xA2000 : 0x1D00;
        return (age >= 0 && age < ttl) ? this.busValue : 0;
      }
    }
  }
  reset() {
    this.regs.fill(0);
    this.busValue = 0;
    this.busValueCycle = 0;
    // /RESET pulse reaches the chip itself: registers/envelopes/noise clear
    // in the shadow voices too (they were playing on through resets before),
    // while their phase accumulators survive — reSID reset semantics, same
    // as the worklet chip's 'reset' message path (P9).
    this.machine.shadowV1?.reset?.();
    this.machine.shadowV2?.reset?.();
    this.machine.shadowV3?.reset?.();
  }
}

export class C64Machine {
  constructor() {
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error(
        "SharedArrayBuffer is not available. This is required for SID audio. " +
        "Ensure your server is sending COOP/COEP headers and you are using " +
        "a secure context (http://localhost or https)."
      );
    }
    this.mem = new Memory();
    this._loadTrapPhase = 0;   // see _trapLoad: 0 = load, 1/2 = printing the KERNAL's messages
    this.cpu = new CPU(this.mem);
    this.cia1 = new CIA(1);
    this.cia2 = new CIA(2);
    this.vic2 = new VIC2();

    this.drive1541 = null;
    // Optional second physical 1541, addressed as IEC device 9. Non-null ONLY
    // while the user has switched drive 9 on AND enabled its true-drive
    // emulation; in every other configuration it is null and the entire
    // dual-drive path below is bypassed, so the single-drive timing that the
    // demos/loaders depend on is byte-for-byte unchanged.
    this.drive1541b = null;
    this.truedriveEnabled = true;    // default on (matches the UI); when true, KERNAL load trap is disabled
    this._driveIdleSkipping = false;
    this._driveIdleSkippedPendingCycles = 0;
    this._driveIdleWakeInCycles = IDLE_WAKE_NONE;
    this.tdeIdleSkippedCycles = 0;
    // IEC-bus-quiet hysteresis for idle-skip ENGAGEMENT. Spindle-class loaders
    // bit-bang C64→drive command bytes as $DD02 DDR wiggles ~26-40 cycles
    // apart while the drive change-polls $1800 from a loop that sits inside
    // canIdleSkip()'s fastloader window — if the skip engages between two
    // wiggles (any both-lines-released intermediate state qualifies), the
    // frozen drive CPU misses the state it was about to sample and the
    // command byte decodes corrupted (The Ghost disk A: flip cmd $F1 read as
    // $AB chunk request → track-32 phantom hunt → flip-wait deadlock).
    // Only engage the skip after the bus
    // has been quiet for IEC_IDLE_ENGAGE_QUIET cycles; waking stays instant.
    this._iecBusStableCycles = 0;
    this._lastIecBusAtn = 1;
    this._lastIecBusClk = 1;
    this._lastIecBusData = 1;
    this.datasette = new Datasette();
    this.datasette.flagCallback = (level) => this.cia1.setFlag(level);
    // Optional RAM Expansion Unit — a second bus master. Non-null only while
    // the user has switched one on. _reuBusHold is kept as a plain boolean on
    // the machine rather than reached for through the device, so the master
    // cycle's arbitration test stays a single monomorphic load.
    this.reu = null;
    this._reuBusHold = false;
    this._reuIrqPending = false;
    this.driveCycleAccum = 0;
    this.driveClockFactor = switchOn('driveTrueClockRatio')
      ? DRIVE_CLOCK_FACTOR_TRUE : DRIVE_CLOCK_FACTOR_1TO1;
    this.sidCycleCounter = 0;

    // CIA2 Port A IEC bus wiring
    // Lines are Active Low on the bus (0V = Asserted, 1 = Released/High)
    //
    // Edge-propagation latency ('iecEdgeLatency' in switches.js): drive
    // output pins reach the C64's CIA one master cycle later than the run
    // order already gives (_iecDrvVis*, one stage behind _iecDrvPrev*) —
    // the C64's $DD00 read at cycle S sees drive writes from ≤ S−2. The
    // C64→drive direction stays instant (a blanket delay there corrupts the
    // NOSDOS install stage). Each device sees its OWN pulls instantly.
    // NOSDOS-class 2-bit loaders need the read-side stage: their drive-
    // release-to-last-sample margin runs at exactly +1 cycle here, and the
    // true-ratio phase sweep periodically lands the release one cycle
    // before the sample → received bytes get bit 7/6 read HIGH (GnG /
    // Commando CHECKING corruption). Real hardware's asynchronous-clock
    // input latching carries this margin.
    this.iecEdgeLatency = switchOn('iecEdgeLatency');
    this._iecDrvPrevClk = 1; this._iecDrvPrevData = 1;
    this._iecDrvPrevClk9 = 1; this._iecDrvPrevData9 = 1;
    this._iecDrvVisClk = 1; this._iecDrvVisData = 1;
    this._iecDrvVisClk9 = 1; this._iecDrvVisData9 = 1;

    // Returns the C64-facing bus level PACKED as a small int — bit2 = ATN,
    // bit1 = CLK, bit0 = DATA (1 = released, 0b111 = all released). This is
    // the hottest IEC call (the drive re-syncs on every $1800 poll — every
    // few cycles during fastloader traffic), so it must not allocate; the
    // old `{busAtn, busClk, busData}` literal fed the mobile GC one throw-
    // away object per poll. Only cia2.readPortA consumes the return.
    this._syncIecBus = () => {
      if (!this.drive1541) return 0b111;
      const portA = this.cia2.portA;
      const ddr = this.cia2.portADir;

      // C64 IEC outputs go through open-collector 7406 inverters. If the
      // CIA pin is switched to input, its pull-up leaves the inverter input
      // high, which pulls the IEC line low. Fastloaders such as NOSDOS use
      // DDRA changes directly, so direction bits are part of the line state.
      const c64atn = c64IecLineLow(portA, ddr, 0x08);
      const c64clk = c64IecLineLow(portA, ddr, 0x10);
      const c64Data = c64IecLineLow(portA, ddr, 0x20);

      // Drive internal signals (0 = Pull/0V, 1 = Release)
      const drvClk = this.drive1541.clkOut_pin;
      const drvData = this.drive1541.dataOut;

      // Wired-AND logic: Final bus level is 0 if ANY device pulls it low
      const busAtn = c64atn; // Drives don't pull ATN
      let busClk = (c64clk === 0 || drvClk === 0) ? 0 : 1;
      let busData = (c64Data === 0 || drvData === 0) ? 0 : 1;
      // A second 1541 (device 9), if connected, also pulls the open-collector
      // bus low — fold its CLK/DATA into the wired-AND.
      if (this.drive1541b) {
        if (this.drive1541b.clkOut_pin === 0) busClk = 0;
        if (this.drive1541b.dataOut === 0) busData = 0;
      }

      const busChanged =
        busAtn !== this._lastIecBusAtn ||
        busClk !== this._lastIecBusClk ||
        busData !== this._lastIecBusData;
      this._lastIecBusAtn = busAtn;
      this._lastIecBusClk = busClk;
      this._lastIecBusData = busData;
      if (busChanged) this._iecBusStableCycles = 0;
      if (this._driveIdleSkipping && busChanged) this._wakeDriveIdleSkip();

      // Feed high-fidelity bus state BACK to the drive(s) so they see the reflection
      this.drive1541.setIecLines(busAtn, busClk, busData);
      if (this.drive1541b) this.drive1541b.setIecLines(busAtn, busClk, busData);

      // C64-facing view for readPortA: own pulls live, drive pins through
      // the one-cycle delay stage when the latency switch is on.
      if (this.iecEdgeLatency) {
        let rClk = (c64clk === 0 || this._iecDrvVisClk === 0) ? 0 : 1;
        let rData = (c64Data === 0 || this._iecDrvVisData === 0) ? 0 : 1;
        if (this.drive1541b) {
          if (this._iecDrvVisClk9 === 0) rClk = 0;
          if (this._iecDrvVisData9 === 0) rData = 0;
        }
        return (busAtn << 2) | (rClk << 1) | rData;
      }
      return (busAtn << 2) | (busClk << 1) | busData;
    };

    // Per-master-cycle IEC pipeline step (latency switch ON only): advance
    // the drive-pin delay line the C64's $DD00 reads sample from. The
    // drive-facing bus is untouched — the drive sees C64 edges instantly
    // (legacy semantics) and its own pins instantly.
    this._iecClock = () => {
      const d = this.drive1541;
      this._iecDrvVisClk = this._iecDrvPrevClk;
      this._iecDrvVisData = this._iecDrvPrevData;
      this._iecDrvPrevClk = d.clkOut_pin;
      this._iecDrvPrevData = d.dataOut;
      if (this.drive1541b) {
        this._iecDrvVisClk9 = this._iecDrvPrevClk9;
        this._iecDrvVisData9 = this._iecDrvPrevData9;
        this._iecDrvPrevClk9 = this.drive1541b.clkOut_pin;
        this._iecDrvPrevData9 = this.drive1541b.dataOut;
      }
    };

    this.cia2.writePortA = (val, viaDir = false, oldDdra = 0) => {
      this._syncIecBus();
      const newBank = this.cia2.vicBank;
      // NMOS DDRA-bit-set delay quirk (VIC-Addendum.txt, "Video bank and
      // C64C"). Gated by an opt-in flag — VIC-Addendum.txt says the effect
      // is unstable, so it's not on by default. Only DDRA writes are
      // eligible (viaDir=true), only the PA0/PA1 bits that went 0→1
      // count, and only on the 6569 NMOS variant.
      if (viaDir
          && this.vic2.nmosBankDelay
          && this.vic2.vicVariant === '6569'
          && ((~oldDdra & this.cia2.portADir) & 0x03) !== 0) {
        this.vic2.noteBankChange(newBank, /*delay=*/ 1);
      } else {
        this.vic2.noteBankChange(newBank);
      }
    };

    this.cia2.readPortA = () => {
      // CIA port read: for OUTPUT bits (DDR=1), return the output register
      // value (the last byte the CPU wrote). For INPUT bits (DDR=0), return
      // the external pin state.
      //
      // PA3/PA4/PA5 are ATN/CLK/DATA OUT (outputs). PA6/PA7 are CLK/DATA IN
      // (always inputs, tied to the bus). Returning the bus level for the
      // OUT bits breaks KERNAL read-modify-write idioms like $EE97
      // (`LDA $DD00 / AND #$DF / STA $DD00` to release DATA): when the bus
      // transiently reads high, the RMW would latch bit 5 back to 1 and
      // accidentally pull DATA.
      const bus = this._syncIecBus();   // packed: bit1 = CLK, bit0 = DATA
      const busClk = (bus >> 1) & 1;
      const busData = bus & 1;
      const portA = this.cia2.portA;
      const ddr = this.cia2.portADir;

      // Pin states for inputs (bit 6 CLK IN, bit 7 DATA IN). Other input
      // bits default to high (no pull).
      let pins = 0xFF;
      if (busClk === 0) pins &= ~0x40;
      if (busData === 0) pins &= ~0x80;

      return (portA & ddr) | (pins & ~ddr);
    };

    // Wire chips into memory map
    this.mem.vic2 = this.vic2;
    this.mem.cia1 = this.cia1;
    this.mem.cia2 = this.cia2;
    this.mem.sid = new SIDProxy(this);
    this.mem.machine = this; // for joystick read-back

    // Wire VIC-II to RAM / color RAM / char ROM / CIA2
    this.vic2.ram = this.mem.ram;
    this.vic2.colorRam = this.mem.colorRam;
    this.vic2.cia2 = this.cia2;
    this.vic2.cpu = this.cpu;
    // Back-ref so VIC chip-bus fetches can update the shared external bus
    // latch in Memory (open-bus reads at $DE00-$DFFF and Color-RAM upper
    // nybble sample it). Bare VIC2 instances in tests leave this null.
    this.vic2.memory = this.mem;
    this.vic2.noteBankChange(this.cia2.vicBank);
    // Diagnostic only: forward CPU interrupt-acceptance events to the VIC's
    // frame trace so (assert→accept) latency is observable per-IRQ.
    this.cpu.onInterruptAccept = (kind) => this.vic2.noteInterruptAccepted(kind);

    // NMI edge tracking
    this.prevNmiLevel = false;
    this.driveCycleAccum = 0;

    // Joystick port 2 (active-low byte, bits 0-4: up/down/left/right/fire)
    this.joyPort2 = 0xFF;
    // Joystick port 1 (active-low)
    this.joyPort1 = 0xFF;

    // Lightpen line wiring. The LP input of the VIC (Bauer §3.11) is the same
    // electrical node as CIA1 Port B bit 4 and the FIRE line of joystick port
    // 1 — toggling that CIA bit (as output) drives the lightpen pin, which is
    // exactly how the "stable raster via lightpen" trick works (read $D013 to
    // recover the IRQ-entry jitter). The node is pulled high and reads low if
    // EITHER the CIA drives it low (PB4 = output, value 0) OR joystick-1 FIRE
    // is pressed. Recomputed on every CIA1 Port-B / DDRB write.
    this._updateLightpen = () => {
      const ddr = this.cia1.portBDir;
      const out = this.cia1.portB;
      const ciaPin4High = (ddr & 0x10) ? ((out & 0x10) !== 0) : true;
      const joyFireLow = (this.joyPort1 & 0x10) === 0;
      this.vic2.setLightpenLevel(ciaPin4High && !joyFireLow ? 1 : 0);
    };
    this.cia1.writePortB = () => this._updateLightpen();

    // SharedArrayBuffer for SID audio worklet.
    //   sidCtrl[0] = writeIdx, [1] = readIdx, [2] = OSC3 (unused), [3] = ENV3 (unused).
    //   sidRing32  = ring entries starting at SHARED_HEADER_BYTES.
    this.sidShared = new SharedArrayBuffer(SHARED_BUF_SIZE);
    this.sidCtrl = new Int32Array(this.sidShared, 0, 4);
    this.sidRing32 = new Uint32Array(this.sidShared, SHARED_HEADER_BYTES);

    // Shadow SID voices on the main thread. Same SIDVoice code the
    // worklet uses, clocked in lockstep with the CPU via _runMasterCycle.
    // Purpose: cycle-exact $D41B (OSC3) and $D41C (ENV3) readback for
    // demos that poll voice 3 in tight loops (RNG via NOISE waveform,
    // sample-trigger envelope tracking, raster-sync tricks). The worklet
    // can't serve these reads with sub-block latency, so we duplicate
    // just the oscillator + envelope here. No filter, no mixing, no
    // tanh — those are audio-only concerns the main thread never reads.
    const [sv1, sv2, sv3] = makeVoiceTrio();
    this.shadowV1 = sv1; this.shadowV2 = sv2; this.shadowV3 = sv3;
    this.shadowVoices = [sv1, sv2, sv3];
    // SID model (false = 6581, true = 8580). The shadow voices serve
    // $D41B/$D41C (OSC3/ENV3) reads, and the combined-waveform / pulse-zero
    // output differs between the two chips — that difference is exactly how
    // demos detect the model (e.g. lft's "Lunatico" gates on OSC3). Kept in
    // sync with the audio worklet via main.js's setSidModel() calls.
    // Default 8580 (HMOS-II, the C64C SID) — matches the UI default (main.js)
    // and what most modern demos expect; a 6581 default tripped the "old SID
    // detected" prompt in 8580-targeted demos. Use setSidModel(false) for 6581.
    this.sidIs8580 = true;
    for (const v of this.shadowVoices) v.is8580 = this.sidIs8580;   // shadow voices default 6581; match the model

    // Paddle / mouse X+Y as seen by SID $D419 / $D41A. Default to mid-
    // range (~$80) so paddle reads return a sensible value before any
    // mouse input. main.js updates these on canvas mousemove.
    //
    // Sample-and-hold: real SID samples the POTX/POTY pins once every
    // 512 master cycles via an internal 8-bit successive-approximation
    // ADC that times the RC charge of the paddle capacitor (per the MOS
    // 6581 datasheet's POT interface description). Software
    // reading $D419/$D41A always sees the *latched* sample, not the
    // live pin voltage. We model the 512-cycle latching here; the
    // mouse-driven paddleX / paddleY get sampled into potXSampled /
    // potYSampled in _runMasterCycle. Games like Arkanoid that poll
    // POTX in a tight loop now see the same byte for up to 512 cycles
    // instead of seeing live mouse position on every read.
    this.paddleX = 0x80;
    this.paddleY = 0x80;
    this.potXSampled = 0x80;
    this.potYSampled = 0x80;
    this.potSampleCounter = 0;
    // Is anything actually wired to the POT pins? False means $D419/$D41A read
    // $FF (open lines), which is what real hardware and VICE report and what
    // paddle-detection routines look for. input.js sets this every frame from
    // the selected control-port devices — only the paddle and the 1351, the
    // two that verifiably read a position off these pins. Headless callers
    // that want paddle reads must set this themselves.
    this.potConnected = false;
    // The NEOS mouse does not report a position on the pot pins — it wires its
    // RIGHT BUTTON to POTX (pin 9) and leaves POTY open. Both reference
    // drivers in VICE's testprogs (mouse/neos/mousecheese.s, marked "literal
    // reference - DONT CHANGE", and mouse/neos/krakout.s) test it as
    // `lda $D419 / cmp #$FF`, taking carry set — i.e. exactly $FF — to mean
    // pressed. So this is a whole-byte override, not a bit: $FF pressed,
    // non-$FF released. null = nothing overriding POTX.
    this.potXOverride = null;

    this.currentD64 = null;

    // Secondary disk drive, addressed as IEC device 9. It is a trap-backed
    // drive (the $FFD5 KERNAL LOAD trap serves its D64 directly) — it has no
    // Drive1541 CPU on the bus, so it stays completely absent until the user
    // switches it on. While `drive9Enabled` is false the trap never routes to
    // it, so `LOAD…,9` returns DEVICE NOT PRESENT, exactly as if no drive 9
    // were connected.
    this.drive9Enabled = false;
    this.currentD64Drive9 = null;

    this.ready = false;

    // External hook: fired whenever the KERNAL load trap runs (trap mode).
    // Used by main.js to play a simulated disk-drive sound effect.
    this.onLoadTrap = null;

    // Per-cycle bus trace (open-bus debug). Default OFF — allocates one
    // small record per master cycle when enabled, used by spec tests to
    // assert phi1/phi2 owner, BA/AEC/RDY state, CPU op kind, and the
    // external/internal bus latches. Enable via enableBusTrace(depth);
    // read back with busTraceSnapshot().
    this.busTraceEnabled = false;
    this.busTraceDepth = 0;
    this.busTraceRing = null;
    this.busTraceHead = 0;
    this.busTraceCount = 0;
    this.busTraceFrame = 0;

    // Per-source interrupt delay pipeline.
    // VIC raster IRQ: 1 machine stage (sweet spot for Nine + raster_time_gp).
    // CIA1 IRQ:       1 machine stage. The chip-internal ICR data→IR latch in
    //   cia.js (datasheet sheet 7) supplies the cycle that used to be modelled
    //   here as a 2nd machine stage, so net IRQ latency is unchanged but the
    //   6526 interrupt-acknowledge bug now behaves correctly (cia1.prg).
    // CIA2 NMI:       1 machine stage. The CPU recognises NMI from its edge FF
    //   without the IRQ line's sampledIrq cycle, so adding a compensating extra
    //   stage makes CIA2 NMI one cycle too late for code that executes the
    //   live CIA timer registers as opcodes.
    // Separate VIC/CIA pending flags so the per-source delay is independent.
    this.cia1.irqHandler = () => { this._cpuCiaIrqPending = this.cia1.irqState; };
    this.vic2.irqHandler = () => {
      const pending = this.vic2.irqPending;
      if (pending && !this._cpuVicIrqPending) {
        // Late-tag fires only for assertions during the 'cpu' master phase
        // (= CPU writes to $d011/$d012/$d01a/$d019 that re-evaluate the
        // compare). Natural raster IRQ fires in the VIC's cycle-1 access
        // window ('vic' phase, Bauer §3.12) and is NOT late.
        this._cpuVicIrqPendingLate = (this._masterPhase === 'cpu');
      }
      if (!pending) this._cpuVicIrqPendingLate = false;
      this._cpuVicIrqPending = pending;
    };
    this.cia2.irqHandler = () => this._setNmiSource('cia2', this.cia2.irqState);
    this._cpuVicIrqPending = false;     // VIC source — 1 machine stage
    this._cpuVicIrqPendingLate = false; // first CPU-visible cycle of a VIC IRQ
    this._cpuVicIrqPrev = false;        // last cycle's VIC pending (deassert-hold)
    this._cpuCiaIrqPending = false;     // CIA source — 1 machine stage (+ in-CIA latch)
    this._nmiSources = { cia2: false, restore: false, cartridge: false };
    this._cpuNmiPending = false;        // combined physical /NMI assertion
    this._cpuNmiEdgeSeen = false;       // sticky deasserted→asserted edge
    this.mem.cartNmiHandler = asserted => this._setNmiSource('cartridge', asserted);
  }

  _updateC64Irq() {
    // Sync force-update: bypass pipeline staging for test/setup paths.
    const cia = this.cia1.irqState, vic = this.vic2.irqPending;
    const state = cia || vic || this._reuIrqPending;
    this.cpu.setIrqLine(state);
    this._cpuVicIrqPending = vic;
    this._cpuVicIrqPendingLate = false;
    this._cpuCiaIrqPending = cia;
  }

  _setNmiSource(source, asserted) {
    asserted = !!asserted;
    if (this._nmiSources[source] === asserted) return;
    this._nmiSources[source] = asserted;
    const combined = this._nmiSources.cia2 ||
      this._nmiSources.restore ||
      this._nmiSources.cartridge;
    // The expansion-port and CIA sources are wired onto one physical pin.
    // A second source asserting while the pin is already low is not a new NMI.
    if (combined && !this._cpuNmiPending) this._cpuNmiEdgeSeen = true;
    this._cpuNmiPending = combined;
  }

  setRestoreNmiLine(asserted) {
    this._setNmiSource('restore', asserted);
  }

  _sampleCpuInterrupts() {
    // VIC: 1 machine stage (pending → cpu directly).
    // CIA: 1 machine stage (pending → cpu); the in-CIA data→IR latch supplies
    //      the other cycle of delay. Combined cpu.irqLine = CIA OR VIC.
    const ciaToCpu = this._cpuCiaIrqPending;
    // VIC IRQ deassertion is held one machine cycle, mirroring the one-cycle
    // assertion latency (the VIC's cycle-1 raster compare lands after this
    // sample, so an assertion is felt next cycle). Without the symmetric hold,
    // a $D019 ack that clears the IRQ on the very cycle the CPU performs its
    // penultimate-cycle interrupt poll retracts the IRQ before the poll sees
    // it — so an IRQ raised then acked by the same RMW (ASL/INC $D019) is lost.
    // Real 6569+6510 still deliver it (verified vs VICE on the hat raster-wall:
    // the raster-0 sprite-setup IRQ is taken even when the raster-18 handler's
    // ASL $D019 exit acks it). The tail is one cycle, far shorter than any
    // ack→RTI gap, so it can't re-trigger a normally-serviced handler.
    const vicNow = this._cpuVicIrqPending;
    const vicToCpu = vicNow || this._cpuVicIrqPrev;
    this._cpuVicIrqPrev = vicNow;
    // The REU's /IRQ is a plain level from the expansion port — no staging and
    // no late semantics, so it only ever adds to the line.
    const reuToCpu = this._reuIrqPending;
    const lateVicOnly = vicToCpu && !ciaToCpu && !reuToCpu && this._cpuVicIrqPendingLate;
    this.cpu.setIrqLine(ciaToCpu || vicToCpu || reuToCpu, lateVicOnly);
    if (vicToCpu) this._cpuVicIrqPendingLate = false;

    // NMI is edge-triggered. Present the sticky combined assertion edge for one
    // CPU-visible cycle; source levels stay separate so only a fully released
    // pin followed by a new assertion can create another edge.
    this.cpu.setNmiLine(this._cpuNmiEdgeSeen);
    this._cpuNmiEdgeSeen = false;
  }

  // Enable the per-cycle bus trace. depth must be a power of 2 (or any
  // positive integer; ring buffer wraps). Use only for debugging — adds
  // one object allocation per master cycle (~985 KHz), so disable in
  // performance-sensitive runs.
  enableBusTrace(depth = 1024) {
    this.busTraceDepth = Math.max(16, depth | 0);
    this.busTraceRing = new Array(this.busTraceDepth);
    this.busTraceHead = 0;
    this.busTraceCount = 0;
    this.busTraceEnabled = true;
  }

  disableBusTrace() {
    this.busTraceEnabled = false;
    this.busTraceRing = null;
    this.busTraceHead = 0;
    this.busTraceCount = 0;
  }

  // Return the most-recent n entries from the bus trace in chronological
  // order (oldest first). n defaults to the full ring depth. Each entry
  // captures the latched state at the END of the master cycle.
  busTraceSnapshot(n) {
    if (!this.busTraceEnabled || !this.busTraceRing) return [];
    const total = Math.min(this.busTraceCount, this.busTraceDepth);
    const take = Math.min(total, n ?? total);
    const out = new Array(take);
    let idx = (this.busTraceHead - take + this.busTraceDepth) % this.busTraceDepth;
    for (let i = 0; i < take; i++) {
      out[i] = this.busTraceRing[idx];
      idx = (idx + 1) % this.busTraceDepth;
    }
    return out;
  }

  // Snapshot the live bus state at this point in the master cycle. baLow /
  // aecLowPhi2 / cpuBlocked / cpuOp / reuHeld are passed in because they're
  // already computed in _runMasterCycle — reuHeld in particular is sampled
  // before the transfer's final cycle releases it. Cheap object allocation
  // (one per cycle when enabled, none otherwise).
  _recordBusTrace(baLow, aecLowPhi2, cpuBlocked, cpuOpKind, reuHeld) {
    const entry = {
      frame: this.busTraceFrame,
      raster: this.vic2.raster,
      cycle: this.vic2.cycleInLine,
      ba: !!baLow,
      aec: !aecLowPhi2,            // AEC high (true) means CPU may drive
      rdy: !(baLow && cpuOpKind !== 'write'),
      cpuBlocked: !!cpuBlocked,
      cpuOp: cpuBlocked ? 'stalled' : cpuOpKind,
      phi2Owner: cpuBlocked
        ? (aecLowPhi2 ? 'vic' : (reuHeld ? 'reu' : 'none'))
        : 'cpu',
      externalDataBus8: this.mem.externalDataBus8 & 0xFF,
      vicInternalBus8: this.vic2.vicInternalBus & 0xFF,
    };
    this.busTraceRing[this.busTraceHead] = entry;
    this.busTraceHead = (this.busTraceHead + 1) % this.busTraceDepth;
    if (this.busTraceCount < this.busTraceDepth) this.busTraceCount++;
  }

  _wakeDriveIdleSkip() {
    if (this._driveIdleSkippedPendingCycles > 0 && this.drive1541) {
      this.drive1541.settleIdleCycles(this._driveIdleSkippedPendingCycles);
    }
    this._driveIdleSkippedPendingCycles = 0;
    this._driveIdleWakeInCycles = IDLE_WAKE_NONE;
    this._driveIdleSkipping = false;
  }

  // steps = drive cycles owed this master cycle (1, sometimes 2 under the
  // true-ratio clock). The pending settle count and the wake countdown are
  // both in DRIVE cycles (idleSkipWakeCycles reads VIA timer counters), so
  // they advance by steps, not per master cycle.
  _skipDriveIdleCycle(steps) {
    this._driveIdleSkipping = true;
    this.tdeIdleSkippedCycles++;
    this._driveIdleSkippedPendingCycles += steps;
    this.drive1541.deferIdleCycle(steps);
    if (this._driveIdleWakeInCycles < IDLE_WAKE_NONE) {
      this._driveIdleWakeInCycles -= steps;
      if (this._driveIdleWakeInCycles <= 0) {
        this._wakeDriveIdleSkip();
      }
    }
  }

  // Load ROM data
  loadROMs({ kernal, basic, charRom }) {
    this.mem.kernal = kernal;
    this.mem.basic = basic;
    this.mem.charRom = charRom;
    this.vic2.charRom = charRom;
    this.reset();
    this.ready = true;
  }

  // Select the emulated SID model on the main-thread shadow voices.
  // false = 6581 (original NMOS), true = 8580 (HMOS-II). Must be kept in
  // sync with the audio worklet (main.js posts a `model` message there).
  // Survives reset() — the shadow voices are never recreated — so the
  // model only changes when the user toggles it.
  setSidModel(is8580) {
    this.sidIs8580 = !!is8580;
    for (const v of this.shadowVoices) v.is8580 = this.sidIs8580;
  }

  // Inject a PRG into RAM and leave the same zero-page / CPU state a real
  // KERNAL `LOAD "...",8,1` would. Demos read $00AE/$AF, $0090, $00BA, and
  // VARTAB/ARYTAB/STREND during init; populating them avoids the prg
  // taking an "error" code path that breaks sprite multiplexing.
  loadPRG(data) {
    if (data.length < 2) return;
    const loadAddr = data[0] | (data[1] << 8);
    for (let i = 2; i < data.length; i++) {
      this.mem.ram[loadAddr + i - 2] = data[i];
    }
    const endAddr = loadAddr + data.length - 2;
    this.mem.ram[0x002D] = endAddr & 0xFF;
    this.mem.ram[0x002E] = (endAddr >> 8) & 0xFF;
    this.mem.ram[0x002F] = endAddr & 0xFF;
    this.mem.ram[0x0030] = (endAddr >> 8) & 0xFF;
    this.mem.ram[0x0031] = endAddr & 0xFF;
    this.mem.ram[0x0032] = (endAddr >> 8) & 0xFF;
    this.mem.ram[0x00AE] = endAddr & 0xFF;
    this.mem.ram[0x00AF] = (endAddr >> 8) & 0xFF;
    this.mem.ram[0x0090] = 0;
    this.mem.ram[0x00BA] = 8;
    this.cpu.C = 0;
    this.cpu.a = 0;
    this.cpu.x = endAddr & 0xFF;
    this.cpu.y = (endAddr >> 8) & 0xFF;
    return loadAddr;
  }

  // Parse the CRT container, then let the hardware-type registry construct
  // the expansion-port device that owns its banking and I/O behavior.
  loadCartridge(crtBytes) {
    const cart = parseCRT(crtBytes);
    const device = createCartridgeFromCRT(cart);
    this.mem.installCartridge(device);
    this.reset();
    return {
      name: cart.name,
      mode: device.id === 'generic' ? device.mode : device.id,
      hwType: device.hwType,
      hasReset: device.capabilities.reset,
      hasFreeze: device.capabilities.freeze,
    };
  }

  setCartridgeFreeze(held) {
    return this.mem.setCartridgeFreeze(held);
  }

  resetCartridge() {
    if (!this.mem.resetCartridgeControl()) return false;
    this.mem.softReset();
    this._resetChips();
    return true;
  }

  ejectCartridge() {
    this.mem.setCartridge({ mode: 'none' });
    this.reset();
  }

  // Inject a SYS command into the keyboard buffer to auto-run
  injectSys(addr) {
    const cmd = `SYS${addr}\r`;
    for (let i = 0; i < cmd.length; i++) {
      this.mem.ram[0x0277 + i] = cmd.charCodeAt(i);
    }
    this.mem.ram[0x00C6] = cmd.length; // keyboard buffer count
  }

  // Inject RUN command into the keyboard buffer
  injectRun() {
    const cmd = 'RUN\r';
    for (let i = 0; i < cmd.length; i++) {
      this.mem.ram[0x0277 + i] = cmd.charCodeAt(i);
    }
    this.mem.ram[0x00C6] = cmd.length;
  }

  // Inject LOAD"*",8,1 and arm a deferred RUN. The C64 keyboard buffer is
  // only 10 bytes; LOAD"*",8,1\r is 12, so RUN can't be queued alongside.
  // `_pendingAutoRun` is consumed by `_trapLoad` (TDE off path) which types
  // RUN\r once LOAD completes. TDE-on path is not wired here.
  injectLoadAndRun() {
    const cmd = 'LOAD"*",8,1\r';
    for (let i = 0; i < cmd.length; i++) {
      this.mem.ram[0x0277 + i] = cmd.charCodeAt(i);
    }
    this.mem.ram[0x00C6] = cmd.length;
    this._pendingAutoRun = true;
  }

  // Append as much text as possible to the C64 keyboard buffer and return
  // the number of characters accepted. The KERNAL buffer is 10 bytes long.
  bufferKeyboardText(text) {
    const currentCount = this.mem.ram[0x00C6] & 0xFF;
    const available = Math.max(0, 10 - currentCount);
    const accepted = Math.min(available, text.length);
    for (let i = 0; i < accepted; i++) {
      this.mem.ram[0x0277 + currentCount + i] = text.charCodeAt(i) & 0xFF;
    }
    this.mem.ram[0x00C6] = currentCount + accepted;
    return accepted;
  }

  // Internal helper: reset all chip state + machine-level flags that
  // /RESET line on real hardware affects. Both softReset() (= /RESET
  // pulse, RAM preserved) and reset() (= cold boot, full RAM init)
  // call this AFTER doing their respective Memory reset.
  _resetChips() {
    this.cia1.reset();
    this.cia2.reset();
    this.vic2.reset();
    this.mem.sid?.reset?.();
    this.prevNmiLevel = false;
    this.driveCycleAccum = 0;
    this.sidCycleCounter = 0;
    this._cpuVicIrqPending = false;
    this._cpuVicIrqPendingLate = false;
    this._cpuVicIrqPrev = false;
    this._cpuCiaIrqPending = false;
    // The REU's own /RESET handling runs in mem.softReset(); this drops the
    // machine-side latch the register file no longer backs.
    this._reuIrqPending = false;
    this._reuBusHold = false;
    this._nmiSources.cia2 = false;
    this._nmiSources.restore = false;
    // An FC3 reset holds /NMI low at the same time as /RESET. That existing
    // level must not become a fresh edge when the CPU leaves reset; the cart's
    // startup code releases it by writing bit 6 at $DFFF.
    this._nmiSources.cartridge = !!this.mem.cartNmiAsserted;
    this._cpuNmiPending = this._nmiSources.cartridge;
    this._cpuNmiEdgeSeen = false;
    this._wakeDriveIdleSkip();
    // Clear stateful caches that should not survive a /RESET pulse.
    this._lastIecBusAtn = 1;
    this._lastIecBusClk = 1;
    this._lastIecBusData = 1;
    // IEC edge-latency pipeline stages → all lines released.
    this._iecDrvPrevClk = 1; this._iecDrvPrevData = 1;
    this._iecDrvPrevClk9 = 1; this._iecDrvPrevData9 = 1;
    this._iecDrvVisClk = 1; this._iecDrvVisData = 1;
    this._iecDrvVisClk9 = 1; this._iecDrvVisData9 = 1;
    this.tdeIdleSkippedCycles = 0;
    this._pendingAutoRun = false;
    // Joystick input bytes (active-low). main.js refreshes from key /
    // gamepad state per frame, but a reset while a joystick is held
    // should not leave a stale "pressed" byte on the port.
    this.joyPort1 = 0xFF;
    this.joyPort2 = 0xFF;

    this.datasette.reset();
    this._resetSidAudioQueue();

    // 1541 needs a fresh CPU/VIA state so its DOS ROM boots into its idle loop
    if (this.drive1541) {
      this.drive1541.reset();
      if (this.drive1541b) this.drive1541b.reset();
      this._syncIecBus(); // Force bus state to Released (1,1,1) on boot
    }

    // Bring CPU out of reset (fetches reset vector at $FFFC)
    this.cpu.reset();

    // Ensure charset at $6800 is initialized (VIC Bank 1 default)
    // Many games running in Bank 1 copy the Char ROM here. We pre-init
    // it to match a common "booted" state or to help software with
    // tight timing.
    if (this.mem.charRom) {
      for (let i = 0; i < 4096; i++) {
        this.mem.ram[0x6800 + i] = this.mem.charRom[i];
      }
    }
  }

  _resetSidAudioQueue() {
    if (!this.sidCtrl) return;
    // Clear the worklet's OSC3/ENV3 publish slots [2]/[3] (a debug-only tap;
    // $D41B/$D41C reads are served by the shadow voices, not these slots). Do
    // NOT touch the ring indices or sidCycleCounter — both are free-running
    // counters synchronized with the worklet's clock. Resetting only one side
    // broke audio-rate SID write timing for several seconds (see the worklet's
    // 'reset' handler comment).
    Atomics.store(this.sidCtrl, 2, 0);
    Atomics.store(this.sidCtrl, 3, 0);
  }

  // /RESET line pulse — runtime reset. RAM is preserved (real hardware
  // /RESET doesn't touch DRAM contents; the KERNAL boot does software-
  // level RAM init for screen + zero-page pointers via $FFFC vector).
  // EasyFlash registers + cart RAM reset per real hardware.
  // Pass allowSoft:true to opt in; the UI reset button uses reset() instead.
  softReset({ allowSoft = false } = {}) {
    if (!allowSoft) throw new Error('softReset() requires allowSoft:true — use reset() for a power cycle');
    this.mem.softReset();
    this._resetChips();
  }

  // Cold-boot reset — full power-up. DRAM regenerated with VICE-style
  // init pattern, then /RESET-line semantics applied on top. Used by
  // loadROMs() and tests that need a clean RAM baseline.
  reset() {
    this.mem.reset();
    this._resetChips();
    // Power cycle re-seeds the SID phase accumulators with the $555555
    // power-up pattern. (_resetChips applies /RESET-pulse semantics, under
    // which the accumulators survive — correct for softReset(), but a cold
    // boot loses them. The shadow voices are never recreated, so do it
    // here; the worklet chip gets the same via main.js's 'init' message.)
    for (const v of [this.shadowV1, this.shadowV2, this.shadowV3]) {
      if (v) { v.phase = 0x555555; v.prevPhase = 0x555555; }
    }
  }

  // Which disk image (if any) the $FFD5 LOAD trap should serve right now,
  // keyed off the KERNAL current-device number ($BA). Device 8 is trap-served
  // only when TDE is off (otherwise the real 1541 on the bus handles it);
  // device 9 is the trap-backed secondary drive and is served whenever it is
  // switched on, regardless of drive 8's TDE state. Returns null (no trap)
  // when the addressed drive is absent or empty.
  _loadTrapDisk() {
    const dev = this.mem.ram[0xBA];
    if (dev === 8 && !this.truedriveEnabled) return this.currentD64;
    // Device 9 is trap-served only while its own true-drive emulation is off
    // (no real drive 9 on the bus). With drive1541b connected, the real drive
    // answers the serial protocol instead — exactly like drive 8 under TDE.
    if (dev === 9 && this.drive9Enabled && !this.drive1541b) return this.currentD64Drive9;
    return null;
  }

  // Do the ROM's message routines actually live where we are about to jump?
  // $F5AF opens `LDA MSGFLG` and $F5D2 opens `LDY #$49`. A replacement or stub
  // KERNAL that has something else there gets the silent load instead of a jump
  // into whatever happens to sit at that address.
  _kernalPrintsLoadMessages() {
    const rom = this.mem._kernal;
    if (!rom || rom.length < 0x2000) return false;
    return rom[0xF5AF - 0xE000] === 0xA5 && rom[0xF5B0 - 0xE000] === 0x9D
        && rom[0xF5D2 - 0xE000] === 0xA0 && rom[0xF5D3 - 0xE000] === 0x49;
  }

  // JSR into the KERNAL and come back here: RTS pops this and adds one, so the
  // trap runs again once the routine has finished.
  _callFromTrap(addr) {
    this.cpu._push(0xFF);
    this.cpu._push(0xD4);          // -> returns to $FFD5
    this.cpu.pc = addr;
  }

  _trapLoad(disk) {
    // Before fetching a byte the KERNAL prints SEARCHING FOR <name> and then
    // LOADING, and those two lines are part of what a program sees: tape and
    // disk intros that hand over by stuffing RETURNs read their commands back
    // off the screen, so a load that prints nothing leaves the cursor two lines
    // high and the handover reads the wrong line. Run the ROM's own routines
    // rather than imitate them — they format the name, scroll, and test MSGFLG
    // themselves, so a program-initiated LOAD still prints nothing. Each returns
    // to $FFD5; the third pass does the load.
    if (this._kernalPrintsLoadMessages()) {
      if (this._loadTrapPhase === 0) { this._loadTrapPhase = 1; this._callFromTrap(0xF5AF); return; }
      if (this._loadTrapPhase === 1) { this._loadTrapPhase = 2; this._callFromTrap(0xF5D2); return; }
    }
    this._loadTrapPhase = 0;

    const dev = this.mem.ram[0xBA];
    if (this.onLoadTrap) { try { this.onLoadTrap(dev); } catch { } }
    const isVerify = this.cpu.a === 1;
    const nameLen = this.mem.ram[0xB7];
    const namePtr = this.mem.ram[0xBB] | (this.mem.ram[0xBC] << 8);
    let fileName = '';
    for (let i = 0; i < nameLen; i++) {
      fileName += String.fromCharCode(this.mem.ram[namePtr + i]);
    }

    // '$' is the directory, and anything after it narrows the listing the way
    // DOS does (LOAD"$0:A*",8). Everything else is a file name, wildcards and
    // drive prefix and type suffix included — see D64.loadFile.
    const data = fileName.startsWith('$')
      ? disk.buildDirectoryPRG(fileName.slice(1))
      : disk.loadFile(fileName);

    if (!data || data.length < 2) {
      // File not found error
      this.cpu.C = 1;
      this.cpu.a = 4; // FILE NOT FOUND
    } else {
      const fileAddr = data[0] | (data[1] << 8);
      const sa = this.mem.ram[0xB9]; // secondary address

      // SA=0 -> use X/Y, otherwise use file addr
      let loadAddr = (sa === 0) ? (this.cpu.x | (this.cpu.y << 8)) : fileAddr;
      const endAddr = loadAddr + data.length - 2;

      if (!isVerify) {
        for (let i = 2; i < data.length; i++) {
          this.mem.write(loadAddr + i - 2, data[i]);
        }
        // Update pointers KERNAL usually updates
        this.mem.ram[0x002D] = (endAddr) & 0xFF;
        this.mem.ram[0x002E] = (endAddr >> 8) & 0xFF;
        this.mem.ram[0xAE] = (endAddr) & 0xFF; // end of load addr
        this.mem.ram[0xAF] = (endAddr >> 8) & 0xFF;
        this.mem.ram[0x90] = 0; // status OK
      }

      this.cpu.C = 0; // Carry clear = success
      this.cpu.x = endAddr & 0xFF;
      this.cpu.y = (endAddr >> 8) & 0xFF;
    }

    // Simulate RTS from $FFD5 (which was entered via JSR)
    const lo = this.cpu._pop();
    const hi = this.cpu._pop();
    this.cpu.pc = ((hi << 8) | lo) + 1;

    // Auto-RUN follow-up: see injectLoadAndRun.
    if (this._pendingAutoRun && this.cpu.C === 0) {
      const cmd = 'RUN\r';
      for (let i = 0; i < cmd.length; i++) {
        this.mem.ram[0x0277 + i] = cmd.charCodeAt(i);
      }
      this.mem.ram[0x00C6] = cmd.length;
      this._pendingAutoRun = false;
    }
  }

  // Forward SID write to the audio worklet ring buffer AND apply to
  // the main-thread shadow voices so $D41B/$D41C reads see the same
  // state the worklet will reach at the corresponding cycle.
  _sidWrite(reg, val) {
    const wi = Atomics.load(this.sidCtrl, 0);
    const off = (wi & (RING_CAPACITY - 1)) * 2;
    this.sidRing32[off] = this.sidCycleCounter >>> 0;
    this.sidRing32[off + 1] = ((val & 0xFF) << 8) | (reg & 0x1F);
    Atomics.store(this.sidCtrl, 0, (wi + 1) & 0x7FFFFFFF);

    // Mirror voice-register writes to the shadow voices. Filter / vol
    // registers ($D415-$D418) are audio-output-only; the shadow doesn't
    // need them.
    const r = reg & 0x1F;
    if (r < 7)       this.shadowV1.write(r, val);
    else if (r < 14) this.shadowV2.write(r - 7, val);
    else if (r < 21) this.shadowV3.write(r - 14, val);

    // Debug: capture register writes when sidTraceLeft > 0. Call
    // `machine.sidTraceStart(n)` from the console to begin; then
    // `machine.sidTraceDump()` to get the array. Used for diagnosing
    // WOTEF-style digi by inspecting the actual $D418 sequence the
    // game emits.
    if (this.sidTraceLeft > 0) {
      this.sidTraceBuf.push([this.sidCycleCounter >>> 0, reg & 0x1F, val & 0xFF]);
      this.sidTraceLeft--;
    }
  }

  sidTraceStart(n = 8000) {
    this.sidTraceBuf = [];
    this.sidTraceLeft = n;
    console.log(`[sid-trace] capturing next ${n} SID writes…`);
  }

  sidTraceDump(reg) {
    const all = this.sidTraceBuf || [];
    const rows = reg !== undefined ? all.filter(r => r[1] === reg) : all;
    console.log(`[sid-trace] ${rows.length} events${reg !== undefined ? ` for reg $${reg.toString(16).padStart(2,'0')}` : ''}`);
    if (rows.length > 0) {
      const first = rows[0][0], last = rows[rows.length - 1][0];
      const span = (last - first) / 985248 * 1000;
      console.log(`  span: ${span.toFixed(1)} ms  (rate ≈ ${(rows.length / span * 1000).toFixed(0)} Hz)`);
    }
    return rows;
  }

  attachDrive(romBuffer) {
    this._wakeDriveIdleSkip();
    this.drive1541 = new Drive1541(romBuffer, this.currentD64);
    // When the drive flips CLK/DATA on the IEC bus, re-compute the wired-AND
    // state and push it back into the drive's input latches. Without this,
    // the drive reads a stale `dataIn` until the C64 next touches CIA2.
    this.drive1541.busSyncCallback = () => {
      this._wakeDriveIdleSkip();
      this._syncIecBus();
    };
  }

  setTrueDrive(on) {
    const wasOn = this.truedriveEnabled;
    this.truedriveEnabled = !!on && !!this.drive1541;
    this._wakeDriveIdleSkip();
    // When TDE becomes effective, run the drive forward until its ROM self-test
    // finishes and the CPU reaches the DOS idle scheduler. Without this, the
    // first LOAD after enabling TDE issues IEC commands while the drive is still
    // booting and the C64 times out. Gate on _driveBooted (boot once) rather than
    // the off→on edge, so it still fires when TDE is on by default at construction
    // and only becomes effective here once the drive is attached (wasOn is already
    // true then, so an edge test would skip the boot).
    void wasOn;
    if (this.truedriveEnabled && this.drive1541 && !this._driveBooted) {
      this._bootDriveToIdle(this.drive1541);
      this._driveBooted = true;
    }
  }

  // Run a freshly attached drive forward until its ROM self-test finishes and
  // its CPU settles into the DOS idle scheduler (canIdleSkip). The 3M-cycle cap
  // is a safety net for malformed/foreign ROMs.
  _bootDriveToIdle(drive) {
    const CHUNK = 2_000;
    const CAP = 3_000_000;
    let spent = 0;
    while (spent < CAP) {
      drive.clock(CHUNK);
      spent += CHUNK;
      if (drive.canIdleSkip()) break;
    }
  }

  // Connect / disconnect the second physical 1541 (IEC device 9). Connecting
  // it puts a real drive on the bus that answers LOAD"…",9 over the standard
  // serial protocol; while it is connected the $FFD5 trap leaves device 9 to
  // the real drive (see _loadTrapDisk). Disconnecting removes it from the bus
  // entirely. Idempotent.
  attachDrive9(romBuffer) {
    if (this.drive1541b) return;
    this._wakeDriveIdleSkip();
    const drive = new Drive1541(romBuffer, this.currentD64Drive9);
    drive._setDeviceNumber(9);        // device-# jumpers → 9
    drive.busSyncCallback = () => {
      this._wakeDriveIdleSkip();
      this._syncIecBus();
    };
    this._bootDriveToIdle(drive);
    this.drive1541b = drive;
    this._syncIecBus();               // fold the new drive into the bus level
  }

  detachDrive9() {
    if (!this.drive1541b) return;
    this._wakeDriveIdleSkip();
    this.drive1541b = null;
    this._syncIecBus();               // drive 9 stops pulling the bus
  }

  // Plug an REU onto the expansion port. A cartridge may stay attached — the
  // real pairing needs a port expander, and the REU claims only $DF00-$DF0A.
  // Passing the same model again is a no-op so the contents survive.
  attachReu(modelId = REU_DEFAULT_MODEL) {
    if (this.reu && this.reu.modelId === modelId) return this.reu;
    const reu = new REU(modelId);
    reu.busHoldHandler = held => { this._reuBusHold = held; };
    reu.irqHandler = asserted => { this._reuIrqPending = asserted; };
    this._reuBusHold = false;
    this._reuIrqPending = false;
    this.mem.installReu(reu);
    this.reu = reu;
    return reu;
  }

  detachReu() {
    if (!this.reu) return;
    this.mem.installReu(null);
    this.reu = null;
    this._reuBusHold = false;
    this._reuIrqPending = false;
  }

  loadTap(data) {
    this.datasette.loadTap(data);
  }

  setTapePlayPressed(pressed) {
    this.datasette.setPlayPressed(pressed);
  }

  ejectTape() {
    this.datasette.eject();
  }

  rewindTape() {
    this.datasette.rewind();
  }

  // Press one datasette key: 'STOP' | 'PLAY' | 'REC' | 'FF' | 'REW'. Returns
  // false when the mechanism refuses (RECORD on a protected or absent tape).
  setTapeKey(key) {
    return this.datasette.pressKey(key);
  }

  newBlankTape() {
    this.datasette.newBlankTape();
  }

  // Scrub the tape to a 0..1 position along the pulse stream (the progress bar).
  seekTapeFraction(fraction) {
    this.datasette.seekToFraction(fraction);
  }

  seekTapeSeconds(seconds) {
    this.datasette.seekToSeconds(seconds);
  }

  setTapeWriteProtected(protectedOn) {
    this.datasette.writeProtected = !!protectedOn;
  }

  // Recorded content that hasn't been exported / persisted yet.
  hasUnsavedTapeWrites() {
    return this.datasette.dirty;
  }

  // A complete .tap file for the tape as it currently stands, recording included.
  exportTapBytes() {
    return this.datasette.exportTapBytes();
  }

  // Expose current D64 to the drive, so it starts streaming GCR.
  setD64(d64) {
    this._wakeDriveIdleSkip();
    this.currentD64 = d64;
    if (this.drive1541) this.drive1541.setDisk(d64);
  }

  // Turn the secondary device-9 drive on/off. When off it is invisible to the
  // C64 — the load trap won't answer for device 9.
  setDrive9Enabled(on) {
    this.drive9Enabled = !!on;
  }

  // Insert / eject the disk in the device-9 drive (null = empty).
  setD64Drive9(d64) {
    this._wakeDriveIdleSkip();
    this.currentD64Drive9 = d64;
    if (this.drive1541b) this.drive1541b.setDisk(d64);
  }

  // Fold any pending 1541 head writes back into the mounted D64 images so the
  // image bytes are authoritative — call before snapshotting, exporting, or
  // persisting a disk. Returns the total number of sectors written across both
  // drives. (setDisk already commits on eject / disk-swap / reset.)
  commitDriveWrites() {
    let n = 0;
    if (this.drive1541) n += this.drive1541.commitWrites();
    if (this.drive1541b) n += this.drive1541b.commitWrites();
    return n;
  }

  // Whether either drive holds un-persisted head writes (for the UI dirty marker).
  hasUnsavedDiskWrites() {
    return !!((this.drive1541 && this.drive1541.hasUnsavedWrites()) ||
              (this.drive1541b && this.drive1541b.hasUnsavedWrites()));
  }

  // Capture a JSON-serializable dump of machine state for debugging.
  // Memory blocks are base64-encoded. Format is informational — fields
  // may be added without bumping `version`; consumers should ignore unknown.
  snapshot() {
    const b64 = (u8) => {
      if (!u8) return null;
      let s = '';
      const N = u8.length;
      for (let i = 0; i < N; i += 0x4000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x4000, N)));
      }
      return btoa(s);
    };
    const arr = (u8) => u8 ? Array.from(u8) : null;

    const cpu = this.cpu;
    const vic = this.vic2;
    const ciaState = (cia) => ({
      timerA: cia.timerA, latchA: cia.latchA,
      timerB: cia.timerB, latchB: cia.latchB,
      cra: cia.cra, crb: cia.crb,
      icrStatus: cia.icrStatus, icrMask: cia.icrMask,
      portA: cia.portA, portADir: cia.portADir,
      portB: cia.portB, portBDir: cia.portBDir,
      sdr: cia.sdr,
      tod: {
        tod10: cia.tod10, sec: cia.todSec, min: cia.todMin, hr: cia.todHr,
        alm10: cia.alm10, almSec: cia.almSec, almMin: cia.almMin, almHr: cia.almHr,
        halted: cia.todHalted, latched: cia.todLatched
      },
    });

    const drive = this.drive1541;
    const driveState = drive ? {
      enabled: this.truedriveEnabled,
      ram: b64(drive.ram),
      via1Regs: arr(drive.via1?.regs),
      via2Regs: arr(drive.via2?.regs),
      cpu: drive.cpu ? {
        a: drive.cpu.a, x: drive.cpu.x, y: drive.cpu.y,
        pc: drive.cpu.pc, sp: drive.cpu.sp,
      } : null,
    } : null;

    return {
      version: 2,
      timestamp: new Date().toISOString(),
      cpu: {
        a: cpu.a, x: cpu.x, y: cpu.y, pc: cpu.pc, sp: cpu.sp,
        flags: { N: cpu.N, V: cpu.V, D: cpu.D, I: cpu.I, Z: cpu.Z, C: cpu.C },
        irqLine: cpu.irqLine, nmiLine: cpu.nmiLine,
        nmiEdge: cpu.nmiEdge, halted: cpu.halted,
        // Mid-instruction state — required for deterministic replay.
        // Snapshots taken between runFrame() boundaries can land
        // anywhere inside an instruction; restoring just PC isn't
        // enough to resume cycle-exact.
        instructionCyclesRemaining: cpu.instructionCyclesRemaining ?? 0,
        microOpHead: cpu.microOpHead ?? 0,
        microOpLen: cpu.microOpLen ?? 0,
        sampledIrq: !!cpu.sampledIrq,
        sampledIrqLate: !!cpu.sampledIrqLate,
        irqLineLate: !!cpu.irqLineLate,
        tmpAddr: cpu.tmpAddr ?? 0,
        tmpLo: cpu.tmpLo ?? 0,
        pageCrossed: !!cpu.pageCrossed,
      },
      vic2: {
        regs: arr(vic.regs),
        raster: vic.raster, cycleInLine: vic.cycleInLine,
        vc: vic.vc, vcBase: vic.vcBase, rc: vic.rc, vmli: vic.vmli,
        displayActive: !!vic.displayActive,
        displayEnabled: !!vic.displayEnabled,
        vBorderActive: !!vic.vBorderActive,
        vBorderLatch: !!vic._vBorderLatch,
        hBorderActive: !!vic.hBorderActive,
        irqStatus: vic.irqStatus, irqMask: vic.irqMask,
        currentVicBank: vic.currentVicBank,
        lastRefreshAddr: vic.lastRefreshAddr,
        lineBadLineDisplayPending: !!vic.lineBadLineDisplayPending,
        lineBadLineStartCycle: vic.lineBadLineStartCycle,
        lineMatrixFetchCol: vic.lineMatrixFetchCol,
        sprite: {
          mc: arr(vic.spriteMC),
          mcBase: arr(vic.spriteMCBase),
          yExpandFF: arr(vic.spriteYExpandFF),
          dmaOn: arr(vic.spriteDmaOn),
          displayOn: arr(vic.spriteDisplayOn),
          ptrValue: arr(vic.spritePointerValue),
          dataBase: Array.from(vic.spriteDataBase),
          dataRow: arr(vic.spriteLineDataRow),
        },
        // VIC internal scratch — required for deterministic replay.
        // Without these the renderer takes a different code path on
        // the first frame after restore (e.g., bad-line edge handler
        // mis-fires, raster IRQ comparator state differs, pending FF
        // transitions are lost).
        internal: {
          prevBadLineCondition: !!vic._prevBadLineCondition,
          prevSpriteBaLow: !!vic._prevSpriteBaLow,
          lineBadLineLatch: !!vic._lineBadLineLatch,
          rcResetDoneThisLine: !!vic._rcResetDoneThisLine,
          lastRasterMatch: !!vic._lastRasterMatch,
          rasterCompMidLineDip: !!vic._rasterCompMidLineDip,
          baLow: !!vic.baLow,
          aecLow: !!vic.aecLow,
          spriteBaLowOnly: !!vic.spriteBaLowOnly,
          cycleRenderActiveCanvasY: vic._cycleRenderActiveCanvasY ?? -1,
          pendingFFTransitions: (vic._pendingFFTransitions || []).map(p => ({
            kind: p.kind,
            detectCycle: p.detectCycle,
            detectRaster: p.detectRaster,
            latchTotalCycles: p.latchTotalCycles,
            cselAtFire: p.cselAtFire,
            raster: p.raster,
            vetoable: p.vetoable,
            // spriteSnapshot is large + nested; capturing skipped
            // for now (best-effort replay).
          })),
          // Renderer fb32 / collision / priority buffers (already in
          // vicFrameDebug above but mirrored here for clean restore).
          fb32: b64(new Uint8Array(vic.fb32.buffer)),
        },
      },
      cia1: ciaState(this.cia1),
      cia2: ciaState(this.cia2),
      memory: {
        ram: b64(this.mem.ram),
        colorRam: b64(this.mem.colorRam),
        cpuPort: this.mem.cpuPort,
        cpuDDR: this.mem.cpuDDR,
        kernalLoaded: !!this.mem.kernal,
        basicLoaded: !!this.mem.basic,
        charRomLoaded: !!this.mem.charRom,
      },
      // Per-pixel border/priority/owner state, CANVAS_W×CANVAS_H (full frame).
      // The live buffers are line-sized (#1); when the frame trace is enabled
      // (c64Trace.enable()) the VIC accumulates each rendered line into a full-
      // frame map (frameTrace*Map), serialized here. With the trace OFF those
      // maps are null and we fall back to the current line buffer (last rendered
      // line only) — so enable the trace first for a whole-frame border map.
      // borderBuffer[i] = 1 → pixel was drawn as border (h or v border closed)
      //                 = 0 → pixel was drawn as graphics/sprite/open-border-idle
      // Combined with framebufferPng the user can verify whether a "garbage in
      // side border" symptom is the border being closed (=1) or open (=0).
      vicFrameDebug: {
        canvasW: CANVAS_W,
        canvasH: CANVAS_H,
        // True iff the per-raster frame trace is currently capturing. If
        // false, the frameTrace* fields below contain whatever was last
        // captured (or zeros if never enabled). Toggle from the JS console:
        //   c64Trace.enable()   /   c64Trace.disable()
        traceEnabled: !!vic.frameTraceEnabled,
        borderBuffer: b64(vic.frameTraceBorderMap || vic.borderBuffer),
        graphicsPriorityBuffer: b64(vic.frameTracePriorityMap || vic.graphicsPriorityBuffer),
        spriteOwnerBuffer: b64(vic.frameTraceOwnerMap || vic.spriteOwnerBuffer),
        // Per-line border-FF trace from the last completed frame.
        // Indexed [raster * 64 + cycle]. raster 0..311, cycle 0..63.
        // Use these to verify whether the side-border-open trick fired on
        // every line (hBorder = 0 in the display window) or only on the
        // bad-line raster of each character row.
        frameTraceHBorder: b64(vic.frameTraceHBorder),
        frameTraceVBorder: b64(vic.frameTraceVBorder),
        frameTraceLineD011: Array.from(vic.frameTraceLineD011),
        frameTraceLineD016: Array.from(vic.frameTraceLineD016),
        // bit0 = bad line, bit1 = displayActive at end-of-line
        frameTraceLineFlags: Array.from(vic.frameTraceLineFlags),
        // Per-line sprite state (sampled at cycle 30 mid-display).
        frameTraceLineD015: Array.from(vic.frameTraceLineD015),
        frameTraceLineD01C: Array.from(vic.frameTraceLineD01C),
        frameTraceLineD01D: Array.from(vic.frameTraceLineD01D),
        frameTraceLineD017: Array.from(vic.frameTraceLineD017),
        frameTraceLineD01B: Array.from(vic.frameTraceLineD01B),
        frameTraceLineD010: Array.from(vic.frameTraceLineD010),
        frameTraceLineD021: Array.from(vic.frameTraceLineD021),
        frameTraceLineD012: Array.from(vic.frameTraceLineD012),
        frameTraceLineD019: Array.from(vic.frameTraceLineD019),
        frameTraceLineD01A: Array.from(vic.frameTraceLineD01A),
        frameTraceLineD020: Array.from(vic.frameTraceLineD020),
        frameTraceLineRegChanges: Array.from(vic.frameTraceLineRegChanges),
        frameTraceLineSpriteDmaOn: Array.from(vic.frameTraceLineSpriteDmaOn),
        frameTraceLineSpriteDisplayOn: Array.from(vic.frameTraceLineSpriteDisplayOn),
        frameTraceLineVicBank: Array.from(vic.frameTraceLineVicBank),
        frameTraceLineSpriteXY: b64(vic.frameTraceLineSpriteXY),  // 312 lines × 16 bytes (X,Y per sprite)
        frameTraceLineSpriteColors: b64(vic.frameTraceLineSpriteColors),  // 312 lines × 8 bytes
        frameTraceLineSpritePtrs: b64(vic.frameTraceLineSpritePtrs),  // 312 lines × 8 bytes
        frameTraceLineSpriteMC: b64(vic.frameTraceLineSpriteMC),      // 312 × 8: MC at end-of-line per sprite
        frameTraceLineSpriteMCBase: b64(vic.frameTraceLineSpriteMCBase), // 312 × 8
        frameTraceLineSpriteYExpFF: Array.from(vic.frameTraceLineSpriteYExpFF), // bit s = sprite s FF
        // Per-CPU-write logs for raster-IRQ-relevant VIC registers (most-
        // recent completed frame). Each entry: {raster, cycleInLine, value,
        // totalCycles}. Empty unless trace is enabled. Bin by `raster` to
        // compare multiplexer IRQ-chain timing across snapshots.
        frameTraceD012Writes: vic.frameTraceD012Writes.slice(),
        frameTraceD011Writes: vic.frameTraceD011Writes.slice(),
        frameTraceD01AWrites: vic.frameTraceD01AWrites.slice(),
        frameTraceD017Writes: vic.frameTraceD017Writes.slice(),
        frameTraceD018Writes: vic.frameTraceD018Writes.slice(),
        frameTraceD016Writes: vic.frameTraceD016Writes.slice(),
        frameTraceIrqAssertions: vic.frameTraceIrqAssertions.slice(),
        frameTraceIrqAccepts: vic.frameTraceIrqAccepts.slice(),
      },
      drive1541: driveState,
    };
  }

  // ── Save-state (restorable snapshot) ──────────────────────────────────────
  // Unlike snapshot() (a debug dump that cannot be restored and omits the
  // media + many pipeline latches), serializeState()/restoreState() form a
  // complete, restorable pair. The CPU executes via closures (microOpFns)
  // that can't be serialized, so we first quiesce to an instruction boundary
  // — at a boundary the queue is empty and only registers + numeric latches
  // need saving. The bundled media bytes (disk/tape/cart) are added by the
  // caller (main.js), which owns those caches and the machine's reattach path.

  // Step master cycles until the main CPU is between instructions (and, when a
  // true-drive 1541 is active, the drive CPU too, so its saved PC is a real
  // opcode boundary). Both CPUs idle in tight loops, so joint alignment is
  // found quickly; the cap is a safety bound (best-effort beyond it).
  _quiesceToBoundary(maxCycles = 512) {
    if (!this.ready) return 0;
    let n = 0;
    // An REU transfer halts the CPU for its whole duration, so the boundary
    // search below cannot make progress while one is running — and a 64K
    // transfer far outruns the cap. Draining it first is invisible to the CPU
    // (it is stopped either way) and leaves an ordinary boundary to find.
    let drain = 0x20001;   // longest transfer: 64K bytes at two cycles each
    while (this._reuBusHold && drain-- > 0) this._runMasterCycle();
    while (n < maxCycles && !this.cpu.atInstructionBoundary()) { this._runMasterCycle(); n++; }
    if (this.drive1541 && this.truedriveEnabled) {
      while (n < maxCycles &&
             !(this.cpu.atInstructionBoundary() && this.drive1541.cpu.atInstructionBoundary())) {
        this._runMasterCycle(); n++;
      }
    }
    return n;
  }

  // Capture full, restorable machine state. Media bytes are NOT included here
  // (the caller bundles them). Takes effect at an instruction boundary.
  serializeState() {
    this._quiesceToBoundary();
    return {
      format: 'c64state',
      version: 1,
      cpu: this.cpu.serialize(),
      memory: this.mem.serialize(),
      vic2: this.vic2.serialize(),
      cia1: this.cia1.serialize(),
      cia2: this.cia2.serialize(),
      datasette: this.datasette.serialize(),
      drive1541: (this.drive1541 && this.truedriveEnabled) ? this.drive1541.serialize() : null,
      reu: this.reu ? this.reu.serialize() : null,
      sid: {
        is8580: this.sidIs8580,
        paddleX: this.paddleX, paddleY: this.paddleY,
        potXSampled: this.potXSampled, potYSampled: this.potYSampled,
        potSampleCounter: this.potSampleCounter, potConnected: this.potConnected,
        potXOverride: this.potXOverride,
        regs: this.mem.sid.regs.slice(),
        shadowVoices: this.shadowVoices.map(v => v.serialize()),
      },
      machine: {
        prevNmiLevel: this.prevNmiLevel,
        _cpuVicIrqPending: this._cpuVicIrqPending,
        _cpuVicIrqPendingLate: this._cpuVicIrqPendingLate,
        _cpuVicIrqPrev: this._cpuVicIrqPrev,
        _cpuCiaIrqPending: this._cpuCiaIrqPending,
        _cpuNmiPending: this._cpuNmiPending,
        _cpuNmiEdgeSeen: this._cpuNmiEdgeSeen,
        nmiSources: { ...this._nmiSources, restore: false },
        joyPort1: this.joyPort1, joyPort2: this.joyPort2,
        sidCycleCounter: this.sidCycleCounter,
        driveCycleAccum: this.driveCycleAccum,
      },
    };
  }

  // Restore state produced by serializeState(). REQUIRES that the caller has
  // already re-attached the matching media (disk/tape/cart) and applied the
  // VIC/SID variant — i.e. run on a freshly created+wired machine (see
  // main.js _loadState). Throws on an unrecognized/newer format.
  restoreState(s) {
    if (!s || s.format !== 'c64state') throw new Error('Not a C64 save-state');
    if (s.version > 1) throw new Error(`Save-state version ${s.version} is newer than supported (1)`);

    // Chips first (CIA deserialize re-wires its /IRQ line via _updateIrq).
    this.cpu.deserialize(s.cpu);
    this.mem.deserialize(s.memory);
    this.vic2.deserialize(s.vic2);
    this.cia1.deserialize(s.cia1);
    this.cia2.deserialize(s.cia2);
    this.datasette.deserialize(s.datasette);
    if (s.drive1541 && this.drive1541) this.drive1541.deserialize(s.drive1541);
    // The REU re-drives its own bus-hold and /IRQ lines from the restored
    // register file, so the machine-level latches below need no REU entry.
    if (s.reu && this.reu) this.reu.deserialize(s.reu);

    // Machine-level interrupt pipeline + joystick (overwrite the values the
    // chip _updateIrq() calls above just recomputed — saved values win).
    const m = s.machine || {};
    this.prevNmiLevel = !!m.prevNmiLevel;
    this._cpuVicIrqPending = !!m._cpuVicIrqPending;
    this._cpuVicIrqPendingLate = !!m._cpuVicIrqPendingLate;
    this._cpuVicIrqPrev = !!m._cpuVicIrqPrev;
    this._cpuCiaIrqPending = !!m._cpuCiaIrqPending;
    this._nmiSources = {
      cia2: !!(m.nmiSources?.cia2 ?? m._cpuNmiPending),
      restore: false,
      cartridge: !!(m.nmiSources?.cartridge ?? this.mem.cartNmiAsserted),
    };
    this._cpuNmiPending = !!(m._cpuNmiPending ??
      (this._nmiSources.cia2 || this._nmiSources.cartridge));
    this._cpuNmiEdgeSeen = !!m._cpuNmiEdgeSeen;
    this.joyPort1 = m.joyPort1 ?? 0xFF;
    this.joyPort2 = m.joyPort2 ?? 0xFF;
    this.driveCycleAccum = m.driveCycleAccum | 0;
    this.sidCycleCounter = (m.sidCycleCounter ?? 0) >>> 0;

    // SID: register shadow + main-thread shadow voices, then re-push the
    // register file to the audio worklet so sound resumes (the fresh machine's
    // ring is empty). Oscillator phase is approximate across restore — a brief
    // audio blip is expected, no logical-state loss.
    const sid = s.sid || {};
    this.sidIs8580 = !!sid.is8580;
    this.paddleX = sid.paddleX ?? 0x80; this.paddleY = sid.paddleY ?? 0x80;
    this.potXSampled = sid.potXSampled ?? 0x80; this.potYSampled = sid.potYSampled ?? 0x80;
    this.potSampleCounter = sid.potSampleCounter | 0;
    // Absent in states saved before the pot gates were modelled; the live
    // control-port config re-asserts both every frame anyway.
    this.potConnected = !!sid.potConnected;
    this.potXOverride = sid.potXOverride ?? null;
    if (sid.regs) this.mem.sid.regs.set(sid.regs);
    for (let r = 0; r < 25; r++) this._sidWrite(r, this.mem.sid.regs[r]);
    if (sid.shadowVoices) {
      for (let i = 0; i < 3; i++) this.shadowVoices[i].deserialize(sid.shadowVoices[i]);
    }
    for (const v of this.shadowVoices) v.is8580 = this.sidIs8580;
  }

  // Run one PAL frame (~19,656 clock cycles = ~4,914 instructions @ 4 cyc each)
  // Returns true when a new video frame is ready to be rendered.
  runFrame() {
    if (!this.ready) return false;

    this._runFrameCycles();

    // ── TOD Clock (50Hz PAL) ────────────────────────────────────────────────
    this.cia1.tick50Hz();
    this.cia2.tick50Hz();
    this.busTraceFrame = (this.busTraceFrame + 1) | 0;

    return true; // frame complete → caller should render VIC-II
  }

  // The per-frame master-cycle loop, isolated from runFrame's epilogue.
  // When the 19656-iteration loop lived directly in runFrame, V8 OSR-compiled
  // runFrame mid-loop; the epilogue (tick50Hz + busTraceFrame) had cold inline
  // caches at that point, so it was emitted as a "generic named access" and
  // DEOPTED on every loop exit (~0.4 deopts/frame, 253 over 600). Isolating
  // the loop here lets it OSR-compile with no cold tail; runFrame tiers up
  // normally.
  _runFrameCycles() {
    for (let cycle = 0; cycle < CYCLES_PER_FRAME; cycle++) {
      this._runMasterCycle();
    }
  }

  _runMasterCycle() {
    this.sidCycleCounter = (this.sidCycleCounter + 1) >>> 0;

    // Clock the shadow SID voices, which serve cycle-exact $D41B/$D41C
    // (voice 3 OSC3/ENV3) readback. Only voice 3 is read; voices 1 & 2
    // exist solely as the sync/ring-mod source chain (v3←v2←v1), so they
    // need only their phase accumulator advanced — clockPhaseOnly() skips
    // their (unread) envelope, LFSR, waveform synthesis and OSC latch.
    // Voice 3 gets the full clock. Byte-identical OSC3/ENV3, ~2/3 cheaper.
    computeSyncPulses(this.shadowV1, this.shadowV2, this.shadowV3);
    this.shadowV1.clockPhaseOnly();
    this.shadowV2.clockPhaseOnly();
    this.shadowV3.clockCore();
    // OSC3-only output: the shadow serves only $D41B/$D41C (OSC3/ENV3); v3's
    // audio DAC sample is discarded, so outputStageOsc3() skips it (dead work
    // on the CPU hot loop). Byte-identical OSC3/ENV3 (skip-equiv test).
    this.shadowV3.outputStageOsc3();

    // POTX/POTY sample-and-hold: latch the live paddle position into
    // the SID-readable register every 512 master cycles, modelling the
    // real chip's internal RC-discharge timer.
    if (++this.potSampleCounter >= 512) {
      this.potSampleCounter = 0;
      this.potXSampled = this.paddleX & 0xFF;
      this.potYSampled = this.paddleY & 0xFF;
    }

    // IEC edge-propagation pipeline step (see 'iecEdgeLatency'): make last
    // cycle's C64 output edges visible to the drive and advance the
    // drive-pin delay line the C64's $DD00 reads sample from.
    if (this.iecEdgeLatency && this.drive1541) this._iecClock();

    // Apply the PREVIOUS cycle's pending IRQ/NMI state to the CPU before
    // cpu.clock runs this cycle (the per-source delay pipeline). This reads
    // _cpuCiaIrqPending/_cpuNmiPending as left by the PRIOR cycle's CIA clock,
    // which is what gives the CIA→CPU its delay; the CIA clock for THIS cycle
    // runs below at phi1 (after the VIC, before the CPU).
    this._masterPhase = 'irq-sample';
    this._sampleCpuInterrupts();

    // Clock VIC-II first to determine bus state for this master cycle.
    // Per Bauer §3.8.1 + the bumbershootsoft "VIC-II interrupt timing"
    // article: real hardware runs VIC during phi1 of a cycle and CPU
    // during phi2. The article explicitly states "VIC acts before CPU
    // on cycle 58" — the VIC reads its own registers on cycle 58 (phi1)
    // BEFORE the CPU has a chance to write them on phi2 of the same
    // cycle. CPU writes therefore become visible to the VIC starting
    // from the NEXT cycle's phi1. Modeling this with VIC-first ordering
    // approximates that behavior: any CPU write this cycle lands in the
    // register file after the VIC has already evaluated its phi1 logic.
    this._masterPhase = 'vic';
    this.vic2.clock(1);

    // CIA timer counting + underflow + IR-latch advance run at phi1, BEFORE
    // the CPU's phi2 — so a CPU register read this cycle sees this cycle's
    // underflow (matching real silicon, where a phi2 ICR read races the
    // underflow: the 6526 interrupt-acknowledge bug). The CIA→CPU IRQ delay is
    // preserved because _sampleCpuInterrupts (above) already consumed the prior
    // cycle's pending before this clock sets the new pending state. Register
    // WRITES still land in the CPU phase below, so their timer effects are seen
    // by NEXT cycle's clock — _craStartPending=2 makes that net-equivalent to
    // the old CIA-after-CPU 3-clock force-load phase. The CIA counts regardless
    // of CPU BA/AEC stalls (cia-timer-during-ba-stall-spec-test), so it runs
    // unconditionally here. beginMasterCycle snapshots the timer counters
    // BEFORE clock(1) counts them, so a CPU $DC04-07 read this cycle returns the
    // start-of-cycle value (= the previous cycle's post-count) — real silicon's
    // live-phi2 read. That counter read is deliberately one count BEHIND the
    // $DC0D/icrStatus read above (which DOES reflect this cycle's underflow);
    // the asymmetry is the validated model — see cia-timer-spec-test.
    this._masterPhase = 'cia';
    this.cia1.beginMasterCycle?.();
    this.cia2.beginMasterCycle?.();
    this.cia1.clock(1);
    this.cia2.clock(1);

    // CIA2 /NMI is delivered to the CPU symmetrically with the IRQ: the sticky
    // edge (_cpuNmiEdgeSeen) is presented at the TOP of the NEXT master cycle by
    // _sampleCpuInterrupts, i.e. one cycle after the cia2.clock that raised it.
    // This is the honest old-6526 timing (measured against VICE: the timer
    // interrupt line asserts one cycle after the underflow, identically for
    // IRQ and NMI). The former same-cycle
    // presentation (`_nmiSameCycle`, the Hat $8800 workaround) delivered the NMI
    // a cycle EARLY — wrong direction: it crashed Coma's logo scene (NMI landed
    // in the player's PLA/RTS stack section) and regressed cia-int-nmi 38→68.
    // The Hat's true root (live $DD06 read value) is the Timer-B reload timing,
    // fixed in the CIA timer core.

    // BA/RDY: Bauer §3.5 strict reading — "RDY halts a read access. Writes
    // are not affected." Bauer also notes the 6510 does a bus access EVERY
    // cycle: even internal/dummy cycles perform a discarded read. So RDY
    // stops ANY non-write cycle (reads + opcode fetches + dummy reads +
    // internal cycles), not just explicit reads.
    //
    // AEC: canonical Bauer §3.6.1 formula via isAecLowPhi2() — BA low at
    // current cycle AND BA low 3 cycles ago. When AEC is low VIC owns
    // the address bus during phi2 and EVERY CPU bus phase is blocked.
    const baLow = this.vic2.isBaLow();
    const aecLowPhi2 = this.vic2.isAecLowPhi2
      ? this.vic2.isAecLowPhi2()
      : this.vic2.isAecLow();
    // RDY (BA low) stalls any non-write CPU bus cycle; writes proceed.
    let rdyBlocked = false;
    if (baLow) {
      const nextBusIsWrite = this.cpu.nextBusIsWrite
        ? this.cpu.nextBusIsWrite()
        : this.cpu.peekNextBusKind() === 'write';
      rdyBlocked = !nextBusIsWrite;
    }
    // DMA: an REU transfer holds the bus for its whole duration. Like AEC low
    // and unlike RDY, this blocks every CPU bus phase including writes — the
    // processor is halted outright, not stalled on a read.
    const reuHeld = this._reuBusHold;
    const busBlocked = aecLowPhi2 || reuHeld;
    const cpuBlocked = rdyBlocked || busBlocked;

    // REU phi2 — one C64-bus access per cycle, but VIC DMA takes precedence,
    // so bad-line and sprite cycles stretch the transfer exactly as they do on
    // hardware. Its own phase tag keeps a DMA-time $D019 write from being
    // mis-read as a CPU-late VIC IRQ (see the vic2.irqHandler late-tag).
    if (reuHeld && !aecLowPhi2) {
      this._masterPhase = 'reu';
      this.reu.dmaCycle();
    }

    // C64 CPU runs BEFORE the drive this cycle so that any STA $DD00 the
    // host issues lands in the drive's input latches before the drive's
    // next instruction reads $1800. CIA2 reads are passive bus samples;
    // advancing the drive from readPortA() changes the phase of loaders that
    // take several $DD00 samples per byte.
    this._masterPhase = 'cpu';
    const trapDisk =
      (this.cpu.atInstructionBoundary() && !cpuBlocked && this.cpu.pc === 0xFFD5)
        ? this._loadTrapDisk()
        : null;
    if (trapDisk) {
      this._trapLoad(trapDisk);
    } else if (!cpuBlocked) {
      this.cpu.clock();
    } else if (!this.cpu.atInstructionBoundary()) {
      // Mid-opcode RDY/AEC stall: note it on the CPU — a steal landing
      // inside an I-writing instruction changes when the write reaches
      // the interrupt poll (cpu.noteMidOpcodeStall; irqdma test6/test7
      // sprite rows; NMOS CLI/SEI steal-cycle handling).
      // Optional-chained: some test harnesses drive stub CPUs.
      this.cpu.noteMidOpcodeStall?.();
    }
    // else: boundary stall — FULL freeze. The IRQ/NMI line latches do not
    // sample (refuted twice vs the irqdma real-C64 dumps: boundary-only
    // refresh, then every-stall-cycle — test1b 3968/16384 vs freeze
    // 0/16384) and the poll-visible I does not sync either (measured:
    // syncing it produced early accepts at badline boundaries).

    // VIC phi2 hook — runs AFTER CPU phi2 register writes have landed.
    // Used for c56 $D017 reconciliation and kept as the explicit place for
    // VIC behavior that really depends on same-cycle CPU writes.
    this._masterPhase = 'vic-phi2';
    this.vic2.phi2();

    // Datasette runs after the CPU: a tape pulse edge sets the CIA1 FLAG data
    // bit, picked up by next cycle's phi1 CIA clock (the timers themselves
    // already clocked at phi1, above). Closing the timer read-window here ends
    // the per-cycle snapshot used by CPU register reads.
    this._masterPhase = 'cia-post';
    // clock() early-returns unless the motor is running, so gate the call: an
    // idle machine with no tape then skips it entirely (measured ~0.4% of the
    // idle frame — the call + arg + the callee's guard loads × 19,656 cy/frame,
    // uninlined into this large method). motorOn flips only via setMotor
    // (CPU-port $01 bit 5) between cycles, so the gate is always current, and
    // _motorStartupRemaining only counts down while motorOn — behavior-identical.
    if (this.datasette.motorOn) this.datasette.clock(1);

    this.cia1.endMasterCycle?.();
    this.cia2.endMasterCycle?.();

    // Per-cycle bus trace snapshot (debug only; flag-gated).
    if (this.busTraceEnabled) {
      this._recordBusTrace(baLow, aecLowPhi2, cpuBlocked, this.cpu.currentMicroOpKind, reuHeld);
    }

    // An attached 1541 keeps ticking in both modes. TDE only controls the
    // $FFD5 KERNAL LOAD trap above: trap-mode LOADs read the D64 directly,
    // but code that talks to lower KERNAL IEC routines or bit-bangs $DD00
    // still needs a live drive CPU/VIA/spindle state.
    //
    // Drive clock: driveCycleAccum carries the 16.16 drive:C64 ratio
    // (driveClockFactor — see 'driveTrueClockRatio' in switches.js). At the
    // true PAL factor 66517 this pops 1 drive cycle per master cycle plus a
    // 2nd every ~66th, sweeping the drive↔C64 phase like real hardware; at
    // 65536 it is exactly the old 1:1 lockstep. steps is always 1 or 2
    // (factor ≥ 65536 guarantees ≥ 1).
    if (this.drive1541) {
      this.driveCycleAccum += this.driveClockFactor;
      const steps = this.driveCycleAccum >>> 16;
      this.driveCycleAccum &= 0xffff;
      if (this._iecBusStableCycles < IEC_IDLE_ENGAGE_QUIET) this._iecBusStableCycles++;
      if (this.drive1541b) {
        // Dual-drive (device 9 connected): the idle-skip accumulator tracks a
        // single drive, so disable it here and clock both drives in lockstep.
        // This path only runs when the user has opted into a second TDE drive.
        if (this._driveIdleSkippedPendingCycles > 0) this._wakeDriveIdleSkip();
        this.drive1541.clock(steps);
        this.drive1541b.clock(steps);
      } else if (this._driveIdleSkipping) {
        this._skipDriveIdleCycle(steps);
      } else if (this._iecBusStableCycles >= IEC_IDLE_ENGAGE_QUIET
                 && this.drive1541.canIdleSkip()) {
        this._driveIdleWakeInCycles = this.drive1541.idleSkipWakeCycles();
        this._skipDriveIdleCycle(steps);
      } else {
        if (this._driveIdleSkippedPendingCycles > 0) {
          this._wakeDriveIdleSkip();
        }
        this.drive1541.clock(steps);
      }
    }
  }
}
