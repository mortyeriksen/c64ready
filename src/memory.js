// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/memory.js – C64 bank-switched memory map
// CPU port $01 controls ROM/IO visibility (LORAM, HIRAM, CHAREN)
// Reads/writes route to: RAM, KERNAL ROM, BASIC ROM, CHAR ROM, or I/O chips
//
// Hot-path read/write use a 256-entry per-page dispatch table —
// _readPageArr[page] holds the Uint8Array to read from (or null for the
// slow / IO / open-bus paths), and _readPageOffset[page] is the value
// subtracted from addr to index that array. The table is rebuilt
// whenever cpuPort, cartMode, or any ROM/cart array changes. RAM, KERNAL,
// BASIC, CHAR-ROM, ROML/ROMH, and the ultimax-open-bus shadow page
// resolve to a single typed-array load. I/O ($D000-$DFFF when CHAREN
// gates it on) and CPU port $00/$01 still go through the slow path.

import { IO_UNHANDLED } from './cartridges/device.js';
import { createCartridgeFromConfig } from './cartridges/registry.js';

const OPEN_BUS_FILL = 0xFF;

export class Memory {
  constructor() {
    this.ram      = new Uint8Array(65536);
    this.colorRam = new Uint8Array(1024);
    this._kernal  = null; // Uint8Array(8192)
    this._basic   = null; // Uint8Array(8192)
    this._charRom = null; // Uint8Array(4096)

    // I/O chip references
    this.vic2  = null;
    this.sid   = null;   // SID write forwarder (ring buffer writer)
    this.cia1  = null;
    this.cia2  = null;
    this.machine = null; // back-ref for joystick reads

    // 6510 on-chip I/O (addresses 0 and 1). Raw power-up: DDR = all inputs
    // ($00), data latch $00. The KERNAL reset routine later writes $2F/$37;
    // until then the pull-ups (bits 0,1,2,4) make $01 read back as $17, which
    // still selects KERNAL+BASIC+IO so the reset vector is reachable.
    this.cpuDDR  = 0x00;
    this.cpuPort = 0x00;

    // Shared external data bus latch (D0-D7). Updated by every CPU read,
    // every CPU write, and every VIC chip-bus fetch. Open-bus CPU reads
    // ($DE00-$DFFF without a cart device, and the high nybble of Color RAM)
    // sample this latch instead of returning a fixed value. See
    // VIC-Addendum.txt + Bauer §3.12. Default 0xFF mirrors a freshly-released
    // bus on power-up.
    this.externalDataBus8 = 0xFF;

    // Tier-3 line-batch fetch watch (see the hook in write()) — armed by
    // vic2 while a line's paints are deferred, covering the absolute RAM
    // range the line's g-accesses fetch from.
    this._vicFetchWatchOn = false;
    this._vicFetchWatchLo = 0;
    this._vicFetchWatchHi = 0;

    // Profile flags — toggle individually to bisect.
    //
    // openBusWritesToZeroOneEnabled models what the CPU port actually does to
    // the RAM beneath it: the 6510's data drivers stay tri-stated on a write to
    // $00/$01 (the port is internal), so the byte the VIC drove during phi1
    // lands in the DRAM instead of the written value. The VICE testprogs'
    // REU/cpuport check depends on it — "writing to addresses 0/1 will always
    // write into RAM whatever was on the bus before" — and reads it back
    // through an REU transfer, which is the only way software can see it.
    this.openBusMode = 'vice-compatible';        // 'vice-compatible' | 'disabled' | 'random'
    this.colorRamReadDrivesComposedByte = true;  // composed value re-drives latch
    this.openBusWritesToZeroOneEnabled = true;   // RAM-under-port quirk

    // Cartridge mapping cache. Cartridge-specific registers and lifecycle
    // live in the attached device; these fields keep the page-table hot path
    // free of polymorphic calls.
    this.cartridge = null;
    this.cartType  = 'none';
    this.cartRomLo = null;   // Uint8Array(8192) – active ROML ($8000-$9FFF)
    this.cartRomHi = null;   // Uint8Array(8192) – active ROMH ($A000-$BFFF or $E000-$FFFF)
    this.cartMode  = 'none'; // 'none' | '8k' | '16k' | 'ultimax'

    this.cartBank       = 0;
    this.cartRomLoBanks = null;
    this.cartRomHiBanks = null;
    this.cartRam        = null;
    this.cartControl       = 0x40;
    this.cartFreezeHeld    = false;
    this.cartNmiAsserted   = false;
    this.cartNmiHandler    = null;

    // RAM Expansion Unit. A separate slot from the cartridge — an REU is a
    // pass-through expansion, so both can be attached at once (the real setup
    // needs a port expander). It decodes $DF00-$DF0A ahead of the cartridge.
    this.reu = null;
    // $FF00 write snoop for the REU's deferred transfer trigger. While armed,
    // page $FF's write entry is forced to the slow path and its real target
    // parked in _ff00Write*; disarmed, the write fast path is untouched.
    this._reuFf00Watch = false;
    this._ff00WriteArr = null;
    this._ff00WriteOff = 0;

    // Per-page dispatch tables. arr = null means "slow path" (the read/
    // write fn falls through to _readSlow / _writeSlow which handles I/O,
    // EasyFlash regs, and any other special cases). Otherwise:
    //   read: result = arr[addr - offset]
    //   write: arr[addr - offset] = val
    this._readPageArr    = new Array(256).fill(null);
    this._readPageOffset = new Int32Array(256);
    this._writePageArr    = new Array(256).fill(null);
    this._writePageOffset = new Int32Array(256);
    // Shadow buffer that returns 0xFF for ultimax open-bus reads. One
    // 256-byte buffer reused across all open-bus pages — each page sets
    // offset = (page << 8) so arr[addr - offset] always lands at
    // _openBus[addr & 0xFF] regardless of which page is reading.
    this._openBus = new Uint8Array(256).fill(OPEN_BUS_FILL);

    this._rebuildMemoryMap();
  }

