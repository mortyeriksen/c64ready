// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { ProvenanceCapture } from './provenance-capture.js';
import { CANVAS_W, CANVAS_H, CYCLES_PER_LINE, LINES_PER_FRAME, C64_PALETTE } from './vic2-tables.js';

// One detached PAL frame. All storage is allocated before clocking starts.
// Cycle flags describe phi1 state. Events describe writes/IRQ assertions,
// not same-cycle pixel effects. Sprite pointers and DMA are end-of-line samples.
export class VicFrameCapture {
  constructor({ analysis = false, provenance = false } = {}) {
    const cycles = CYCLES_PER_LINE * LINES_PER_FRAME;
    this.status = 'waiting';
    this.provenance = provenance ? new ProvenanceCapture(cycles) : null;
    analysis ||= provenance;
    this.analysis = analysis ? {
      version: 1, scope: 'pal-bus-v1', model: '',
      border: { version: 1, phase: 'vic-line-end-before-phi2',
        initial: { mainClosed: true, verticalClosed: true, verticalLatch: true, pendingTransitions: 0 },
        before: new Uint8Array(cycles), after: new Uint8Array(cycles), latch: new Uint8Array(cycles),
        d016: new Uint8Array(cycles), lineEndGates: new Uint8Array(cycles), lineEndValid: new Uint8Array(cycles) },
      initial: { registers: new Uint8Array(64), bank: 0, displayEnabled: false,
        displayActive: false, vc: 0, vcBase: 0, rc: 0, vmli: 0,
        spriteMC: new Uint8Array(8), spriteMCBase: new Uint8Array(8), spriteYExpandFF: new Uint8Array(8) },
      sequencer: { version: 1, phase: 'after-vic-before-cpu', displayPhase: 'render-window', spriteFetchPhase: 'grouped-row',
        registers: new Uint8Array(cycles*64), bank: new Uint16Array(cycles),
        vc: new Uint16Array(cycles), vcBase: new Uint16Array(cycles), rc: new Uint8Array(cycles), vmli: new Uint8Array(cycles),
        display: new Uint8Array(cycles), refresh: new Uint8Array(cycles), irq: new Uint8Array(cycles), mask: new Uint8Array(cycles),
        dma: new Uint8Array(cycles), spriteDisplay: new Uint8Array(cycles),
        mc: new Uint8Array(cycles*8), mcBase: new Uint8Array(cycles*8), advance: new Uint8Array(cycles*8),
      },
      d011: new Uint8Array(cycles), denLatch: new Uint8Array(cycles),
      // Bus: valid, write, blocked, REU hold, CPU halted, BA low, AEC low.
      bus: new Uint8Array(cycles), pc: new Uint16Array(cycles),
      vicValid: new Uint8Array(cycles),
    } : null;
    this.frame = {
      analysis: this.analysis, provenance: this.provenance?.data ?? null,
      width: CANVAS_W, height: CANVAS_H, rasterOffset: 15,
      lines: LINES_PER_FRAME, cyclesPerLine: CYCLES_PER_LINE,
      rgba: new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4),
      border: new Uint8Array(CANVAS_W * CANVAS_H),
      owners: new Uint8Array(CANVAS_W * CANVAS_H),
      flags: new Uint8Array(cycles),
      pointers: new Uint8Array(LINES_PER_FRAME * 8),
      spriteBanks: new Uint16Array(LINES_PER_FRAME * 8),
      spriteDma: new Uint8Array(LINES_PER_FRAME),
      palette: new Uint32Array(16),
      eventTick: new Uint16Array(cycles * 2),
      eventKind: new Uint8Array(cycles * 2),
      eventValue: new Uint8Array(cycles * 2),
      eventPC: new Uint16Array(cycles * 2),
      eventOpcode: new Uint8Array(cycles * 2),
      eventCPU: new Uint8Array(cycles * 2),
      eventCount: 0, overflow: false, startCycle: 0, endCycle: 0,
    };
  }

  cycle(vic) {
    if (this.status !== 'recording') return;
    const c = vic.cycleInLine, tick = vic.raster * CYCLES_PER_LINE + c - 1;
    if (this.analysis) {
      this.analysis.d011[tick] = vic.regs[0x11];
      this.analysis.border.d016[tick] = vic.regs[0x16];
      this.analysis.border.before[tick]=(vic.lineCycleHBorderBefore[c]?1:0)|(vic.lineCycleVBorderBefore[c]?2:0);
      this.analysis.border.after[tick]=(vic.hBorderActive?1:0)|(vic.vBorderActive?2:0);
      this.analysis.border.latch[tick]=vic._vBorderLatch?1:0;
      this.analysis.denLatch[tick] = vic.displayEnabled ? 1 : 0;
      this.analysis.vicValid[tick] = 1;
      const q=this.analysis.sequencer;
      q.registers.set(vic.regs,tick*64); q.bank[tick]=vic.currentVicBank;
      q.vc[tick]=vic.vc; q.vcBase[tick]=vic.vcBase; q.rc[tick]=vic.rc; q.vmli[tick]=vic.vmli;
      q.display[tick]=vic.displayActive?1:0; q.refresh[tick]=vic.refreshCounter;
      q.irq[tick]=vic.irqStatus; q.mask[tick]=vic.irqMask;
      q.mc.set(vic.spriteMC,tick*8); q.mcBase.set(vic.spriteMCBase,tick*8); q.advance.set(vic.spriteYExpandFF,tick*8);
      let dma=0, display=0;
      for(let s=0;s<8;s++){if(vic.spriteDmaOn[s])dma|=1<<s;if(vic.spriteDisplayOn[s])display|=1<<s;}
      q.dma[tick]=dma; q.spriteDisplay[tick]=display;
    }
    this.frame.flags[tick] = (vic.lineCycleHBorder[c] ? 1 : 0)
      | (vic.lineCycleVBorder[c] ? 2 : 0)
      | (vic._isBadLine(vic.raster, vic.regs) ? 4 : 0)
      | (vic.lineCycleMatrixFetchActive[c] ? 8 : 0)
      | (vic.baLow ? 16 : 0) | (vic._aecLowPhi2 ? 32 : 0)
      | (vic.irqStatus & 0x80 ? 64 : 0);
  }

  cpuBus(machine, baLow, aecLow, reuHeld, blocked) {
    if (this.status !== 'recording' || !this.analysis) return;
    const vic = machine.vic2;
    const cycle = vic.cycleInLine || CYCLES_PER_LINE;
    const raster = vic.cycleInLine ? vic.raster : (vic.raster + LINES_PER_FRAME - 1) % LINES_PER_FRAME;
    const tick = raster * CYCLES_PER_LINE + cycle - 1;
    const a = this.analysis;
    a.bus[tick] = 1 | (machine.cpu.nextBusIsWrite() ? 2 : 0) | (blocked ? 4 : 0)
      | (reuHeld ? 8 : 0) | (machine.cpu.halted ? 16 : 0) | (baLow ? 32 : 0) | (aecLow ? 64 : 0);
    a.pc[tick] = machine.cpu.pc;
  }

  line(vic) {
    if (this.status !== 'recording') return;
    if(this.provenance) this.provenance.line(vic);
    const y = vic._cycleRenderActiveCanvasY, frame = this.frame;
    if (y >= 0 && y < CANVAS_H) {
      frame.border.set(vic.borderBuffer, y * CANVAS_W);
      frame.owners.set(vic.spriteOwnerBuffer, y * CANVAS_W);
    }
    if (this.analysis) {
      const border = this.analysis.border, start = vic.raster * CYCLES_PER_LINE;
      for (let c = 1; c <= CYCLES_PER_LINE; c++) {
        border.lineEndGates[start+c-1] = (vic.lineCycleHBorder[c] ? 1 : 0) | (vic.lineCycleVBorder[c] ? 2 : 0);
        border.lineEndValid[start+c-1] = 1;
      }
    }
    const base = vic.raster * 8;
    frame.pointers.set(vic.spritePointerValue, base);
    frame.spriteBanks.set(vic.spriteDataBank, base);
    let dma = 0;
    for (let s = 0; s < 8; s++) if (vic.spriteDmaOn[s]) dma |= 1 << s;
    frame.spriteDma[vic.raster] = dma;
  }

  event(vic, kind, value = 0) {
    if (this.status !== 'recording') return;
    const f = this.frame, index = f.eventCount;
    if (index >= f.eventTick.length) { f.overflow = true; return; }
    const cycle = vic.cycleInLine || CYCLES_PER_LINE;
    const raster = vic.cycleInLine ? vic.raster : (vic.raster + LINES_PER_FRAME - 1) % LINES_PER_FRAME;
    f.eventTick[index] = raster * CYCLES_PER_LINE + cycle - 1;
    f.eventKind[index] = kind; f.eventValue[index] = value;
    const machine = vic.memory?.machine, cpu = machine?.cpu;
    if (kind < 64 && machine?._masterPhase === 'cpu' && cpu.instructionAddress >= 0) {
      f.eventCPU[index] = 1; f.eventPC[index] = cpu.instructionAddress;
      f.eventOpcode[index] = cpu.instructionOpcode;
    }
    f.eventCount++;
  }

  boundary(vic) {
    if (this.status === 'waiting') {
      if (this.analysis) {
        const a = this.analysis, initial = a.initial;
        a.model = vic.vicVariant;
        a.border.initial.mainClosed = vic.hBorderActive;
        a.border.initial.verticalClosed = vic.vBorderActive;
        a.border.initial.verticalLatch = vic._vBorderLatch;
        a.border.initial.pendingTransitions = vic._ffCount;
        initial.registers.set(vic.regs); initial.bank = vic.currentVicBank;
        initial.displayEnabled = vic.displayEnabled; initial.displayActive = vic.displayActive;
        initial.vc = vic.vc; initial.vcBase = vic.vcBase; initial.rc = vic.rc; initial.vmli = vic.vmli;
        initial.spriteMC.set(vic.spriteMC); initial.spriteMCBase.set(vic.spriteMCBase); initial.spriteYExpandFF.set(vic.spriteYExpandFF);
      }
      this.status = 'recording';
      if(this.provenance) this.provenance.start(vic.memory.machine,this);
      this.frame.startCycle = vic.totalCycles;
    } else if (this.status === 'recording') {
      this.frame.rgba.set(vic.frameBuffer);
      this.frame.palette.set(C64_PALETTE);
      this.frame.endCycle = vic.totalCycles;
      this.status = 'ready';
      this.provenance?.stop();
      vic._frameCapture = null;
    }
  }

  cancel() { this.provenance?.stop(); if (this.status !== 'ready') this.status = 'cancelled'; }
}
