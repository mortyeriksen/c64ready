// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const IO_UNHANDLED = -1;

export function modeFromLines(exrom, game) {
  if (exrom === 0 && game === 1) return '8k';
  if (exrom === 0 && game === 0) return '16k';
  if (exrom === 1 && game === 0) return 'ultimax';
  return 'none';
}

export function emptyCapabilities() {
  return { reset: false, freeze: false };
}

export class CartridgeDevice {
  constructor({ id, hwType = null, label = id, capabilities = emptyCapabilities() }) {
    this.id = id;
    this.hwType = hwType;
    this.label = label;
    this.capabilities = capabilities;
    this.memory = null;
    this.mode = 'none';
    this.bank = 0;
    this.romLo = null;
    this.romHi = null;
    this.romLoWriteTarget = null;
    this.romLoReadHook = false;
    this.ram = null;
  }

  attach(memory) {
    this.memory = memory;
    this.applyMapping();
  }

  detach() {
    this.memory?._setCartNmi(false);
    this.memory = null;
  }

  applyMapping() {
    this.memory?._applyCartridgeDeviceMapping(this);
  }

  powerUp() { this.applyMapping(); }
  resetLine() { this.applyMapping(); }
  physicalReset() { return false; }
  freezePressed() { return false; }
  freezeReleased() { return false; }
  ioRead() { return IO_UNHANDLED; }
  ioPeek() { return IO_UNHANDLED; }
  ioWrite() { return false; }
  readRomLo(addr) { return this.romLo?.[addr & 0x1fff] ?? 0xff; }
  serialize() { return { id: this.id, mode: this.mode, bank: this.bank }; }
  deserialize() { this.applyMapping(); }
}