  // kernal/basic/charRom are exposed as properties for back-compat with
  // callers (machine.loadROMs, tests) that assign them directly. Each
  // assignment retriggers the dispatch-table rebuild so the new ROM
  // becomes visible without an explicit invalidation call.
  get kernal()  { return this._kernal; }
  set kernal(v) { this._kernal = v; this._rebuildMemoryMap(); }
  get basic()   { return this._basic; }
  set basic(v)  { this._basic = v; this._rebuildMemoryMap(); }
  get charRom() { return this._charRom; }
  set charRom(v){ this._charRom = v; this._rebuildMemoryMap(); }

  setCartridge(cfg) {
    this.installCartridge(createCartridgeFromConfig(cfg));
  }

  installCartridge(device) {
    this.cartridge?.detach();
    this.cartridge = device;
    if (device) device.attach(this);
    else this._applyCartridgeDeviceMapping(null);
  }

  _applyCartridgeDeviceMapping(device) {
    this.cartType = device?.id ?? 'none';
    this.cartMode = device?.mode ?? 'none';
    this.cartBank = device?.bank ?? 0;
    this.cartRomLo = device?.romLo ?? null;
    this.cartRomHi = device?.romHi ?? null;
    this.cartRomLoBanks = device?.romLoBanks ?? device?.romBanks ?? null;
    this.cartRomHiBanks = device?.romHiBanks ?? null;
    this.cartRam = device?.ram ?? null;
    this.cartControl = device?.control ?? 0x40;
    this.cartFreezeHeld = device?.freezeHeld ?? device?.freezeLatched ?? false;
    this._rebuildMemoryMap();
  }

  installReu(device) {
    this.reu?.detach();
    this.reu = device;
    if (device) device.attach(this);
    else this.setReuFf00Watch(false);
  }

  // Armed by the REU when a transfer waits on the $FF00 trigger.
  setReuFf00Watch(armed) {
    armed = !!armed;
    if (armed === this._reuFf00Watch) return;
    this._reuFf00Watch = armed;
    this._rebuildMemoryMap();
  }

  _setCartNmi(asserted) {
    asserted = !!asserted;
    if (asserted === this.cartNmiAsserted) return;
    this.cartNmiAsserted = asserted;
    this.cartNmiHandler?.(asserted);
  }

