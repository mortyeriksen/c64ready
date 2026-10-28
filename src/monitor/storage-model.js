// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const STORAGE_DEVICES = ['Drive 8', 'Drive 9', 'Tape', 'CRT', 'REU'];

export function reuSettings(registers, bankMask = 255) {
  return { operation: ['C64 → REU', 'REU → C64', 'Swap memory', 'Compare memory'][registers[1] & 3],
    c64: registers[2] | registers[3] << 8,
    reu: registers[4] | registers[5] << 8 | (registers[6] & bankMask) << 16,
    length: (registers[7] | registers[8] << 8) || 65536,
    complete: !!(registers[0] & 0x40), fault: !!(registers[0] & 0x20), irq: !!(registers[0] & 0x80) };
}

// History stores sampled conditions. It does not reconstruct missed transfers.
export class StorageHistory {
  constructor() { this.rows = Array.from({length: 5}, () => new Uint8Array(401)); this.times = new Float64Array(401); this.heads = [new Float32Array(401), new Float32Array(401)]; this.banks = new Int32Array(401); this.reset(); }
  reset() { this.cursor = 0; this.count = 0; this.lastReu = null; this.lastReuBytes = 0; this.reuChanged = false; this.lastTime = -Infinity; for (const row of this.rows) row.fill(0); for (const row of this.heads) row.fill(NaN); this.banks.fill(-1); }
  sample(state, time, interval = 100) {
    if (time - this.lastTime < interval * .9) return;
    this.lastTime = time;
    this.reuChanged = state.reu.attached && this.lastReu !== null && this.lastReuBytes === state.reu.bytes && ((state.reu.activity - this.lastReu) >>> 0) > 0 && ((state.reu.activity - this.lastReu) >>> 0) < 0x80000000;
    const index = this.cursor;
    for (let d = 0; d < 2; d++) this.rows[d][index] = state.drives[d].led ? 2 : state.drives[d].motor ? 1 : 0;
    this.rows[2][index] = state.tape.recording ? 2 : state.tape.motor ? 1 : 0;
    this.rows[3][index] = state.cartridge.inserted && state.cartridge.mode !== 'none' ? 1 : 0;
    this.rows[4][index] = state.reu.active || this.reuChanged ? 2 : 0;
    for (let d = 0; d < 2; d++) this.heads[d][index] = state.drives[d].hardware && state.drives[d].hasMedia ? state.drives[d].halfTrack / 2 : NaN;
    this.banks[index] = state.cartridge.inserted ? state.cartridge.bank : -1;
    this.times[index] = time;
    this.lastReu = state.reu.attached ? state.reu.activity : null; this.lastReuBytes = state.reu.bytes;
    this.cursor = (index + 1) % 401; this.count = Math.min(401, this.count + 1);
    while(this.count>1&&time-this.times[(this.cursor-this.count+401)%401]>8000)this.count--;
  }
  get seconds() { return this.count < 2 ? 0 : (this.times[(this.cursor + 400) % 401] - this.times[(this.cursor - this.count + 401) % 401]) / 1000; }
}

export function activeStorageDevice(state, selected = 0, reuChanged = false) {
  const present = [state.drives[0].hasMedia,state.drives[1].hasMedia,state.tape.hasMedia,state.cartridge.inserted,state.reu.attached];
  const active = [state.drives[0].motor || state.drives[0].led,state.drives[1].motor || state.drives[1].led,state.tape.motor || state.tape.recording,false,state.reu.active || reuChanged];
  for (let i=0;i<active.length;i++) active[i] ||= (state.rates?.[i]?.total ?? 0)>0;
  if (active[selected]) return selected;
  const busy = active.findIndex(Boolean);
  if (busy >= 0) return busy;
  if (present[selected]) return selected;
  const inserted = present.findIndex(Boolean);
  return inserted >= 0 ? inserted : state.drives.findIndex(drive => drive.available) >= 0 ? state.drives.findIndex(drive => drive.available) : 0;
}
