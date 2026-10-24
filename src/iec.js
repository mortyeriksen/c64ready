// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Additional IEC participants. Levels are physical TTL, 0 pulls low, 1 releases.
// Drives 8 and 9 remain owned by the machine's drive subsystem.
export const IEC_API_VERSION = 1;
import { createIecListener } from './iec/listener.js';
export const IEC_DATA = 1, IEC_CLK = 2, IEC_ATN = 4;
const NEVER = Number.MAX_SAFE_INTEGER;

export function validIecAddress(address) {
  return Number.isInteger(address) && address >= 4 && address <= 30 && address !== 8 && address !== 9;
}

export class IecDevices {
  constructor(cyclesPerSecond, sync) {
    this.cyclesPerSecond = cyclesPerSecond;
    this.sync = sync;
    this.devices = new Map();
    this.records = [];
    this.notifiedInputs = -1;
    this.clock = 0;
    this.inputs = 7;
    this.outputs = 3;
    this.previous = 3;
    this.visible = 3;
    this.next = NEVER;
    this.onError = null;
  }
  _schedule() {
    let due = NEVER;
    for (let i = 0; i < this.records.length; i++) if (this.records[i].wake < due) due = this.records[i].wake;
    this.next = due;
  }
  _outputs() {
    let outputs = 3;
    for (let i = 0; i < this.records.length; i++) outputs &= this.records[i].outputs;
    if (outputs !== this.outputs) { this.outputs = outputs; this.sync(); }
  }
  _call(r, name, arg) {
    try {
      const callback = r.device?.[name];
      if (typeof callback === 'function') return callback.call(r.device, arg);
    }
    catch (error) {
      this.unplug(r.address);
      this.onError?.(r.address, r.id, error);
    }
  }
  plug(address, id, factory, version = null) {
    if (!validIecAddress(address)) throw new Error('IEC addresses are 4 to 30, with 8 and 9 reserved for disk drives.');
    if (this.devices.has(address)) throw new Error(`IEC address ${address} is already in use.`);
    const r = { address, id, version, outputs: 3, wake: NEVER, lastLines: -1, device: null, active: true };
    const live = () => r.active && this.devices.get(address) === r;
    const port = Object.freeze({
      apiVersion: IEC_API_VERSION, address, cyclesPerSecond: this.cyclesPerSecond,
      now: () => this.clock,
      lines: () => { this.sync(); return this.inputs; },
      createListener: callbacks => createIecListener(port, callbacks),
      drive: (mask, levels) => {
        if (!live()) return;
        r.outputs = ((~mask | levels) & 3);
        this._outputs();
      },
      wakeAt: cycle => {
        if (!live()) return;
        r.wake = Number.isFinite(cycle) ? Math.max(this.clock + 1, Math.floor(cycle)) : NEVER;
        this._schedule();
      },
      cancelWake: () => { if (live()) { r.wake = NEVER; this._schedule(); } },
    });
    this.devices.set(address, r);
    this.records.push(r); this.notifiedInputs = -1;
    try { r.device = factory(port) || {}; }
    catch (error) { this.unplug(address); throw error; }
    this.sync();
    return r.device;
  }
  unplug(address) {
    const r = this.devices.get(address);
    if (!r) return;
    r.active = false;
    this.devices.delete(address);
    this.records.splice(this.records.indexOf(r), 1); this.notifiedInputs = -1;
    try { r.device?.detach?.(); } catch { /* pins are already released */ }
    this._outputs(); this._schedule(); this.sync();
  }
  advanceVisible() { this.visible = this.previous; this.previous = this.outputs; }
  tick() {
    const now = ++this.clock;
    if (this.inputs === this.notifiedInputs && now < this.next) return;
    this.notifiedInputs = this.inputs;
    for (let i = 0; i < this.records.length;) {
      const r = this.records[i];
      if (r.lastLines !== this.inputs) {
        r.lastLines = this.inputs;
        this._call(r, 'onLines', this.inputs);
      }
      if (r.active && now >= r.wake) {
        r.wake = NEVER;
        this._call(r, 'onTimer', now);
      }
      if (this.records[i] === r) i++;
    }
    if (now >= this.next) this._schedule();
  }
  reset() {
    for (const r of this.devices.values()) {
      r.outputs = 3; r.wake = NEVER; r.lastLines = -1;
      this._call(r, 'reset');
    }
    this.previous = this.visible = 3;
    this.notifiedInputs = -1;
    this._outputs(); this._schedule(); this.sync();
  }
  serialize() {
    const devices = [];
    for (const r of this.devices.values()) {
      const state = this._call(r, 'serialize');
      if (r.active) devices.push({ address: r.address, id: r.id, version: r.version, outputs: r.outputs,
        wake: r.wake === NEVER ? null : r.wake, lastLines: r.lastLines, state });
    }
    return { clock: this.clock, previous: this.previous, visible: this.visible, devices };
  }
  deserialize(s) {
    const mismatches = [];
    this.reset();
    this.clock = Number.isSafeInteger(s?.clock) && s.clock >= 0 ? s.clock : 0;
    for (const saved of s?.devices || []) {
      const r = this.devices.get(saved.address);
      if (!r || r.id !== saved.id) { mismatches.push({ address: saved.address, id: saved.id }); continue; }
      r.outputs = saved.outputs & 3;
      r.wake = saved.wake == null ? NEVER : Math.max(this.clock + 1, saved.wake);
      r.lastLines = -1;
      this._call(r, 'deserialize', saved.state);
    }
    this.previous = s?.previous == null ? 3 : s.previous & 3;
    this.visible = s?.visible == null ? 3 : s.visible & 3;
    this._outputs(); this._schedule(); this.sync();
    return mismatches;
  }
}
