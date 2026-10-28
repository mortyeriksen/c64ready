// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

let nextEpoch = 0;
export const ACTIVITY_CAPACITY = 32768;
export const ACTIVITY_WINDOW_CYCLES = 985248 * 8;

export function createActivityInspection() {
  return {
    active: false, epoch: 0, first: 0, next: 0, count: 0,
    startCycle: 0, endCycle: 0, truncated: false, sidCount: 1, sid2Address: 0,
    initialSid: new Uint8Array(64), cycle: new Float64Array(ACTIVITY_CAPACITY),
    kind: new Uint8Array(ACTIVITY_CAPACITY), device: new Uint8Array(ACTIVITY_CAPACITY),
    address: new Uint16Array(ACTIVITY_CAPACITY), value: new Uint32Array(ACTIVITY_CAPACITY),
    ramBytes: new Uint32Array(ACTIVITY_CAPACITY),
  };
}

// Sparse typed-array ring. Kind 0 is a SID write, kind 1 a completed LOAD.
// No UI callbacks or event objects run on the observed write path.
export class MonitorActivityCapture {
  constructor(machine) {
    this.machine = machine;
    this.data = createActivityInspection();
    this.overflowUntil = 0;
  }

  start() {
    const m = this.machine, d = this.data;
    d.active = true;
    d.epoch = ++nextEpoch;
    d.first = d.next = d.count = 0;
    d.startCycle = d.endCycle = m.vic2.totalCycles;
    this.overflowUntil = 0;
    d.sidCount = m.sid2 ? 2 : 1;
    d.sid2Address = m.sid2?.address ?? 0;
    d.initialSid.fill(0);
    d.initialSid.set(m.mem.sid.regs);
    if (m.sid2) d.initialSid.set(m.sid2.proxy.regs, 32);
    m._monitorActivity = this;
  }

  stop() {
    const d = this.data;
    if (!d.active) return;
    if (this.machine._monitorActivity === this) this.machine._monitorActivity = null;
    d.active = false;
    d.count = 0;
    d.first = d.next;
    d.epoch = ++nextEpoch;
  }

  discard() {
    const d = this.data, i = d.first % ACTIVITY_CAPACITY;
    if (d.kind[i] === 0) d.initialSid[d.device[i] * 32 + d.address[i]] = d.value[i];
    d.first++;
    d.count--;
  }

  expire(now) {
    const d = this.data;
    while (d.count && d.cycle[d.first % ACTIVITY_CAPACITY] < now - ACTIVITY_WINDOW_CYCLES) this.discard();
    d.startCycle = Math.max(d.startCycle, now - ACTIVITY_WINDOW_CYCLES);
  }

  add(kind, device, address, value, ramBytes = 0) {
    const d = this.data, now = this.machine.vic2.totalCycles;
    this.expire(now);
    if (d.count === ACTIVITY_CAPACITY) {
      this.overflowUntil = now + ACTIVITY_WINDOW_CYCLES;
      this.discard();
      d.startCycle = d.cycle[d.first % ACTIVITY_CAPACITY];
    }
    const i = d.next % ACTIVITY_CAPACITY;
    d.cycle[i] = now;
    d.kind[i] = kind;
    d.device[i] = device;
    d.address[i] = address;
    d.value[i] = value;
    d.ramBytes[i] = ramBytes;
    d.next++;
    d.count++;
  }

  copyInto(out) {
    const d = this.data, now = this.machine.vic2.totalCycles;
    this.expire(now);
    const from = out.epoch === d.epoch ? Math.max(out.next, d.first) : d.first;
    for (let seq = from; seq < d.next; seq++) {
      const i = seq % ACTIVITY_CAPACITY;
      out.cycle[i] = d.cycle[i];
      out.kind[i] = d.kind[i];
      out.device[i] = d.device[i];
      out.address[i] = d.address[i];
      out.value[i] = d.value[i];
      out.ramBytes[i] = d.ramBytes[i];
    }
    out.active = d.active;
    out.epoch = d.epoch;
    out.first = d.first;
    out.next = d.next;
    out.count = d.count;
    out.startCycle = d.startCycle;
    out.endCycle = now;
    out.truncated = d.active && now < this.overflowUntil;
    out.sidCount = d.sidCount;
    out.sid2Address = d.sid2Address;
    out.initialSid.set(d.initialSid);
    return out;
  }
}
