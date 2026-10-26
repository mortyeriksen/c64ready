// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Scalar observers are attached only for an open, visible Monitor. Device
// clocks increment totals without allocating events or invoking UI callbacks.
export class StorageTransferCapture {
  constructor(machine) {
    this.machine = machine;
    this.epoch = 0;
    this.bindings = Array(5).fill(null);
  }

  bind(index, owner, field, media, scope) {
    const previous = this.bindings[index];
    if (previous?.owner === owner && previous?.media === media && previous?.scope === scope) return;
    if (previous) previous.owner[previous.field] = null;
    this.bindings[index] = null;
    if (!owner || !media) return;
    const counter = new Float64Array(2);
    const epoch = ++this.epoch;
    owner[field] = counter;
    this.bindings[index] = { owner, field, media, scope, epoch, counter };
  }

  sync() {
    const m = this.machine;
    for (let i = 0; i < 2; i++) {
      const drive = i ? m.drive1541b : m.drive1541;
      const accelerated = i ? m.drive9Enabled && !drive : !m.truedriveEnabled;
      const owner = accelerated ? (i ? m.vdrive9 : m.vdrive8) : drive;
      this.bind(i, owner, '_storageCounter', i ? m.currentD64Drive9 : m.currentD64,
        accelerated ? 'File/channel bytes' : 'GCR media bytes');
    }
    this.bind(2, m.datasette, '_storageCounter', m.datasette.tapData, 'TAP stream bytes');
    this.bind(3, m.mem, '_storageRomCounter', m.mem.cartridge, 'CPU ROM reads');
    this.bind(4, m.mem, '_storageDmaCounter', m.reu, 'REU DMA bus bytes');
  }

  copyInto(out) {
    this.sync();
    for (let i = 0; i < 5; i++) {
      const binding = this.bindings[i], c = binding?.counter, target = out[i];
      target.available = !!c;
      target.read = c?.[0] ?? 0; target.write = c?.[1] ?? 0;
      target.epoch = binding?.epoch ?? 0; target.scope = binding?.scope ?? '';
    }
  }

  stop() {
    for (const binding of this.bindings) if (binding) binding.owner[binding.field] = null;
    this.bindings.fill(null);
  }
}
