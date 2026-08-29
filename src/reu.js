// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/reu.js – Commodore RAM Expansion Unit (MOS 8726 REC)
//
// An REU is not a cartridge. It is a second bus master: the REC exposes eleven
// registers on IO2 and performs DMA between C64 memory and its own RAM, halting
// the 6510 for the duration. The expansion RAM is never visible in the CPU's
// address space — everything moves through the controller.
//
// The C64 side of every transfer goes through Memory.dmaRead/dmaWrite, not
// ram[], so a transfer sees the live $01 banking, ROM and I/O exactly as the
// real bus does. That is the whole point of the $FF00 trigger: software banks
// I/O out, writes $FF00, and the DMA then reads the RAM underneath. The one
// difference from a CPU access is the 6510's on-chip port at $00/$01, which
// stays silent while another master holds the bus.
//
// Register semantics follow the REC register set as published with the
// Commodore RAM Expansion Module User's Guides (see SPECIFICATIONS.md).

import { IO_UNHANDLED } from './cartridges/device.js';

// Transfer types (command register bits 1-0).
const T_STASH  = 0;   // C64 → REU
const T_FETCH  = 1;   // REU → C64
const T_SWAP   = 2;
const T_VERIFY = 3;

// Save-state RAM packing granularity. Expansion RAM is overwhelmingly zero in
// practice, so all-zero blocks are dropped from the snapshot entirely.
const PACK_BLOCK = 4096;

// The models the UI offers, ordered by capacity.
//
// `sizeBit` is status-register bit 4, which reports the RAM chip type rather
// than the capacity: it reads 1 on a 1750 and 0 on a 1700/1764, and that is how
// software tells a 1750 apart from the smaller pair. Distinguishing a 1700 from
// a 1764 needs a second probe — a write into bank 2, which aliases back onto
// bank 0 on the 128K unit (see `_ramMask`).
//
// `bankBits` is the width of the bank register itself. Stock hardware decodes
// three bits whatever the installed RAM, so bank 2 is *writable* on a 1700 and
// merely aliases; capacities above 512K widen the register the way the larger
// third-party units do.
//
// `spanKb` is how far the address counter runs before wrapping, which is not
// the same as how much RAM is fitted. Jumper J1 tells the controller whether
// the DRAM is 64ki×1 or 256ki×1, and it drives two banks either way:
//   1700  J1 closed, 64ki chips, both banks fitted → 128K, wraps at 128K
//   1764  J1 open, 256ki chips, ONE bank fitted    → 256K inside a 512K span,
//                                                    so banks 4-7 are not
//                                                    backed by DRAM and float
//   1750  J1 open, both banks fitted               → 512K, wraps at 512K
// (Moser §2.3.8, §3.5.) Everything above is a later expansion with no holes.
export const REU_MODELS = [
  { id: '1700',    label: '1700',      kb:   128, spanKb:   128, sizeBit: 0, bankBits: 3 },
  { id: '1764',    label: '1764',      kb:   256, spanKb:   512, sizeBit: 0, bankBits: 3 },
  { id: '1750',    label: '1750',      kb:   512, spanKb:   512, sizeBit: 1, bankBits: 3 },
  { id: '1mb',     label: 'GENERIC 1 MB',  kb:  1024, spanKb:  1024, sizeBit: 1, bankBits: 4 },
  { id: '1750xl',  label: '1750 XL',   kb:  2048, spanKb:  2048, sizeBit: 1, bankBits: 5 },
  { id: '4mb',     label: 'GENERIC 4 MB',  kb:  4096, spanKb:  4096, sizeBit: 1, bankBits: 6 },
  { id: '8mb',     label: 'GENERIC 8 MB',  kb:  8192, spanKb:  8192, sizeBit: 1, bankBits: 7 },
  { id: '16mb',    label: 'GENERIC 16 MB', kb: 16384, spanKb: 16384, sizeBit: 1, bankBits: 8 },
];

export const REU_DEFAULT_MODEL = '1750';

export function reuModel(id) {
  return REU_MODELS.find(m => m.id === id) ?? REU_MODELS.find(m => m.id === REU_DEFAULT_MODEL);
}