  setFinal3Freeze(held) {
    return this.setCartridgeFreeze(held);
  }

  resetFinal3Control() {
    return this.cartridge?.physicalReset() ?? false;
  }

  setCartridgeFreeze(held) {
    if (!this.cartridge?.capabilities.freeze) return false;
    return held ? this.cartridge.freezePressed() : this.cartridge.freezeReleased();
  }

  resetCartridgeControl() {
    if (!this.cartridge?.capabilities.reset) return false;
    return this.cartridge.physicalReset();
  }

  // ── Save-state ────────────────────────────────────────────────────────────
  // Captures RAM + color RAM + CPU-port banking + cartridge bank/RAM state.
  // The cartridge ROM banks themselves are NOT captured — they are large and
  // are rebuilt by re-loading the .crt before restoreState() runs; deserialize
  // only re-points the active bank and restores the (small) EF cart RAM.
  serialize() {
    return {
      ram: this.ram.slice(),
      colorRam: this.colorRam.slice(),
      cpuPort: this.cpuPort, cpuDDR: this.cpuDDR,
      externalDataBus8: this.externalDataBus8,
      cart: this.cartridge?.serialize() ?? null,
    };
  }

  deserialize(s) {
    this.ram.set(s.ram);
    this.colorRam.set(s.colorRam);
    this.cpuPort = s.cpuPort & 0xFF; this.cpuDDR = s.cpuDDR & 0xFF;
    this.externalDataBus8 = (s.externalDataBus8 ?? 0xFF) & 0xFF;
    if (s.cart && this.cartridge) this.cartridge.deserialize(s.cart);
    this._rebuildMemoryMap();
  }

