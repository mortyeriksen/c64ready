// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const TAPE_CLOCK_HZ = 985248;
const CAPACITY = 256;

// Decode forwards from known TAP entry boundaries. Work per observation is
// bounded, including the first visit to a tape that is already far advanced.
export class TapePulseWindow {
  constructor() {
    this.lengths = new Uint32Array(CAPACITY);
    this.offsets = new Uint32Array(CAPACITY);
    this.reset();
  }
  reset() {
    this.buffer = null; this.base = 0; this.offset = 0; this.cursor = 0;
    this.count = 0; this.version = -1; this.recording = false;
    this.target = 0; this.pending = false; this.incomplete = false;
  }
  sample(tape, budget = 32768) {
    const recording = !!tape?.recording;
    const data = recording ? tape.recordedSlice(0, tape.recordedLength) : tape?.tapData;
    if (!data) { this.reset(); return; }
    const version = tape.tapVersion ?? 1;
    const target = Math.max(0, Math.min(data.length, recording ? tape.recordedLength : tape.pos));
    if (this.buffer !== data.buffer || this.base !== data.byteOffset || this.version !== version ||
        this.recording !== recording || target < this.target) {
      this.reset(); this.buffer = data.buffer; this.base = data.byteOffset;
      this.version = version; this.recording = recording;
    }
    this.target = target; this.incomplete = false;
    const end = Math.min(target, this.offset + Math.max(4, budget));
    while (this.offset < end) {
      const at = this.offset, byte = data[at], size = byte === 0 && version > 0 ? 4 : 1;
      if (at + size > target) { this.incomplete = true; break; }
      if (at + size > end) break;
      const cycles = byte ? byte * 8 : version === 0 ? (tape.zeroGapCycles ?? 20000)
        : data[at + 1] | data[at + 2] << 8 | data[at + 3] << 16;
      this.offset += size;
      // Zero-length entries have no drawable duration.
      if (!cycles) continue;
      this.lengths[this.cursor] = cycles; this.offsets[this.cursor] = at;
      this.cursor = (this.cursor + 1) % CAPACITY;
      this.count = Math.min(CAPACITY, this.count + 1);
    }
    this.pending = this.offset < target && !this.incomplete;
  }
  window(cycles = 20000) {
    if (this.pending) return [];
    let sum = 0, size = 0;
    while (size < this.count && sum < cycles) {
      sum += this.lengths[(this.cursor - 1 - size + CAPACITY) % CAPACITY]; size++;
    }
    const result = [];
    for (let i = size; i > 0; i--) {
      const index = (this.cursor - i + CAPACITY) % CAPACITY;
      result.push({ cycles: this.lengths[index], offset: this.offsets[index] });
    }
    return result;
  }
}