export class REU {
  constructor(modelId = REU_DEFAULT_MODEL) {
    const model = reuModel(modelId);
    this.modelId = model.id;
    this.model = model;

    this.ram = new Uint8Array(model.kb * 1024);
    // Every span is a power of two, so the wrap is a mask, not a modulo — this
    // runs once per transferred byte. An address inside the span but past the
    // fitted RAM lands on an unpopulated DRAM bank.
    this._spanMask = (model.spanKb * 1024) - 1;
    this._bankMask = (1 << model.bankBits) - 1;
    // Data-bus latch for the unpopulated banks. The DRAM bus holds the last
    // byte the controller drove onto it, so a write — to real RAM or to a hole —
    // is what an unpopulated read gives back; a read does not disturb it.
    this._floatByte = 0x00;

    this.memory = null;
    // Assigned by the machine. busHoldHandler drives the CPU-halt boolean the
    // master cycle tests; irqHandler drives the /IRQ line.
    this.busHoldHandler = null;
    this.irqHandler = null;

    this.activityTick = 0;

    this._resetRegisters();
    this.ram.fill(0);
  }

  attach(memory) {
    this.memory = memory;
  }

  detach() {
    this._setFf00Armed(false);
    this._setBusHold(false);
    this.irqHandler?.(false);
    this.memory = null;
  }

  // ── Register file ─────────────────────────────────────────────────────────
  // Power-up values are the ones a detection routine reads back before touching
  // anything: $10 $10 $00 $00 $00 $00 $F8 $FF $FF $1F $3F.
  _resetRegisters() {
    this._irqPending = false;
    this._endOfBlock = false;
    this._fault      = false;

    this._command  = 0x10;   // execute clear, FF00 decode disabled
    this._imr      = 0x00;
    this._addrCtrl = 0x00;

    this._c64Addr = 0x0000;
    this._reuAddr = 0x000000;
    this._len     = 0xFFFF;

    // Autoload reloads from the last values the CPU *wrote*, not from the
    // counters the transfer left behind. The bank shadow is separate from the
    // 16-bit REU address shadow — the chip pairs $DF04/$DF05 but not $DF06.
    this._shadowC64 = 0x0000;
    this._shadowReuAddr = 0x0000;
    this._shadowBank = 0x00;
    this._shadowLen = 0xFFFF;

    this._active    = false;
    this._xferType  = T_STASH;
    this._swapPhase = 0;
    this._swapLatch = 0;
    this._verifyTail = false;
    this._ff00Armed = false;
  }

  // Activity counter for the UI's expansion-RAM lamp: one tick per transfer, so
  // a per-frame poller can tell a fresh burst from a stale one. Transfers are
  // far too short to watch live, so the card latches the light on for a beat.
  _noteActivity() {
    this.activityTick = (this.activityTick + 1) >>> 0;
  }

  get dmaActive() { return this._active; }

  // Expansion-RAM access at an already-wrapped offset. Offsets past the fitted
  // DRAM read the floating bus and swallow writes.
  _ramRead(off) {
    return off < this.ram.length ? this.ram[off] : this._floatByte;
  }

  _ramWrite(off, v) {
    this._floatByte = v;
    if (off < this.ram.length) this.ram[off] = v;
  }

  _statusByte() {
    return (this._irqPending ? 0x80 : 0)
         | (this._endOfBlock ? 0x40 : 0)
         | (this._fault      ? 0x20 : 0)
         | (this.model.sizeBit << 4);
    // Bits 3-0 are the chip version, which reads 0.
  }

  // The REC sits on IO2 and decodes only the low five address lines, so the
  // eleven registers mirror every 32 bytes across the whole $DF00 page. The
  // controller occupies every address in that page: the offsets above $0A are
  // not registers but still read back as $FF, driven by the chip rather than
  // left to open bus. Detection routines walk the mirrors to find the REU, so
  // this is load-bearing (Moser §2.1).
  _reg(addr) {
    if ((addr & 0xFF00) !== 0xDF00) return -1;
    const reg = addr & 0x1F;
    return reg > 0x0A ? -2 : reg;      // -2 = in the page, but not a register
  }

