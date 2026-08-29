// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/cia.js – MOS 6526 CIA chip (instances for CIA1 and CIA2)
// CIA1: timer A+B, IRQ, keyboard matrix (Port A = col select, Port B = row read)
// CIA2: timer A+B, NMI, VIC-II bank via Port A bits 0-1


// Browser key → C64 keyboard matrix [col, row]
// Col = CIA1 Port A bit# (output, active-low selects column)
// Row = CIA1 Port B bit# (input, active-low = key pressed)
//
// Special keys mapped to function-key row:
//   Tab → INST/DEL    F9 → RUN/STOP    F10 → Commodore
//   F11 → CLR/HOME    F12 → RESTORE (NMI, handled in main.js, NOT in matrix)
export const KEY_MAP = {
  'Backspace':     [0, 0], 'Delete':       [0, 0], 'Tab':       [0, 0],
  'Enter':         [0, 1], 'ArrowRight':   [0, 2],
  'F7':            [0, 3], 'F1':           [0, 4],
  'F3':            [0, 5], 'F5':           [0, 6],
  'ArrowDown':     [0, 7],
  'Digit3':        [1, 0], 'KeyW':         [1, 1],
  'KeyA':          [1, 2], 'Digit4':       [1, 3],
  'KeyZ':          [1, 4], 'KeyS':         [1, 5],
  'KeyE':          [1, 6], 'ShiftLeft':    [1, 7],
  'Digit5':        [2, 0], 'KeyR':         [2, 1],
  'KeyD':          [2, 2], 'Digit6':       [2, 3],
  'KeyC':          [2, 4], 'KeyF':         [2, 5],
  'KeyT':          [2, 6], 'KeyX':         [2, 7],
  'Digit7':        [3, 0], 'KeyY':         [3, 1],
  'KeyG':          [3, 2], 'Digit8':       [3, 3],
  'KeyB':          [3, 4], 'KeyH':         [3, 5],
  'KeyU':          [3, 6], 'KeyV':         [3, 7],
  'Digit9':        [4, 0], 'KeyI':         [4, 1],
  'KeyJ':          [4, 2], 'Digit0':       [4, 3],
  'KeyM':          [4, 4], 'KeyK':         [4, 5],
  'KeyO':          [4, 6], 'KeyN':         [4, 7],
  'KeyP':          [5, 1], 'KeyL':         [5, 2],
  'F11':           [6, 3], // F11 = CLR/HOME
  'Digit1':        [7, 0],
  'ControlLeft':   [7, 2], 'ControlRight': [7, 2],
  'Digit2':        [7, 3], 'Space':        [7, 4],
  'F10':           [7, 5], // F10 = Commodore
  'KeyQ':          [7, 6],
  'F9':            [7, 7], // F9 = RUN/STOP
  // Note: Escape is intentionally NOT mapped — plain ESC stays free for
  //   browser fullscreen exit. RUN/STOP is on F9 instead.
  // Note: F12 = RESTORE → NMI, handled directly in main.js (it isn't a
  //   keyboard-matrix key on real silicon).
  'ShiftRight':    [6, 4], // Right shift at col 6 row 4
  // Note: Printable symbol keys (-=[];',./\` and friends) are NOT in this
  //   table. They go through CHAR_MAP below, keyed on event.key (the actual
  //   character typed), so host layout differences don't misroute symbols.
};

// Character (event.key) → C64 matrix position + required Shift state.
// Used to map typed symbols 1-to-1 regardless of host keyboard layout:
// pressing '*' on the host produces '*' on the C64, even when the physical
// key or Shift state differs between layouts. Letters/digits/F-keys stay
// on KEY_MAP (physical position).
export const CHAR_MAP = {
  // Unshifted on C64
  '+': { col: 5, row: 0, shift: false },
  '-': { col: 5, row: 3, shift: false },
  '.': { col: 5, row: 4, shift: false },
  ':': { col: 5, row: 5, shift: false },
  '@': { col: 5, row: 6, shift: false },
  ',': { col: 5, row: 7, shift: false },
  '£': { col: 6, row: 0, shift: false },
  '*': { col: 6, row: 1, shift: false },
  ';': { col: 6, row: 2, shift: false },
  '=': { col: 6, row: 5, shift: false },
  '^': { col: 6, row: 6, shift: false }, // shares PETSCII $5E with ↑
  '/': { col: 6, row: 7, shift: false },
  '_': { col: 7, row: 1, shift: false }, // shares PETSCII $5F with ←

  // Require C64 Shift
  '!': { col: 7, row: 0, shift: true },
  '"': { col: 7, row: 3, shift: true },
  '#': { col: 1, row: 0, shift: true },
  '$': { col: 1, row: 3, shift: true },
  '%': { col: 2, row: 0, shift: true },
  '&': { col: 2, row: 3, shift: true },
  "'": { col: 3, row: 0, shift: true },
  '(': { col: 3, row: 3, shift: true },
  ')': { col: 4, row: 0, shift: true },
  '<': { col: 5, row: 7, shift: true },
  '>': { col: 5, row: 4, shift: true },
  '?': { col: 6, row: 7, shift: true },
  '[': { col: 5, row: 5, shift: true },
  ']': { col: 6, row: 2, shift: true },
};

