// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport.js – the user port and its device API.
//
// One device plugs in at a time. The machine owns a UserPort while a device is
// attached and calls tick() from the master cycle, which only does work when a
// device timer or a PC2 strobe is due, so a device costs nothing between its
// own events. The API devices are written against is documented in
// docs/DEVICE-PLUGINS.md.
//
// Lines are TTL levels at the connector, 1 = high. Every line is pulled up, and
// a line is low when either side pulls it low (wired-AND), which is how the
// CIA's port pins and open-collector devices meet on the real port.

export const USERPORT_API_VERSION = 2;

// Serial pins, as bits for driveSerial() and c64Serial(): the SP and CNT lines
// of CIA1 (pins 5 and 4) and CIA2 (pins 7 and 6).
export const SP1 = 0x01, CNT1 = 0x02, SP2 = 0x04, CNT2 = 0x08;

const NONE = Number.MAX_SAFE_INTEGER;

export class UserPort {
  constructor(cia2, cyclesPerSecond, cia1 = null) {
    this.cia1 = cia1;
    this.cia2 = cia2;
    this.cyclesPerSecond = cyclesPerSecond;
    this.device = null;
    this.deviceId = null;
    this.deviceVersion = null;
    // Called with (deviceId, error) when a device callback throws. The device
    // is unplugged first, so the C64 keeps running with an empty port.
    this.onError = null;
    this.clock = 0;          // cycles completed since the port was created
    this.wake = NONE;        // device timer
    this.pc2Due = NONE;      // PC2 low cycle after a $DD01 access
    this.next = NONE;        // min(wake, pc2Due)
    this.devPB = 0xFF;       // levels the device drives (1 where released)
    this.lastC64PB = 0xFF;
    this.lastPA2 = 1;
    this.flagLevel = 1;
    this.devSerial = 0x0F;   // SP/CNT levels the device drives
    this.lastSerial = 0x0F;
    this.port = this._makeHandle();
  }

  _makeHandle() {
    const up = this;
    return Object.freeze({
      apiVersion: USERPORT_API_VERSION,
      cyclesPerSecond: up.cyclesPerSecond,
      now: () => up.clock,
      drivePB(mask, levels) {
        up.devPB = (~mask | levels) & 0xFF;
      },
      setFlag(level) {
        level = level ? 1 : 0;
        up.flagLevel = level;
        up.cia2.setFlag(level);
      },
      wakeAt(cycle) {
        up.wake = cycle > up.clock ? Math.floor(cycle) : up.clock + 1;
        up.next = Math.min(up.wake, up.pc2Due);
      },
      cancelWake() {
        up.wake = NONE;
        up.next = up.pc2Due;
      },
      c64PB: () => up._c64PB(),
      c64PA2: () => up._c64PA2(),
      driveSerial(mask, levels) {
        up._driveSerial((~mask | levels) & 0x0F);
      },
      c64Serial: () => up._c64Serial(),
    });
  }

  // Plug a device in. `factory(port)` returns the device object.
  plug(id, factory, version = null) {
    this.unplug();
    this.lastC64PB = this._c64PB();
    this.lastPA2 = this._c64PA2();
    this.lastSerial = this._c64Serial();
    this.deviceId = id;
    this.deviceVersion = version;
    let dev;
    try {
      dev = factory(this.port);
    } catch (err) {
      this._fail(err);
      throw err;
    }
    this.device = dev && typeof dev === 'object' ? dev : {};
    return this.device;
  }

  unplug() {
    const dev = this.device;
    this.device = null;
    this.deviceId = null;
    this.deviceVersion = null;
    this.wake = NONE;
    this.pc2Due = NONE;
    this.next = NONE;
    this.devPB = 0xFF;
    if (this.flagLevel === 0) this.port.setFlag(1);
    this._driveSerial(0x0F);
    if (dev && dev.detach) {
      try { dev.detach(); } catch { /* a failing detach must not keep the device plugged */ }
    }
  }

  _fail(err) {
    const id = this.deviceId;
    this.unplug();
    if (this.onError) this.onError(id, err);
  }

  // Master-cycle hook: one increment and one compare unless an event is due.
  tick() {
    const c = ++this.clock;
    if (c < this.next) return;
    const dev = this.device;
    if (c >= this.pc2Due) {
      this.pc2Due = NONE;
      this.next = this.wake;
      if (dev !== null && dev.onPC2) {
        try { dev.onPC2(); } catch (err) { this._fail(err); return; }
      }
    }
    if (c >= this.wake) {
      this.wake = NONE;
      this.next = this.pc2Due;
      if (dev !== null && this.device === dev && dev.onTimer) {
        try { dev.onTimer(c); } catch (err) { this._fail(err); }
      }
    }
  }

  // CIA2 $DD01 read: output bits read the latch, input bits read the pin
  // (pulled up, ANDed with the device). Pure, so debugger peeks may use it.
  readPortB() {
    const cia = this.cia2;
    const ddr = cia.portBDir;
    return ((cia.portB & ddr) | (this.devPB & ~ddr)) & 0xFF;
  }

