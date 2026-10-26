// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Counts differences between samples, not writes or loading transfers.
export class MemorySampler {
  constructor() {
    this.bytes = new Uint8Array(65536);
    this.pages = new Uint16Array(256);
    this.observedPages = new Uint8Array(256);
    this.intervalAddresses = new Uint8Array(65536);
    this.intervalPages = new Uint16Array(256);
    this.intervalChanged = 0;
    this.initialized = false;
    this.changed = 0;
  }

  reset() {
    this.initialized = false;
    this.changed = 0;
    this.pages.fill(0);
    this.observedPages.fill(0);
    this.intervalAddresses.fill(0); this.intervalPages.fill(0); this.intervalChanged = 0;
  }

  consumeInterval(out) {
    out.set(this.intervalPages);
    const changed = this.intervalChanged;
    this.intervalAddresses.fill(0); this.intervalPages.fill(0); this.intervalChanged = 0;
    return changed;
  }

  sample(ram) {
    this.pages.fill(0);
    this.changed = 0;
    if (this.initialized) {
      for (let address = 0; address < 65536; address++) {
        if (ram[address] !== this.bytes[address]) {
          this.pages[address >>> 8]++;
          this.observedPages[address >>> 8] = 1;
          this.changed++;
          if (!this.intervalAddresses[address]) {
            this.intervalAddresses[address] = 1; this.intervalPages[address >>> 8]++; this.intervalChanged++;
          }
        }
      }
    }
    this.bytes.set(ram);
    this.initialized = true;
  }
}

export const hex = (value, width = 4) => value.toString(16).toUpperCase().padStart(width, '0');

export function regionHint(page) {
  if (page === 0) return 'Zero page: short addresses used by programs and the operating system. $0000 and $0001 below show underlying RAM, not the CPU port registers.';
  if (page === 1) return 'Stack area: the CPU stores return addresses and temporary values here.';
  if (page >= 4 && page <= 7) return 'Default screen area: BASIC normally stores screen codes from $0400. Programs can move the screen elsewhere. In BASIC, these bytes select characters rather than storing their pixels.';
  if (page >= 0xA0 && page <= 0xBF) return 'RAM beneath the BASIC ROM area. Banking determines whether the CPU reads this RAM or ROM.';
  if (page >= 0xD0 && page <= 0xDF) return 'RAM beneath the I/O and character ROM area. This view does not show chip registers or colour RAM.';
  if (page >= 0xE0) return 'RAM beneath the KERNAL ROM area. Programs can use this RAM even when ROM is visible to CPU reads.';
  return 'General RAM: these bytes might be instructions, graphics, sound data, or workspace. Their purpose depends on the running program.';
}