export class CIA {
  constructor(id) {
    this.id = id;           // 1 = CIA1, 2 = CIA2
    this.timerA = 0xFFFF;  this.latchA = 0xFFFF;
    this.timerB = 0xFFFF;  this.latchB = 0xFFFF;
    this.cra = 0;          this.crb = 0;
    this.icrStatus = 0;    this.icrMask = 0;
    // IR latch (datasheet sheet 7): the IR bit (MSB of the DATA register) and
    // the /IRQ pin are a phi2-clocked flip-flop one CIA clock behind the
    // masked-data condition. _irLatch = current output; _irNextPending = the
    // value clocked into _irLatch on the next clock(). See clock()/read $0D.
    this._irLatch = false; this._irNextPending = false;
    // Interrupt-acknowledge bug: a $DC0D read that races the IR latch being
    // armed (data set this cycle, IR not yet latched) cannot acknowledge the
    // interrupt — and on the old 6526 the IR latch then sets one cycle LATER
    // than normal. This counter holds the latch advance for that extra cycle.
    this._irAckRaceDelay = 0;

    // Port A/B data registers and direction registers
    this.portA = 0x00;     this.portADir = 0x00;
    this.portB = 0x00;     this.portBDir = 0x00;
    this.sdr = 0x00;

    // Port A/B I/O hooks, wired post-construction (machine.js / input.js).
    // Declared here so CIA1 and CIA2 share ONE hidden class from birth —
    // otherwise the shared hot read()/write()/peek() see two divergent shapes
    // and the port-callback loads go polymorphic on every access (keyboard
    // scan, ICR poll). VIA6522 initializes these the same way (see 6522.js).
    // null is falsy exactly like the previous undefined, so every
    // `if (this.readPortA)` / `if (this.writePortB)` guard behaves identically.
    this.readPortA = null;  this.readPortB = null;
    this.writePortA = null; this.writePortB = null;

    // CIA1 keyboard matrix: matrix[col] is a byte; bit = 0 means key pressed
    this.matrix = new Uint8Array(8).fill(0xFF);

    // Track NMI edge (CIA2)
    this.prevIrq = false;

    // TOD Clock
    this.tod10  = 0; this.todSec = 0; this.todMin = 0; this.todHr  = 0x12; // default 12 AM
    this.alm10  = 0; this.almSec = 0; this.almMin = 0; this.almHr  = 0;
    this.latch10= 0; this.latchSec= 0; this.latchMin= 0; this.latchHr= 0;
    this.todHalted  = false;
    this.todLatched = false;
    this.todDivider = 0;
    
    this.irqHandler = (state) => {};
    this._flagLevel = 1; // FLAG pin state (1=high, 0=low)
    this._cntLevel = 1;  // CNT pin level (idle high unless driven)
    this._cntRising = false;

    // SDR output-mode shift state (CRA bit 6 = 1).
    // Real hw: a write to SDR primes the internal shift register; each Timer A
    // underflow toggles CNT, and 16 underflows (= 8 bits) later the SP IRQ
    // (ICR bit 3) fires. We don't model the SP/CNT pins, only the count + IRQ.
    this._sdrShifting = false;
    this._sdrCount = 0;
    this._sdrPending = false;  // SDR write queued during an active shift

    // CRA/CRB LOAD+START write→count latency. Counter set when the LOAD
    // strobe is written while START is set; cia.clock decrements it instead
    // of counting until it reaches 0. Plain START without LOAD counts on
    // the first CIA clock that observes it.
    this._craStartPending = 0;
    this._crbStartPending = 0;

    // Timer CRA/CRB-STOP delay (symmetric to _cra/_crbStartPending): a control
    // write that clears START makes the timer do ONE more count before freezing.
    // Set in the CRA/CRB write, consumed by the next clock(). Models the 6526's
    // one-cycle control-write delay — see testprogs/VICII/split-tests/bascan.
    // _cra/_crbStopControl snapshot the control register the timer was RUNNING
    // under at the stop write, so the delayed final count uses the count-source
    // mode in effect then — not a mode the same write may have flipped (e.g.
    // a write that clears START and toggles PHI2<->CNT). CPU reads of $DC0E/0F
    // still return the freshly-written value.
    this._craStopPending = 0;
    this._crbStopPending = 0;
    this._craStopControl = 0;
    this._crbStopControl = 0;

    // C64Machine calls beginMasterCycle (snapshot) before clock(1) at phi1.
    // Timer counter reads ($DC04-07) return the start-of-master-cycle value
    // (= the previous cycle's post-count), matching real silicon's live-phi2
    // read — deliberately one count behind the icrStatus the $DC0D read sees
    // (which reflects this cycle's underflow). See cia-timer-spec-test.
    this._timerReadWindow = false;
    this._timerAReadValue = this.timerA;
    this._timerBReadValue = this.timerB;
  }

  get irqState() {
    // /IRQ output = the IR latch (one clock behind the masked-data condition).
    return this._irLatch;
  }

  _updateIrq() {
    this.irqHandler(this.irqState);
  }

  // Called 50 times a second by the machine loop
  tick50Hz() {
    this.todDivider++;
    const maxDiv = (this.cra & 0x80) ? 5 : 6;
    if (this.todDivider >= maxDiv) {
      this.todDivider = 0;
      this._incTOD();
    }
  }

  _bcdAdd(val, add) {
    let lower = (val & 0x0F) + add;
    let upper = (val >> 4);
    if (lower > 9) { lower -= 10; upper++; }
    return (upper << 4) | lower;
  }