  // CPU read or write of $DD01. PC2 is low for the cycle after the access, and
  // the access happens before this cycle's tick, so that is two ticks away.
  pcStrobe() {
    if (this.device === null) return;
    this.pc2Due = this.clock + 2;
    if (this.pc2Due < this.next) this.next = this.pc2Due;
  }

  // CIA2 port B latch or DDRB written, or a PB6/PB7 timer output changed.
  portBChanged() {
    const pb = this._c64PB();
    if (pb === this.lastC64PB) return;
    this.lastC64PB = pb;
    const dev = this.device;
    if (dev !== null && dev.onPortB) {
      try { dev.onPortB(pb); } catch (err) { this._fail(err); }
    }
  }

  // CIA1 or CIA2 changed what it drives on SP or CNT.
  serialChanged() {
    const lines = this._c64Serial();
    if (lines === this.lastSerial) return;
    this.lastSerial = lines;
    const dev = this.device;
    if (dev !== null && dev.onSerial) {
      try { dev.onSerial(lines); } catch (err) { this._fail(err); }
    }
  }

  // CIA2 port A latch or DDRA written.
  portAChanged() {
    const pa2 = this._c64PA2();
    if (pa2 === this.lastPA2) return;
    this.lastPA2 = pa2;
    const dev = this.device;
    if (dev !== null && dev.onPA2) {
      try { dev.onPA2(pa2); } catch (err) { this._fail(err); }
    }
  }

  // Tell the device the C64's current lines, whatever it was last told: after a
  // snapshot is restored the CIA's registers changed without a write.
  resync() {
    this.lastC64PB = -1;
    this.lastPA2 = -1;
    this.lastSerial = -1;
    this.portBChanged();
    this.portAChanged();
    this.serialChanged();
  }

  reset() {
    // CIA2 /RESET turns every port pin into an input, so the C64 side floats high.
    this.portBChanged();
    this.portAChanged();
    this.serialChanged();
    const dev = this.device;
    if (dev !== null && dev.reset) {
      try { dev.reset(); } catch (err) { this._fail(err); }
    }
  }

  // Port B as the C64 drives it, PB6/PB7 included when they are timer outputs.
  _c64PB() {
    const cia = this.cia2;
    const pb = ((cia.portB & cia.portBDir) | ~cia.portBDir) & 0xFF;
    return ((cia.cra | cia.crb) & 0x02) ? cia.applyTimerOutputs(pb) : pb;
  }

  _c64Serial() {
    const one = this.cia1 ? this.cia1.serialPins() : 3;
    return one | (this.cia2.serialPins() << 2);
  }

  _driveSerial(levels) {
    const changed = levels ^ this.devSerial;
    if (!changed) return;
    this.devSerial = levels;
    const one = this.cia1, two = this.cia2;
    if (one && (changed & SP1)) one.setSp(levels & SP1 ? 1 : 0);
    if (one && (changed & CNT1)) one.setCnt(levels & CNT1 ? 1 : 0);
    if (changed & SP2) two.setSp(levels & SP2 ? 1 : 0);
    if (changed & CNT2) two.setCnt(levels & CNT2 ? 1 : 0);
  }

  _c64PA2() {
    const cia = this.cia2;
    return (cia.portADir & 0x04) ? (cia.portA >> 2) & 1 : 1;
  }

  serialize() {
    let device = null;
    if (this.device !== null && this.device.serialize) {
      try { device = this.device.serialize(); } catch (err) { this._fail(err); }
    }
    return {
      deviceId: this.deviceId,
      deviceVersion: this.deviceVersion,
      clock: this.clock,
      wake: this.wake === NONE ? null : this.wake,
      pc2Due: this.pc2Due === NONE ? null : this.pc2Due,
      devPB: this.devPB,
      lastC64PB: this.lastC64PB,
      lastPA2: this.lastPA2,
      flagLevel: this.flagLevel,
      devSerial: this.devSerial,
      lastSerial: this.lastSerial,
      device,
    };
  }

  // Restores port state when the snapshot's device is the one plugged in now.
  // Returns false when it is not, so the caller can say which device it was.
  deserialize(s) {
    if (!s || s.deviceId !== this.deviceId) return false;
    this.clock = s.clock;
    this.wake = s.wake == null ? NONE : s.wake;
    this.pc2Due = s.pc2Due == null ? NONE : s.pc2Due;
    this.next = Math.min(this.wake, this.pc2Due);
    this.devPB = s.devPB & 0xFF;
    this.lastC64PB = s.lastC64PB & 0xFF;
    this.lastPA2 = s.lastPA2 & 1;
    this.flagLevel = s.flagLevel & 1;
    this.devSerial = (s.devSerial ?? 0x0F) & 0x0F;
    this.lastSerial = (s.lastSerial ?? 0x0F) & 0x0F;
    if (s.device != null && this.device !== null && this.device.deserialize) {
      try { this.device.deserialize(s.device); } catch (err) { this._fail(err); }
    }
    return true;
  }
}
