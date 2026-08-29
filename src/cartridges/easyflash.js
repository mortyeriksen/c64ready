// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { CartridgeDevice, IO_UNHANDLED } from './device.js';

export class EasyFlashCartridge extends CartridgeDevice {
  constructor(romLoBanks, romHiBanks) {
    super({ id: 'easyflash', hwType: 32, label: 'EasyFlash' });
    this.romLoBanks = romLoBanks;
    this.romHiBanks = romHiBanks;
    this.ram = new Uint8Array(256);
    this.control = 0;
    this.powerUp();
  }

  static fromCRT(cart) {
    const lo = Array.from({ length: 64 }, () => new Uint8Array(8192));
    const hi = Array.from({ length: 64 }, () => new Uint8Array(8192));
    for (const chip of cart.chips) {
      if (chip.bank >= 64) continue;
      if (chip.loadAddr === 0x8000) {
        lo[chip.bank].set(chip.data.subarray(0, Math.min(chip.size, 8192)));
        if (chip.size > 8192) hi[chip.bank].set(chip.data.subarray(8192, 16384));
      } else if (chip.loadAddr === 0xa000 || chip.loadAddr === 0xe000) {
        hi[chip.bank].set(chip.data.subarray(0, Math.min(chip.size, 8192)));
      }
    }
    return new EasyFlashCartridge(lo, hi);
  }

  _select() {
    const visible = this.mode !== 'none';
    this.romLo = visible ? this.romLoBanks[this.bank] : null;
    this.romHi = visible ? this.romHiBanks[this.bank] : null;
    this.applyMapping();
  }

  powerUp() {
    this.bank = 0;
    this.control = 0;
    this.mode = 'ultimax';
    this.ram.fill(0);
    this._select();
  }

  resetLine() { this.powerUp(); }

  ioRead(addr) {
    if (addr >= 0xdf00 && addr <= 0xdfff) return this.ram[addr & 0xff];
    if (addr >= 0xde00 && addr <= 0xdeff) return this.memory?.externalDataBus8 ?? 0xff;
    return IO_UNHANDLED;
  }

  ioPeek(addr) { return this.ioRead(addr); }

  ioWrite(addr, value) {
    if (addr >= 0xdf00 && addr <= 0xdfff) {
      this.ram[addr & 0xff] = value;
      return true;
    }
    if (addr < 0xde00 || addr > 0xdeff) return false;
    const reg = addr & 0xff;
    if (reg === 0) {
      this.bank = value & 0x3f;
      this._select();
    } else if (reg === 2) {
      this.control = value;
      const m = (value >> 2) & 1;
      const x = (value >> 1) & 1;
      const g = value & 1;
      const exrom = x ? 0 : 1;
      const game = m ? (g ? 0 : 1) : 0;
      if (exrom === 0 && game === 1) this.mode = '8k';
      else if (exrom === 0 && game === 0) this.mode = '16k';
      else if (exrom === 1 && game === 0) this.mode = 'ultimax';
      else this.mode = 'none';
      this._select();
    }
    return true;
  }

  serialize() {
    return {
      id: this.id, mode: this.mode, bank: this.bank, control: this.control,
      ram: this.ram.slice(),
    };
  }

  deserialize(state) {
    this.bank = state.bank & 0x3f;
    this.control = state.control ?? 0;
    this.mode = state.mode;
    if (state.ram) this.ram.set(state.ram);
    this._select();
  }
}