  _incTOD() {
    if (this.todHalted) return;

    this.tod10++;
    if (this.tod10 > 9) {
      this.tod10 = 0;
      this.todSec = this._bcdAdd(this.todSec, 1);
      if (this.todSec >= 0x60) {
        this.todSec = 0;
        this.todMin = this._bcdAdd(this.todMin, 1);
        if (this.todMin >= 0x60) {
          this.todMin = 0;
          let hr = this.todHr & 0x1F;
          let pm = this.todHr & 0x80;
          hr = this._bcdAdd(hr, 1);
          if (hr === 0x12) pm ^= 0x80;
          if (hr > 0x12) hr = 0x01;
          this.todHr = hr | pm;
        }
      }
    }

    if (this.tod10 === this.alm10 && this.todSec === this.almSec &&
        this.todMin === this.almMin && this.todHr === this.almHr) {
      this._raiseIcr(0x04);
    }

    if (!this.todLatched) {
      this.latch10  = this.tod10;  this.latchSec = this.todSec;
      this.latchMin = this.todMin; this.latchHr  = this.todHr;
    }
  }

  _raiseIcr(bit) {
    // Datasheet sheet 7: "Any interrupt will set the corresponding bit in the
    // DATA register." The IR bit (MSB) + /IRQ follow one clock later via the
    // _irLatch flip-flop in clock(), so we set only the data bit here.
    this.icrStatus |= bit;
  }