  // Rebuild the per-page read/write dispatch tables based on current
  // cpuPort + cartMode + ROM availability. Cheap (~256 iterations) and
  // only fires on state changes (CPU port write, cartridge swap, ROM
  // load), not per CPU cycle.
  _rebuildMemoryMap() {
    // Banking reads the port PINS, not the latch: input bits (DDR=0) float to
    // their pull-ups. Bits 0,1,2 (LORAM/HIRAM/CHAREN) pull up to 1, so a raw
    // power-up DDR=$00/latch=$00 still reads $07 here → KERNAL+BASIC+IO, and
    // the $FFFC reset vector lands in KERNAL ROM (not RAM garbage).
    const port  = (this.cpuPort & this.cpuDDR) | (0x07 & ~this.cpuDDR);
    const loram = (port & 1) !== 0;
    const hiram = (port & 2) !== 0;
    const charen= (port & 4) !== 0;
    const ram = this.ram;
    const readArr = this._readPageArr;
    const readOff = this._readPageOffset;
    const writeArr = this._writePageArr;
    const writeOff = this._writePageOffset;
    const openBus = this._openBus;

    for (let page = 0; page < 256; page++) {
      const baseAddr = page << 8;
      // Default: RAM read, RAM write. Overridden below per region.
      let rArr = ram, rOff = 0;
      let wArr = ram, wOff = 0;

      if (this.cartMode === 'ultimax') {
        // Ultimax remaps the entire address space.
        if (page >= 0x80 && page <= 0x9F && this.cartRomLo) {
          if (this.cartridge?.romLoReadHook) {
            rArr = null;
          } else {
            rArr = this.cartRomLo; rOff = 0x8000;
          }
          if (this.cartridge?.romLoWriteTarget) {
            wArr = this.cartridge.romLoWriteTarget; wOff = 0x8000;
          } else {
            wArr = null;
          }
        } else if (page >= 0xE0 && this.cartRomHi) {
          rArr = this.cartRomHi; rOff = 0xE000;
          wArr = null;
        } else if (page >= 0xD0 && page <= 0xDF) {
          // I/O area always active in ultimax. Slow path handles
          // VIC/SID/CIA/colorRam and EasyFlash $DE/$DF.
          rArr = null;
          wArr = null;
        } else if ((page >= 0x10 && page <= 0x7F) || (page >= 0xA0 && page <= 0xCF)) {
          // Open bus. Reads return 0xFF, writes are silently dropped.
          rArr = openBus; rOff = baseAddr;
          wArr = null;
        }
      } else {
        // Standard PLA decoding (no/8k/16k cart variants).
        if (page >= 0x80 && page <= 0x9F &&
            (this.cartMode === '8k' || this.cartMode === '16k') &&
            this.cartRomLo && loram && hiram) {
          if (this.cartridge?.romLoReadHook) {
            rArr = null;
          } else {
            rArr = this.cartRomLo; rOff = 0x8000;
          }
          if (this.cartridge?.romLoWriteTarget) {
            wArr = this.cartridge.romLoWriteTarget; wOff = 0x8000;
          }
        } else if (page >= 0xA0 && page <= 0xBF &&
                   this.cartMode === '16k' && this.cartRomHi && hiram) {
          rArr = this.cartRomHi; rOff = 0xA000;
        } else if (page >= 0xE0 && hiram && this._kernal) {
          rArr = this._kernal; rOff = 0xE000;
        } else if (page >= 0xA0 && page <= 0xBF && loram && hiram && this._basic) {
          rArr = this._basic; rOff = 0xA000;
        } else if (page >= 0xD0 && page <= 0xDF && (loram || hiram)) {
          // I/O / CHARROM region. Whether reads are I/O, CHARROM, or
          // RAM depends on CHAREN + cartMode. If CHAREN=1 → I/O (slow).
          // If CHAREN=0 → CHARROM (when available, gated on cartMode).
          // If neither path picks up the read, fall back to RAM.
          if (charen) {
            rArr = null;          // slow → _readIO
          } else if (this._charRom && (this.cartMode !== '16k' || hiram)) {
            rArr = this._charRom; rOff = 0xD000;
          }
          // Writes always go to slow path when (loram || hiram) && charen
          // is the I/O gate; otherwise they fall to RAM.
          if (charen) {
            wArr = null;          // slow → _writeIO
          }
        }
      }

      // Page 0 has CPU-port special-cases at $00/$01 — handled by the
      // entry checks in read()/write() before the table dispatch, so
      // the table itself stays simple (RAM for the rest of page 0).
      readArr[page] = rArr;
      readOff[page] = rOff;
      writeArr[page] = wArr;
      writeOff[page] = wOff;
    }

    // REU $FF00 trigger: divert page $FF's writes to the slow path so
    // _writeSlow sees the store, keeping the page's real write target so the
    // byte still lands where it would have. Only while a transfer is armed —
    // the write fast path costs nothing the rest of the time.
    if (this._reuFf00Watch) {
      this._ff00WriteArr = writeArr[0xFF];
      this._ff00WriteOff = writeOff[0xFF];
      writeArr[0xFF] = null;
    } else {
      this._ff00WriteArr = null;
      this._ff00WriteOff = 0;
    }
  }

  // Bus accesses by an external DMA master (the REU). Identical to read() and
  // write() except that the 6510's on-chip port at $00/$01 does not answer:
  // that decode is inside the CPU, which is tri-stated while another master
  // drives the bus, so the DRAM underneath responds instead. Banking, ROM and
  // I/O all behave exactly as they do for the CPU. Without this a 64K transfer
  // covering all of RAM would write $01 mid-flight and re-bank itself.
  dmaRead(addr) {
    addr &= 0xFFFF;
    const page = addr >> 8;
    const arr = this._readPageArr[page];
    const v = arr !== null ? arr[addr - this._readPageOffset[page]] : this._readSlow(addr);
    this.externalDataBus8 = v & 0xFF;
    return v;
  }

  dmaWrite(addr, val) {
    addr &= 0xFFFF;
    val  &= 0xFF;
    this.externalDataBus8 = val;
    const page = addr >> 8;
    const arr = this._writePageArr[page];
    if (arr !== null) {
      if (this._vicFetchWatchOn && addr >= this._vicFetchWatchLo && addr < this._vicFetchWatchHi) {
        this.vic2._catchUpDeferredLine();
      }
      arr[addr - this._writePageOffset[page]] = val;
      return;
    }
    this._writeSlow(addr, val);
  }

