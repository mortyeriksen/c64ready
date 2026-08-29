// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { CartridgeDevice, IO_UNHANDLED, modeFromLines } from './device.js';

export class ActionReplayCartridge extends CartridgeDevice {
  constructor(romBanks) {
    super({
      id: 'action-replay',
      hwType: 1,
      label: 'Action Replay',
      capabilities: { reset: true, freeze: true },
    });
    this.romBanks = romBanks;
    this.ram = new Uint8Array(8192);
    this.control = 0;
    this.freezeLatched = false;
    this.powerUp();
  }

  static fromCRT(cart) {
    const banks = Array.from({ length: 4 }, () => new Uint8Array(8192));
    const seen = new Set();
    for (const chip of cart.chips) {
      if (chip.bank > 3 || chip.loadAddr !== 0x8000 || chip.size !== 8192) {
        throw new Error(
          `Invalid Action Replay CHIP: bank ${chip.bank}, ` +
          `load $${chip.loadAddr.toString(16)}, size ${chip.size}; ` +
          'expected banks 0-3, $8000, 8192 bytes'
        );
      }
      if (seen.has(chip.bank)) throw new Error(`Duplicate Action Replay bank ${chip.bank}`);
      seen.add(chip.bank);
      banks[chip.bank].set(chip.data);
    }
    if (seen.size !== 4) {
      throw new Error(`Invalid Action Replay image: expected 4 banks, found ${seen.size}`);
    }
    return new ActionReplayCartridge(banks);
  }

  attach(memory) {
    this.memory = memory;
    this._applyControl();
  }

  _applyControl() {
    if (this.freezeLatched) {
      this.bank = 0;
      this.mode = 'ultimax';
      this.romLo = this.ram;
      this.romHi = this.romBanks[0];
      this.romLoWriteTarget = this.ram;
      this.romLoReadHook = false;
      this.memory?._setCartNmi(true);
      this.applyMapping();
      return;
    }

    this.bank = (this.control >> 3) & 3;
    const disabled = (this.control & 4) !== 0;
    const ramSelected = (this.control & 0x20) !== 0;
    const exrom = (this.control >> 1) & 1;
    const game = (this.control & 1) ? 0 : 1;
    const contendedRomLo = !disabled && ramSelected && (this.control & 0x23) === 0x22;
    this.mode = contendedRomLo ? '8k' : (disabled ? 'none' : modeFromLines(exrom, game));
    this.romLo = ramSelected ? this.ram : this.romBanks[this.bank];
    this.romHi = this.romBanks[this.bank];
    this.romLoWriteTarget = ramSelected ? this.ram : null;

    // In this state both the C64 DRAM and cartridge RAM drive ROML reads.
    this.romLoReadHook = contendedRomLo;
    this.memory?._setCartNmi(false);
    this.applyMapping();
  }

  powerUp() {
    this.ram.fill(0);
    this.control = 0;
    this.freezeLatched = false;
    this._applyControl();
  }

  resetLine() {
    this.control = 0;
    this.freezeLatched = false;
    this._applyControl();
  }

  physicalReset() {
    this.resetLine();
    return true;
  }

  freezePressed() {
    this.freezeLatched = true;
    this._applyControl();
    return true;
  }

  // The button triggers a latch; releasing the physical button does not
  // release /NMI. Firmware acknowledges it through control bit 6.
  freezeReleased() { return true; }

  _writeControl(value) {
    this.control = value & 0xff;
    if (this.control & 0x40) this.freezeLatched = false;
    this._applyControl();
  }

  _ioDisabled() {
    return !this.freezeLatched && (this.control & 4) !== 0;
  }

  ioRead(addr, busValue) {
    if (this._ioDisabled()) return IO_UNHANDLED;
    if (addr >= 0xde00 && addr <= 0xdeff) {
      const value = busValue & 0xff;
      this._writeControl(value);
      return value;
    }
    if (addr >= 0xdf00 && addr <= 0xdfff) {
      return (this.control & 0x20)
        ? this.ram[0x1f00 + (addr & 0xff)]
        : this.romBanks[this.bank][0x1f00 + (addr & 0xff)];
    }
    return IO_UNHANDLED;
  }

  ioPeek(addr, busValue) {
    if (this._ioDisabled()) return IO_UNHANDLED;
    if (addr >= 0xde00 && addr <= 0xdeff) return busValue & 0xff;
    if (addr >= 0xdf00 && addr <= 0xdfff) {
      return (this.control & 0x20)
        ? this.ram[0x1f00 + (addr & 0xff)]
        : this.romBanks[this.bank][0x1f00 + (addr & 0xff)];
    }
    return IO_UNHANDLED;
  }

  ioWrite(addr, value) {
    if (this._ioDisabled()) return false;
    if (addr >= 0xde00 && addr <= 0xdeff) {
      this._writeControl(value);
      return true;
    }
    if (addr >= 0xdf00 && addr <= 0xdfff) {
      if (this.control & 0x20) this.ram[0x1f00 + (addr & 0xff)] = value;
      return true;
    }
    return false;
  }

  readRomLo(addr) {
    const offset = addr & 0x1fff;
    return this.ram[offset] | this.memory.ram[addr & 0xffff];
  }

  serialize() {
    return {
      id: this.id, mode: this.mode, bank: this.bank, control: this.control,
      freezeLatched: this.freezeLatched, ram: this.ram.slice(),
    };
  }

  deserialize(state) {
    this.control = (state.control ?? 0) & 0xff;
    this.freezeLatched = !!state.freezeLatched;
    if (state.ram) this.ram.set(state.ram);
    this._applyControl();
  }
}
