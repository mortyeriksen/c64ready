// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { CartridgeDevice, IO_UNHANDLED, modeFromLines } from './device.js';

export class FinalCartridge3 extends CartridgeDevice {
  constructor(romLoBanks, romHiBanks) {
    super({
      id: 'final3',
      hwType: 3,
      label: 'Final Cartridge III',
      capabilities: { reset: true, freeze: true },
    });
    this.romLoBanks = romLoBanks;
    this.romHiBanks = romHiBanks;
    this.control = 0;
    this.freezeHeld = false;
    this.powerUp();
  }

  static fromCRT(cart) {
    const lo = Array.from({ length: 4 }, () => new Uint8Array(8192));
    const hi = Array.from({ length: 4 }, () => new Uint8Array(8192));
    const seen = new Set();
    for (const chip of cart.chips) {
      if (chip.bank > 3 || chip.loadAddr !== 0x8000 || chip.size !== 16384) {
        throw new Error(
          `Invalid Final Cartridge III CHIP: bank ${chip.bank}, ` +
          `load $${chip.loadAddr.toString(16)}, size ${chip.size}; ` +
          'expected banks 0-3, $8000, 16384 bytes'
        );
      }
      if (seen.has(chip.bank)) {
        throw new Error(`Duplicate Final Cartridge III bank ${chip.bank}`);
      }
      seen.add(chip.bank);
      lo[chip.bank].set(chip.data.subarray(0, 8192));
      hi[chip.bank].set(chip.data.subarray(8192, 16384));
    }
    if (seen.size !== 4) {
      throw new Error(`Invalid Final Cartridge III image: expected 4 banks, found ${seen.size}`);
    }
    return new FinalCartridge3(lo, hi);
  }

  attach(memory) {
    this.memory = memory;
    this._applyControl();
  }

  _applyControl() {
    this.bank = this.control & 3;
    this.romLo = this.romLoBanks[this.bank];
    this.romHi = this.romHiBanks[this.bank];
    // The FREEZE button pulls only /NMI and GAME; EXROM stays under firmware
    // control through this latch. So freezing an EXROM-high config (the hidden
    // state BASIC runs in) yields Ultimax and $FFFA comes from cart ROMH, while
    // freezing an EXROM-low config yields plain 16K, leaving $FFFA in the KERNAL
    // — the NMI then lands on the KERNAL handler and returns, so FREEZE does
    // nothing from the FC3's own DESKTOP. That is the hardware's behaviour, not
    // a gap: do not "fix" it by forcing EXROM here.
    const exrom = (this.control >> 4) & 1;
    const game = this.freezeHeld ? 0 : ((this.control >> 5) & 1);
    this.mode = modeFromLines(exrom, game);
    this.memory?._setCartNmi(this.freezeHeld || (this.control & 0x40) === 0);
    this.applyMapping();
  }

  powerUp() {
    this.control = 0;
    this.freezeHeld = false;
    this._applyControl();
  }

  // The C64 expansion-port reset line does not reset the FC3 latch.
  resetLine() {
    this.freezeHeld = false;
    this._applyControl();
  }

  physicalReset() {
    this.powerUp();
    return true;
  }

  freezePressed() {
    this.freezeHeld = true;
    this._applyControl();
    return true;
  }

  freezeReleased() {
    this.freezeHeld = false;
    this._applyControl();
    return true;
  }

  ioRead(addr) {
    if (addr < 0xde00 || addr > 0xdfff) return IO_UNHANDLED;
    return this.romLoBanks[this.bank]?.[0x1e00 + addr - 0xde00] ?? 0xff;
  }

  ioPeek(addr) { return this.ioRead(addr); }

  ioWrite(addr, value) {
    if (addr < 0xde00 || addr > 0xdfff) return false;
    if (addr === 0xdfff && (!(this.control & 0x80) || this.freezeHeld)) {
      this.control = value & 0xff;
      this._applyControl();
    }
    return true;
  }

  serialize() {
    return { id: this.id, mode: this.mode, bank: this.bank, control: this.control };
  }

  deserialize(state) {
    this.control = (state.control ?? 0) & 0xff;
    this.freezeHeld = false;
    this._applyControl();
  }
}