  read(addr) {
    addr &= 0xFFFF;

    // CPU port special-cases. The DDR/port register and the SENSE-bit
    // dynamic read can't be table-served because $01's value depends on
    // datasette pin state at read time.
    if (addr < 2) {
      let v;
      if (addr === 0) v = this.cpuDDR;
      else {
        const sense = this.machine?.datasette?.getSenseLevel() ?? 1;
        // 6510 port read: output bits (DDR=1) read the latch; input bits
        // (DDR=0) read the pin. Bits 0,1,2 have external pull-ups (→1), bit 4
        // is the cassette-sense input, bits 3,5-7 read 0 when input. So with
        // DDR=$00 this returns $17 (the power-up memory-config value).
        const inputPins = 0x07 | (sense ? 0x10 : 0);
        v = (this.cpuPort & this.cpuDDR) | (inputPins & ~this.cpuDDR);
      }
      this.externalDataBus8 = v & 0xFF;
      return v;
    }

    const page = addr >> 8;
    const arr = this._readPageArr[page];
    let v;
    if (arr !== null) v = arr[addr - this._readPageOffset[page]];
    else v = this._readSlow(addr);
    this.externalDataBus8 = v & 0xFF;
    return v;
  }

  // Side-effect-free read: returns the byte at `addr` through the current
  // CPU memory map WITHOUT driving the external data-bus latch or triggering
  // device read side-effects (CIA/SID/VIC register reads can clear flags /
  // advance state). Used by the VIC to sample the byte a BA-stalled CPU is
  // driving on the bus during the §3.14.6 AEC-lag invalid c-reads.
  peek(addr) {
    addr &= 0xFFFF;
    if (addr < 2) {
      if (addr === 0) return this.cpuDDR;
      const sense = this.machine?.datasette?.getSenseLevel() ?? 1;
      const inputPins = 0x07 | (sense ? 0x10 : 0);
      return (this.cpuPort & this.cpuDDR) | (inputPins & ~this.cpuDDR);
    }
    const page = addr >> 8;
    const arr = this._readPageArr[page];
    if (arr !== null) return arr[addr - this._readPageOffset[page]];
    if (addr >= 0x8000 && addr <= 0x9fff && this.cartridge?.romLoReadHook) {
      return this.cartridge.readRomLo(addr);
    }
    // I/O / open-bus pages: don't poke devices — report the bus latch.
    return this.externalDataBus8;
  }

  // Side-effect-free CPU-visible peek for opcode predecode. Unlike `peek`,
  // this returns the value an I/O register read would place on the bus, while
  // still avoiding read side effects such as CIA ICR acknowledge.
  peekForCpu(addr) {
    addr &= 0xFFFF;
    if (addr < 2) return this.peek(addr);
    const page = addr >> 8;
    const arr = this._readPageArr[page];
    if (arr !== null) return arr[addr - this._readPageOffset[page]];
    if (addr >= 0x8000 && addr <= 0x9fff && this.cartridge?.romLoReadHook) {
      return this.cartridge.readRomLo(addr);
    }
    if (addr >= 0xD000 && addr <= 0xDFFF) return this._peekIO(addr);
    return this.ram[addr];
  }

  // The datasette's two output lines live on the 6510 port: MOTOR on pin 5
  // (0 = run) and the cassette WRITE line on pin 3. A pin drives only while its
  // DDR bit is an output. An input bit leaves the motor untouched (the pin
  // floats, so the deck holds whatever it had); the write line is treated as
  // idle high when undriven. Called from every $00 and $01 write.
  _syncCassetteLines() {
    const ds = this.machine?.datasette;
    if (!ds) return;
    if (this.cpuDDR & 0x20) ds.setMotor?.(!(this.cpuPort & 0x20));
    // Banking code writes $01 constantly, so compare the level here and only
    // call across when the pin actually moves.
    const wr = (this.cpuDDR & 0x08) ? ((this.cpuPort >> 3) & 1) : 1;
    if (wr !== ds._writeLevel) ds.setWriteLine?.(wr);
  }