  // Returns true if a Timer A underflow occurred this tick.
  // Hot path — runs ~2× per master cycle (CIA1 + CIA2). Inlined as a
  // single-cycle step (every caller passes cycles=1). The IR-latch advance and
  // _irNextPending recompute run every clock (so FLAG / mask writes propagate
  // even with timers stopped); only the timer-counting work is gated behind a
  // started timer.
  clock(cycles) {
    if (cycles !== 1) {
      // Multi-cycle calls fall back to a simple loop. No internal caller hits
      // this; kept for API compatibility. OR the per-cycle results so a Timer A
      // underflow anywhere in the span is reported (it would otherwise be lost).
      let any = false;
      for (let i = 0; i < cycles; i++) any = this.clock(1) || any;
      return any;
    }

    // Advance the IR latch at the TOP of every clock, BEFORE this cycle's
    // underflows set any new data bit (datasheet sheet 7: the IR bit + /IRQ
    // follow the masked-data condition by one phi2). So a source bit set this
    // cycle is not visible on /IRQ until the next clock — and a $DC0D read in
    // that window sees the data bit without the IR bit ($01), the hallmark of
    // the interrupt-acknowledge bug (see read $0D + the _irAckRaceDelay block).
    const prevLatch = this._irLatch;
    if (this._irAckRaceDelay > 0) {
      // Ack-bug: a $DC0D read that races the IR latch being armed holds the
      // latch advance for one extra cycle. Because that read also emptied
      // icrStatus, the _irNextPending recompute below then clears the armed
      // condition — so on the old 6526 the IRQ that raced the read is
      // effectively swallowed (the read returns $01 but no IRQ is delivered in
      // the measurement window). This is what the irq-ackn-bug testprogs pin.
      this._irAckRaceDelay--;
    } else if (this._irNextPending) {
      // The IR flip-flop (/IRQ, ICR bit 7) is SET-DOMINANT and STICKY, NOT a
      // level copy of the masked-data condition (datasheet sheet 7 / Lorenz):
      // an armed (masked-source-present) condition matures it to 1, and once
      // set it stays set until an ICR read ($DC0D) clears it. Clearing the IMR
      // (mask) must NOT drop an already-latched IRQ — only a read acknowledges.
      // (icrStatus is only ever zeroed by an ICR read — which also clears
      // _irLatch — or reset(); so the sole case where _irNextPending lapses to
      // false while _irLatch is set is a mask-clear, exactly what stays sticky.)
      this._irLatch = true;
    }

    const cra = this.cra;
    const crb = this.crb;
    let anyUnderflow = false;

    // Sample and clear the CNT rising-edge flag EVERY clock, before the
    // "are any timers running?" gate below. A CNT edge that arrives while both
    // timers are stopped must NOT linger to be consumed by a later CNT-mode
    // start — edge detection is per-clock on real silicon, not a sticky latch.
    const cntRising = this._cntRising;
    this._cntRising = false;

    // Timer work only runs when a timer is started (or finishing a delayed
    // stop); the latch logic above and the _irNextPending recompute below run
    // every clock regardless.
    if ((cra & 0x01) !== 0 || (crb & 0x01) !== 0 ||
        this._craStopPending || this._crbStopPending) {
      let aUnderflow = false;

      // Underflow occurs one tick after the counter reaches 0. `_craStopPending`
      // lets the timer do ONE final count after a CRA-write cleared START (the
      // one-cycle 6526 control-write delay; see the CRA write handler).
      if ((cra & 0x01) || this._craStopPending) {
        // CRA bit 5 selects Timer A's count source: 0 = every PHI2 cycle,
        // 1 = CNT positive edges (symmetric to Timer B's count modes). In CNT
        // mode the counter only advances on a rising edge seen this clock. The
        // delayed final count after a STOP uses the mode the timer was RUNNING
        // under (snapshot), not a mode the stop write may have changed.
        const ctrlA = (cra & 0x01) ? cra : this._craStopControl;
        const shouldCountA = (ctrlA & 0x20) ? cntRising : true;
        if (this._craStartPending > 0) {
          // Skip the count for `_craStartPending` (=2) clocks after LOAD+START.
          // Combined with the machine's phi1 CIA clock (the write is first seen
          // next cycle) this is the 3-clock NET load phase the stable-IRQ timer
          // path needs — the `lda $dc04` low bits compensate IRQ-entry jitter
          // and land the first side-border $D016 write on the intended cycle.
          this._craStartPending--;
        } else if (shouldCountA) {
          if (this.timerA === 0) {
            // A latch of 0 is legal and means "underflow every cycle" (period
            // 1) — NOT 0xFFFF. The old `latchA || 0xFFFF` corrupted a 0-latch
            // into the maximum period (cia-int timer-value-0 column never fired).
            this.timerA = this.latchA;
            this._raiseIcr(0x01);
            aUnderflow = true;
            anyUnderflow = true;
            if (cra & 0x08) this.cra = cra & ~0x01; // one-shot
          } else {
            this.timerA = (this.timerA - 1) & 0xFFFF;
          }
        }
        // Consume the delayed-stop count: the timer is now frozen.
        if (this._craStopPending) this._craStopPending = 0;
      }

      // SDR output: each Timer A underflow shifts a half-bit on CNT. 16
      // underflows = 8 bits => SP IRQ (ICR bit 3). Only counts when shifting
      // has been armed by an SDR write while in output mode.
      if (aUnderflow && this._sdrShifting && (cra & 0x40)) {
        this._sdrCount++;
        if (this._sdrCount >= 16) {
          this._sdrCount = 0;
          this._raiseIcr(0x08);
          if (this._sdrPending) this._sdrPending = false; // re-arm: keep shifting
          else                   this._sdrShifting = false;
        }
      }

      // Timer B count modes:
      // 00 = PHI2
      // 01 = CNT positive edge
      // 10 = Timer A underflow
      // 11 = Timer A underflow while CNT high
      // `_crbStopPending` lets Timer B do ONE final count after a CRB-write
      // cleared START (symmetric to Timer A; see the CRB write handler).
      if ((crb & 0x01) || this._crbStopPending) {
        // Final count after a STOP uses the count mode the timer was RUNNING
        // under (snapshot), not a mode the stop write may have changed.
        const ctrlB = (crb & 0x01) ? crb : this._crbStopControl;
        const countMode = (ctrlB >> 5) & 0x03;
        const inLoadPhase = this._crbStartPending > 0;
        if (inLoadPhase) this._crbStartPending--;
        // The LOAD+START load phase blocks only the PHI2-clocked count (the
        // stable-IRQ path). External-clocked modes (CNT / Timer-A-underflow
        // cascade) count from the first clock — VICE counts the TA underflow
        // that lands in the load-phase window, so ours must too (#15 cascade
        // oracle: without this, ours lags VICE by exactly one cascade count).
        const shouldCount =
          (countMode === 0 && !inLoadPhase) ||
          (countMode === 1 && cntRising) ||
          (countMode === 2 && aUnderflow) ||
          (countMode === 3 && aUnderflow && this._cntLevel === 1);
        if (shouldCount) {
          if (this.timerB === 0) {
            this.timerB = this.latchB; // latch 0 => period 1 (see Timer A)
            this._raiseIcr(0x02);
            if (crb & 0x08) this.crb = crb & ~0x01; // one-shot
          } else {
            this.timerB = (this.timerB - 1) & 0xFFFF;
          }
        }
        // Consume the delayed-stop count: Timer B is now frozen.
        if (this._crbStopPending) this._crbStopPending = 0;
      }
    }

    // Arm the IR latch for the next clock from the current (post-underflow)
    // masked-data condition. NOT recomputed on $DC0D read — that's the bug.
    this._irNextPending = (this.icrStatus & this.icrMask & 0x1F) !== 0;

    // Only ping the machine when the /IRQ output actually changed.
    if (this._irLatch !== prevLatch) this._updateIrq();
    return anyUnderflow;
  }

  get irqPending() {
    return (this.icrStatus & this.icrMask & 0x1F) !== 0;
  }

  beginMasterCycle() {
    this._timerAReadValue = this.timerA;
    this._timerBReadValue = this.timerB;
    this._timerReadWindow = true;
  }

  endMasterCycle() {
    this._timerReadWindow = false;
  }

  _visibleTimerARead() {
    const timerARead = this._timerReadWindow ? this._timerAReadValue : this.timerA;
    return ((this.cra & 0x21) === 0x01 && timerARead === 0) ? this.latchA : timerARead;
  }

  _visibleTimerBRead() {
    const timerBRead = this._timerReadWindow ? this._timerBReadValue : this.timerB;
    return ((this.crb & 0x61) === 0x01 && timerBRead === 0) ? this.latchB : timerBRead;
  }