  ioRead(addr) {
    const reg = this._reg(addr);
    if (reg === -1) return IO_UNHANDLED;
    if (reg === -2) return 0xFF;
    if (reg === 0x00) {
      const v = this._statusByte();
      // Reading the status register clears bits 7-5 and releases /IRQ.
      this._irqPending = false;
      this._endOfBlock = false;
      this._fault = false;
      this.irqHandler?.(false);
      return v;
    }
    return this._peekReg(reg);
  }

  ioPeek(addr) {
    const reg = this._reg(addr);
    if (reg === -1) return IO_UNHANDLED;
    if (reg === -2) return 0xFF;
    return reg === 0x00 ? this._statusByte() : this._peekReg(reg);
  }

  // Undriven bits do not read alike. The bank, interrupt-mask and address-
  // control registers pull their spare bits to 1. The command register's
  // "reserved" bits 6 and 3-2 are neither: they are backed by real flip-flops
  // and read back whatever was last written, unchanged by any REU operation
  // (Moser §2.4.2) — so the whole byte reads back as written.
  _peekReg(reg) {
    switch (reg) {
      case 0x01: return this._command & 0xFF;
      case 0x02: return this._c64Addr & 0xFF;
      case 0x03: return (this._c64Addr >> 8) & 0xFF;
      case 0x04: return this._reuAddr & 0xFF;
      case 0x05: return (this._reuAddr >> 8) & 0xFF;
      case 0x06: return ((this._reuAddr >> 16) & this._bankMask) | (~this._bankMask & 0xFF);
      case 0x07: return this._len & 0xFF;
      case 0x08: return (this._len >> 8) & 0xFF;
      case 0x09: return (this._imr & 0xE0) | 0x1F;
      case 0x0A: return (this._addrCtrl & 0xC0) | 0x3F;
      default:   return 0xFF;
    }
  }

  ioWrite(addr, val) {
    const reg = this._reg(addr);
    if (reg < 0) return false;
    val &= 0xFF;
    // Writes to $DF02-$DF08 land in the shadow registers, and the counters are
    // then reloaded from the shadow. The address and length pairs are 16-bit
    // registers internally, so writing one half drags the other half's shadow
    // value into the counter with it — the documented "half-autoload bug"
    // (Moser §3.2). The bank register has no such pairing.
    switch (reg) {
      case 0x00:
        break;                       // status is read-only
      case 0x01:
        this._command = val;
        if (val & 0x80) {
          // Bit 4 set means the $FF00 decode is DISABLED, so the transfer
          // starts straight away; clear means wait for a write to $FF00.
          if (val & 0x10) this._execute();
          else this._setFf00Armed(true);
        } else {
          this._setFf00Armed(false);
        }
        break;
      case 0x02:
        this._shadowC64 = (this._shadowC64 & 0xFF00) | val;
        this._c64Addr = this._shadowC64;
        break;
      case 0x03:
        this._shadowC64 = (this._shadowC64 & 0x00FF) | (val << 8);
        this._c64Addr = this._shadowC64;
        break;
      case 0x04:
        this._shadowReuAddr = (this._shadowReuAddr & 0xFF00) | val;
        this._reuAddr = (this._reuAddr & 0xFF0000) | this._shadowReuAddr;
        break;
      case 0x05:
        this._shadowReuAddr = (this._shadowReuAddr & 0x00FF) | (val << 8);
        this._reuAddr = (this._reuAddr & 0xFF0000) | this._shadowReuAddr;
        break;
      case 0x06:
        this._shadowBank = val & this._bankMask;
        this._reuAddr = (this._reuAddr & 0x00FFFF) | (this._shadowBank << 16);
        break;
      case 0x07:
        this._shadowLen = (this._shadowLen & 0xFF00) | val;
        this._len = this._shadowLen;
        break;
      case 0x08:
        this._shadowLen = (this._shadowLen & 0x00FF) | (val << 8);
        this._len = this._shadowLen;
        break;
      case 0x09:
        this._imr = val;
        this._updateIrq();           // unmasking a pending flag raises /IRQ
        break;
      case 0x0A:
        this._addrCtrl = val;
        break;
    }
    return true;
  }

  // ── Transfer engine ───────────────────────────────────────────────────────

  // Called by Memory when the CPU writes $FF00 while a transfer is armed.
  ff00Triggered() {
    if (!this._ff00Armed) return;
    this._setFf00Armed(false);
    if (this._command & 0x80) this._execute();
  }

