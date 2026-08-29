// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { CartridgeDevice } from './device.js';

export class MagicDeskCartridge extends CartridgeDevice {
  constructor(romBanks) {
    super({ id: 'magicdesk', hwType: 19, label: 'Magic Desk' });
    this.romBanks = romBanks;
    this.powerUp();
  }

  static fromCRT(cart) {
    const banks = Array.from({ length: 64 }, () => new Uint8Array(8192));
    for (const chip of cart.chips) {
      if (chip.loadAddr !== 0x8000 || chip.size > 8192) continue;
      banks[chip.bank]?.set(chip.data.subarray(0, chip.size));
    }
    return new MagicDeskCartridge(banks);
  }

  powerUp() {
    this.bank = 0;
    this.mode = '8k';
    this.romLo = this.romBanks[0] ?? null;
    this.romHi = null;
    this.applyMapping();
  }

  resetLine() { this.powerUp(); }

  ioWrite(addr, value) {
    if (addr < 0xde00 || addr > 0xdeff) return false;
    if (value & 0x80) {
      this.mode = 'none';
      this.romLo = null;
    } else {
      this.bank = value & 0x3f;
      this.mode = '8k';
      this.romLo = this.romBanks[this.bank] ?? null;
    }
    this.applyMapping();
    return true;
  }

  serialize() {
    return { id: this.id, mode: this.mode, bank: this.bank };
  }

  deserialize(state) {
    this.bank = (state.bank | 0) & 0x3f;
    this.mode = state.mode === 'none' ? 'none' : '8k';
    this.romLo = this.mode === 'none' ? null : this.romBanks[this.bank];
    this.applyMapping();
  }
}