  read(reg) {
    // #14 underflow read aperture: a PHI2-clocked running timer momentarily 0 at
    // underflow reloads from the latch, and a read on that cycle returns the
    // reloaded value (VICE-oracle confirmed). The counter still passes through 0
    // internally so the period (latch+1) and cascade are unchanged. This applies
    // ONLY in PHI2 count mode (CRA bit5 / CRB bits6-5 clear): there the 0 is
    // transient (reload next cycle). In CNT/cascade modes the count input is
    // sparse so 0 PERSISTS until the next count event and a read returns 0 — the
    // #15 cascade oracle confirms VICE reads 0 there. A STOPPED timer at 0 reads 0.
    // taVal/tbVal are computed lazily in the 0x04-0x07 cases below — both
    // _visibleTimer*Read() are pure, so this is behavior-identical and skips the
    // two calls on the common non-timer reads (ICR poll, keyboard scan, ports).
    switch (reg & 0x0F) {
      case 0x00: 
        if (this.readPortA) return this.readPortA();
        return (this.portA & this.portADir) | (0xFF & ~this.portADir);
      case 0x01:
        if (this.id === 1) {
          // CIA1 Port B: per-bit, output pins (DDR=1) read back the output
          // latch while input pins (DDR=0) read the keyboard-matrix row state
          // (wired-AND of the selected columns). The normal KERNAL scan uses
          // DDRB=$00 so this still returns the pure keyboard read. But the TLR
          // cia-int test executes instructions straight out of $DC01 with
          // DDRB=$FF — returning the keyboard unconditionally (ignoring DDRB)
          // made the latch invisible, so a written RTS read back as $FF and
          // crashed test 5 into a BRK storm.
          return ((this.portB & this.portBDir) |
                  (this._readKeyboard() & ~this.portBDir)) & 0xFF;
        }
        if (this.readPortB) return this.readPortB();
        return (this.portB & this.portBDir) | (0xFF & ~this.portBDir);
      case 0x02: return this.portADir;
      case 0x03: return this.portBDir;
      case 0x04: return this._visibleTimerARead() & 0xFF;
      case 0x05: return (this._visibleTimerARead() >> 8) & 0xFF;
      case 0x06: return this._visibleTimerBRead() & 0xFF;
      case 0x07: return (this._visibleTimerBRead() >> 8) & 0xFF;
      // TOD reads. Per CIA datasheet: reading hours LATCHES the displayed
      // time (snapshots tod* → latch*); reading tenths UNLATCHES. While
      // latched, all four registers return their latched snapshot. While
      // unlatched, _incTOD keeps the latches mirrored to live tod*.
      case 0x08: {
        const v = this.todLatched ? this.latch10 : this.tod10;
        this.todLatched = false;
        return v;
      }
      case 0x09: return this.todLatched ? this.latchSec : this.todSec;
      case 0x0A: return this.todLatched ? this.latchMin : this.todMin;
      case 0x0B: {
        const v = this.todLatched ? this.latchHr : this.todHr;
        if (!this.todLatched) {
          this.latch10  = this.tod10;
          this.latchSec = this.todSec;
          this.latchMin = this.todMin;
          this.latchHr  = this.todHr;
          this.todLatched = true;
        }
        return v;
      }
      case 0x0C: return this.sdr;
      case 0x0D: {
        // Returns the DATA register (bits 0-4) + the IR latch (bit 7), then
        // clears the data register and the IR latch and returns /IRQ high
        // (datasheet sheet 7). The machine clocks the CIA at phi1 (before the
        // CPU), so this read already sees this cycle's underflow in icrStatus
        // while the IR latch still lags one cycle.
        //
        // The interrupt-acknowledge bug turns on whether the IR was ALREADY
        // latched at read time:
        //  • IR latched ($80 set) → a clean acknowledge: clear the data, the
        //    latch AND the pending-IR, so /IRQ stays high (no further IRQ).
        //  • IR not yet latched but a source bit just set this cycle (reads
        //    $01-style) → the read returns the data bit WITHOUT bit 7 and
        //    cannot acknowledge the IR armed on this cycle's clock. The latch
        //    advance is held one extra cycle (_irAckRaceDelay) and this read
        //    already emptied icrStatus, so the armed condition clears before it
        //    can latch — the interrupt is SWALLOWED, no IRQ delivered. This is
        //    the ack bug; see clock() + the cia-irq-ackn-bug spec test
        //    (old-6526 CIA reference). (The clock() comment says the same.)
        const irWasLatched = this._irLatch;
        const v = (this.icrStatus & 0x1F) | (irWasLatched ? 0x80 : 0);
        this.icrStatus = 0;
        this._irLatch = false;
        if (irWasLatched) {
          this._irNextPending = false;
        } else if (this._irNextPending) {
          // Race: a source bit was armed on this cycle's clock but the IR
          // hasn't latched yet. Defer the latch advance one cycle. Because this
          // read already cleared icrStatus, the armed condition recomputes false
          // in clock() before it can latch — so the old-6526 ack bug SWALLOWS
          // this IRQ (NOT "late but delivered"; that would need a separate
          // sticky-pending latch). See clock() + the cia-irq-ackn-bug test.
          this._irAckRaceDelay = 1;
        }
        this._updateIrq();
        return v;
      }
      case 0x0E: return this.cra;
      case 0x0F: return this.crb;
      default:   return 0xFF;
    }
  }