  _execute() {
    if (this._active) return;
    this._xferType = this._command & 0x03;
    this._swapPhase = 0;
    this._verifyTail = false;
    this._active = true;
    this._noteActivity();
    this._setFf00Armed(false);
    // The hold is read at the top of the next master cycle — the CPU is still
    // completing the write that triggered this one.
    this._setBusHold(true);
  }

  // One C64-bus access. Stash, fetch and verify move a byte per access; swap
  // needs two (read then write), which is the documented halving of its rate.
  dmaCycle() {
    const mem = this.memory;
    const reuOff = this._reuAddr & this._spanMask;

    switch (this._xferType) {
      case T_STASH:
        this._ramWrite(reuOff, mem.dmaRead(this._c64Addr));
        break;

      case T_FETCH:
        mem.dmaWrite(this._c64Addr, this._ramRead(reuOff));
        break;

      case T_VERIFY: {
        // A fault that is not on the final byte costs one more comparison
        // cycle, and that comparison is what decides end-of-block. QuickReuTest
        // measures it: a fault on the last byte runs for exactly the bytes
        // compared, while a fault one earlier runs for one cycle more, whether
        // or not the byte after it matches. The counters do not advance again,
        // so the addresses still stop one past the byte that failed.
        if (this._verifyTail) {
          const equal = mem.dmaRead(this._c64Addr) === this._ramRead(reuOff);
          this._verifyTail = false;
          // The run only counts as having reached its end if the counter got to
          // 1 *and* that last comparison was clean — two mismatches running
          // into the end of the block leave end-of-block clear.
          this._finish(this._len === 1 && equal);
          return;
        }
        // Moser §2.3.6: the fault flag is set, the addresses still advance past
        // the failing byte, and the counter is only decremented if it had not
        // already reached 1.
        if (mem.dmaRead(this._c64Addr) !== this._ramRead(reuOff)) this._fault = true;
        this._advance();
        if (this._len === 1) { this._finish(true); return; }
        this._len = (this._len - 1) & 0xFFFF;
        if (this._fault) { this._verifyTail = true; return; }
        return;
      }

      case T_SWAP:
        if (this._swapPhase === 0) {
          this._swapLatch = mem.dmaRead(this._c64Addr);
          this._swapPhase = 1;
          return;                    // second bus cycle next time round
        }
        mem.dmaWrite(this._c64Addr, this._ramRead(reuOff));
        this._ramWrite(reuOff, this._swapLatch);
        this._swapPhase = 0;
        break;
    }

    this._advance();
    // The byte counter counts down to 1, not 0 — a length of N transfers N
    // bytes and leaves the register reading 1. A length of 0 wraps through
    // $FFFF and so transfers the full 64K.
    if (this._len === 1) this._finish(true);
    else this._len = (this._len - 1) & 0xFFFF;
  }

  _advance() {
    const ctl = this._addrCtrl;
    // Address control bit 7 fixes the C64 side, bit 6 fixes the REU side.
    if ((ctl & 0x80) === 0) this._c64Addr = (this._c64Addr + 1) & 0xFFFF;
    if ((ctl & 0x40) === 0) this._reuAddr = (this._reuAddr + 1) & 0xFFFFFF;
  }

  // `setEndOfBlock` follows the transfer-length counter reaching 1, not whether
  // a fault occurred. The controller never clears these flags itself — they OR
  // together across transfers until the CPU reads the status register.
  _finish(setEndOfBlock) {
    this._active = false;
    this._swapPhase = 0;
    if (setEndOfBlock) this._endOfBlock = true;
    // Execute clears and the $FF00 decode is disabled again — the option is
    // consumed by every use.
    this._command = (this._command & 0x7F) | 0x10;
    if (this._command & 0x20) {
      this._c64Addr = this._shadowC64;
      this._reuAddr = (this._shadowBank << 16) | this._shadowReuAddr;
      this._len = this._shadowLen;
    }
    this._setBusHold(false);
    this._updateIrq();
  }

  _updateIrq() {
    const enabled = (this._imr & 0x80) !== 0;
    const raise = enabled && (
      ((this._imr & 0x40) !== 0 && this._endOfBlock) ||
      ((this._imr & 0x20) !== 0 && this._fault)
    );
    if (raise) this._irqPending = true;
    this.irqHandler?.(this._irqPending);
  }

