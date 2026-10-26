// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export function formatStorageRate(bytesPerSecond, alwaysKilobytes = false) {
  return alwaysKilobytes || bytesPerSecond >= 1000
    ? `${(bytesPerSecond / 1000).toFixed(1)} kB/s`
    : `${Math.round(bytesPerSecond)} B/s`;
}

const RATE_CAPACITY = 52;

// Wall-time throughput over at most one second. A delayed observation spreads
// its byte delta over the observed interval rather than inventing a burst time.
export class StorageRates {
  constructor() {
    this.values = Array.from({ length: 5 }, () => ({ available: false, ready: false,
      scope: '', read: 0, write: 0, total: 0, epoch: -1, start: 0,
      times: new Float64Array(RATE_CAPACITY), reads: new Float64Array(RATE_CAPACITY), writes: new Float64Array(RATE_CAPACITY),
      cursor: 0, count: 0, history: new Float64Array(80), historyCursor: 0, historyCount: 0 }));
  }

  sample(transfers, now) {
    for (let i = 0; i < this.values.length; i++) {
      const out = this.values[i], current = transfers[i];
      const last = (out.cursor + RATE_CAPACITY - 1) % RATE_CAPACITY;
      const reset = !current.available || current.epoch !== out.epoch ||
        (out.count && (now <= out.times[last] || current.read < out.reads[last] || current.write < out.writes[last]));
      if (reset) {
        out.count = 0; out.cursor = 0; out.start = now;
        out.historyCount = 0; out.historyCursor = 0; out.history.fill(0);
      }
      out.available = current.available; out.epoch = current.epoch; out.scope = current.scope;
      out.read = 0; out.write = 0; out.total = 0; out.ready = false;
      if (!current.available) continue;
      const index = out.cursor;
      out.times[index] = now; out.reads[index] = current.read; out.writes[index] = current.write;
      out.cursor = (index + 1) % RATE_CAPACITY; out.count = Math.min(RATE_CAPACITY, out.count + 1);
      const oldest = (out.cursor - out.count + RATE_CAPACITY) % RATE_CAPACITY;
      const duration = Math.min(1000, now - out.start, now - out.times[oldest]);
      if (duration > 0) {
        for (let j = 1; j < out.count; j++) {
          const b = (out.cursor - out.count + j + RATE_CAPACITY) % RATE_CAPACITY, a = (b + RATE_CAPACITY - 1) % RATE_CAPACITY;
          const overlap = Math.max(0, out.times[b] - Math.max(out.times[a], now - duration));
          const fraction = overlap / (out.times[b] - out.times[a]);
          out.read += (out.reads[b] - out.reads[a]) * fraction * 1000 / duration;
          out.write += (out.writes[b] - out.writes[a]) * fraction * 1000 / duration;
        }
        out.ready = true; out.total = out.read + out.write;
      }
      out.history[out.historyCursor] = out.total;
      out.historyCursor = (out.historyCursor + 1) % 80;
      out.historyCount = Math.min(80, out.historyCount + 1);
    }
  }
}
