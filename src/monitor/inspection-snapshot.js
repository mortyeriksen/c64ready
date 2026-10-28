// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { StorageRates } from './storage-rates.js';

export const INSPECTION_RATES = Object.freeze([1, 10, 25, 50]);
export const DEFAULT_INSPECTION_RATE = 10;
export const INSPECTION_INTERVAL_MS = 1000 / DEFAULT_INSPECTION_RATE;

// One reusable observation shared by every inspection view. Memory navigation
// reads these detached bytes, so changing sections does not resample hardware.
export class InspectionSnapshot {
  constructor(facade, rate = DEFAULT_INSPECTION_RATE) {
    this.facade = facade;
    this.state = facade.createInspectionState();
    this.storage = facade.createStorageInspection();
    this.storageRates = new StorageRates();
    this.storage.rates = this.storageRates.values;
    this.activity = facade.createMonitorActivityInspection?.() ?? null;
    this.controls = facade.createControlInspection?.() ?? null;
    this.bytes = new Uint8Array(65536);
    this.cpuBytes = new Uint8Array(65536);
    this.vicBytes = new Uint8Array(65536);
    this.vicBanks = Array.from({length:4}, (_, i) => this.vicBytes.subarray(i * 16384, (i + 1) * 16384));
    this.cpuSources = new Array(256).fill('RAM');
    this.vicSources = new Array(16).fill('RAM');
    this.characters = new Uint8Array(4096);
    this.hasCharacters = false;
    this.revision = 0;
    this.capturedAt = 0;
    this.elapsed = 0;
    this.setRate(rate);
  }

  setRate(rate) {
    if (!INSPECTION_RATES.includes(rate)) throw new RangeError('Unsupported Monitor sampling rate');
    this.rate = rate;
    this.intervalMs = 1000 / rate;
    this.nextAt = -Infinity;
  }

  capture(now, force = false) {
    if (!force && now < this.nextAt) return false;
    // A late callback takes one sample, never a burst of missed samples.
    this.nextAt = !force && Number.isFinite(this.nextAt)
      ? this.nextAt + (Math.floor((now-this.nextAt)/this.intervalMs)+1)*this.intervalMs
      : now + this.intervalMs;
    const f = this.facade;
    f.inspectInto(this.state);
    f.inspectStorageInto(this.storage);
    if(this.activity)f.inspectMonitorActivityInto(this.activity);
    this.storageRates.sample(this.storage.transfers, now);
    if (this.controls) f.inspectControlsInto(this.controls);
    this.bytes.set(f.ram());
    f.copyCpuMemory(0, this.cpuBytes);
    for (let bank = 0; bank < 4; bank++) f.copyVicMemory(0, this.vicBanks[bank], bank * 16384);
    for (let page = 0; page < 256; page++) this.cpuSources[page] = f.cpuMemorySource(page * 256 + 2);
    for (let page = 0; page < 16; page++) this.vicSources[page] = f.vicMemorySource((page & 3) * 4096, (page >> 2) * 16384);
    const rom = f.charRom();
    this.hasCharacters = !!rom;
    if (rom) this.characters.set(rom);
    this.elapsed = this.revision ? now - this.capturedAt : 0;
    this.capturedAt = now;
    this.revision++;
    return true;
  }

  charRom() { return this.hasCharacters ? this.characters : null; }
  cpuMemorySource(address) { return (address & 65535) < 2 ? 'CPU port' : this.cpuSources[(address & 65535) >>> 8]; }
  vicMemorySource(address, bank = this.state.vicBank) { return this.vicSources[(bank + (address & 16383)) >>> 12]; }
  copyCpuMemory(address, target) {
    for (let i = 0; i < target.length; i++) target[i] = this.cpuBytes[(address + i) & 65535];
    return target;
  }
  copyVicMemory(address, target, bank = this.state.vicBank) {
    if (!Number.isInteger(bank) || bank < 0 || bank > 0xC000 || (bank & 0x3FFF)) throw new RangeError('VIC bank must be a 16 KB base');
    for (let i = 0; i < target.length; i++) target[i] = this.vicBytes[bank + ((address + i) & 16383)];
    return target;
  }
}