  _setBusHold(held) {
    this.busHoldHandler?.(held);
  }

  _setFf00Armed(armed) {
    armed = !!armed;
    if (armed === this._ff00Armed) return;
    this._ff00Armed = armed;
    this.memory?.setReuFf00Watch(armed);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // /RESET aborts any transfer and restores the power-up register values.
  // Expansion DRAM is not cleared — a reset does not wipe the contents.
  resetLine() {
    const held = this._active;
    this._setFf00Armed(false);
    this._resetRegisters();
    if (held) this._setBusHold(false);
    this.irqHandler?.(false);
  }

  powerUp() {
    this.resetLine();
    this.ram.fill(0);
  }

  clearRam() {
    this.ram.fill(0);
  }

  loadImage(bytes) {
    this.ram.fill(0);
    this.ram.set(bytes.subarray(0, Math.min(bytes.length, this.ram.length)));
  }

  // ── Save state ────────────────────────────────────────────────────────────

  serialize() {
    return {
      model: this.modelId,
      irqPending: this._irqPending,
      endOfBlock: this._endOfBlock,
      fault: this._fault,
      command: this._command,
      imr: this._imr,
      addrCtrl: this._addrCtrl,
      c64Addr: this._c64Addr,
      reuAddr: this._reuAddr,
      len: this._len,
      shadowC64: this._shadowC64,
      shadowReuAddr: this._shadowReuAddr,
      shadowBank: this._shadowBank,
      shadowLen: this._shadowLen,
      active: this._active,
      xferType: this._xferType,
      swapPhase: this._swapPhase,
      swapLatch: this._swapLatch,
      verifyTail: this._verifyTail,
      ff00Armed: this._ff00Armed,
      ram: this._packRam(),
    };
  }

  deserialize(s) {
    this._irqPending = !!s.irqPending;
    this._endOfBlock = !!s.endOfBlock;
    this._fault = !!s.fault;
    this._command = s.command & 0xFF;
    this._imr = s.imr & 0xFF;
    this._addrCtrl = s.addrCtrl & 0xFF;
    this._c64Addr = s.c64Addr & 0xFFFF;
    this._reuAddr = s.reuAddr & 0xFFFFFF;
    this._len = s.len & 0xFFFF;
    this._shadowC64 = s.shadowC64 & 0xFFFF;
    this._shadowReuAddr = (s.shadowReuAddr ?? 0) & 0xFFFF;
    this._shadowBank = (s.shadowBank ?? 0) & 0xFF;
    this._shadowLen = s.shadowLen & 0xFFFF;
    this._active = !!s.active;
    this._xferType = s.xferType & 3;
    this._swapPhase = s.swapPhase ? 1 : 0;
    this._swapLatch = s.swapLatch & 0xFF;
    this._verifyTail = !!s.verifyTail;
    this._unpackRam(s.ram);

    // The armed/held lines are outputs, so re-drive them rather than trusting
    // the snapshot's view of the machine.
    this._ff00Armed = false;
    this._setFf00Armed(!!s.ff00Armed);
    this._setBusHold(this._active);
    this.irqHandler?.(this._irqPending);
  }

  _packRam() {
    const blocks = [];
    for (let i = 0; i < this.ram.length; i += PACK_BLOCK) {
      const end = i + PACK_BLOCK;
      let zero = true;
      for (let j = i; j < end; j++) {
        if (this.ram[j] !== 0) { zero = false; break; }
      }
      if (!zero) blocks.push({ at: i, bytes: this.ram.slice(i, end) });
    }
    return { size: this.ram.length, blockSize: PACK_BLOCK, blocks };
  }

  _unpackRam(p) {
    this.ram.fill(0);
    if (!p || !p.blocks) return;
    for (const b of p.blocks) {
      // A state saved from a larger model than the one now installed keeps
      // whatever fits rather than throwing the restore away.
      if (b.at >= this.ram.length) continue;
      const bytes = b.bytes.length > this.ram.length - b.at
        ? b.bytes.subarray(0, this.ram.length - b.at)
        : b.bytes;
      this.ram.set(bytes, b.at);
    }
  }
}
