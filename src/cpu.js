// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/cpu.js – MOS 6510 CPU
// All official + illegal opcodes. Reads/writes delegate to a memory object.

// Microop bus-kind codes. Stored as bytes in microOpKinds (Uint8Array) for
// fast indexed reads in the dispatcher. The current microop kind is kept as a
// numeric byte (currentMicroOpKindByte) to avoid a per-cycle string store; the
// public string `currentMicroOpKind` is exposed via a getter (KIND_NAMES) for
// the debug bus-trace, the only consumer.
const KIND_INTERNAL = 0;
const KIND_READ = 1;
const KIND_WRITE = 2;
const KIND_NAMES = ['internal', 'read', 'write'];

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.a = 0; this.x = 0; this.y = 0;
    // SP starts at $00 so the first reset's 3 dummy stack reads decrement
    // it to $FD — matches what a cold-boot 6502 produces after reset.
    this.pc = 0; this.sp = 0x00;
    this.N = 0; this.V = 0; this.D = 0; this.I = 1; this.Z = 0; this.C = 0;
    this.irqLine = false;   // Level-triggered IRQ pin state
    // ⚠ NOT the physical CIA2 /NMI pin level. The machine (_sampleCpuInterrupts)
    // edge-detects the CIA2 /NMI level itself and drives setNmiLine() as a
    // one-cycle EDGE PULSE (true the cycle an edge is presented, false otherwise).
    // nmiLine is only the internal prev-state for setNmiLine's 0→1 edge detect;
    // recognition uses nmiEdge/sampledNmiEdge, never nmiLine. Do not read nmiLine
    // as "is /NMI asserted" — it isn't.
    this.nmiLine = false;   // prev-state for edge detect (NOT the physical pin level)
    this.nmiEdge = false;   // Latched NMI edge (set on nmiLine 0→1; consumed at vector)
    // NMI-hijack-of-IRQ/BRK transient state (mid-interrupt-sequence only; never
    // persists across an instruction boundary, so not serialized). See
    // _seqSampleNmi / _seqResolveVector.
    this._intSeqHijackable = false;  // this sequence is IRQ/BRK ($FFFE), redirectable to $FFFA
    this._intSeqNmiLatched = false;  // a /NMI became pending during cycles 1-5
    this._intSeqVector = 0;          // the vector actually committed at cy6
    this.halted = false;
    this.pageCrossed = 0;   // +1 cycle penalty for page-boundary crossing
    this.instructionCyclesRemaining = 0;
    // Microop queue uses parallel arrays instead of {fn, kind} objects.
    // _readOp/_writeOp/_internalOp push fn+kind directly via side-effect
    // (array literals at call sites still work — they collect the
    // returned undefineds, which _queueMicroOps ignores). microOpHead
    // is the index of the next op to dispatch; microOpLen is the
    // running count of queued ops. Pre-sized to a comfortable upper
    // bound — the longest path is the BRK/IRQ vector at 7 ops, plus
    // branch/page-cross adds 2.
    this.microOpFns = new Array(16);
    this.microOpKinds = new Uint8Array(16);
    // Writable scratch for the micro-op queue. Dispatch aliases a pre-built
    // program (this.microOpFns = template) with no copy; if an instruction
    // rewrites its own program at runtime (branch extra cycle, indexed page
    // cross) or the interrupt/fallback path builds via _op, we copy-on-write
    // back into this scratch first so the shared template is never mutated.
    // (Same object as the initial arrays — they double as the build scratchpad.)
    this._scratchFns = this.microOpFns;
    this._scratchKinds = this.microOpKinds;
    // Pre-built 1-cycle halt program (JAM/KIL). A halted CPU dispatches one
    // internal (dummy-bus) op every cycle until RESET. Building it inline
    // (_queueMicroOps([_internalOp(() => {})])) allocated a fresh closure + array
    // literal every cycle — ~1 MB/frame on any crash/end screen parked on JAM.
    // Installed by reference like an opcode template: holey fns array + Uint8Array
    // kinds, matching _buildOpcodeTable so the dispatch load site stays
    // elements-kind-monomorphic. A halted CPU never appends ops, so the template
    // is never rewritten — and the _op copy-on-write guard protects it regardless.
    this._haltFns = new Array(1);
    this._haltFns[0] = () => { };
    this._haltKinds = new Uint8Array(1);   // [KIND_INTERNAL] (= 0)
    this.microOpHead = 0;
    this.microOpLen = 0;
    this.tmpAddr = 0;
    this.tmpLo = 0;
    this.tmpFalseAddr = 0;  // 6502 indexed false/wrapped address for the page-cross dummy access
    this._shValue = 0;   // staged ANDed value for SHA/SHX/SHY/TAS store-illegals
    this._shReg = 0;     // staged un-ANDed register (stored when the AND drops off)
    this.currentMicroOpKindByte = KIND_INTERNAL;
    // The I value the interrupt poll sees. CLI/SEI/PLP write I in their
    // FINAL cycle, after their own poll, so _pollI lags this.I by exactly
    // one instruction boundary for those opcodes — both directions (late
    // unmask AND late mask). RTI and the IRQ/NMI/BRK sequences update it
    // immediately. Synced to this.I at every boundary poll and on every
    // stalled boundary cycle (stallBoundaryPoll).
    this._pollI = 1;
    this._iWriteThisInstr = false;
    this._seiMaskStalled = false;
    this._seiPreStallLine = false;
    this._shArmDrop = false;
    this._shDropAnd = false;
    this.sampledIrq = false;
    this.sampledIrqLate = false;
    // Previous cycle's sampledIrq snapshot — preserved before each cycle's
    // sample update. Read by the branch-no-cross delay logic: the NMOS
    // quirk's "early poll" for taken-no-cross branches happens at the
    // cycle BEFORE the branch's last cycle. sampledIrqPrev captures that
    // value so the delay flag is set only when the early poll missed.
    this.sampledIrqPrev = false;
    this.sampledIrqLatePrev = false;
    // NMI recognition phase. The IRQ is recognized from sampledIrq (sampled
    // during the PRIOR cycle → a 1-cycle recognition lag). The NMI used to be
    // recognized from nmiEdge DIRECTLY (0 lag), so an NMI was acted on one
    // boundary EARLIER than an identically-timed IRQ. sampledNmiEdge samples
    // nmiEdge in the same per-cycle block as sampledIrq, making NMI recognition
    // phase-symmetric with IRQ — the 7-cycle entry sequence is unchanged, only
    // the recognition point shifts by one cycle. Fixes The Hat's periodic NMI
    // landing one cycle early in the $8c1a RTS-dispatch window (oracle:
    // cia-int-nmi; verified against a VICE trace of the same window).
    this.sampledNmiEdge = false;
    this.sampledNmiEdgePrev = false;   // prior-cycle sampledNmiEdge (branch early-poll, NMI)
    // Diagnostic hook: invoked when the CPU starts vectoring an interrupt
    // (the boundary at which _queueInterruptMicroOps fires). Receives 'irq'
    // or 'nmi'. Default no-op; machine integration may attach a frame trace.
    this.onInterruptAccept = null;
    this.irqLineLate = false;
    // NMOS 6502 branch-no-cross IRQ delay:
    // a taken branch with no page-cross defers IRQ/NMI recognition by
    // one boundary. Tracked PER SOURCE (the early-poll catch is source-specific;
    // a shared flag mis-phased NMI). Set in the branch's final cycle, consumed at
    // the next instruction's _beginMicroInstruction interrupt check.
    this._branchIrqNoCrossDelay = false;
    this._branchNmiNoCrossDelay = false;
    // Real 6510 performs a bus access every cycle, even internal ones.
    // When true, clock() synthesizes a discarded read at PC after any
    // KIND_INTERNAL microop so the external/internal bus latches reflect
    // the real chip behavior.
    // A/B gate: false skips the extra reads.
    this.cpuInternalCycleDrivesBus = true;

    // Branch extra-cycle micro-ops, pre-created ONCE (the taken cycle + the
    // page-cross cycle). A taken branch fires ~once per idle KERNAL-loop
    // iteration, so building these closures fresh each time was the dominant
    // idle allocation on JSC/mobile. They read the branch's operands from
    // instance fields (set by the decode cycle immediately before they run —
    // one instruction executes at a time, so no overlap) instead of capturing
    // per-dispatch locals, which is what lets them be shared + pre-created.
    // Appended via _readOp at runtime; see _queueBranchMicroOps.
    this._branchTarget = 0;
    this._branchCrossed = false;
    this._branchTakenOp = () => {
      this.r((this.pc & 0xFF00) | (this._branchTarget & 0x00FF));
      this.pc = this._branchTarget;
      // Per-source early-poll: delay only the source whose interrupt was NOT
      // already caught at the branch's early poll (see _queueBranchMicroOps).
      const irqCaughtAtEarlyPoll = this.sampledIrqPrev && !this.sampledIrqLatePrev;
      const nmiCaughtAtEarlyPoll = this.sampledNmiEdgePrev;
      if (!this._branchCrossed) {
        if (!irqCaughtAtEarlyPoll) this._branchIrqNoCrossDelay = true;
        if (!nmiCaughtAtEarlyPoll) this._branchNmiNoCrossDelay = true;
      }
    };
    this._branchCrossOp = () => { this.r(this.pc); };

    // Interrupt (IRQ/NMI) 7-cycle sequence, pre-created ONCE. An IRQ fires ~once
    // per frame even at the idle READY prompt (KERNAL raster/timer IRQ), so
    // rebuilding these 7 closures + a throwaway array on every interrupt was the
    // last idle allocation. Capture-free: they read _intSeqBaseVector (the stable
    // base — an NMI hijack rewrites the live _intSeqVector at cy6) and the usual
    // sequence state. Pushed by reference in _queueInterruptMicroOps.
    this._intSeqBaseVector = 0;
    this._intSeqOp1 = () => { this.r(this.pc); };
    this._intSeqOp2 = () => { this.r(this.pc); this._seqSampleNmi(); };
    this._intSeqOp3 = () => { this._push((this.pc >> 8) & 0xFF); this._seqSampleNmi(); };
    this._intSeqOp4 = () => { this._push(this.pc & 0xFF); this._seqSampleNmi(); };
    this._intSeqOp5 = () => {
      this._push(this.getP() & ~0x10);
      this.I = 1;
      this._pollI = 1;        // sequence I-write is poll-visible immediately (no shadow)
      this._seqSampleNmi();   // last cycle a /NMI can latch to hijack the vector
      // NOTE: do NOT clear this.halted here — a JAMmed CPU never reaches this code
      // (interrupt vectoring is gated off while halted) and only RESET recovers a jam.
    };
    this._intSeqOp6 = () => { this._seqSampleNmi(); this.tmpLo = this.r(this._seqResolveVector(this._intSeqBaseVector)); };
    this._intSeqOp7 = () => { this.pc = this.tmpLo | (this.r(this._intSeqVector + 1) << 8); };

    // Pre-build the per-opcode micro-op program table (once). Runs each opcode's
    // builder here so the closures are created a single time; dispatch then
    // replays them with no allocation. Must be last — after every field the
    // builders' build-time code touches (microOp arrays, pageCrossed) exists.
    this._buildOpcodeTable();
  }

  reset() {
    // Per MOS 6502 reset spec: 8 cycles of dummy bus activity before the
    // first instruction fetch. The cycles are 3 PC reads at $00FF + 3
    // dummy stack-decrement reads ($0100/$01FF/$01FE) + 2 vector reads
    // ($FFFC/$FFFD). On real hardware the 3 dummy stack reads decrement SP
    // by 3 from its (indeterminate) power-up value, so SP-after-reset is not
    // a fixed quantity. VICE presents SP=$FF after reset (the value the
    // CPU/cpuport `initvalue` testprog checks for, before the KERNAL's own
    // LDX #$FF/TXS runs), and we match that — path-stable across repeated
    // resets, unlike a relative `-3` which accumulates over warm resets.
    this.sp = 0xFF;
    this.a = 0xAA; this.x = 0; this.y = 0;
    this.N = 0; this.V = 0; this.D = 0; this.I = 1; this.Z = 1; this.C = 0;
    this.pc = this.mem.read(0xFFFC) | (this.mem.read(0xFFFD) << 8);
    this.halted = false;
    this.irqLine = false;
    this.nmiLine = false;
    this.nmiEdge = false;
    this.microOpHead = 0;
    this.microOpLen = 0;
    this.tmpAddr = 0;
    this.tmpLo = 0;
    this.tmpFalseAddr = 0;  // 6502 indexed false/wrapped address for the page-cross dummy access
    this._shValue = 0;   // staged ANDed value for SHA/SHX/SHY/TAS store-illegals
    this._shReg = 0;     // staged un-ANDed register (stored when the AND drops off)
    this.currentMicroOpKindByte = KIND_INTERNAL;
    this._pollI = 1;
    this._iWriteThisInstr = false;
    this._seiMaskStalled = false;
    this._seiPreStallLine = false;
    this._shArmDrop = false;
    this._shDropAnd = false;
    this.sampledIrq = false;
    this.sampledIrqLate = false;
    this.sampledIrqPrev = false;
    this.sampledIrqLatePrev = false;
    this.sampledNmiEdge = false;
    this.sampledNmiEdgePrev = false;
    this.irqLineLate = false;
    this._branchIrqNoCrossDelay = false;
    this._branchNmiNoCrossDelay = false;
    // Queue 7 dummy internal cycles so the first instruction fetch happens
    // on the 8th cycle after reset, matching the real 6510 boot sequence.
    // (We already read the vector synchronously above; the dummy cycles
    // just consume bus time so cycle counters elsewhere align with VICE.)
    // The last dummy clears sampledIrq so that IRQ asserted before reset
    // doesn't pre-empt the first instruction — per 6502 spec the first
    // instruction always runs after reset, with I=1 masking interrupts.
      this._queueMicroOps([
      this._internalOp(() => { }),
      this._internalOp(() => { }),
      this._internalOp(() => { }),
      this._internalOp(() => { }),
      this._internalOp(() => { }),
      this._internalOp(() => { }),
      this._internalOp(() => {
        this.sampledIrq = false;
        this.sampledIrqLate = false;
        this.sampledIrqPrev = false;
        this.sampledIrqLatePrev = false;
      }),
    ]);
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // serialize()/deserialize() capture the CPU's logical state for a machine
  // snapshot. The micro-op queue is NOT captured: snapshots are taken at an
  // instruction boundary (machine._quiesceToBoundary), so the queue is empty
  // and the saved PC points at a real opcode fetch. deserialize() therefore
  // forces a clean fetch (head=len=0, cyclesRemaining=0) at the restored PC.
  serialize() {
    return {
      a: this.a, x: this.x, y: this.y, pc: this.pc, sp: this.sp,
      N: this.N, V: this.V, D: this.D, I: this.I, Z: this.Z, C: this.C,
      irqLine: this.irqLine, nmiLine: this.nmiLine, nmiEdge: this.nmiEdge,
      halted: this.halted, pageCrossed: this.pageCrossed,
      tmpAddr: this.tmpAddr, tmpLo: this.tmpLo, tmpFalseAddr: this.tmpFalseAddr, _shValue: this._shValue, _shReg: this._shReg,
      currentMicroOpKindByte: this.currentMicroOpKindByte,
      _pollI: this._pollI,
      sampledIrq: this.sampledIrq, sampledIrqLate: this.sampledIrqLate,
      sampledIrqPrev: this.sampledIrqPrev, sampledIrqLatePrev: this.sampledIrqLatePrev,
      sampledNmiEdge: this.sampledNmiEdge, sampledNmiEdgePrev: this.sampledNmiEdgePrev,
      irqLineLate: this.irqLineLate,
      _branchIrqNoCrossDelay: this._branchIrqNoCrossDelay,
      _branchNmiNoCrossDelay: this._branchNmiNoCrossDelay,
    };
  }

  deserialize(s) {
    this.a = s.a | 0; this.x = s.x | 0; this.y = s.y | 0;
    this.pc = s.pc | 0; this.sp = s.sp | 0;
    this.N = s.N | 0; this.V = s.V | 0; this.D = s.D | 0;
    this.I = s.I | 0; this.Z = s.Z | 0; this.C = s.C | 0;
    this.irqLine = !!s.irqLine; this.nmiLine = !!s.nmiLine;
    this.nmiEdge = !!s.nmiEdge; this.halted = !!s.halted;
    this.pageCrossed = s.pageCrossed | 0;
    this.tmpAddr = s.tmpAddr | 0; this.tmpLo = s.tmpLo | 0; this.tmpFalseAddr = s.tmpFalseAddr | 0;
    this._shValue = s._shValue | 0; this._shReg = s._shReg | 0;
    this._shArmDrop = false; this._shDropAnd = false;
    this.currentMicroOpKindByte = s.currentMicroOpKindByte ?? KIND_INTERNAL;
    // Older saved states predate _pollI; fall back to the restored live I
    // (correct at a quiesced boundary unless the last opcode wrote I).
    this._pollI = s._pollI !== undefined ? (s._pollI ? 1 : 0) : this.I;
    // Mid-instruction transients — always false at a quiesced boundary save.
    this._iWriteThisInstr = false; this._seiMaskStalled = false; this._seiPreStallLine = false;
    this.sampledIrq = !!s.sampledIrq; this.sampledIrqLate = !!s.sampledIrqLate;
    this.sampledIrqPrev = !!s.sampledIrqPrev; this.sampledIrqLatePrev = !!s.sampledIrqLatePrev;
    this.sampledNmiEdge = !!s.sampledNmiEdge; this.sampledNmiEdgePrev = !!s.sampledNmiEdgePrev;
    this.irqLineLate = !!s.irqLineLate;
    this._branchIrqNoCrossDelay = !!s._branchIrqNoCrossDelay;
    this._branchNmiNoCrossDelay = !!s._branchNmiNoCrossDelay;
    // Resume on a clean instruction boundary (queue empty, fresh fetch at PC).
    this.microOpHead = 0; this.microOpLen = 0; this.instructionCyclesRemaining = 0;
  }

  getP() {
    return (this.N << 7) | (this.V << 6) | 0x20 | (this.D << 3) | (this.I << 2) | (this.Z << 1) | this.C;
  }

  setP(p, suppressIntShadow = false) {
    const newI = (p >> 2) & 1;
    this.N = (p >> 7) & 1; this.V = (p >> 6) & 1;
    this.D = (p >> 3) & 1; this.I = newI;
    this.Z = (p >> 1) & 1; this.C = p & 1;
    // PLP writes I in its FINAL cycle, after its own interrupt poll, so
    // the change reaches the poll one instruction late in BOTH directions
    // (_pollI stays stale until the next boundary sync — Bruce Clark
    // §I-flag-delay; irqdma test6/test7 real-C64 dumps). RTI restores I
    // *before* its poll — RTI callers pass suppressIntShadow=true and
    // _pollI updates immediately. This is what lets an un-acknowledged
    // IRQ re-trigger "immediately" after RTI (Bauer §3.12: "the IRQ input
    // of the 6510 is state-sensitive").
    if (suppressIntShadow) this._pollI = newI;
    else this._iWriteThisInstr = true;
  }

  setIrqLine(asserted, late = false) {
    this.irqLine = !!asserted;
    this.irqLineLate = !!asserted && !!late;
  }

  // NMI input. NOTE: the machine drives this as a one-cycle EDGE PULSE, not the
  // held CIA2 /NMI level — _sampleCpuInterrupts already edge-detects the CIA2
  // level (machine._cpuNmiEdgeSeen) and calls setNmiLine(true) for the single
  // cycle the edge is presented, then setNmiLine(false). So `asserted` here is
  // "an NMI edge is being presented this cycle", not "the /NMI pin is low". This
  // method's own 0→1 detect is a second, harmless guard; the sticky nmiEdge it
  // latches is what recognition consumes. (Tests assert an NMI by calling
  // setNmiLine(true) + setting cpu.sampledNmiEdge, mirroring the IRQ path.)
  setNmiLine(asserted) {
    if (asserted && !this.nmiLine) {
      this.nmiEdge = true; // latch the rising edge (low-to-high asserting)
    }
    this.nmiLine = !!asserted;
  }

  _triggerIrq() {
    this._push((this.pc >> 8) & 0xFF);
    this._push(this.pc & 0xFF);
    this._push(this.getP() & ~0x10); // B flag = 0 for hardware IRQ
    this.I = 1;
    this.pc = this.mem.read(0xFFFE) | (this.mem.read(0xFFFF) << 8);
    this.halted = false;
  }

  _triggerNmi() {
    this._push((this.pc >> 8) & 0xFF);
    this._push(this.pc & 0xFF);
    this._push(this.getP() & ~0x10); // B flag = 0
    this.I = 1;
    this.pc = this.mem.read(0xFFFA) | (this.mem.read(0xFFFB) << 8);
    this.halted = false;
    this.nmiEdge = false;
    this.sampledNmiEdge = false;
  }

  // Set Overflow (SO) pin – level-triggered input that forces V=1.
  // Used by the 1541 read head to signal byte-ready to the drive CPU.
  setOverflow() { this.V = 1; }

  r(a) { return this.mem.read(a); }
  w(a, v) { this.mem.write(a, v); }
  peek(a) {
    a &= 0xFFFF;
    if (typeof this.mem.peekForCpu === 'function') return this.mem.peekForCpu(a);
    if (typeof this.mem.peek === 'function') return this.mem.peek(a);
    if (this.mem.ram) return this.mem.ram[a];
    return this.mem.read(a);
  }
  _push(v) { this.w(0x0100 + this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
  _pop() { this.sp = (this.sp + 1) & 0xFF; return this.r(0x0100 + this.sp); }
  setZN(v) { this.Z = (v === 0) ? 1 : 0; this.N = (v >> 7) & 1; }

  // ALU
  adc(val) {
    // Decimal (D=1) path: digit-split BCD with the NMOS flag semantics
    // (Z from the binary sum, N/V from the intermediate result) — per
    // Bruce Clark, "Decimal Mode". Same scheme in _sbcBCD below.
    if (this.D) {
      let l = (this.a & 0x0F) + (val & 0x0F) + this.C;
      let h = (this.a >> 4) + (val >> 4) + (l > 9 ? 1 : 0);
      this.Z = ((this.a + val + this.C) & 0xFF) === 0 ? 1 : 0;
      this.N = (h & 8) ? 1 : 0;
      this.V = (~(this.a ^ val) & (this.a ^ (h << 4 | l)) & 0x80) ? 1 : 0;
      if (l > 9) l += 6; if (h > 9) h += 6;
      this.C = (h > 15) ? 1 : 0;
      this.a = ((h << 4) | (l & 0x0F)) & 0xFF;
    } else {
      const sum = this.a + val + this.C;
      this.C = (sum > 0xFF) ? 1 : 0;
      this.V = (~(this.a ^ val) & (this.a ^ sum) & 0x80) ? 1 : 0;
      this.a = sum & 0xFF;
      this.setZN(this.a);
    }
  }
  sbc(val) { this.D ? this._sbcBCD(val) : this.adc(val ^ 0xFF); }
  _sbcBCD(val) {
    let l = (this.a & 0x0F) - (val & 0x0F) - (1 - this.C);
    let h = (this.a >> 4) - (val >> 4) - (l < 0 ? 1 : 0);
    this.Z = ((this.a - val - (1 - this.C)) & 0xFF) === 0 ? 1 : 0;
    this.N = (h & 8) ? 1 : 0;
    this.V = ((this.a ^ val) & (this.a ^ (h << 4 | l)) & 0x80) ? 1 : 0;
    if (l < 0) l -= 6; if (h < 0) h -= 6;
    this.C = (h < 0) ? 0 : 1;
    this.a = ((h << 4) | (l & 0x0F)) & 0xFF;
  }
  cmp(reg, val) { this.C = (reg >= val) ? 1 : 0; this.setZN((reg - val) & 0xFF); }
  asl(v) { this.C = (v >> 7) & 1; v = (v << 1) & 0xFF; this.setZN(v); return v; }
  lsr(v) { this.C = v & 1; v = (v >> 1) & 0xFF; this.setZN(v); return v; }
  rol(v) { const oC = this.C; this.C = (v >> 7) & 1; v = ((v << 1) | oC) & 0xFF; this.setZN(v); return v; }
  ror(v) { const oC = this.C; this.C = v & 1; v = ((v >> 1) | (oC << 7)) & 0xFF; this.setZN(v); return v; }

  // RMW helper
  rmw(addr, fn) { const o = this.r(addr); this.w(addr, o); const v = fn(o); this.w(addr, v); return v; }
  rmw_inc(a) { this.rmw(a, v => { const r = (v + 1) & 0xFF; this.setZN(r); return r; }); }
  rmw_dec(a) { this.rmw(a, v => { const r = (v - 1) & 0xFF; this.setZN(r); return r; }); }
  rmw_asl(a) { this.rmw(a, v => this.asl(v)); }
  rmw_lsr(a) { this.rmw(a, v => this.lsr(v)); }
  rmw_rol(a) { this.rmw(a, v => this.rol(v)); }
  rmw_ror(a) { this.rmw(a, v => this.ror(v)); }
  rmw_dcp(a) { this.rmw(a, v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); }
  rmw_isb(a) { this.rmw(a, v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); }
  rmw_slo(a) { this.rmw(a, v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); }
  rmw_rla(a) { this.rmw(a, v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); }
  rmw_sre(a) { this.rmw(a, v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); }
  rmw_rra(a) { this.rmw(a, v => { const r = this.ror(v); this.adc(r); return r; }); }

  atInstructionBoundary() {
    return this.instructionCyclesRemaining === 0;
  }

  // Public string view of the current microop bus-kind, derived on demand from
  // the numeric byte. Only read by the (flag-gated) machine bus-trace, so the
  // string is never materialised on the hot path.
  get currentMicroOpKind() {
    return KIND_NAMES[this.currentMicroOpKindByte];
  }

  // Microop builders: side-effect onto microOpFns/microOpKinds. The return
  // value is unused (the array literal at the call site collects undefineds
  // that _queueMicroOps then ignores). Each instruction dispatch resets
  // microOpLen to 0 in _beginInstruction before the queue methods run.
  // The single guarded path for writing a micro-op slot. EVERY runtime write to
  // the micro-op arrays goes through here — _op appends, the page-cross re-insert
  // rewrites a slot — so the copy-on-write rule lives in exactly ONE place: if
  // we're aliasing a pre-built template (dispatch installed it by reference),
  // copy it into scratch FIRST so a write can never corrupt the shared cache. At
  // build time and on the interrupt/fallback path microOpFns already IS the
  // scratch, so the guard is a cheap no-op identity check.
  _writeMicroOp(idx, fn, kind) {
    if (this.microOpFns !== this._scratchFns) this._cowMicroOps();
    this.microOpFns[idx] = fn;
    this.microOpKinds[idx] = kind;
  }

  _op(fn, kind = KIND_INTERNAL) { this._writeMicroOp(this.microOpLen++, fn, kind); }

  // Copy the current (aliased template) program into scratch and point the live
  // arrays at it, so the ensuing slot write never corrupts the template.
  _cowMicroOps() {
    const n = this.microOpLen;
    const sf = this._scratchFns, sk = this._scratchKinds;
    const tf = this.microOpFns, tk = this.microOpKinds;
    for (let i = 0; i < n; i++) { sf[i] = tf[i]; sk[i] = tk[i]; }
    this.microOpFns = sf;
    this.microOpKinds = sk;
  }

  _readOp(fn) { this._op(fn, KIND_READ); }
  _writeOp(fn) { this._op(fn, KIND_WRITE); }
  _internalOp(fn) { this._op(fn, KIND_INTERNAL); }

  peekNextBusKindByte() {
    if (this.instructionCyclesRemaining === 0 || this.microOpHead >= this.microOpLen) {
      return KIND_READ; // opcode fetch
    }
    return this.microOpKinds[this.microOpHead];
  }

  peekNextBusKind() {
    return KIND_NAMES[this.peekNextBusKindByte()];
  }

  nextBusIsWrite() {
    return this.peekNextBusKindByte() === KIND_WRITE;
  }

  // RDY classification: Bauer §3.5 — "RDY halts a read access. Writes
  // are not affected." The 6510 does a bus access every cycle, and
  // internal/dummy cycles perform a discarded read. So for RDY purposes,
  // both KIND_READ and KIND_INTERNAL behave as 'read' (RDY halts them);
  // only KIND_WRITE proceeds during BA-low.
  peekNextRdyClass() {
    return this.nextBusIsWrite() ? 'write' : 'read';
  }

  // A RDY/AEC steal cycle INSIDE the current instruction (not at its
  // boundary). Two hardware effects, both scoped to a steal interrupting
  // the I-WRITING instruction itself and both measured against the irqdma
  // test6/test7 real-C64 dumps (the line latches stay frozen through
  // stalls regardless — test1-5, 0/16384):
  //   • UNMASK propagates: a mid-CLI steal makes the I=0 write
  //     poll-visible, cancelling the one-instruction shadow (the NMOS
  //     CLI-steal quirk — "shouldn't delay the interrupt").
  //     The mask direction does NOT propagate — a pending IRQ visible
  //     before a mid-SEI steal is still accepted at SEI's boundary
  //     (late-mask slip preserved; propagating it scored Δ-4×1815).
  //   • SEI defers a MID-STALL assert: the steal-time maturity credit
  //     is skipped for SEI, so an IRQ that first
  //     asserts during a mid-SEI steal is not mature at the release
  //     boundary — it must wait for the poll after the NEXT instruction
  //     (_seiMaskStalled → the boundary uses the pre-stall line sample).
  //     For every other opcode the credit applies and the release-side
  //     boundary accepts (test1b NOP fields, 0/16384).
  noteMidOpcodeStall() {
    if (this._iWriteThisInstr) {
      if (this.I === 0) {
        this._pollI = 0;
      } else if (!this._seiMaskStalled) {
        this._seiMaskStalled = true;
        // The poll's line cutoff sits at the stall's FIRST cycle: a line
        // already up when the steal begins is still caught (accepted at
        // SEI's boundary); one asserting deeper into the stall is not.
        this._seiPreStallLine = this.irqLine;
      }
    }
    // SH-family unstable stores: a stall between the address-compute cycle
    // and the dummy read drops the & (H+1) term from the stored value
    // (see _computeShAddr block; CPU/sha shaabsy4 real-HW timing sweep).
    if (this._shArmDrop) this._shDropAnd = true;
  }

  clock() {

    if (this.instructionCyclesRemaining === 0) {
      this._beginInstruction();
    }

    if (this.instructionCyclesRemaining > 0) {
      this.sampledIrqPrev = this.sampledIrq;
      this.sampledIrqLatePrev = this.sampledIrqLate;
      this.sampledIrq = this.irqLine;
      this.sampledIrqLate = this.irqLine && this.irqLineLate;
      this.irqLineLate = false;
      // Sample the NMI edge in the same per-cycle window as the IRQ so its
      // recognition lags by one cycle identically (see sampledNmiEdge decl).
      // sampledNmiEdgePrev is the NMI analogue of sampledIrqPrev: the branch-
      // no-cross delay needs to know if the NMI edge was already visible at the
      // branch's early-poll cycle (see _beginMicroInstruction).
      this.sampledNmiEdgePrev = this.sampledNmiEdge;
      this.sampledNmiEdge = this.nmiEdge;
    }

    if (this.microOpHead < this.microOpLen) {
      const idx = this.microOpHead++;
      const kindByte = this.microOpKinds[idx];
      this.currentMicroOpKindByte = kindByte;
      this.microOpFns[idx]();
      // The 6510 performs a real bus access every cycle. KIND_INTERNAL
      // microops (reset settle, HALT spin) do no bus work logically, so
      // synthesize a discarded read at PC so the external/internal bus
      // latches stay correct. Gated so it can be bisected if it ever
      // interacts badly with a future test.
      if (kindByte === KIND_INTERNAL && this.cpuInternalCycleDrivesBus !== false) {
        this.r(this.pc);
      }
      if (this.microOpHead >= this.microOpLen) {
        this.microOpHead = 0;
        this.microOpLen = 0;
      }
    } else {
      this.currentMicroOpKindByte = KIND_INTERNAL;
      if (this.cpuInternalCycleDrivesBus !== false) this.r(this.pc);
    }
    this.instructionCyclesRemaining = Math.max(0, this.instructionCyclesRemaining - 1);
    return 1;
  }

  _beginInstruction() {
    // Point the live queue back at scratch before dispatch: the interrupt
    // prologue and any non-pre-built opcode build via _op, which must write a
    // private array, not a still-aliased template from the previous
    // instruction. _installOpcode then re-aliases a template for pre-built
    // opcodes (the common case, no copy).
    this.microOpFns = this._scratchFns;
    this.microOpKinds = this._scratchKinds;
    this.microOpHead = 0;
    this.microOpLen = 0;
    this._beginMicroInstruction();
  }

  _queueMicroOps(ops) {
    // Builders already pushed fn+kind into the parallel arrays during
    // evaluation of the array literal — `ops` itself is just a vector
    // of undefineds we don't need. Trust microOpLen as the source of
    // truth. We assert ops.length matches in dev-tracing only.
    this.instructionCyclesRemaining = this.microOpLen;
  }

  _beginMicroInstruction() {
    // A JAMmed (KIL/HLT) CPU is frozen: it fetches no further opcodes and
    // does NOT respond to IRQ or NMI — only RESET recovers it (NMOS 6510
    // unintended opcodes). This check MUST precede the interrupt logic
    // below so a pending timer IRQ/NMI can never un-jam the CPU. (VICE
    // cpujam testprogs jamirq.prg / jamnmi.prg verify exactly this.)
    if (this.halted) {
      this.microOpFns = this._haltFns;       // alias template by reference (no alloc)
      this.microOpKinds = this._haltKinds;
      this.microOpLen = 1;
      this.instructionCyclesRemaining = 1;
      return true;
    }

    // NMOS branch-no-cross delays IRQ/NMI by exactly one instruction
    // boundary. Consume the flag here; if set, fall through to normal
    // dispatch (no interrupt vectoring this boundary).
    // Branch-no-cross delay is tracked SEPARATELY per source: the NMOS quirk's
    // early-poll happens before the branch's last cycle, and whether it caught
    // the pending interrupt is source-specific. A shared flag (the old code) set
    // the NMI delay from IRQ-only early-poll state, mis-phasing NMI acceptance
    // after taken non-crossing branches (esp. the common no-IRQ case).
    const branchIrqDelay = this._branchIrqNoCrossDelay;
    const branchNmiDelay = this._branchNmiNoCrossDelay;
    this._branchIrqNoCrossDelay = false;
    this._branchNmiNoCrossDelay = false;

    // NMOS I-flag pipeline (Bruce Clark §I-flag-delay; irqdma test6/test7
    // real-C64 dumps): the boundary poll runs BEFORE the final-cycle I
    // write of CLI/SEI/PLP, so their masking change reaches the poll one
    // instruction late in BOTH directions — a pending IRQ still fires at
    // the boundary right after SEI (late mask), CLI's unmask admits it
    // only one instruction later (late unmask), and CLI;SEI lets exactly
    // one slip through (the admitting poll ran during SEI with I still
    // 0). Read the poll-visible I, then sync it so a delayed write
    // becomes visible at the NEXT boundary. RTI and the IRQ/NMI/BRK
    // sequences write _pollI immediately (no shadow), which keeps the
    // post-RTI re-trigger state-sensitive (Bauer §3.12) and prevents any
    // stale slip from surviving an NMI preemption (Codeboys $177b).
    const pollI = this._pollI;
    // A mid-SEI steal denies the maturity credit: an IRQ that first
    // asserted DURING that stall (after its first cycle) polls with the
    // stall-start line sample at this boundary, deferring it past SEI.
    const lineOk = this._seiMaskStalled ? this._seiPreStallLine : this.sampledIrq;
    this._pollI = this.I;
    this._iWriteThisInstr = false;
    this._seiMaskStalled = false;
    this._shArmDrop = false;
    this._shDropAnd = false;

    if (this.sampledNmiEdge && !branchNmiDelay) {
      this._queueInterruptMicroOps(0xFFFA, true);
      return true;
    }

    // IRQ is sampled only during CPU cycles and acted on at the next
    // opcode boundary. When RDY/AEC holds the CPU, no CPU cycle occurs,
    // so sampledIrq must remain unchanged until cpu.clock() resumes.
    if (lineOk && pollI === 0 && !branchIrqDelay) {
      this._queueInterruptMicroOps(0xFFFE, false);
      return true;
    }

    return this._installOpcode(this.peek(this.pc));
  }

  // The 256-opcode dispatch, extracted from _beginMicroInstruction so it can be
  // run once per opcode at construction to pre-build the micro-op program table
  // (see _buildOpcodeTable). Each case builds a fresh set of micro-op closures;
  // running it per dispatch is the dominant allocation on JSC/mobile (V8 escape-
  // analyzes it away). Live callers go through _installOpcode, which replays a
  // pre-built program with no allocation and only falls back here for an opcode
  // that has no cached program.
  _queueOpcode(opcode) {
    switch (opcode) {
      case 0x00: this._queueBrkMicroOps(); return true;
      // JAM / KIL / HLT (NMOS unintended opcodes): halt the CPU until reset.
      // No IRQ/NMI recovery — only the halted-spin above runs hereafter.
      case 0x02: case 0x12: case 0x22: case 0x32:
      case 0x42: case 0x52: case 0x62: case 0x72:
      case 0x92: case 0xB2: case 0xD2: case 0xF2:
        this._queueJamMicroOps(); return true;
      case 0x03: this._queueRmwIndxMicroOps(v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x01: this._queueReadIndxMicroOps(v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x05: this._queueReadZpMicroOps(v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x06: this._queueRmwZpMicroOps(v => this.asl(v)); return true;
      case 0x07: this._queueRmwZpMicroOps(v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x09: this._queueReadImmMicroOps(v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x0A: this._queueAccumulatorMicroOp(() => { this.a = this.asl(this.a); }); return true;
      case 0x0B: this._queueReadImmMicroOps(v => { this.a &= v; this.setZN(this.a); this.C = this.N; }); return true;
      case 0x0D: this._queueReadAbsMicroOps(v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x0E: this._queueRmwAbsMicroOps(v => this.asl(v)); return true;
      case 0x0F: this._queueRmwAbsMicroOps(v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x04: this._queueSkipMicroOps(2, 3); return true;
      case 0x4C: this._queueJmpAbsMicroOps(); return true;
      case 0x0C: this._queueSkipMicroOps(3, 4); return true;
      case 0x11: this._queueReadIndyMicroOps(v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x14: this._queueSkipMicroOps(2, 4); return true;
      case 0x13: this._queueRmwIndyMicroOps(v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x15: this._queueReadZpIndexedMicroOps(() => this.x, v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x16: this._queueRmwZpIndexedMicroOps(() => this.x, v => this.asl(v)); return true;
      case 0x17: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x18: this._queueTransferMicroOp(() => { this.C = 0; }); return true;
      case 0x19: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x1A: case 0x3A: case 0xDA:
        this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }, 2); return true;
      case 0x1B: this._queueRmwAbsIndexedMicroOps(() => this.y, v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x1D: this._queueReadAbsIndexedMicroOps(() => this.x, v => { this.a |= v; this.setZN(this.a); }); return true;
      case 0x1E: this._queueRmwAbsIndexedMicroOps(() => this.x, v => this.asl(v)); return true;
      case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC:
        this._queueReadAbsIndexedMicroOps(() => this.x, () => { }); return true;
      case 0x1F: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = this.asl(v); this.a |= r; this.setZN(this.a); return r; }); return true;
      case 0x20: this._queueJsrMicroOps(); return true;
      case 0x23: this._queueRmwIndxMicroOps(v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x21: this._queueReadIndxMicroOps(v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x24: this._queueReadZpMicroOps(v => { this.Z = (this.a & v) === 0 ? 1 : 0; this.N = (v >> 7) & 1; this.V = (v >> 6) & 1; }); return true;
      case 0x25: this._queueReadZpMicroOps(v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x26: this._queueRmwZpMicroOps(v => this.rol(v)); return true;
      case 0x27: this._queueRmwZpMicroOps(v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x28: this._queuePlpMicroOps(); return true;
      case 0x29: this._queueReadImmMicroOps(v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x2A: this._queueAccumulatorMicroOp(() => { this.a = this.rol(this.a); }); return true;
      case 0x2B: this._queueReadImmMicroOps(v => { this.a &= v; this.setZN(this.a); this.C = this.N; }); return true;
      case 0x2C: this._queueReadAbsMicroOps(v => { this.Z = (this.a & v) === 0 ? 1 : 0; this.N = (v >> 7) & 1; this.V = (v >> 6) & 1; }); return true;
      case 0x2D: this._queueReadAbsMicroOps(v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x2E: this._queueRmwAbsMicroOps(v => this.rol(v)); return true;
      case 0x2F: this._queueRmwAbsMicroOps(v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x40: this._queueRtiMicroOps(); return true;
      case 0x48: this._queuePhaMicroOps(); return true;
      case 0x31: this._queueReadIndyMicroOps(v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x34: this._queueSkipMicroOps(2, 4); return true;
      case 0x33: this._queueRmwIndyMicroOps(v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x35: this._queueReadZpIndexedMicroOps(() => this.x, v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x36: this._queueRmwZpIndexedMicroOps(() => this.x, v => this.rol(v)); return true;
      case 0x37: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x38: this._queueTransferMicroOp(() => { this.C = 1; }); return true;
      case 0x39: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x3A: this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }, 2); return true;
      case 0x3B: this._queueRmwAbsIndexedMicroOps(() => this.y, v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x3D: this._queueReadAbsIndexedMicroOps(() => this.x, v => { this.a &= v; this.setZN(this.a); }); return true;
      case 0x3E: this._queueRmwAbsIndexedMicroOps(() => this.x, v => this.rol(v)); return true;
      case 0x3C: this._queueSkipMicroOps(3, 4); return true;
      case 0x3F: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = this.rol(v); this.a &= r; this.setZN(this.a); return r; }); return true;
      case 0x41: this._queueReadIndxMicroOps(v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x43: this._queueRmwIndxMicroOps(v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x44: case 0x64: this._queueSkipMicroOps(2, 3); return true;
      case 0x45: this._queueReadZpMicroOps(v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x46: this._queueRmwZpMicroOps(v => this.lsr(v)); return true;
      case 0x47: this._queueRmwZpMicroOps(v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x49: this._queueReadImmMicroOps(v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x4A: this._queueAccumulatorMicroOp(() => { this.a = this.lsr(this.a); }); return true;
      case 0x4B: this._queueReadImmMicroOps(v => { this.a &= v; this.a = this.lsr(this.a); }); return true;
      case 0x4D: this._queueReadAbsMicroOps(v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x4E: this._queueRmwAbsMicroOps(v => this.lsr(v)); return true;
      case 0x4F: this._queueRmwAbsMicroOps(v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x68: this._queuePlaMicroOps(); return true;
      case 0x60: this._queueRtsMicroOps(); return true;
      case 0x6C: this._queueJmpIndirectMicroOps(); return true;
      case 0x51: this._queueReadIndyMicroOps(v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x53: this._queueRmwIndyMicroOps(v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x54: this._queueSkipMicroOps(2, 4); return true;
      case 0x55: this._queueReadZpIndexedMicroOps(() => this.x, v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x56: this._queueRmwZpIndexedMicroOps(() => this.x, v => this.lsr(v)); return true;
      case 0x57: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x58: this._queueSimpleMicroOp(() => {
        this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
        // CLI writes I after its own poll — _pollI keeps the old value
        // until the next boundary sync, so the unmask is felt one
        // instruction late (Bruce Clark §I-flag-delay). A steal landing
        // inside this CLI cancels the shadow (noteMidOpcodeStall).
        this.I = 0;
        this._iWriteThisInstr = true;
      }, 2); return true;
      case 0x59: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x5A: this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }, 2); return true;
      case 0x5B: this._queueRmwAbsIndexedMicroOps(() => this.y, v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x5D: this._queueReadAbsIndexedMicroOps(() => this.x, v => { this.a ^= v; this.setZN(this.a); }); return true;
      case 0x5E: this._queueRmwAbsIndexedMicroOps(() => this.x, v => this.lsr(v)); return true;
      case 0x5C:
        this._queueReadAbsIndexedMicroOps(() => this.x, () => { }); return true;
      case 0x5F: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = this.lsr(v); this.a ^= r; this.setZN(this.a); return r; }); return true;
      case 0x61: this._queueReadIndxMicroOps(v => { this.adc(v); }); return true;
      case 0x63: this._queueRmwIndxMicroOps(v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x65: this._queueReadZpMicroOps(v => { this.adc(v); }); return true;
      case 0x66: this._queueRmwZpMicroOps(v => this.ror(v)); return true;
      case 0x67: this._queueRmwZpMicroOps(v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x69: this._queueReadImmMicroOps(v => { this.adc(v); }); return true;
      case 0x6A: this._queueAccumulatorMicroOp(() => { this.a = this.ror(this.a); }); return true;
      case 0x6B: this._queueReadImmMicroOps(v => { this.a &= v; this.a = this.ror(this.a); this.C = (this.a >> 6) & 1; this.V = (((this.a >> 6) & 1) ^ (this.a >> 5) & 1); }); return true;
      case 0x6D: this._queueReadAbsMicroOps(v => { this.adc(v); }); return true;
      case 0x6E: this._queueRmwAbsMicroOps(v => this.ror(v)); return true;
      case 0x6F: this._queueRmwAbsMicroOps(v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x71: this._queueReadIndyMicroOps(v => { this.adc(v); }); return true;
      case 0x74: this._queueSkipMicroOps(2, 4); return true;
      case 0x73: this._queueRmwIndyMicroOps(v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x75: this._queueReadZpIndexedMicroOps(() => this.x, v => { this.adc(v); }); return true;
      case 0x76: this._queueRmwZpIndexedMicroOps(() => this.x, v => this.ror(v)); return true;
      case 0x77: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x79: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.adc(v); }); return true;
      case 0x7A: this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }, 2); return true;
      case 0x7B: this._queueRmwAbsIndexedMicroOps(() => this.y, v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x7C: this._queueSkipMicroOps(3, 4); return true;
      case 0x7D: this._queueReadAbsIndexedMicroOps(() => this.x, v => { this.adc(v); }); return true;
      case 0x7E: this._queueRmwAbsIndexedMicroOps(() => this.x, v => this.ror(v)); return true;
      case 0x7F: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = this.ror(v); this.adc(r); return r; }); return true;
      case 0x78: this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.I = 1; this._iWriteThisInstr = true; }, 2); return true;
      case 0x80: case 0x82: case 0x89: case 0xC2: case 0xE2:
        this._queueSkipMicroOps(2, 2); return true;
      // ANE / XAA ($8B): unstable. A = (A | CONST) & X & imm (X unchanged).
      // VICE's 6510 CONST = 0xEF here — distinct from LXA's 0xEE (verified
      // against the VICE monitor).
      case 0x8B: this._queueReadImmMicroOps(v => { this.a = (this.a | 0xEF) & this.x & v; this.setZN(this.a); }); return true;
      case 0x08: this._queuePhpMicroOps(); return true;
      case 0x81: this._queueStoreIndxMicroOps(() => this.a); return true;
      case 0x83: this._queueStoreIndxMicroOps(() => this.a & this.x); return true;
      case 0x84: this._queueStoreZpMicroOps(() => this.y); return true;
      case 0x85: this._queueStoreZpMicroOps(() => this.a); return true;
      case 0x86: this._queueStoreZpMicroOps(() => this.x); return true;
      case 0x87: this._queueStoreZpMicroOps(() => this.a & this.x); return true;
      case 0x8A: this._queueTransferMicroOp(() => { this.a = this.x; this.setZN(this.a); }); return true;
      case 0x8C: this._queueStoreAbsMicroOps(() => this.y); return true;
      case 0x8D: this._queueStoreAbsMicroOps(() => this.a); return true;
      case 0x8E: this._queueStoreAbsMicroOps(() => this.x); return true;
      case 0x8F: this._queueStoreAbsMicroOps(() => this.a & this.x); return true;
      case 0x91: this._queueStoreIndyMicroOps(() => this.a); return true;
      case 0x94: this._queueStoreZpIndexedMicroOps(() => this.y, () => this.x); return true;
      case 0x95: this._queueStoreZpIndexedMicroOps(() => this.a, () => this.x); return true;
      case 0x96: this._queueStoreZpIndexedMicroOps(() => this.x, () => this.y); return true;
      case 0x97: this._queueStoreZpIndexedMicroOps(() => this.a & this.x, () => this.y); return true;
      case 0x98: this._queueTransferMicroOp(() => { this.a = this.y; this.setZN(this.a); }); return true;
      case 0x89: this._queueSkipMicroOps(2, 2); return true;
      case 0x99: this._queueStoreAbsIndexedMicroOps(() => this.a, () => this.y); return true;
      case 0x9D: this._queueStoreAbsIndexedMicroOps(() => this.a, () => this.x); return true;
      case 0x9A: this._queueTransferMicroOp(() => { this.sp = this.x; }); return true;
      // ── Unstable store-illegals (SHA/SHX/SHY/TAS) — value = reg & (H+1) ──
      case 0x93: this._queueShIndyMicroOps(() => this.a & this.x); return true;            // SHA/AHX (zp),Y
      case 0x9F: this._queueShAbsIndexedMicroOps(() => this.a & this.x, () => this.y); return true;  // SHA/AHX abs,Y
      case 0x9E: this._queueShAbsIndexedMicroOps(() => this.x, () => this.y); return true;           // SHX abs,Y
      case 0x9C: this._queueShAbsIndexedMicroOps(() => this.y, () => this.x); return true;           // SHY abs,X
      // TAS/SHS abs,Y: SP ← A&X, then store (A&X) & (H+1).
      case 0x9B: this._queueShAbsIndexedMicroOps(() => { this.sp = this.a & this.x; return this.sp; }, () => this.y); return true;
      case 0x10: this._queueBranchMicroOps(() => this.N === 0); return true;
      case 0xA1: this._queueLoadIndxMicroOps(v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xA3: this._queueLoadIndxMicroOps(v => { this.a = this.x = v; this.setZN(this.a); }); return true;
      case 0xA0: this._queueLoadImmMicroOps(v => { this.y = v; this.setZN(this.y); }); return true;
      case 0xA2: this._queueLoadImmMicroOps(v => { this.x = v; this.setZN(this.x); }); return true;
      case 0xA4: this._queueLoadZpMicroOps(v => { this.y = v; this.setZN(this.y); }); return true;
      case 0xA5: this._queueLoadZpMicroOps(v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xA6: this._queueLoadZpMicroOps(v => { this.x = v; this.setZN(this.x); }); return true;
      case 0xA7: this._queueLoadZpMicroOps(v => { this.a = this.x = v; this.setZN(this.a); }); return true;
      case 0xA8: this._queueTransferMicroOp(() => { this.y = this.a; this.setZN(this.y); }); return true;
      case 0xA9: this._queueLoadImmMicroOps(v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xAA: this._queueTransferMicroOp(() => { this.x = this.a; this.setZN(this.x); }); return true;
      // LAX #imm / LXA: unstable. A = X = (A | CONST) & imm. CONST is the
      // chip "magic constant"; VICE's 6510 uses 0xEE (bit0 clear). flibug's
      // blackmail-ee relies on it (see VICII/flibug/blackmail.asm).
      case 0xAB: this._queueLoadImmMicroOps(v => { this.a = this.x = (this.a | 0xEE) & v; this.setZN(this.a); }); return true;
      case 0xAC: this._queueLoadAbsMicroOps(v => { this.y = v; this.setZN(this.y); }); return true;
      case 0xAD: this._queueLoadAbsMicroOps(v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xAE: this._queueLoadAbsMicroOps(v => { this.x = v; this.setZN(this.x); }); return true;
      case 0xAF: this._queueLoadAbsMicroOps(v => { this.a = this.x = v; this.setZN(this.a); }); return true;
      case 0xB1: this._queueLoadIndyMicroOps(v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xB3: this._queueLoadIndyMicroOps(v => { this.a = this.x = v; this.setZN(this.a); }); return true;
      case 0xB4: this._queueLoadZpIndexedMicroOps(() => this.x, v => { this.y = v; this.setZN(this.y); }); return true;
      case 0xB5: this._queueLoadZpIndexedMicroOps(() => this.x, v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xB6: this._queueLoadZpIndexedMicroOps(() => this.y, v => { this.x = v; this.setZN(this.x); }); return true;
      case 0xB7: this._queueLoadZpIndexedMicroOps(() => this.y, v => { this.a = this.x = v; this.setZN(this.a); }); return true;
      case 0xB9: this._queueLoadAbsIndexedMicroOps(() => this.y, v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xBA: this._queueTransferMicroOp(() => { this.x = this.sp; this.setZN(this.x); }); return true;
      case 0xB8: this._queueTransferMicroOp(() => { this.V = 0; }); return true;
      case 0xBC: this._queueLoadAbsIndexedMicroOps(() => this.x, v => { this.y = v; this.setZN(this.y); }); return true;
      case 0xBD: this._queueLoadAbsIndexedMicroOps(() => this.x, v => { this.a = v; this.setZN(this.a); }); return true;
      case 0xBE: this._queueLoadAbsIndexedMicroOps(() => this.y, v => { this.x = v; this.setZN(this.x); }); return true;
      case 0xBF: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.a = this.x = v; this.setZN(this.a); }); return true;
      case 0xBB: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.a = this.x = this.sp = this.sp & v; this.setZN(this.a); }); return true;
      case 0x30: this._queueBranchMicroOps(() => this.N === 1); return true;
      case 0x50: this._queueBranchMicroOps(() => this.V === 0); return true;
      case 0x70: this._queueBranchMicroOps(() => this.V === 1); return true;
      case 0x90: this._queueBranchMicroOps(() => this.C === 0); return true;
      case 0xB0: this._queueBranchMicroOps(() => this.C === 1); return true;
      case 0xC0: this._queueReadImmMicroOps(v => { this.cmp(this.y, v); }); return true;
      case 0xC1: this._queueReadIndxMicroOps(v => { this.cmp(this.a, v); }); return true;
      case 0xC3: this._queueRmwIndxMicroOps(v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xC4: this._queueReadZpMicroOps(v => { this.cmp(this.y, v); }); return true;
      case 0xC5: this._queueReadZpMicroOps(v => { this.cmp(this.a, v); }); return true;
      case 0xC6: this._queueRmwZpMicroOps(v => { const r = (v - 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xC7: this._queueRmwZpMicroOps(v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xC9: this._queueReadImmMicroOps(v => { this.cmp(this.a, v); }); return true;
      case 0xCB: this._queueReadImmMicroOps(v => { const res = (this.a & this.x) - v; this.C = res >= 0 ? 1 : 0; this.x = res & 0xFF; this.setZN(this.x); }); return true;
      case 0xCC: this._queueReadAbsMicroOps(v => { this.cmp(this.y, v); }); return true;
      case 0xCD: this._queueReadAbsMicroOps(v => { this.cmp(this.a, v); }); return true;
      case 0xCE: this._queueRmwAbsMicroOps(v => { const r = (v - 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xCF: this._queueRmwAbsMicroOps(v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xD0: this._queueBranchMicroOps(() => this.Z === 0); return true;
      case 0xD1: this._queueReadIndyMicroOps(v => { this.cmp(this.a, v); }); return true;
      case 0xD3: this._queueRmwIndyMicroOps(v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xD4: this._queueSkipMicroOps(2, 4); return true;
      case 0xD5: this._queueReadZpIndexedMicroOps(() => this.x, v => { this.cmp(this.a, v); }); return true;
      case 0xD6: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = (v - 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xD7: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xD9: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.cmp(this.a, v); }); return true;
      case 0xDB: this._queueRmwAbsIndexedMicroOps(() => this.y, v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xD8: this._queueTransferMicroOp(() => { this.D = 0; }); return true;
      case 0xDD: this._queueReadAbsIndexedMicroOps(() => this.x, v => { this.cmp(this.a, v); }); return true;
      case 0xDE: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = (v - 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xDF: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = (v - 1) & 0xFF; this.cmp(this.a, r); return r; }); return true;
      case 0xEA: this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }, 2); return true;
      case 0xE0: this._queueReadImmMicroOps(v => { this.cmp(this.x, v); }); return true;
      case 0xE1: this._queueReadIndxMicroOps(v => { this.sbc(v); }); return true;
      case 0xE3: this._queueRmwIndxMicroOps(v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0xE4: this._queueReadZpMicroOps(v => { this.cmp(this.x, v); }); return true;
      case 0xE5: this._queueReadZpMicroOps(v => { this.sbc(v); }); return true;
      case 0xE6: this._queueRmwZpMicroOps(v => { const r = (v + 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xE7: this._queueRmwZpMicroOps(v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0x88: this._queueTransferMicroOp(() => { this.y = (this.y - 1) & 0xFF; this.setZN(this.y); }); return true;
      case 0xC8: this._queueTransferMicroOp(() => { this.y = (this.y + 1) & 0xFF; this.setZN(this.y); }); return true;
      case 0xCA: this._queueTransferMicroOp(() => { this.x = (this.x - 1) & 0xFF; this.setZN(this.x); }); return true;
      case 0xE9: this._queueReadImmMicroOps(v => { this.sbc(v); }); return true;
      case 0xEB: this._queueReadImmMicroOps(v => { this.sbc(v); }); return true;
      case 0xEC: this._queueReadAbsMicroOps(v => { this.cmp(this.x, v); }); return true;
      case 0xED: this._queueReadAbsMicroOps(v => { this.sbc(v); }); return true;
      case 0xEE: this._queueRmwAbsMicroOps(v => { const r = (v + 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xEF: this._queueRmwAbsMicroOps(v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0xE8: this._queueTransferMicroOp(() => { this.x = (this.x + 1) & 0xFF; this.setZN(this.x); }); return true;
      case 0xF0: this._queueBranchMicroOps(() => this.Z === 1); return true;
      case 0xF1: this._queueReadIndyMicroOps(v => { this.sbc(v); }); return true;
      case 0xF3: this._queueRmwIndyMicroOps(v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0xF4: this._queueSkipMicroOps(2, 4); return true;
      case 0xF5: this._queueReadZpIndexedMicroOps(() => this.x, v => { this.sbc(v); }); return true;
      case 0xF6: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = (v + 1) & 0xFF; this.setZN(r); return r; }); return true;
      case 0xF7: this._queueRmwZpIndexedMicroOps(() => this.x, v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0xF8: this._queueTransferMicroOp(() => { this.D = 1; }); return true;
      case 0xF9: this._queueReadAbsIndexedMicroOps(() => this.y, v => { this.sbc(v); }); return true;
      case 0xFA: this._queueSimpleMicroOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }, 2); return true;
      case 0xFB: this._queueRmwAbsIndexedMicroOps(() => this.y, v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0xFD: this._queueReadAbsIndexedMicroOps(() => this.x, v => { this.sbc(v); }); return true;
      case 0xFF: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = (v + 1) & 0xFF; this.sbc(r); return r; }); return true;
      case 0xFE: this._queueRmwAbsIndexedMicroOps(() => this.x, v => { const r = (v + 1) & 0xFF; this.setZN(r); return r; }); return true;
      // All 256 opcodes are cased above, so this is unreachable; fail loud
      // rather than silently leave the micro-op queue empty (which would spin
      // the CPU on the same PC forever).
      default: throw new Error('6510: unhandled opcode $' + opcode.toString(16).padStart(2, '0'));
    }
  }

  // ── Pre-built micro-op program table ────────────────────────────────────────
  // For each opcode, _queueOpcode() produces the same sequence of micro-op
  // closures every dispatch — they close over `this` and per-opcode constants,
  // never per-dispatch state (a couple of write-before-read locals like `base`
  // are safe: instructions never overlap). So we run each opcode's builder ONCE
  // here and snapshot the resulting (fns, kinds) into a per-opcode program.
  // _installOpcode then replays a program by copying its refs into the live
  // microOp arrays — zero closure allocation on the hot path. Unhandled opcodes
  // (the switch's `default` throws) are left null and fall back to the builder.
  _buildOpcodeTable() {
    const progFns = new Array(256).fill(null);
    const progKinds = new Array(256).fill(null);
    const progLen = new Uint8Array(256);
    for (let op = 0; op <= 0xFF; op++) {
      this.microOpLen = 0;
      // Snapshot the CPU state a builder might mutate at BUILD time (rather than
      // inside a micro-op closure): BRK arms the interrupt sequence, JAM sets
      // halted. Those opcodes have per-dispatch build-time effects a cached
      // program would silently drop, so detect the mutation, skip caching them
      // (they fall back to the live builder), and restore state. Everything else
      // builds its closures purely and is safe to cache.
      const halted0 = this.halted;
      const iv0 = this._intSeqVector, ih0 = this._intSeqHijackable, il0 = this._intSeqNmiLatched;
      let built = true;
      try {
        this._queueOpcode(op);
      } catch {
        built = false;   // truly-unhandled opcode → leave null, fall back live
      }
      const mutated = this.halted !== halted0 || this._intSeqVector !== iv0 ||
        this._intSeqHijackable !== ih0 || this._intSeqNmiLatched !== il0;
      if (built && !mutated) {
        const len = this.microOpLen;
        const fns = new Array(len);
        const kinds = new Uint8Array(len);
        for (let i = 0; i < len; i++) { fns[i] = this.microOpFns[i]; kinds[i] = this.microOpKinds[i]; }
        progFns[op] = fns;
        progKinds[op] = kinds;
        progLen[op] = len;
      }
      // Undo any build-time mutation so the CPU ends construction idle/clean.
      this.halted = halted0;
      this._intSeqVector = iv0;
      this._intSeqHijackable = ih0;
      this._intSeqNmiLatched = il0;
    }
    // Restore a clean, idle queue so the first real clock() starts fresh.
    this.microOpLen = 0;
    this.microOpHead = 0;
    this.instructionCyclesRemaining = 0;
    this.pageCrossed = 0;
    this._progFns = progFns;
    this._progKinds = progKinds;
    this._progLen = progLen;
  }

  // Install a pre-built program by ALIASING it into the live micro-op arrays —
  // O(1), no per-dispatch allocation and no copy. The template is immutable
  // during normal execution; the few opcodes that rewrite their own program at
  // runtime (branch extra cycle via _op, indexed page-cross) copy-on-write into
  // scratch first (see _op / _cowMicroOps), so the shared template is never
  // corrupted. Any opcode without a cached program falls back to the live
  // builder (microOpFns is still scratch here, set by _beginInstruction).
  _installOpcode(opcode) {
    const fns = this._progFns[opcode];
    if (fns === null) return this._queueOpcode(opcode);   // unhandled/side-effecting → builder
    this.microOpFns = fns;                        // alias template by reference
    this.microOpKinds = this._progKinds[opcode];
    this.microOpLen = this._progLen[opcode];
    this.instructionCyclesRemaining = this.microOpLen;
    return true;
  }

  _queueSimpleMicroOp(fn, cycles) {
    // Real 6502: every cycle is on the bus. Padding cycles in implied
    // ops (TAX/INX/CLC/NOP/...) do a dummy read of PC, not a no-op.
    // Tagging them 'read' makes them stallable by BA-low — without
    // this, BA-low at the dummy-read cycle silently passes (impl runs
    // through a cycle real hardware would have stalled).
    const ops = [this._readOp(fn)];
    for (let i = 1; i < cycles; i++) ops.push(this._readOp(() => { this.r(this.pc); }));
    this._queueMicroOps(ops);
  }

  _queueSkipMicroOps(bytes, cycles) {
    const ops = [];
    for (let i = 0; i < bytes; i++) {
      ops.push(this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }));
    }
    // Same rationale: pad cycles must touch the bus to be BA-low-stallable.
    for (let i = bytes; i < cycles; i++) ops.push(this._readOp(() => { this.r(this.pc); }));
    this._queueMicroOps(ops);
  }

  _queueTransferMicroOp(fn) {
    this._queueSimpleMicroOp(() => {
      this.r(this.pc);
      this.pc = (this.pc + 1) & 0xFFFF;
      fn();
    }, 2);
  }

  _queueAccumulatorMicroOp(fn) {
    this._queueSimpleMicroOp(() => {
      this.r(this.pc);
      this.pc = (this.pc + 1) & 0xFFFF;
      fn();
    }, 2);
  }

  _queueLoadImmMicroOps(assign) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { assign(this.r(this.pc)); this.pc = (this.pc + 1) & 0xFFFF; }),
    ]);
  }

  _queueLoadZpMicroOps(assign) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { assign(this.r(this.tmpAddr)); }),
    ]);
  }

  _queueLoadZpIndexedMicroOps(indexFn, assign) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.tmpAddr); this.tmpAddr = (this.tmpAddr + indexFn()) & 0xFF; }),
      this._readOp(() => { assign(this.r(this.tmpAddr)); }),
    ]);
  }

  _queueLoadAbsMicroOps(assign) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r(this.pc) << 8); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { assign(this.r(this.tmpAddr)); }),
    ]);
  }

  _queueLoadAbsIndexedMicroOps(indexFn, assign) {
    // Real 6502 LDA abs,X / abs,Y is 4 cycles (no page cross) or 5 cycles
    // (page cross). Each micro-op below is one master cycle. The first op
    // re-fetches the opcode (the implicit pre-instruction read costs one
    // cycle in our model, mirroring real-hardware T0).
    //   T0: opcode re-read (the pc++ from the dispatch read)
    //   T1: read addr-lo from PC
    //   T2: read addr-hi from PC, compute base + index in parallel
    //   T3: read from (hi, lo+X) — final addr if no page cross (commit),
    //       OR a "false" read if page cross.
    //   T4 (page cross only): re-read corrected addr and commit.
    //
    this.pageCrossed = 0;
    let base = 0;
    // Page-cross commit read, pre-created once per opcode (captures this op's
    // `assign`) so the cross path doesn't allocate a fresh closure each time.
    const commitOp = () => { assign(this.r(this.tmpAddr)); };
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => {
        base = this.tmpLo | (this.r(this.pc) << 8);
        this.pc = (this.pc + 1) & 0xFFFF;
        this.tmpAddr = (base + indexFn()) & 0xFFFF;
        this.pageCrossed = (base & 0xFF00) !== (this.tmpAddr & 0xFF00) ? 1 : 0;
      }),
      this._readOp(() => {
        if (this.pageCrossed) {
          this.r((base & 0xFF00) | (this.tmpAddr & 0x00FF));
          // Page cross costs a cycle: re-insert the commit read at the slot we
          // just dispatched (microOpHead was incremented by the dispatcher
          // before fn ran, so step it back). The write goes through the one
          // guarded path, _writeMicroOp, which copy-on-writes off any shared
          // template first so the cached program is never corrupted.
          this._writeMicroOp(--this.microOpHead, commitOp, KIND_READ);
          this.instructionCyclesRemaining++;
          return;
        }
        assign(this.r(this.tmpAddr));
      }),
    ]);
  }

  _queueLoadIndxMicroOps(assign) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.tmpAddr); this.tmpAddr = (this.tmpAddr + this.x) & 0xFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r((this.tmpAddr + 1) & 0xFF) << 8); }),
      this._readOp(() => { assign(this.r(this.tmpAddr)); }),
    ]);
  }

  _queueLoadIndyMicroOps(assign) {
    // Real 6502 LDA (zp),Y is 5 cycles (no page cross) or 6 cycles (page
    // cross). Same kind of bug as _queueLoadAbsIndexedMicroOps had: the
    // hi-byte fetch and the data read were combined into one micro-op.
    //
    //   T0: opcode re-read
    //   T1: read zp pointer
    //   T2: read low byte of base from (zp)
    //   T3: read high byte of base from (zp+1), compute base+Y
    //   T4: read at (hi, lo+Y) — final addr if no page cross (commit), or
    //       a "false" read if page cross.
    //   T5 (page cross only): re-read corrected addr and commit.
    this.pageCrossed = 0;
    let base = 0;
    // Page-cross commit read, pre-created once per opcode (captures this op's
    // `assign`) so the cross path doesn't allocate a fresh closure each time.
    const commitOp = () => { assign(this.r(this.tmpAddr)); };
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => {
        base = this.tmpLo | (this.r((this.tmpAddr + 1) & 0xFF) << 8);
        this.tmpAddr = (base + this.y) & 0xFFFF;
        this.pageCrossed = (base & 0xFF00) !== (this.tmpAddr & 0xFF00) ? 1 : 0;
      }),
      this._readOp(() => {
        if (this.pageCrossed) {
          this.r((base & 0xFF00) | (this.tmpAddr & 0x00FF));
          // Page cross costs a cycle: re-insert the commit read at the slot we
          // just dispatched (microOpHead was incremented by the dispatcher
          // before fn ran, so step it back). The write goes through the one
          // guarded path, _writeMicroOp, which copy-on-writes off any shared
          // template first so the cached program is never corrupted.
          this._writeMicroOp(--this.microOpHead, commitOp, KIND_READ);
          this.instructionCyclesRemaining++;
          return;
        }
        assign(this.r(this.tmpAddr));
      }),
    ]);
  }

  _queueReadImmMicroOps(fn) { this._queueLoadImmMicroOps(fn); }
  _queueReadZpMicroOps(fn) { this._queueLoadZpMicroOps(fn); }
  _queueReadZpIndexedMicroOps(indexFn, fn) { this._queueLoadZpIndexedMicroOps(indexFn, fn); }
  _queueReadAbsMicroOps(fn) { this._queueLoadAbsMicroOps(fn); }
  _queueReadAbsIndexedMicroOps(indexFn, fn) { this._queueLoadAbsIndexedMicroOps(indexFn, fn); }
  _queueReadIndxMicroOps(fn) { this._queueLoadIndxMicroOps(fn); }
  _queueReadIndyMicroOps(fn) { this._queueLoadIndyMicroOps(fn); }

  _queueStoreZpMicroOps(valueFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._writeOp(() => { this.w(this.tmpAddr, valueFn()); }),
    ]);
  }

  _queueStoreZpIndexedMicroOps(valueFn, indexFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.tmpAddr); this.tmpAddr = (this.tmpAddr + indexFn()) & 0xFF; }),
      this._writeOp(() => { this.w(this.tmpAddr, valueFn()); }),
    ]);
  }

  _queueStoreAbsMicroOps(valueFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r(this.pc) << 8); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._writeOp(() => { this.w(this.tmpAddr, valueFn()); }),
    ]);
  }

  _queueStoreAbsIndexedMicroOps(valueFn, indexFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => {
        const hi = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
        const idx = indexFn();
        const sum = this.tmpLo + idx;
        this.tmpAddr = ((this.tmpLo | (hi << 8)) + idx) & 0xFFFF;     // corrected target (the write)
        this.tmpFalseAddr = (hi << 8) | (sum & 0xFF);                 // 6502 dummy-read addr (hi NOT carried)
        this.pageCrossed = sum > 0xFF ? 1 : 0;
      }),
      // Indexed stores ALWAYS take this cycle; the dummy read lands on the
      // false (wrapped) address on a page cross — real-HW bus visible (e.g.
      // STA $D0FF,X dummy-reads $D000, not $D100). See cpu-indexed-store-rmw-
      // false-read spec test.
      this._readOp(() => { this.r(this.tmpFalseAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, valueFn()); }),
    ]);
  }

  _queueStoreIndxMicroOps(valueFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.tmpAddr); this.tmpAddr = (this.tmpAddr + this.x) & 0xFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r((this.tmpAddr + 1) & 0xFF) << 8); }),
      this._writeOp(() => { this.w(this.tmpAddr, valueFn()); }),
    ]);
  }

  _queueStoreIndyMicroOps(valueFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => {
        const hi = this.r((this.tmpAddr + 1) & 0xFF);
        const sum = this.tmpLo + this.y;
        this.tmpAddr = ((this.tmpLo | (hi << 8)) + this.y) & 0xFFFF;  // corrected target (the write)
        this.tmpFalseAddr = (hi << 8) | (sum & 0xFF);                 // dummy-read addr (hi NOT carried)
        this.pageCrossed = sum > 0xFF ? 1 : 0;
      }),
      this._readOp(() => { this.r(this.tmpFalseAddr); }),            // page-cross dummy read at the false addr
      this._writeOp(() => { this.w(this.tmpAddr, valueFn()); }),
    ]);
  }

  // ── Unstable store-illegals: SHA/AHX, SHX, SHY, TAS/SHS ──────────────
  // Spec (groepaz "NMOS 6510 Unintended
  // Opcodes"): under stable conditions these store `reg & (H+1)`, where H is
  // the high byte of the base address and `reg` is A&X (SHA/TAS), X (SHX) or
  // Y (SHY). When the index causes a page-boundary crossing, the HIGH byte of
  // the target address is itself replaced by the ANDed value (the classic
  // "high byte = value" corruption). TAS additionally sets SP = A&X.
  //
  // The second instability (sha/shxy/shs readme, real-HW-verified by the
  // *2..*5 testprogs): when a VIC DMA halts the CPU *between the third-last and
  // second-last cycles* — i.e. exactly before the dummy-read cycle — the
  // `& (H+1)` term DROPS OFF the stored VALUE and the instruction stores the
  // plain register. The page-cross ADDRESS high byte keeps the ANDed value
  // regardless (shaabsy5: "the destination address always has its high byte
  // replaced with A&X&(H+1)"). Stalls at other cycles do not drop the AND
  // (shaabsy4 sweeps every alignment; the write itself never stalls — writes
  // proceed under BA). Modelled via _shArmDrop (armed by the address-compute
  // cycle, disarmed by the dummy read) + noteMidOpcodeStall → _shDropAnd.
  _computeShAddr(baseHi, lo, index, regFn) {
    const sum = lo + index;
    this._shReg = regFn() & 0xFF;
    this._shValue = this._shReg & ((baseHi + 1) & 0xFF);
    // No cross → keep base high byte; cross → high byte becomes the ANDed
    // value (steal-independent).
    const ehi = sum > 0xFF ? this._shValue : baseHi;
    this.tmpAddr = ((ehi << 8) | (sum & 0xFF)) & 0xFFFF;
  }

  _queueShAbsIndexedMicroOps(regFn, indexFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => {
        const hi = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
        this._computeShAddr(hi, this.tmpLo, indexFn(), regFn);
        this._shArmDrop = true;         // a stall before the NEXT cycle drops the AND
      }),
      this._readOp(() => { this._shArmDrop = false; this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this._shDropAnd ? this._shReg : this._shValue); }),
    ]);
  }

  _queueShIndyMicroOps(regFn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => {
        const hi = this.r((this.tmpAddr + 1) & 0xFF);
        this._computeShAddr(hi, this.tmpLo, this.y, regFn);
        this._shArmDrop = true;         // a stall before the NEXT cycle drops the AND
      }),
      this._readOp(() => { this._shArmDrop = false; this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this._shDropAnd ? this._shReg : this._shValue); }),
    ]);
  }

  _queueRmwZpMicroOps(fn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this.tmpLo); }),
      this._writeOp(() => { this.w(this.tmpAddr, fn(this.tmpLo)); }),
    ]);
  }

  _queueRmwZpIndexedMicroOps(indexFn, fn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.tmpAddr); this.tmpAddr = (this.tmpAddr + indexFn()) & 0xFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this.tmpLo); }),
      this._writeOp(() => { this.w(this.tmpAddr, fn(this.tmpLo)); }),
    ]);
  }

  _queueRmwAbsMicroOps(fn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r(this.pc) << 8); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this.tmpLo); }),
      this._writeOp(() => { this.w(this.tmpAddr, fn(this.tmpLo)); }),
    ]);
  }

  _queueRmwAbsIndexedMicroOps(indexFn, fn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => {
        const hi = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
        const idx = indexFn();
        const sum = this.tmpLo + idx;
        this.tmpAddr = ((this.tmpLo | (hi << 8)) + idx) & 0xFFFF;     // corrected target
        this.tmpFalseAddr = (hi << 8) | (sum & 0xFF);                 // dummy-read addr (hi NOT carried)
        this.pageCrossed = sum > 0xFF ? 1 : 0;
      }),
      this._readOp(() => { this.r(this.tmpFalseAddr); }),            // RMW dummy read at the false addr on page cross
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this.tmpLo); }),
      this._writeOp(() => { this.w(this.tmpAddr, fn(this.tmpLo)); }),
    ]);
  }

  _queueRmwIndxMicroOps(fn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.tmpAddr); this.tmpAddr = (this.tmpAddr + this.x) & 0xFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r((this.tmpAddr + 1) & 0xFF) << 8); }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this.tmpLo); }),
      this._writeOp(() => { this.w(this.tmpAddr, fn(this.tmpLo)); }),
    ]);
  }

  _queueRmwIndyMicroOps(fn) {
    this.pageCrossed = 0;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => {
        const hi = this.r((this.tmpAddr + 1) & 0xFF);
        const sum = this.tmpLo + this.y;
        this.tmpAddr = ((this.tmpLo | (hi << 8)) + this.y) & 0xFFFF;   // corrected target
        this.tmpFalseAddr = (hi << 8) | (sum & 0xFF);                  // dummy-read addr (hi NOT carried)
        this.pageCrossed = sum > 0xFF ? 1 : 0;
      }),
      this._readOp(() => { this.r(this.tmpFalseAddr); }),            // RMW dummy read at the false addr on page cross
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._writeOp(() => { this.w(this.tmpAddr, this.tmpLo); }),
      this._writeOp(() => { this.w(this.tmpAddr, fn(this.tmpLo)); }),
    ]);
  }

  _queueJmpAbsMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.pc = this.tmpLo | (this.r(this.pc) << 8); }),
    ]);
  }

  _queueJmpIndirectMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this.r(this.pc) << 8); }),
      this._readOp(() => { this.tmpLo = this.r(this.tmpAddr); }),
      this._readOp(() => { this.pc = this.tmpLo | (this.r((this.tmpAddr & 0xFF00) | ((this.tmpAddr + 1) & 0x00FF)) << 8); }),
    ]);
  }

  // Stack ops drive a bus access every cycle at the address the real NMOS
  // chip uses. cy2 is a DUMMY read of the byte after the opcode (PC), NOT a
  // stack read — the stack page is only touched by the push/pull (and, for
  // pulls, the cy3 dummy stack read at the pre-increment SP). Stack page is
  // RAM so the addresses are usually value-equivalent, but matching them
  // keeps the cy2 PC+1 read's potential I/O side effect faithful (same
  // address-level accuracy as the RTS/RTI dummy-read fixes).
  _queuePhaMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }), // cy1: opcode fetch, PC++
      this._readOp(() => { this.r(this.pc); }),                                    // cy2: dummy read of byte after opcode (PC+1)
      this._writeOp(() => { this._push(this.a); }),                                // cy3: push A
    ]);
  }

  _queuePhpMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }), // cy1: opcode fetch, PC++
      this._readOp(() => { this.r(this.pc); }),                                    // cy2: dummy read of byte after opcode (PC+1)
      this._writeOp(() => { this._push(this.getP() | 0x30); }),                    // cy3: push P with bits 4,5 set
    ]);
  }

  _queuePlaMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }), // cy1: opcode fetch, PC++
      this._readOp(() => { this.r(this.pc); }),                                    // cy2: dummy read of byte after opcode (PC+1)
      this._readOp(() => { this.r(0x0100 + this.sp); }),                           // cy3: dummy stack read (S not yet incremented)
      this._readOp(() => { this.a = this._pop(); this.setZN(this.a); }),           // cy4: pull A
    ]);
  }

  _queuePlpMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }), // cy1: opcode fetch, PC++
      this._readOp(() => { this.r(this.pc); }),                                    // cy2: dummy read of byte after opcode (PC+1)
      this._readOp(() => { this.r(0x0100 + this.sp); }),                           // cy3: dummy stack read (S not yet incremented)
      this._readOp(() => { this.setP(this._pop()); }),                             // cy4: pull P (I write is poll-delayed via _pollI — no suppress)
    ]);
  }

  // NMOS interrupt-sequence NMI hijack. The 7-cycle BRK/IRQ sequence does not
  // commit its vector until the cy6/7 fetch — the chip re-reads the interrupt
  // state there. A /NMI that becomes pending during cycles 1-5 therefore
  // HIJACKS an IRQ/BRK sequence: PC and P were already pushed (BRK with B=1,
  // IRQ/NMI with B=0), but the vector fetched is $FFFA, so the NMI handler runs
  // and RTIs past the absorbed BRK/IRQ. A pure NMI sequence is already $FFFA and
  // cannot be hijacked. Verified cycle-band-exact against VICE hijack traces
  // (VICE hijacks L=$01..$05). _seqSampleNmi latches
  // the pending /NMI in cy1-5.
  _seqSampleNmi() { if (this.nmiEdge) this._intSeqNmiLatched = true; }

  // Resolve the vector at the cy6 fetch: redirect a hijackable ($FFFE) sequence
  // to $FFFA when a /NMI latched during cy1-5, consuming the NMI edge so it is
  // not re-serviced at the next boundary.
  _seqResolveVector(baseVector) {
    const v = (this._intSeqHijackable && this._intSeqNmiLatched) ? 0xFFFA : baseVector;
    if (v === 0xFFFA) { this.nmiEdge = false; this.sampledNmiEdge = false; }
    this._intSeqVector = v;
    // Trace hook: the ACTUAL vector committed at the cy6 fetch, distinct from
    // onInterruptAccept (the boundary source). On a hijack the boundary reports
    // 'irq'/BRK while this reports 'nmi' — exactly the IRQ/BRK->NMI distinction.
    if (this.onInterruptVectorCommit) this.onInterruptVectorCommit(v === 0xFFFA ? "nmi" : "irq");
    return v;
  }

  _queueInterruptMicroOps(vector, clearNmiEdge) {
    // onInterruptAccept reports the BOUNDARY decision (the source that started
    // the sequence); an internal cy6 hijack does not change this report — it
    // feeds VIC raster-IRQ-ack timing, which keys on the boundary event.
    if (this.onInterruptAccept) {
      this.onInterruptAccept(vector === 0xFFFA ? 'nmi' : 'irq');
    }
    this._intSeqHijackable = (vector !== 0xFFFA);   // IRQ ($FFFE) is hijackable; NMI is not
    this._intSeqNmiLatched = false;
    this._intSeqVector = vector;
    // Stable base for the cy6 resolve — a mid-sequence NMI hijack rewrites
    // _intSeqVector (see _seqResolveVector), so the pre-created op reads this.
    this._intSeqBaseVector = vector;
    // Replay the pre-created 7-cycle sequence (built once in the constructor) —
    // no per-interrupt closure or array-literal allocation. Cycles:
    //   cy1 read PC — NOT sampled for hijack (a /NMI this early is the boundary
    //       recognizer's job; sampling cy2-6 matches VICE's L=$01..$05 band),
    //   cy2 dummy read, cy3 push PCH, cy4 push PCL, cy5 push P + set I,
    //   cy6 LAST hijack-latch cycle (deadline just before the vector read, VICE
    //       L=$05 edge) → resolve + read vector low, cy7 read vector high.
    this._readOp(this._intSeqOp1);
    this._readOp(this._intSeqOp2);
    this._writeOp(this._intSeqOp3);
    this._writeOp(this._intSeqOp4);
    this._writeOp(this._intSeqOp5);
    this._readOp(this._intSeqOp6);
    this._readOp(this._intSeqOp7);
    this._queueMicroOps();
  }

  _queueJamMicroOps() {
    // JAM / KIL / HLT: the CPU latches the opcode and locks up — it fetches
    // no further bytes, drives $FF on the data bus, and ignores IRQ/NMI.
    // Only RESET recovers it. We mark it halted and burn one bus cycle
    // (the opcode fetch); PC stays put. Every subsequent boundary takes the
    // halted-spin path at the top of _beginMicroInstruction.
    this.halted = true;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); }),  // opcode fetch; PC frozen
    ]);
  }

  _queueBrkMicroOps() {
    // BRK shares the 7-cycle sequence and the NMI hijack: a /NMI pending during
    // cy1-5 redirects the cy6/7 fetch to $FFFA. The B=1 push at cy5 happens
    // BEFORE the vector decision, so a hijacked BRK still pushes B=1 (the NMI
    // handler sees a BRK-flagged status) — matching NMOS. Base vector $FFFE.
    this._intSeqHijackable = true;
    this._intSeqNmiLatched = false;
    this._intSeqVector = 0xFFFE;
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),   // cy1 not sampled (see _queueInterruptMicroOps)
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this._seqSampleNmi(); }),
      this._writeOp(() => { this._push((this.pc >> 8) & 0xFF); this._seqSampleNmi(); }),
      this._writeOp(() => { this._push(this.pc & 0xFF); this._seqSampleNmi(); }),
      this._writeOp(() => { this._push(this.getP() | 0x30); this.I = 1; this._pollI = 1; this._seqSampleNmi(); }),
      this._readOp(() => { this._seqSampleNmi(); this.tmpLo = this.r(this._seqResolveVector(0xFFFE)); }),
      this._readOp(() => { this.pc = this.tmpLo | (this.r(this._intSeqVector + 1) << 8); }),
    ]);
  }

  _queueJsrMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.tmpLo = this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(0x0100 + this.sp); }),
      this._writeOp(() => { this._push((this.pc >> 8) & 0xFF); }),
      this._writeOp(() => { this._push(this.pc & 0xFF); }),
      this._readOp(() => { this.pc = this.tmpLo | (this.r(this.pc) << 8); }),
    ]);
  }

  _queueRtsMicroOps() {
    // Per 6502 datasheet, every cycle of RTS is on the bus, at the
    // address the real chip drives that cycle: opcode, dummy read of the
    // byte after the opcode (PC+1), dummy stack read, pull PCL, pull PCH,
    // dummy read at the assembled return address. Matching the exact
    // addresses matters when RTS sits next to I/O: the cy2 PC+1 read can
    // have a real side effect (e.g. a CIA ICR acknowledge), and there is
    // NO read at return_addr+1 (the old code's spurious extra read would
    // trigger a bogus side effect there). Same class as the RTI dummy-
    // read fix (e19224b). Six bus reads — all stallable under BA-low.
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }), // cy1: opcode fetch, PC++
      this._readOp(() => { this.r(this.pc); }),                                    // cy2: dummy read of byte after opcode (PC+1)
      this._readOp(() => { this.r(0x0100 + this.sp); }),                           // cy3: dummy stack read (S not yet incremented)
      this._readOp(() => { this.tmpLo = this._pop(); }),                           // cy4: pull PCL
      this._readOp(() => { this.tmpAddr = this.tmpLo | (this._pop() << 8); }),     // cy5: pull PCH
      this._readOp(() => { this.r(this.tmpAddr); this.pc = (this.tmpAddr + 1) & 0xFFFF; }), // cy6: dummy read at new PC, then increment
    ]);
  }

  _queueRtiMicroOps() {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => { this.r(this.pc); }),
      this._readOp(() => { this.r(0x0100 + this.sp); }),
      this._readOp(() => { this.setP(this._pop(), /*suppressIntShadow=*/true); }),
      this._readOp(() => { this.tmpLo = this._pop(); }),
      this._readOp(() => { this.pc = this.tmpLo | (this._pop() << 8); }),
    ]);
  }

  _queueBranchMicroOps(condition) {
    this._queueMicroOps([
      this._readOp(() => { this.r(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }),
      this._readOp(() => {
        let offset = this.r(this.pc);
        this.pc = (this.pc + 1) & 0xFFFF;
        if (offset & 0x80) offset |= 0xFF00;
        if (!condition()) return;

        const target = (this.pc + offset) & 0xFFFF;
        const crossed = (this.pc & 0xFF00) !== (target & 0xFF00);
        // NMOS branch-delays-interrupt quirk: a taken branch
        // with no page-cross polls IRQ at end of branch cycle 1, one
        // cycle earlier than the usual penultimate poll. Only set the
        // delay flag if the early poll MISSED the IRQ — otherwise the
        // branch's poll caught it normally and the IRQ should be
        // accepted at the boundary without extra delay. Without this
        // guard, a tight branch loop with a continuously-asserted IRQ
        // would set the delay flag every iteration, deferring
        // acceptance indefinitely (= the FPP / stable-IRQ pattern that
        // motivated audit #3).
        //
        // The delay decision uses the IRQ level sampled for this CPU
        // cycle, plus a phase tag supplied by the machine integration.
        // A late first-sample means the line became visible too late for
        // the branch's early poll even though the normal cycle sample sees
        // it. Once the line has been visible for a full cycle, the tag
        // clears and later branch polls treat it as caught.
        // Publish this branch's operands for the pre-created taken-cycle op
        // (built once in the constructor) — it reads _branchTarget/_branchCrossed
        // instead of allocating a fresh closure. The per-source early-poll
        // interrupt-delay logic (IRQ late-sample tag, NMI sampledNmiEdgePrev)
        // lives in that op, _branchTakenOp.
        this._branchTarget = target;
        this._branchCrossed = crossed;
        this._readOp(this._branchTakenOp);       // pre-created — no allocation
        this.instructionCyclesRemaining++;
        if (crossed) {
          this._readOp(this._branchCrossOp);     // pre-created — no allocation
          this.instructionCyclesRemaining++;
        }
      }),
    ]);
  }

}
