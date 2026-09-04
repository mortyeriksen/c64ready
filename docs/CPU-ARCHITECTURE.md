<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# 6510 CPU (`src/cpu.js`): Architecture Overview

A high-level map of the MOS 6510 CPU emulation: the cycle-accurate microop
engine, instruction dispatch, addressing modes & per-cycle bus access, the
interrupt model (IRQ/NMI sampling, the NMOS I-flag shadow, branch delay), reset,
illegal/unstable opcodes, decimal mode, and how the chip plugs into the machine.

This document describes *the implementation* and points at the real method and
field names so it can be used as a guide into `cpu.js`. The 6510 is
the C64's CPU (a 6502 core + an on-chip 6-bit I/O port); the same `CPU` class
also drives the 1541 drive's 6502. The behavioural references cited in the code
(Bauer §3.x, "Bruce Clark §I-flag-delay", "groepaz NMOS 6510 Unintended
Opcodes", the VICE testprogs) are the authority for the timing quirks below.

> The 6510 **I/O port** ($00/$01) and memory banking live in `src/memory.js`,
> not here; the CPU just delegates every access through `mem.read/write`. See
> the [memory & banking](MEMORY-ARCHITECTURE.md).

---

## 1. Big picture

The CPU is clocked **one cycle at a time** by `machine._runMasterCycle()` via
`cpu.clock()`. Each instruction is decomposed into a queue of **micro-ops**, one
per bus cycle. This is what makes the emulation cycle-exact: VIC bad-line / sprite
DMA can stall the CPU mid-instruction (RDY/AEC), interrupts are sampled at the
spec-correct cycle, and every cycle drives a real bus access at the address the
NMOS chip would use.

```
   machine._runMasterCycle()
        │  cpu.clock()   (once per cycle)
        ▼
   instructionCyclesRemaining == 0 ?
        │ yes → _beginInstruction()
        │          └─ _beginMicroInstruction()   // interrupt? else _installOpcode(op)
        │                ├─ _installOpcode()      // alias pre-built program (common path)
        │                └─ _queueOpcode()        // live _queue*MicroOps() build (BRK/JAM/uncached)
        ▼
   dispatch microOpFns[microOpHead++]   // run THIS cycle's micro-op
        │   each op tagged read / write / internal  (KIND_*)
        ▼
   instructionCyclesRemaining--          // 0 again ⇒ next opcode boundary
```

The live engine is **`_beginMicroInstruction` + the `_queue*MicroOps` builders**:
a single cycle-accurate path covering the full 256-opcode space (official +
illegal + JAM); the module-local `CYCLES` array is only a reference table for
the cycle-audit tests, not a timing source.

---

## 2. CPU state

Registers and flags are stored as separate fields (no packed status byte at
rest; `getP()`/`setP()` pack/unpack on demand):

| Field | Meaning |
|-------|---------|
| `a`, `x`, `y` | accumulator + index registers |
| `sp` | stack pointer (page 1) |
| `pc` | program counter |
| `N V D I Z C` | status flags as separate 0/1 fields (bit 5 always reads 1; B is synthesized) |
| `halted` | JAM/KIL latch; only `reset()` clears it |
| `pageCrossed` | +1-cycle page-cross penalty tracker |

Micro-op queue & dispatch state:

| Field | Meaning |
|-------|---------|
| `microOpFns` / `microOpKinds` | parallel arrays for the current instruction: op closures + bus-kind byte (`KIND_INTERNAL/READ/WRITE`). Normally **alias a pre-built program by reference**; a runtime rewrite copy-on-writes into `_scratchFns`/`_scratchKinds` first (see §4) |
| `_progFns` / `_progKinds` / `_progLen` | the pre-built per-opcode micro-op program table (built once by `_buildOpcodeTable`) |
| `microOpHead` / `microOpLen` | ring cursor + length of the current instruction's queue |
| `instructionCyclesRemaining` | cycles left in the current instruction; `0` ⇒ at an opcode boundary (`atInstructionBoundary()`) |
| `tmpAddr` / `tmpLo` / `_shValue` | scratch carried across cycles of one instruction |
| `currentMicroOpKind` | string form of the current op's kind, read by the machine for RDY/AEC |

The parallel-array (not array-of-objects) design, plus the pre-built program
table that dispatch aliases by reference (no per-instruction closure allocation,
see §4), keep the hot dispatch path allocation-free on JavaScriptCore/mobile as
well as V8.

---

## 3. The `clock()` loop & micro-op dispatch

`clock()` is the per-cycle entry point. Each call:

1. If at a boundary (`instructionCyclesRemaining === 0`), call
   `_beginInstruction()` to build the next queue (interrupt vector or decoded
   opcode). **Building the queue consumes no cycle of its own**; the same
   `clock()` call then dispatches cycle 1.
2. **Sample the IRQ line** into `sampledIrq` (and the late-tag `sampledIrqLate`),
   preserving the previous values in `sampledIrqPrev`/`sampledIrqLatePrev` for
   the branch-delay logic (§6). Sampling happens *only* while the CPU is
   actually stepping: when RDY/AEC blocks the CPU, no sample occurs, so a
   pending IRQ's recognition is correctly held.
3. **Dispatch one micro-op**: read `microOpKinds[head]` into `currentMicroOpKind`,
   run `microOpFns[head]()`, advance the cursor. For a `KIND_INTERNAL` op,
   synthesize a discarded read at PC (`cpuInternalCycleDrivesBus`); the real
   6510 does a bus access *every* cycle, even internal ones, which matters for
   open-bus / I/O side-effect fidelity.
4. Decrement `instructionCyclesRemaining`.

The opcode for decode is read with **`peek()`** (a non-side-effecting memory
read) in `_beginMicroInstruction`; the *actual* bus fetch of the opcode happens
inside cycle 1's micro-op via `r(this.pc)`. That keeps decode from
double-driving the bus.

### Bus-kind tagging (RDY / AEC)
Every micro-op is tagged `read`, `write`, or `internal`. The machine reads
`peekNextBusKind()` / `peekNextRdyClass()` to decide whether a VIC BA-low cycle
stalls the CPU: per Bauer §3.5, **RDY halts reads (and internal/dummy cycles,
which also do a discarded read) but never writes**. So a write micro-op proceeds
under BA-low; a read/internal one stalls. This is why even implied ops
(`_queueSimpleMicroOp`) and NOP-skips (`_queueSkipMicroOps`) pad with real `read`
micro-ops rather than no-ops; otherwise BA-low would silently pass through a
cycle the real chip would have stalled.

---

## 4. Instruction dispatch

Dispatch is driven by a **pre-built per-opcode micro-op program table**.
`_queueOpcode(op)` is a giant `switch (op)` mapping each opcode to a
`_queue*MicroOps` builder (families below). Running that switch every instruction
would allocate a fresh set of micro-op closures per dispatch, on some engines
the dominant idle allocation (see the
[performance doc](PERFORMANCE-ANALYSIS.md)). So the constructor runs the switch
**once per opcode** (`_buildOpcodeTable`) and snapshots each opcode's `(fns, kinds, len)`
into the `_prog*` table. At run time `_installOpcode(op)` **aliases** that program
into the live arrays by reference: O(1), zero allocation. Opcodes that mutate CPU
state at *build* time (BRK arms the interrupt sequence, JAM sets `halted`) are
auto-detected and fall back to the live `_queueOpcode` builder; so does any
uncached opcode.

The builders fall into families:

| Builder family | Covers |
|----------------|--------|
| `_queueLoad*` / `_queueRead*` | LDA/LDX/LDY + read-ALU ops, all address modes (imm/zp/zp,X-Y/abs/abs,X-Y/(ind,X)/(ind),Y) |
| `_queueStore*` | STA/STX/STY + store-illegals (SAX) |
| `_queueRmw*` | INC/DEC/ASL/LSR/ROL/ROR + RMW-illegals (DCP/ISB/SLO/RLA/SRE/RRA) |
| `_queueSh*` | unstable store-illegals SHA/SHX/SHY/TAS (§9) |
| `_queueBranch` | the 8 conditional branches |
| `_queueJmpAbs` / `_queueJmpIndirect` | JMP (incl. the NMOS indirect page-wrap bug) |
| `_queueJsr` / `_queueRts` / `_queueRti` | subroutine + return-from-interrupt |
| `_queuePha/Php/Pla/Plp` | stack push/pull |
| `_queueBrk` / `_queueInterrupt` | BRK + hardware IRQ/NMI vectoring |
| `_queueJam` | JAM/KIL/HLT halt |
| `_queueTransfer` / `_queueSimple` / `_queueAccumulator` / `_queueSkip` | implied, accumulator-mode, multi-byte NOPs |

Each builder pushes its per-cycle closures via `_readOp/_writeOp/_internalOp`
(which append into the parallel arrays); `_queueMicroOps` then sets
`instructionCyclesRemaining = microOpLen`.

---

## 5. Addressing modes & per-cycle bus accuracy

The builders model the exact 6502 bus schedule, including the **dummy reads** the
NMOS core performs. Examples:

- **Zero-page indexed** (`_queueLoadZpIndexedMicroOps`): cycle 3 does a *dummy
  read of the un-indexed address* before the indexed read, the classic 6502
  "read from `base` then `base+X`".
- **Absolute,X / abs,Y / (ind),Y reads** (`_queueLoadAbsIndexedMicroOps`,
  `_queueLoadIndyMicroOps`): a **page cross adds a cycle**. Without a page cross
  the read completes in cycle 4. With one, cycle 4 does a *false read* at the
  wrong-high-byte address and then **unshifts an extra read micro-op** through
  the guarded writer `_writeMicroOp`, so the corrected read happens in cycle 5.
  The writer rewinds `microOpHead`, copies the shared pre-built template on
  first write, overwrites the slot and bumps `instructionCyclesRemaining`. That
  inserted commit op is pre-created once per opcode in the builder, so the
  page-cross path allocates nothing at run time.
- **Store indexed** (`_queueStoreAbsIndexedMicroOps`, `_queueStoreIndyMicroOps`):
  **always** does the dummy read + takes the fixed cycle count (no page-cross
  optimization); stores can't shortcut, matching hardware.
- **RMW** (`_queueRmwAbsMicroOps` etc.): the signature **read, dummy
  write-back-of-old-value, write-new-value** sequence, the double write that
  e.g. `INC $D019` relies on to ack an interrupt twice.
- **JMP (indirect)** (`_queueJmpIndirectMicroOps`): reproduces the NMOS bug where
  the high byte is fetched from `(addr & 0xFF00) | ((addr+1) & 0xFF)`, the
  page-boundary wrap.

---

## 6. Interrupts

This is the most timing-sensitive part of the CPU and the home of several NMOS
quirks. Interrupt *acceptance* is owned exclusively by `_beginMicroInstruction`
(checked at each opcode boundary, before opcode decode).

### Line state & sampling
- **IRQ is level-sensitive**: `setIrqLine(asserted, late)` sets `irqLine`. Each
  `clock()` samples it into `sampledIrq`. Acceptance requires `sampledIrq && I==0`.
- **NMI is edge-triggered**: `setNmiLine` latches the 0→1 rising edge into
  `nmiEdge`; vectoring consumes the edge (cleared in `_seqResolveVector` when the
  resolved vector is `$FFFA`). NMI is **not** masked
  by `I` and takes priority over IRQ.
- **A JAMmed CPU ignores both**: the `halted` spin at the top of
  `_beginMicroInstruction` precedes all interrupt logic, so a pending IRQ/NMI can
  never un-jam the chip (only `reset()` does). Verified by `cpujam` jamirq/jamnmi.

### Vectoring
`_queueInterruptMicroOps(vector, clearNmiEdge)` queues the 7-cycle sequence: 2
dummy PC reads, push PCH/PCL, push P (with B=0), set I, read vector low/high.
`onInterruptAccept('irq'|'nmi')` is a diagnostic hook fired at the boundary
(used by the VIC frame trace to measure latency). BRK (`_queueBrkMicroOps`) is
the software twin: same shape but pushes P with B=1 and advances PC.

The 7 sequence ops are **pre-created once** in the constructor and pushed by
reference, with no per-interrupt allocation. They are
capture-free: cy6 resolves its vector from a stable `_intSeqBaseVector`
published each call, because a mid-sequence NMI **hijack** (`_seqResolveVector`)
rewrites the live `_intSeqVector`.

### NMOS quirks modelled
- **I-flag delay / "interrupt shadow"** (`setP`, CLI/SEI/PLP/RTI): CLI and PLP
  write `I` in their *final* cycle, after the penultimate-cycle interrupt poll,
  so an `I 1→0` unmask is felt **one instruction late**. The interrupt poll
  reads a shadow copy, `_pollI`, that lags `this.I`: a normal `I`-write sets
  `_iWriteThisInstr`, which defers `_pollI`'s update to the next opcode boundary.
  **RTI is the exception**: it restores `I` *before* its poll, so it passes
  `suppressIntShadow=true` (updating `_pollI` immediately) and has no shadow,
  which is what lets an un-acknowledged IRQ re-trigger immediately after RTI
  (Bauer §3.12: the IRQ input is state-sensitive).
- **CLI;SEI slips one interrupt through**: once the shadowed boundary commits a
  pending IRQ, a following `SEI` cannot retract it; the poll that admitted it
  already ran with `_pollI = 0`. This falls straight out of the `_pollI` lag; no
  separate deferral flag is needed.
#### Branch-no-cross IRQ delay

Pinned by the `cpu-branch-irq-delay` and `cpu-nmi-branch-nocross-delay` spec
tests (a VICE-verified NMOS quirk): a *taken branch with no page cross* polls
IRQ one cycle early; if that early poll missed the line, interrupt recognition
is deferred by one boundary (`_branchIrqNoCrossDelay` /
`_branchNmiNoCrossDelay`, tracked per source). The `sampledIrqPrev`/late-tag
machinery decides whether the early poll counts, so a tight branch loop with a
continuously asserted IRQ doesn't defer forever (the stable-raster pattern).
The taken cycle's op (`_branchTakenOp`, which houses this early-poll decision)
and the page-cross cycle's op (`_branchCrossOp`) are **pre-created once** in
the constructor and appended by reference (the decode cycle first publishes the
target into `_branchTarget`/`_branchCrossed`), so a taken branch allocates
nothing.

---

## 7. Machine integration: the interrupt delay pipeline & stalling

`cpu.js` exposes the pins; `machine.js` wires the timing. Two pieces matter:

**Per-source delay pipeline**: each interrupt source (VIC, CIA1, CIA2-NMI) is
staged through the machine's `_sampleCpuInterrupts` so the net CPU-visible
latency matches the VICE oracle. The stage counts and per-source subtleties are
the machine's contract; see the
[machine orchestrator](MACHINE-ARCHITECTURE.md) §5.

**RDY / AEC stalling**: a non-write cycle under BA-low (RDY), or any cycle under
AEC-low, blocks `cpu.clock()` for that cycle, and while blocked, IRQ sampling is
*not* refreshed (Bauer: IRQs are only recognized when RDY is high). The machine
classifies the pending cycle via `peekNextBusKind()`; the arbitration rules live
in the [machine orchestrator](MACHINE-ARCHITECTURE.md) §4.

---

## 8. Reset

`reset()` models the 6502 power-on / reset sequence: it reads the reset vector
(`$FFFC/$FFFD`) into PC, forces `I=1`, and queues **7 dummy internal cycles** so
the first real opcode fetch lands on the 8th cycle. `sp` is set to **`$FF`**
directly (VICE's post-reset presentation, path-stable across repeated resets,
unlike a relative `-3` which would accumulate over warm resets). The 7 dummy
cycles are internal (they do **not** perform the real chip's stack-decrement
reads), and the last one clears the sampled-IRQ state so an IRQ asserted before
reset can't pre-empt the first instruction.

---

## 9. Illegal & unstable opcodes

The full NMOS unintended-opcode set is implemented:

- **Stable illegals**: SAX, LAX, DCP, ISB/ISC, SLO, RLA, SRE, RRA, plus the
  multi-byte NOPs/skips and the implied NOPs.
- **`LAX #imm` / LXA ($AB)** and **ANE/XAA ($8B)** use the chip "magic
  constant": `A = X = (A | 0xEE) & imm` for LXA, `A = (A | 0xEF) & X & imm` for
  ANE. The two constants differ (`0xEE` vs `0xEF`, probed against the VICE
  monitor); the `flibug` torture test depends on the exact bits.
- **Unstable store-illegals SHA/SHX/SHY/TAS** (`_queueSh*` + `_computeShAddr`):
  store `reg & (H+1)` where `H` is the target's high byte; on a page cross the
  **high byte of the address itself becomes the stored value** (the classic
  corruption). TAS also sets `SP = A & X`. The second instability (the `& (H+1)`
  term **dropping off** when a VIC DMA (BA) stall lands in the store's final
  cycles) is modelled too: the `_queueSh*` builders arm `_shArmDrop`, and
  `noteMidOpcodeStall()` then sets `_shDropAnd` so the AND is skipped, matching the
  real-HW `sha*`/`shx*` DMA-drop testprogs.
- **JAM/KIL/HLT** (`_queueJamMicroOps`): sets `halted`, burns the opcode fetch
  cycle, freezes PC; only `reset()` recovers.

---

## 10. ALU & decimal mode

The ALU primitives (`adc`/`sbc`/`cmp`/`asl`/`lsr`/`rol`/`ror`/`setZN`) update
flags inline. **BCD/decimal mode** is fully modelled in `adc`/`_sbcBCD`,
including the NMOS quirk where `N`/`V`/`Z` reflect the *binary* intermediate
rather than the decimal-corrected result. The illegal RMW dispatch inlines a base
op then an ALU op (RRA = ROR then ADC, ISB = INC then SBC) so decimal-mode RRA/ISB
inherit the correct BCD behaviour.

---

## 11. Key invariants & gotchas (quick reference)

- **One micro-op = one bus cycle.** The whole engine's accuracy rests on this;
  never collapse two bus accesses into one micro-op.
- **Every cycle drives the bus**, including internal/dummy cycles, required for
  open-bus and I/O side-effect fidelity (`cpuInternalCycleDrivesBus`).
- **Bus-kind tags drive RDY**: reads/internals stall under BA-low, writes don't.
  Padding cycles must be real `read` ops, not no-ops.
- **Opcode is decoded via `peek()`**, fetched via `r()` in cycle 1; don't
  double-drive the bus at decode.
- **Interrupt acceptance lives only in `_beginMicroInstruction`** (sampled-IRQ +
  branch-delay path), checked at each opcode boundary, before opcode decode.
- **RTI has no I-flag shadow; CLI/PLP do.** Get this wrong and stable-raster /
  acknowledge-race demos break.
- **Page cross adds a cycle for reads, never for stores.**
- **A JAM is only escapable via `reset()`**: interrupts can't recover it.
- **The micro-op engine is the only live path**: `_beginMicroInstruction` and
  the `_queue*` builders. There is no second interpreter.
- The **6510 I/O port and banking are in `memory.js`**, not the CPU.