  write(addr, val) {
    addr &= 0xFFFF;
    val  &= 0xFF;

    if (addr < 2) {
      // 6510 quirk: writes to the on-chip port at $00/$01 keep the CPU's
      // data drivers tri-stated (the port is internal). R/W goes low, so
      // the byte the VIC drove during phi1 stays on the bus and can end
      // up in underlying RAM. Do NOT overwrite externalDataBus8 here.
      if (addr === 0) {
        this.cpuDDR = val;
        if (this.openBusWritesToZeroOneEnabled) this.ram[0x00] = this.externalDataBus8;
        // A DDR write can hand a pin to the latch that was floating a moment
        // ago, so the cassette lines have to be re-evaluated here too — the
        // KERNAL writes $01 first and raises the DDR afterwards.
        this._syncCassetteLines();
        this._rebuildMemoryMap();
        return;
      }
      // $01 (DATA): the 6510 stores all 8 bits in the latch regardless of
      // DDR — DDR only gates whether a bit drives its pin (applied on READ).
      // The KERNAL relies on this: it writes $01 before raising DDR to $2F,
      // so the latched value must survive to drive the bits once DDR flips.
      this.cpuPort = val;
      // RAM under the port: legacy path mirrors the latch; quirk path stores
      // the VIC phi1 byte instead.
      if (this.openBusWritesToZeroOneEnabled) {
        this.ram[0x01] = this.externalDataBus8;
      } else {
        this.ram[0x01] = this.cpuPort;
      }
      this._syncCassetteLines();
      this._rebuildMemoryMap();
      return;
    }

    // For all other addresses the CPU drives D0-D7 on writes, so update
    // the shared latch with the CPU value.
    this.externalDataBus8 = val;

    const page = addr >> 8;
    const arr = this._writePageArr[page];
    if (arr !== null) {
      // Tier-3 line-batch: the renderer re-reads glyph/bitmap bytes from RAM
      // at paint time, so while a raster line's paints are deferred, a CPU
      // write into that line's g-access fetch window must replay the line
      // FIRST (pre-store — the already-due segments then read the pre-write
      // byte exactly as the live path did, and the rest of the line renders
      // live with the new byte). Armed by vic2._armDeferredFetchWatch();
      // one boolean test per RAM write when idle.
      if (this._vicFetchWatchOn && addr >= this._vicFetchWatchLo && addr < this._vicFetchWatchHi) {
        this.vic2._catchUpDeferredLine();
      }
      arr[addr - this._writePageOffset[page]] = val;
      return;
    }
    this._writeSlow(addr, val);
  }

  // Slow path for reads that don't resolve through the page table —
  // typically I/O ($D000-$DFFF when CHAREN gates I/O on, or always in
  // ultimax) plus EasyFlash $DE/$DF. The page-0 / CPU-port cases are
  // handled in `read` itself before the table dispatch.
  _readSlow(addr) {
    if (addr >= 0x8000 && addr <= 0x9fff && this.cartridge?.romLoReadHook) {
      return this.cartridge.readRomLo(addr);
    }
    if (addr >= 0xD000 && addr <= 0xDFFF) return this._readIO(addr);
    // Fallback (shouldn't normally fire — every page should map either
    // to a typed-array slot or the I/O range above).
    return this.ram[addr];
  }

  _writeSlow(addr, val) {
    if (addr >= 0xD000 && addr <= 0xDFFF) {
      this._writeIO(addr, val);
      return;
    }
    if (this._reuFf00Watch && addr >= 0xFF00) {
      // The store lands first, then the REU snoops it — ff00Triggered()
      // disarms the watch, which rebuilds the table under us.
      const arr = this._ff00WriteArr;
      if (arr !== null) arr[addr - this._ff00WriteOff] = val;
      if (addr === 0xFF00) this.reu?.ff00Triggered();
      return;
    }
    // Open-bus / read-only-ROM-shadow regions reach here with arr=null
    // (writes silently dropped, matching the original ultimax write path).
  }