  peek(reg) {
    // peek() is the side-effect-FREE value used by CPU predecode before queuing
    // micro-ops. It matches read() for timer registers. (taVal/tbVal computed
    // lazily in the 0x04-0x07 cases below — pure reads, behavior-identical.)
    switch (reg & 0x0F) {
      case 0x00:
        if (this.readPortA) return this.readPortA();
        return (this.portA & this.portADir) | (0xFF & ~this.portADir);
      case 0x01:
        if (this.id === 1) {
          return ((this.portB & this.portBDir) |
                  (this._readKeyboard() & ~this.portBDir)) & 0xFF;
        }
        if (this.readPortB) return this.readPortB();
        return (this.portB & this.portBDir) | (0xFF & ~this.portBDir);
      case 0x02: return this.portADir;
      case 0x03: return this.portBDir;
      case 0x04: return this._visibleTimerARead() & 0xFF;
      case 0x05: return (this._visibleTimerARead() >> 8) & 0xFF;
      case 0x06: return this._visibleTimerBRead() & 0xFF;
      case 0x07: return (this._visibleTimerBRead() >> 8) & 0xFF;
      case 0x08: return this.todLatched ? this.latch10 : this.tod10;
      case 0x09: return this.todLatched ? this.latchSec : this.todSec;
      case 0x0A: return this.todLatched ? this.latchMin : this.todMin;
      case 0x0B: return this.todLatched ? this.latchHr : this.todHr;
      case 0x0C: return this.sdr;
      case 0x0D: return (this.icrStatus & 0x1F) | (this._irLatch ? 0x80 : 0);
      case 0x0E: return this.cra;
      case 0x0F: return this.crb;
      default: return 0xFF;
    }
  }

  write(reg, val) {
    switch (reg & 0x0F) {
      case 0x00: 
        this.portA = val; 
        if (this.writePortA) this.writePortA(val);
        break;
      case 0x01: 
        this.portB = val; 
        if (this.writePortB) this.writePortB(val);
        break;
      case 0x02: {
        const oldDdra = this.portADir;
        this.portADir = val;
        // writePortA gets (val, viaDir=true, oldDdra) when called from
        // the DDRA path — consumers that care about input→output
        // transitions on PA0/PA1 (e.g. CIA2 → VIC bank with the NMOS
        // bit-set delay) can detect them without re-reading the latch.
        if (this.writePortA) this.writePortA(this.portA, true, oldDdra);
        break;
      }
      case 0x03: 
        this.portBDir = val; 
        if (this.writePortB) this.writePortB(this.portB);
        break;
      case 0x04: this.latchA = (this.latchA & 0xFF00) | val; break;
      case 0x05:
        this.latchA = (this.latchA & 0x00FF) | (val << 8);
        if (!(this.cra & 0x01)) this.timerA = this.latchA; // 0-latch stays 0
        break;
      case 0x06: this.latchB = (this.latchB & 0xFF00) | val; break;
      case 0x07:
        this.latchB = (this.latchB & 0x00FF) | (val << 8);
        if (!(this.crb & 0x01)) this.timerB = this.latchB; // 0-latch stays 0
        break;
      case 0x08:
        if (this.crb & 0x80) this.alm10 = val & 0x0F;
        else { this.tod10 = val & 0x0F; this.todHalted = false; }
        break;
      case 0x09:
        if (this.crb & 0x80) this.almSec = val & 0x7F;
        else this.todSec = val & 0x7F;
        break;
      case 0x0A:
        if (this.crb & 0x80) this.almMin = val & 0x7F;
        else this.todMin = val & 0x7F;
        break;
      case 0x0B:
        if (this.crb & 0x80) this.almHr = val & 0x9F;
        else { this.todHr = val & 0x9F; this.todHalted = true; }
        break;
      case 0x0C:
        this.sdr = val;
        // Arm SDR shifting if currently in output mode. If a shift is
        // already active, queue this byte to be sent right after.
        if (this.cra & 0x40) {
          if (this._sdrShifting) this._sdrPending = true;
          else { this._sdrShifting = true; this._sdrCount = 0; }
        }
        break;
      case 0x0D:
        if (val & 0x80) this.icrMask |= (val & 0x7F);
        else            this.icrMask &= ~(val & 0x7F);
        // The (data & mask) condition is combinatorial, so re-evaluate it now;
        // the IR latch / /IRQ follows it on the next clock() (datasheet sheet 7:
        // an enabled, already-set interrupt sets the IR bit). No immediate
        // assert — the one-clock IR-latch delay is what clock() applies.
        this._irNextPending = (this.icrStatus & this.icrMask & 0x1F) !== 0;
        break;
      case 0x0E: {
        const oldCra = this.cra;
        const wasOutput = this.cra & 0x40;
        const wasRunning = this.cra & 0x01;
        this.cra = val & ~0x10;
        // CRA write that STOPS the running timer (bit0 1→0) without a
        // force-load takes effect with a ONE-CYCLE delay: the timer does one
        // more count before freezing (symmetric to _craStartPending). The CIA
        // is clocked at phi1, before this phi2 write, so by stopping "now" we'd
        // freeze one count too early; real hardware counts the write cycle's
        // (and next) tick. _craStopPending lets clock() do one final decrement.
        // See testprogs/VICII/split-tests/bascan (tests 3 & 6: read $dc04 right
        // after a CRA stop/RMW). cra bit0 is already 0 here so reads of $dc0e
        // return the written value.
        if (wasRunning && !(val & 0x01) && !(val & 0x10)) {
          this._craStopPending = 1;
          this._craStopControl = oldCra;   // mode the timer was running under
        }
        // A write that leaves START clear cancels any pending LOAD+START load
        // phase — otherwise a stale countdown would delay a later plain START
        // by one count (the load phase only belongs to the LOAD+START it armed).
        if (!(val & 0x01)) this._craStartPending = 0;
        if (val & 0x10) this.timerA = this.latchA; // force-load; 0-latch stays 0
        // Force-load (bit 4) WITH start (bit 0) write→count latency.
        // Plain START without LOAD has no internal delay; LOAD+START
        // holds the loaded value for a 2-clock load phase. The CIA is clocked
        // at phi1 (before the CPU writes this register), so the write is first
        // seen by NEXT cycle's clock — that extra cycle + this 2-clock phase
        // reproduces the 3-clock net load phase the old CIA-after-CPU ordering
        // needed (see cia-force-load-edge-spec-test). Covered there.
        if ((val & 0x10) && (this.cra & 0x01)) this._craStartPending = 2;
        // Plain START 0→1 (no force-load) holds the count for ONE clock
        // before the first decrement — measured vs VICE (cia-start oracle:
        // stopped timer, latch preloaded, $DC0E=$01 → every subsequent read
        // is one higher than our old immediate-count model, on TA and TB
        // alike; the $11 FORCE+START path above was already exact). Reuses
        // _craStartPending as a pure count-skip — no load semantics here.
        if (!wasRunning && (val & 0x01) && !(val & 0x10)) this._craStartPending = 1;
        // Switching SP out -> in cancels any in-progress shift.
        if (wasOutput && !(this.cra & 0x40)) {
          this._sdrShifting = false;
          this._sdrPending = false;
          this._sdrCount = 0;
        }
        break;
      }
      case 0x0F: {
        const oldCrb = this.crb;
        const wasRunning = this.crb & 0x01;
        this.crb = val & ~0x10;
        // CRB write that STOPS a running Timer B (bit0 1→0) without a force-load
        // takes effect with a ONE-CYCLE delay — one more count before freezing,
        // symmetric to _craStopPending. The CIA is clocked at phi1, before this
        // phi2 write, so stopping "now" would freeze one count too early.
        if (wasRunning && !(val & 0x01) && !(val & 0x10)) {
          this._crbStopPending = 1;
          this._crbStopControl = oldCrb;   // count mode the timer was running under
        }
        // A write that leaves START clear cancels any pending LOAD+START load
        // phase (see the CRA handler).
        if (!(val & 0x01)) this._crbStartPending = 0;
        if (val & 0x10) this.timerB = this.latchB; // force-load; 0-latch stays 0
        if ((val & 0x10) && (this.crb & 0x01)) this._crbStartPending = 2;
        // Plain START 0→1 count-hold, symmetric to the CRA handler above
        // (one-clock skip, VICE-measured on TB via the cia-start oracle).
        if (!wasRunning && (val & 0x01) && !(val & 0x10)) this._crbStartPending = 1;
        break;
      }
    }
  }

