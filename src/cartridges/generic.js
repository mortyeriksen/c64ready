// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { CartridgeDevice, modeFromLines } from './device.js';

export class GenericCartridge extends CartridgeDevice {
  constructor({ mode, romLo = null, romHi = null }) {
    super({ id: 'generic', hwType: 0, label: 'Generic cartridge' });
    this.mode = mode;
    this.romLo = romLo;
    this.romHi = romHi;
  }

  static fromCRT(cart) {
    let romLo = null;
    let romHi = null;
    for (const chip of cart.chips) {
      if (chip.loadAddr === 0x8000) {
        romLo = new Uint8Array(8192);
        romLo.set(chip.data.subarray(0, Math.min(chip.size, 8192)));
        if (chip.size > 8192) {
          romHi = new Uint8Array(8192);
          romHi.set(chip.data.subarray(8192, Math.min(chip.size, 16384)));
        }
      } else if (chip.loadAddr === 0xa000 || chip.loadAddr === 0xe000) {
        romHi = new Uint8Array(8192);
        romHi.set(chip.data.subarray(0, Math.min(chip.size, 8192)));
      }
    }
    const mode = modeFromLines(cart.exrom, cart.game);
    if (mode === 'none') {
      throw new Error('Cart signals EXROM=1, GAME=1 (no cart) — invalid');
    }
    return new GenericCartridge({ mode, romLo, romHi });
  }
}