  _readIO(addr) {
    if (addr >= 0xD000 && addr <= 0xD3FF) return this.vic2  ? this.vic2.read(addr & 0x3F) : this._openBusRead();
    if (addr >= 0xD400 && addr <= 0xD7FF) return this.sid ? this.sid.read(addr & 0x1F) : this._openBusRead();
    if (addr >= 0xD800 && addr <= 0xDBFF) {
      // Color RAM is connected to the lower 4 data bits; upper 4 are open
      // bus. In vice-compatible mode, sample the latch for the upper nybble
      // (typically the byte the VIC fetched in phi1 of this cycle).
      const lo = this.colorRam[addr - 0xD800] & 0x0F;
      const hi = (this.openBusMode === 'disabled') ? 0xF0 : (this.externalDataBus8 & 0xF0);
      const composed = hi | lo;
      if (this.colorRamReadDrivesComposedByte) this.externalDataBus8 = composed;
      return composed;
    }
    if (addr >= 0xDC00 && addr <= 0xDCFF) return this._readCIA1(addr & 0x0F);
    if (addr >= 0xDD00 && addr <= 0xDDFF) return this.cia2  ? this.cia2.read(addr & 0x0F) : this._openBusRead();
    if (this.reu) {
      const r = this.reu.ioRead(addr);
      if (r !== IO_UNHANDLED) return r;
    }
    const value = this.cartridge?.ioRead(addr, this.externalDataBus8) ?? IO_UNHANDLED;
    if (value !== IO_UNHANDLED) return value;
    return this._openBusRead();
  }

  _peekIO(addr) {
    if (addr >= 0xD000 && addr <= 0xD3FF) return this.vic2?.peek?.(addr & 0x3F) ?? this.externalDataBus8;
    if (addr >= 0xD400 && addr <= 0xD7FF) return this.sid?.peek?.(addr & 0x1F) ?? this.externalDataBus8;
    if (addr >= 0xD800 && addr <= 0xDBFF) {
      const lo = this.colorRam[addr - 0xD800] & 0x0F;
      const hi = (this.openBusMode === 'disabled') ? 0xF0 : (this.externalDataBus8 & 0xF0);
      return hi | lo;
    }
    if (addr >= 0xDC00 && addr <= 0xDCFF) return this._peekCIA1(addr & 0x0F);
    if (addr >= 0xDD00 && addr <= 0xDDFF) return this.cia2?.peek?.(addr & 0x0F) ?? this.externalDataBus8;
    if (this.reu) {
      const r = this.reu.ioPeek(addr);
      if (r !== IO_UNHANDLED) return r;
    }
    const value = this.cartridge?.ioPeek(addr, this.externalDataBus8) ?? IO_UNHANDLED;
    if (value !== IO_UNHANDLED) return value;
    return this.externalDataBus8;
  }

  // Open-bus read: with no device driving D0-D7, the CPU samples whatever
  // was last on the bus. In vice-compatible mode this is the
  // externalDataBus8 latch. 'disabled' returns the historical 0xFF for
  // debugging; 'random' returns a fuzz byte for tracking down code that
  // assumes a fixed value.
  _openBusRead() {
    if (this.openBusMode === 'disabled') return 0xFF;
    if (this.openBusMode === 'random') return (Math.random() * 256) | 0;
    return this.externalDataBus8;
  }

  // CIA1 read with joystick port integration
  // Real C64 hardware:
  //   Port A ($DC00) bits 0-4: Joystick Port 2 (active-low)
  //   Port B ($DC01) bits 0-4: Joystick Port 1 (active-low)
  // Both ports also carry keyboard matrix data, so joystick bits are ANDed in.
  _readCIA1(reg) {
    if (!this.cia1) return 0xFF;

    // Port A ($DC00): keyboard column select + joystick port 2
    if (reg === 0x00) {
      let val = this.cia1.read(0x00);
      if (this.machine) val &= this.machine.joyPort2;
      return val;
    }

    // Port B ($DC01): keyboard row read + joystick port 1
    if (reg === 0x01) {
      let val = this.cia1.read(0x01); // keyboard matrix
      if (this.machine) val &= this.machine.joyPort1;
      return val;
    }

    return this.cia1.read(reg);
  }

