// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/6522.js - MOS 6522 Versatile Interface Adapter (VIA)
// Simplistic emulation tailored for the 1541 disk drive requirements.
// Register/timer model per the MOS 6522 (VIA) datasheet.

export class VIA6522 {
  constructor(name) {
    this.name = name;
    this.regs = new Uint8Array(16);
    
    // I/O ports
    this.portA = 0xFF;
    this.portB = 0xFF;
    this.pinsA = 0xFF; // External pin state
    this.pinsB = 0xFF; // External pin state

    // Timers
    this.t1c = 0; // Timer 1 Counter (16-bit)
    this.t1l = 0; // Timer 1 Latch (16-bit)
    this.t2c = 0; // Timer 2 Counter (16-bit)
    this.t2l = 0; // Timer 2 Latch (16-bit)

    // Derived states
    this.t1_active = false;
    this.t2_active = false;

    this.ifr = 0; // Interrupt Flag Register
    this.ier = 0; // Interrupt Enable Register (bit 7 is not stored, it's used to set/clear)
    
    // Callbacks for external hardware
    this.readPortA = () => this.pinsA;
    this.readPortB = () => this.pinsB;
    this.writePortA = (val) => {};
    this.writePortB = (val) => {};
    this.irqHandler = (state) => {};
  }

  get irqState() {
    return (this.ifr & this.ier) !== 0;
  }

  _updateIrq() {
    // If any enabled interrupt triggers, set bit 7 of IFR
    const pending = (this.ifr & this.ier & 0x7F) !== 0;
    if (pending) this.ifr |= 0x80;
    else this.ifr &= 0x7F;
    
    // Notify the hardware (CPU irq line) of the CURRENT state
    this.irqHandler(pending);
  }

  triggerIrq(bit) {
    this.ifr |= (1 << bit);
    this._updateIrq();
  }

  clearIrq(bit) {
    this.ifr &= ~(1 << bit);
    this._updateIrq();
  }

  clock(cycles) {
    // Timer 1. The 1541 DOS ROM depends heavily on VIA2 T1 periodic IRQs to
    // drive the controller scheduler, so preserve free-run cadence instead of
    // dropping excess underflows on long clock bursts.
    if (this.t1_active) {
      const continuous = (this.regs[0x0B] & 0x40) !== 0;
      let remaining = cycles;
      while (remaining > 0) {
        const step = Math.min(remaining, this.t1c + 1);
        this.t1c -= step;
        remaining -= step;
        if (this.t1c < 0) {
          this.triggerIrq(6);
          if (continuous) {
            this.t1c += this.t1l + 1;
          } else {
            this.t1c = 0xFFFF;
            this.t1_active = false;
            break;
          }
        }
      }
      this.t1c &= 0xFFFF;
    } else {
      this.t1c = (this.t1c - cycles) & 0xFFFF;
    }

    // Timer 2 (Always one-shot internally counting phi2)
    if (this.t2_active) {
      this.t2c -= cycles;
      if (this.t2c < 0) {
        this.triggerIrq(5);
        this.t2c = (this.t2c + 0x10000) & 0xFFFF;
        this.t2_active = false;
      }
    } else {
      this.t2c = (this.t2c - cycles) & 0xFFFF;
    }
  }

  read(reg) {
    const regId = reg & 0x0F;
    let val = 0;

    switch (regId) {
      case 0x00: // IRB
        // For Port B, reading always returns the status of the pins,
        // regardless of whether they are outputs or inputs.
        // However, the "pins" are often driven by the Output Register itself.
        const inB = this.readPortB();
        const dirB = this.regs[0x02];
        val = (this.portB & dirB) | (inB & ~dirB);
        this.clearIrq(3); // CB2 IRQ (side effect of reading IRB)
        this.clearIrq(4); // CB1 IRQ
        break;
      case 0x01: // IRA
      case 0x0F: // IRA (no handshake)
        if (regId === 0x01) {
          this.clearIrq(0); // CA2 IRQ
          this.clearIrq(1); // CA1 IRQ
        }
        if (this.readPortA) return this.readPortA();
        return (this.portA & this.portADir) | (0xFF & ~this.portADir);
      case 0x02: val = this.regs[0x02]; break; // DDRB
      case 0x03: val = this.regs[0x03]; break; // DDRA
      case 0x04: // T1C L
        this.clearIrq(6);
        val = this.t1c & 0xFF;
        break;
      case 0x05: // T1C H
        val = (this.t1c >> 8) & 0xFF;
        break;
      case 0x06: val = this.t1l & 0xFF; break; // T1L L
      case 0x07: val = (this.t1l >> 8) & 0xFF; break; // T1L H
      case 0x08: // T2C L
        this.clearIrq(5);
        val = this.t2c & 0xFF;
        break;
      case 0x09: val = (this.t2c >> 8) & 0xFF; break; // T2C H
      case 0x0A: val = this.regs[0x0A]; break; // SR
      case 0x0B: val = this.regs[0x0B]; break; // ACR
      case 0x0C: val = this.regs[0x0C]; break; // PCR
      case 0x0D: val = this.ifr; break; // IFR
      case 0x0E: val = this.ier | 0x80; break; // IER
    }
    return val;
  }