  // CIA1 Port B read: AND all selected columns' row states
  _readKeyboard() {
    let result = 0xFF;
    // A column is actively selected only by an OUTPUT pin driven low. Apply
    // DDRA so input pins (DDR bit = 0) read high (matrix pull-ups) and never
    // select a column — raw portA would let a stale output-latch bit select
    // columns on pins configured as inputs. Identical to portA when DDRA=$FF
    // (the KERNAL scan case), so normal typing is unaffected; matters when code
    // runs the scan with DDRA != $FF. Matches the read($DC00)/vicBank PA model.
    const sel = (this.portA & this.portADir) | (~this.portADir & 0xFF);
    for (let col = 0; col < 8; col++) {
      if (!(sel & (1 << col))) {
        result &= this.matrix[col];
      }
    }
    return result;
  }

  // Set a key state in the matrix
  setKey(col, row, pressed) {
    if (pressed) this.matrix[col] &= ~(1 << row);
    else         this.matrix[col] |=  (1 << row);
  }

  isKeyDown(col, row) {
    return !(this.matrix[col] & (1 << row));
  }

  // VIC-II bank from CIA2 Port A bits 0-1.
  // PA0-PA1 have external pull-ups: input pins (DDR=0) float HIGH.
  get vicBank() {
    const effective = (this.portA & this.portADir) | (~this.portADir & 0xFF);
    return (3 - (effective & 0x03)) * 0x4000;
  }

  // CIA1 only: called by Datasette on each tape pulse edge.
  // A falling edge (1→0) sets ICR bit 4 (FLAG) and may fire an IRQ.
  setFlag(level) {
    if (this._flagLevel === 1 && level === 0) {
      // Sets the FLAG data bit; the IR latch picks it up on the next clock().
      this._raiseIcr(0x10);
    }
    this._flagLevel = level;
  }

  setCnt(level) {
    level &= 1;
    if (this._cntLevel === 0 && level === 1) {
      this._cntRising = true;
    }
    this._cntLevel = level;
  }