  _peekCIA1(reg) {
    if (!this.cia1) return this.externalDataBus8;
    if (reg === 0x00) {
      let val = this.cia1.peek ? this.cia1.peek(0x00) : this.cia1.read(0x00);
      if (this.machine) val &= this.machine.joyPort2;
      return val;
    }
    if (reg === 0x01) {
      let val = this.cia1.peek ? this.cia1.peek(0x01) : this.cia1.read(0x01);
      if (this.machine) val &= this.machine.joyPort1;
      return val;
    }
    return this.cia1.peek ? this.cia1.peek(reg) : this.cia1.read(reg);
  }

  _writeIO(addr, val) {
    if (addr >= 0xD000 && addr <= 0xD3FF) { this.vic2?.write(addr & 0x3F, val); return; }
    if (addr >= 0xD400 && addr <= 0xD7FF) { this.sid?.write(addr & 0x1F, val); return; }
    if (addr >= 0xD800 && addr <= 0xDBFF) { this.colorRam[addr - 0xD800] = val & 0x0F; return; }
    if (addr >= 0xDC00 && addr <= 0xDCFF) { this.cia1?.write(addr & 0x0F, val); return; }
    if (addr >= 0xDD00 && addr <= 0xDDFF) { this.cia2?.write(addr & 0x0F, val); return; }
    if (this.reu?.ioWrite(addr, val)) return;
    this.cartridge?.ioWrite(addr, val);
  }

  loadROM(data, baseAddr) {
    for (let i = 0; i < data.length; i++) this.ram[baseAddr + i] = data[i];
  }

  // Soft reset = simulated /RESET line pulse. On real silicon, /RESET
  // resets the 6510 CPU port and presents /RESET to the cartridge device,
  // then rebuilds the per-page
  // dispatch table to match the restored banking — but it does NOT
  // touch DRAM contents. The KERNAL boot code (entered via the $FFFC
  // reset vector) does its own software-level RAM init for screen +
  // zero-page pointers.
  softReset() {
    this.cpuDDR  = 0x00;
    this.cpuPort = 0x00;
    this.ram[0x00] = 0x00;
    this.ram[0x01] = 0x00;
    this._syncCassetteLines();   // both pins are inputs again
    this.reu?.resetLine();
    if (this.cartridge) {
      this.cartridge.resetLine();
    } else {
      // cpuPort just changed (back to default 0x37). The dispatch table
      // must be rebuilt so the CPU's first read after reset (the
      // $FFFC/$FFFD reset vector) lands in KERNAL ROM, not whatever the
      // pre-reset banking had at those pages. Without this, soft reset
      // hangs because the CPU jumps to RAM garbage.
      this._rebuildMemoryMap();
    }
  }

  // Cold-boot reset = power-on. DRAM contents are unpredictable in real
  // hardware; we seed with VICE's characteristic init pattern so demos
  // that depend on it (e.g., OrbitUntold's depacker reading uninitialized
  // RAM as compressed back-references) work correctly. Then applies the
  // /RESET-line semantics on top (CPU port + cart + dispatch).
  reset() {
    // C64 RAM at power-up has a characteristic DRAM pattern. VICE's
    // default init is an 8-byte cycle: `00 00 FF FF FF FF 00 00`,
    // i.e. mem[addr] = $FF iff (addr bit 1) XOR (addr bit 2) = 1.
    // Verified by dumping VICE's RAM at boot ready: $0810=$00, $0812=$FF,
    // $0814=$FF, $0816=$00, $0818=$00, etc.
    for (let i = 0; i < this.ram.length; i++) {
      this.ram[i] = (((i >> 1) ^ (i >> 2)) & 1) ? 0xFF : 0x00;
    }
    // Color RAM init: extend the same XOR pattern with 4-bit values
    // ($0F/$00). Our own deterministic choice — real hardware varies, and
    // VICE seeds color RAM from a fixed hardware dump instead; nothing
    // verified depends on it.
    for (let i = 0; i < this.colorRam.length; i++) {
      this.colorRam[i] = (((i >> 1) ^ (i >> 2)) & 1) ? 0x0F : 0x00;
    }
    this.cartridge?.powerUp();
    this.reu?.powerUp();
    this.softReset();
  }
}