  peek(reg) {
    const regId = reg & 0x0F;

    switch (regId) {
      case 0x00: {
        const inB = this.readPortB();
        const dirB = this.regs[0x02];
        return (this.portB & dirB) | (inB & ~dirB);
      }
      case 0x01:
      case 0x0F:
        if (this.readPortA) return this.readPortA();
        return (this.portA & this.regs[0x03]) | (0xFF & ~this.regs[0x03]);
      case 0x02: return this.regs[0x02];
      case 0x03: return this.regs[0x03];
      case 0x04: return this.t1c & 0xFF;
      case 0x05: return (this.t1c >> 8) & 0xFF;
      case 0x06: return this.t1l & 0xFF;
      case 0x07: return (this.t1l >> 8) & 0xFF;
      case 0x08: return this.t2c & 0xFF;
      case 0x09: return (this.t2c >> 8) & 0xFF;
      case 0x0A: return this.regs[0x0A];
      case 0x0B: return this.regs[0x0B];
      case 0x0C: return this.regs[0x0C];
      case 0x0D: return this.ifr;
      case 0x0E: return this.ier | 0x80;
      default: return 0;
    }
  }

  write(reg, val) {
    const regId = reg & 0x0F;
    switch (regId) {
      case 0x00: // ORB
        this.clearIrq(3); // CB2 IRQ
        this.clearIrq(4); // CB1 IRQ
        this.portB = val;
        this.regs[0x00] = val;
        this.writePortB(this.portB & this.regs[0x02]);
        break;
      case 0x01: // ORA
      case 0x0F: // ORA (no handshake)
        if (regId === 0x01) {
          this.clearIrq(0); // CA2 IRQ
          this.clearIrq(1); // CA1 IRQ
        }
        this.portA = val;
        this.regs[0x01] = val;
        this.writePortA(this.portA & this.regs[0x03]);
        break;
      case 0x02: // DDRB
        this.regs[0x02] = val;
        this.writePortB(this.portB & val);
        break;
      case 0x03: // DDRA
        this.regs[0x03] = val;
        this.writePortA(this.portA & val);
        break;
      case 0x04: // T1 Latch L
        this.t1l = (this.t1l & 0xFF00) | val;
        break;
      case 0x05: // T1C H
        this.t1l = (val << 8) | (this.t1l & 0xFF);
        this.t1c = this.t1l + 1; // Load latch into counter (+1 clock internal delay)
        this.clearIrq(6);
        this.t1_active = true;
        break;
      case 0x06: // T1L L
        this.t1l = (this.t1l & 0xFF00) | val;
        break;
      case 0x07: // T1L H
        this.t1l = (val << 8) | (this.t1l & 0xFF);
        this.clearIrq(6);
        break;
      case 0x08: // T2L L
        this.t2l = val;
        break;
      case 0x09: // T2C H
        this.t2c = (val << 8) | this.t2l;
        this.clearIrq(5);
        this.t2_active = true;
        break;
      case 0x0A: // SR
        this.regs[0x0A] = val;
        break;
      case 0x0B: // ACR
        this.regs[0x0B] = val;
        break;
      case 0x0C: // PCR
        this.regs[0x0C] = val;
        break;
      case 0x0D: // IFR (Write 1 to clear)
        this.ifr &= ~val;
        this._updateIrq();
        break;
      case 0x0E: // IER
        if (val & 0x80) {
          this.ier |= (val & 0x7F);
        } else {
          this.ier &= ~(val & 0x7F);
        }
        this._updateIrq();
        break;
    }
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // Callbacks (readPortA/B, writePortA/B, irqHandler) are re-wired by the
  // owning drive, so only data state is captured.
  serialize() {
    return {
      portA: this.portA, portB: this.portB,
      pinsA: this.pinsA, pinsB: this.pinsB,
      t1c: this.t1c, t1l: this.t1l, t2c: this.t2c, t2l: this.t2l,
      t1_active: this.t1_active, t2_active: this.t2_active,
      ifr: this.ifr, ier: this.ier,
      regs: Array.from(this.regs),
    };
  }

  deserialize(s) {
    this.portA = s.portA & 0xFF; this.portB = s.portB & 0xFF;
    this.pinsA = s.pinsA & 0xFF; this.pinsB = s.pinsB & 0xFF;
    this.t1c = s.t1c | 0; this.t1l = s.t1l | 0;
    this.t2c = s.t2c | 0; this.t2l = s.t2l | 0;
    this.t1_active = !!s.t1_active; this.t2_active = !!s.t2_active;
    this.ifr = s.ifr & 0xFF; this.ier = s.ier & 0xFF;
    if (s.regs) this.regs.set(s.regs);
  }
}