  reset() {
    this.timerA = 0xFFFF;  this.latchA = 0xFFFF;
    this.timerB = 0xFFFF;  this.latchB = 0xFFFF;
    this.cra = 0; this.crb = 0;
    this.icrStatus = 0; this.icrMask = 0;
    this._irLatch = false; this._irNextPending = false;
    this._irAckRaceDelay = 0;
    this.portA = 0x00; this.portB = 0x00;
    this.portADir = 0x00; this.portBDir = 0x00;
    this.sdr = 0x00;
    this.matrix.fill(0xFF);
    this.tod10 = 0; this.todSec = 0; this.todMin = 0; this.todHr = 0x12;
    this.alm10 = 0; this.almSec = 0; this.almMin = 0; this.almHr = 0;
    this.latch10 = 0; this.latchSec = 0; this.latchMin = 0; this.latchHr = 0x12;
    this.todHalted = false;
    this.todLatched = false;
    this.todDivider = 0;
    this._flagLevel = 1;
    this._cntLevel = 1;
    this._cntRising = false;
    this._sdrShifting = false;
    this._sdrPending = false;
    this._sdrCount = 0;
    this._craStartPending = 0;
    this._crbStartPending = 0;
    this._craStopPending = 0;
    this._crbStopPending = 0;
    this._craStopControl = 0;
    this._crbStopControl = 0;
    this._timerReadWindow = false;
    this._timerAReadValue = this.timerA;
    this._timerBReadValue = this.timerB;
    this._updateIrq();
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // Full logical state including the interrupt/timer pipeline latches a
  // restore needs to resume cycle-exact. irqHandler is re-wired by the machine.
  // The keyboard `matrix` is deliberately NOT persisted: it is live physical
  // key state, re-applied by the UI, and a key "held" at save time has no keyup
  // in a restored session — it would stay stuck forever (a baked-in CTRL breaks
  // loaders that do an exact CMP on the col-7 keyboard read: the "hit space"
  // bug). deserialize() resets it to all-released instead.
  serialize() {
    return {
      timerA: this.timerA, latchA: this.latchA,
      timerB: this.timerB, latchB: this.latchB,
      cra: this.cra, crb: this.crb,
      icrStatus: this.icrStatus, icrMask: this.icrMask,
      _irLatch: this._irLatch, _irNextPending: this._irNextPending,
      _irAckRaceDelay: this._irAckRaceDelay,
      portA: this.portA, portADir: this.portADir,
      portB: this.portB, portBDir: this.portBDir,
      sdr: this.sdr,
      prevIrq: this.prevIrq,
      tod10: this.tod10, todSec: this.todSec, todMin: this.todMin, todHr: this.todHr,
      alm10: this.alm10, almSec: this.almSec, almMin: this.almMin, almHr: this.almHr,
      latch10: this.latch10, latchSec: this.latchSec, latchMin: this.latchMin, latchHr: this.latchHr,
      todHalted: this.todHalted, todLatched: this.todLatched, todDivider: this.todDivider,
      _flagLevel: this._flagLevel, _cntLevel: this._cntLevel, _cntRising: this._cntRising,
      _sdrShifting: this._sdrShifting, _sdrCount: this._sdrCount, _sdrPending: this._sdrPending,
      _craStartPending: this._craStartPending, _crbStartPending: this._crbStartPending,
      _craStopPending: this._craStopPending, _crbStopPending: this._crbStopPending,
      _craStopControl: this._craStopControl, _crbStopControl: this._crbStopControl,
      _timerReadWindow: this._timerReadWindow,
      _timerAReadValue: this._timerAReadValue, _timerBReadValue: this._timerBReadValue,
    };
  }

  deserialize(s) {
    this.timerA = s.timerA & 0xFFFF; this.latchA = s.latchA & 0xFFFF;
    this.timerB = s.timerB & 0xFFFF; this.latchB = s.latchB & 0xFFFF;
    this.cra = s.cra & 0xFF; this.crb = s.crb & 0xFF;
    this.icrStatus = s.icrStatus & 0xFF; this.icrMask = s.icrMask & 0xFF;
    this._irLatch = !!s._irLatch; this._irNextPending = !!s._irNextPending;
    this._irAckRaceDelay = s._irAckRaceDelay | 0;
    this.portA = s.portA & 0xFF; this.portADir = s.portADir & 0xFF;
    this.portB = s.portB & 0xFF; this.portBDir = s.portBDir & 0xFF;
    this.sdr = s.sdr & 0xFF;
    // Never restore held keys (see serialize() note). Start all-released; the
    // UI re-applies live key state. Older save files may still carry `matrix` —
    // ignore it. This is what makes a loaded state's keyboard read cleanly.
    this.matrix.fill(0xFF);
    this.prevIrq = !!s.prevIrq;
    this.tod10 = s.tod10; this.todSec = s.todSec; this.todMin = s.todMin; this.todHr = s.todHr;
    this.alm10 = s.alm10; this.almSec = s.almSec; this.almMin = s.almMin; this.almHr = s.almHr;
    this.latch10 = s.latch10; this.latchSec = s.latchSec; this.latchMin = s.latchMin; this.latchHr = s.latchHr;
    this.todHalted = !!s.todHalted; this.todLatched = !!s.todLatched; this.todDivider = s.todDivider | 0;
    this._flagLevel = s._flagLevel; this._cntLevel = s._cntLevel; this._cntRising = !!s._cntRising;
    this._sdrShifting = !!s._sdrShifting; this._sdrCount = s._sdrCount | 0; this._sdrPending = !!s._sdrPending;
    this._craStartPending = s._craStartPending | 0; this._crbStartPending = s._crbStartPending | 0;
    this._craStopPending = s._craStopPending | 0; this._crbStopPending = s._crbStopPending | 0;
    this._craStopControl = s._craStopControl | 0; this._crbStopControl = s._crbStopControl | 0;
    this._timerReadWindow = !!s._timerReadWindow;
    this._timerAReadValue = s._timerAReadValue & 0xFFFF; this._timerBReadValue = s._timerBReadValue & 0xFFFF;
    this._updateIrq();
  }
}
