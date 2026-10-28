// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/machine-facade.js – The UI's interface to the emulator.
//
// UI modules drive the machine through these methods and never hold a chip
// object (cia1, vic2, mem, datasette, drive1541, reu). That keeps the boundary
// narrow enough for a different engine to sit behind it: every call is made at
// most a few times per frame or per host event, never from inside the cycle
// loop, and no UI code runs inside the machine.
//
// Devices the UI watches (tape deck, drives, RAM expansion) are exposed as
// small read-only views. A view's getters read the live chip on every access,
// so a view stays valid across inserts, ejects and re-attaches; assigning to
// one throws. Each method likewise looks its chip up on every call, so a
// rewrapped chip method (the browser checks wrap cia1.setKey) is the one
// reached. The live instance is `c64` in state.js, rebuilt with each machine.

import { MonitorActivityCapture, createActivityInspection } from './monitor-activity-capture.js';
import { StorageTransferCapture } from './storage-transfer-capture.js';
import { VicFrameCapture } from './vic2-frame-capture.js';
import { C64_PALETTE } from './vic2-tables.js';

// The cassette deck as the UI sees it.
class TapeView {
  constructor(machine) { this._m = machine; }
  get _ds() { return this._m.datasette; }

  get hasMedia()         { return this._ds.hasMedia; }
  get key()              { return this._ds.key; }   // 'STOP' | 'PLAY' | 'REC' | 'FF' | 'REW'
  get playPressed()      { return this._ds.playPressed; }
  get motorOn()          { return this._ds.motorOn; }
  get recording()        { return this._ds.recording; }
  get atEnd()            { return this._ds.atEnd; }
  get writeProtected()   { return this._ds.writeProtected; }
  get dirty()            { return this._ds.dirty; }    // recorded, not yet exported
  get counter()          { return this._ds.counter; }
  get pos()              { return this._ds.pos; }
  get positionFraction() { return this._ds.positionFraction; }
  get elapsedSeconds()   { return this._ds.elapsedSeconds; }
  get durationSeconds()  { return this._ds.durationSeconds; }
  get recordedLength()   { return this._ds.recordedLength; }
  // The loaded .tap pulse data (read-only), its version and v0 zero-gap length.
  get tapData()          { return this._ds.tapData; }
  get tapVersion()       { return this._ds.tapVersion; }
  get zeroGapCycles()    { return this._ds.zeroGapCycles; }

  secondsAtFraction(fraction) { return this._ds.secondsAtFraction(fraction); }
  recordedSlice(from, to)     { return this._ds.recordedSlice(from, to); }
  exportTapBytes()            { return this._ds.exportTapBytes(); }
  // The recording is safely stored elsewhere; clears `dirty`.
  markSaved()                 { this._ds.dirty = false; }
}

// A true-drive 1541 on the IEC bus (device 8 or 9).
class DriveView {
  constructor(machine, dev) { this._m = machine; this._dev = dev; }
  get _drive() { return this._dev === 9 ? this._m.drive1541b : this._m.drive1541; }

  get attached()         { return !!this._drive; }
  get ledOn()            { return !!this._drive?.ledOn; }
  get motorOn()          { return !!this._drive?.motorOn; }
  get currentHalfTrack() { return this._drive?.currentHalfTrack ?? 0; }
  setWriteProtect(on)    { this._drive?.setWriteProtect(on); }
}

// The RAM Expansion Unit, when one is fitted.
class ReuView {
  constructor(machine) { this._m = machine; }

  // Bumps on every DMA transfer; drives the activity LED.
  get activityTick() { return this._m.reu?.activityTick ?? 0; }
  // Expansion RAM (read-only view; use loadImage / clearRam to change it).
  get ram()          { return this._m.reu?.ram ?? null; }
  loadImage(bytes)   { this._m.reu?.loadImage(bytes); }
  clearRam()         { this._m.reu?.clearRam(); }
}

export class MachineFacade {
  constructor(machine) {
    this.machine = machine;
    this._vicCapture = null;
    this._storageCapture = null;
    this._storageMonitoring = false;
    this._activityCapture = null;
    this.tape = new TapeView(machine);
    this._drives = { 8: new DriveView(machine, 8), 9: new DriveView(machine, 9) };
    this._reu = new ReuView(machine);
    this.debug = new MachineDebug(machine);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // True once ROMs are loaded and the machine can run.
  get ready() { return this.machine.ready; }
  loadROMs(roms) { this.machine.loadROMs(roms); }
  runFrame() { this.machine.runFrame(); }

  // Host callbacks for trap-mode drive activity. They fire from inside
  // runFrame, so a handler must only update UI state, not drive the machine.
  //   onLoadTrap(dev)      a trapped LOAD opened a file on drive `dev`
  //   onTrapDiskWrite(dev) a trapped SAVE wrote to the disk in drive `dev`
  set onLoadTrap(fn)      { this.machine.onLoadTrap = fn; }
  set onTrapDiskWrite(fn) { this.machine.onTrapDiskWrite = fn; }

  // ── Video ────────────────────────────────────────────────────────────────
  // The VIC's RGBA frame (CANVAS_W × CANVAS_H), without overlays.
  frameBuffer()        { return this.machine.vic2.frameBuffer; }
  // The frame as presented, with the collision overlay composed in when on.
  presentationBuffer() { return this.machine.vic2.presentationBuffer(); }
  blit(ctx)            { this.machine.vic2.blit(ctx); }
  collisionOverlay()   { return this.machine.vic2._collisionOverlay; }
  get vicVariant()     { return this.machine.vic2.vicVariant; }
  set vicVariant(v)    { this.machine.vic2.vicVariant = v; }

  // ── Audio ────────────────────────────────────────────────────────────────
  // SharedArrayBuffer ring the SID worklet reads register writes from.
  get sidShared()   { return this.machine.sidShared; }
  get sidIs8580()   { return this.machine.sidIs8580; }
  setSidModel(is8580) { this.machine.setSidModel(is8580); }
  configureSecondSid(cfg) { this.machine.configureSecondSid(cfg); }
  secondSidConfig() { return this.machine.secondSidConfig(); }
  // Throws if `address` is not a legal second-SID base.
  validateSecondSidAddress(address) { this.machine.mem.validateSecondSidAddress(address); }
  // Queue a register write to the SID audio path, as the CPU would.
  writeSid(reg, val, chip = 0) { this.machine._sidWrite(reg, val, chip); }

  // ── Keyboard matrix ──────────────────────────────────────────────────────
  setKey(col, row, down) { this.machine.cia1.setKey(col, row, down); }
  isKeyDown(col, row)    { return this.machine.cia1.isKeyDown(col, row); }
  releaseAllKeys()       { this.machine.cia1.matrix.fill(0xFF); }
  setRestore(down)       { this.machine.setRestoreNmiLine(down); }
  // Types into the KERNAL keyboard buffer; returns how many chars were taken.
  bufferKeyboardText(text) { return this.machine.bufferKeyboardText(text); }

  // ── Control ports ────────────────────────────────────────────────────────
  // Active-low joystick byte (bits 0-4: up, down, left, right, fire).
  setJoystick(port, byte) {
    if (port === 1) this.machine.joyPort1 = byte;
    else this.machine.joyPort2 = byte;
  }

  // Raw POTX/POTY pin values; sampled by the SID every 512 cycles.
  get paddleX() { return this.machine.paddleX; }
  get paddleY() { return this.machine.paddleY; }
  setPaddles(x, y) {
    this.machine.paddleX = x;
    this.machine.paddleY = y;
  }
  // False leaves the pot lines open, so $D419/$D41A read $FF.
  setPotConnected(on) { this.machine.potConnected = on; }

  // NEOS mouse: the machine runs the strobe protocol; the UI reports motion
  // and buttons. See C64Machine.setNeosPort.
  setNeosPort(port, on)             { this.machine.setNeosPort(port, on); }
  neosResetPort(port)               { this.machine.neosResetPort(port); }
  neosMove(port, dx, dy)            { this.machine.neosMove(port, dx, dy); }
  setNeosButtons(port, left, right) { this.machine.setNeosButtons(port, left, right); }
  neosButtonsDown(port)             { return this.machine.neosButtonsDown(port); }
  neosPortByte(port)                { return this.machine.neosPortByte(port); }
  applyNeosPotX()                   { this.machine.applyNeosPotX(); }

  // ── Programs ─────────────────────────────────────────────────────────────
  loadPRG(bytes)   { return this.machine.loadPRG(bytes); }
  injectSys(addr)  { this.machine.injectSys(addr); }
  injectRun()      { this.machine.injectRun(); }

  // ── Cartridge ────────────────────────────────────────────────────────────
  get cartridgeInserted() { return !!this.machine.mem.cartridge; }
  loadCartridge(bytes)    { return this.machine.loadCartridge(bytes); }
  ejectCartridge()        { this.machine.ejectCartridge(); }
  resetCartridge()        { return this.machine.resetCartridge(); }
  setCartridgeFreeze(held) { return this.machine.setCartridgeFreeze(held); }

  // ── Disk drives ──────────────────────────────────────────────────────────
  // The true-drive 1541 on device 8 or 9, or null when none is attached.
  drive(dev) { return this._drives[dev].attached ? this._drives[dev] : null; }
  attachDrive(rom)     { this.machine.attachDrive(rom); }
  attachDrive9(rom)    { this.machine.attachDrive9(rom); }
  detachDrive9()       { this.machine.detachDrive9(); }
  setTrueDrive(on)     { this.machine.setTrueDrive(on); }
  setDrive9Enabled(on) { this.machine.setDrive9Enabled(on); }
  setD64(disk)         { this.machine.setD64(disk); }
  setD64Drive9(disk)   { this.machine.setD64Drive9(disk); }
  // Folds pending head writes into the disk images; returns how many changed.
  commitDriveWrites()    { return this.machine.commitDriveWrites(); }
  hasUnsavedDiskWrites() { return this.machine.hasUnsavedDiskWrites(); }

  // ── Datasette ────────────────────────────────────────────────────────────
  loadTap(bytes)          { this.machine.loadTap(bytes); }
  ejectTape()             { this.machine.ejectTape(); }
  rewindTape()            { this.machine.rewindTape(); }
  newBlankTape()          { this.machine.newBlankTape(); }
  // Returns false when the deck refuses the key (no tape, write-protected REC).
  setTapeKey(key)         { return this.machine.setTapeKey(key); }
  setTapePlayPressed(on)  { this.machine.setTapePlayPressed(on); }
  seekTapeFraction(f)     { this.machine.seekTapeFraction(f); }
  seekTapeSeconds(s)      { this.machine.seekTapeSeconds(s); }
  setTapeWriteProtected(on) { this.machine.setTapeWriteProtected(on); }
  exportTapBytes()        { return this.machine.exportTapBytes(); }
  hasUnsavedTapeWrites()  { return this.machine.hasUnsavedTapeWrites(); }

  // ── RAM Expansion ────────────────────────────────────────────────────────
  // The fitted REU, or null.
  get reu()           { return this.machine.reu ? this._reu : null; }
  attachReu(modelId)  { this.machine.attachReu(modelId); }
  // Additional devices on the shared IEC bus.
  attachIecDevice(address, id, factory, version, onError) {
    const dev = this.machine.attachIecDevice(address, id, factory, version);
    this.machine.iec.onError = onError;
    return dev;
  }
  detachIecDevice(address) { this.machine.detachIecDevice(address); }
  iecDeviceId(address) { return this.machine.iec?.devices.get(address)?.id ?? null; }
  get iecDeviceCount() { return this.machine.iec?.devices.size ?? 0; }
  takeIecRestoreMismatches() {
    const result = this.machine.iecRestoreMismatches;
    this.machine.iecRestoreMismatches = null;
    return result;
  }

  // User port: the error handler survives re-plugging.
  attachUserport(id, factory, version, onError) {
    const dev = this.machine.attachUserport(id, factory, version);
    this.machine.userport.onError = onError;
    return dev;
  }
  detachUserport()    { this.machine.detachUserport(); }
  get userportDeviceId() { return this.machine.userport?.deviceId ?? null; }
  // The device a just-restored snapshot was made with, when it is not the one
  // plugged in. Reading it clears it.
  takeUserportRestoreMismatch() {
    const id = this.machine.userportRestoreMismatch;
    this.machine.userportRestoreMismatch = null;
    return id;
  }
  detachReu()         { this.machine.detachReu(); }

  // ── Memory (read-only views) ─────────────────────────────────────────────
  // The 64K of RAM, as the CPU sees it with every ROM banked out.
  ram()     { return this.machine.mem.ram; }
  // Character ROM as loaded, or null before the ROMs are in.
  charRom() { return this.machine.mem.charRom ?? null; }

  createMonitorActivityInspection(){return createActivityInspection();}
  setMonitorActivityMonitoring(active){
    if(active){this._activityCapture??=new MonitorActivityCapture(this.machine);if(this.machine._monitorActivity!==this._activityCapture)this._activityCapture.start();}
    else this._activityCapture?.stop();
  }
  inspectMonitorActivityInto(out){
    if(this._activityCapture)return this._activityCapture.copyInto(out);
    out.active=false;out.count=0;return out;
  }

  setStorageMonitoring(active) {
    if (active) {
      this._storageCapture ??= new StorageTransferCapture(this.machine);
      this._storageCapture.sync();
    } else {
      this._storageCapture?.stop();
    }
    this._storageMonitoring = !!active;
  }

  // Storage inspection copies scalar state and register bytes without reading
  // acknowledgement registers or committing pending disk writes.
  createStorageInspection() {
    return {
      transfers: Array.from({ length: 5 }, () => ({ available: false, read: 0, write: 0, epoch: 0, scope: '' })),
      drives: [8, 9].map(device => ({ device, available: false, hardware: false,
        hasMedia: false, mode: 'disconnected', format: '', label: '', dirty: false,
        writeProtected: false, motor: false, led: false, halfTrack: 0, pc: 0 })),
      tape: { hasMedia: false, key: 'STOP', motor: false, recording: false,
        fraction: 0, elapsed: 0, duration: 0, dirty: false, writeProtected: false },
      cartridge: { inserted: false, label: '', mode: 'none', bank: 0,
        freeze: false, reset: false },
      reu: { attached: false, model: '', bytes: 0, bankMask: 0, active: false, activity: 0,
        registers: new Uint8Array(11) },
    };
  }

  inspectStorageInto(out) {
    const m = this.machine;
    if (this._storageMonitoring) this._storageCapture.copyInto(out.transfers);
    else for (const t of out.transfers) { t.available = false; t.read = 0; t.write = 0; t.epoch = 0; t.scope = ''; }
    for (let index = 0; index < 2; index++) {
      const drive = index ? m.drive1541b : m.drive1541;
      const disk = index ? m.currentD64Drive9 : m.currentD64;
      const accelerated = index ? m.drive9Enabled && !drive : !m.truedriveEnabled;
      const d = out.drives[index];
      d.hardware = !!drive; d.available = !!drive || !!accelerated;
      d.hasMedia = !!disk;
      d.mode = accelerated ? 'accelerated' : drive ? 'true-drive' : 'disconnected';
      d.format = disk ? (disk.isG64 ? 'G64' : (disk.kind || 'disk').toUpperCase()) : '';
      d.label = disk?.diskName || '';
      d.dirty = !!disk?.dirty; d.writeProtected = !!disk?.writeProtected;
      d.motor = !!drive?.motorOn; d.led = !!drive?.ledOn;
      d.halfTrack = drive?.currentHalfTrack ?? 0; d.pc = drive?.cpu.pc ?? 0;
    }
    const deck = m.datasette, t = out.tape;
    t.hasMedia = deck.hasMedia; t.key = deck.key; t.motor = deck.motorOn;
    t.recording = deck.recording; t.fraction = deck.positionFraction;
    t.elapsed = deck.elapsedSeconds; t.duration = deck.durationSeconds;
    t.dirty = deck.dirty; t.writeProtected = deck.writeProtected;
    const cart = m.mem.cartridge, c = out.cartridge;
    c.inserted = !!cart; c.label = cart?.label || ''; c.mode = m.mem.cartMode;
    c.bank = m.mem.cartBank; c.freeze = !!cart?.capabilities.freeze;
    c.reset = !!cart?.capabilities.reset;
    const reu = m.reu, r = out.reu;
    r.attached = !!reu; r.model = reu?.model.label || ''; r.bytes = reu?.ram.length ?? 0;
    r.bankMask = reu ? (1 << reu.model.bankBits) - 1 : 0;
    r.active = !!reu?.dmaActive; r.activity = reu?.activityTick ?? 0;
    for (let i = 0; i < 11; i++) r.registers[i] = reu ? reu.ioPeek(0xDF00 + i) : 0;
    return out;
  }

  // Input and timer observations never acknowledge ICR or latch TOD reads.
  createControlInspection() {
    return {
      keyboard: new Uint8Array(8), ports: new Uint8Array(2),
      timerCounts: new Uint16Array(4), timerLatches: new Uint16Array(4),
      timerControl: new Uint8Array(4), interrupts: new Uint8Array(2),
      interruptMasks: new Uint8Array(2), potConnected: false, potX: 255, potY: 255,
    };
  }

  inspectControlsInto(out) {
    const m = this.machine;
    out.keyboard.set(m.cia1.matrix);
    out.ports[0] = m.joyPort1; out.ports[1] = m.joyPort2;
    for (let i = 0; i < 2; i++) {
      const cia = i ? m.cia2 : m.cia1, base = i * 2;
      out.timerCounts[base] = cia.timerA; out.timerCounts[base + 1] = cia.timerB;
      out.timerLatches[base] = cia.latchA; out.timerLatches[base + 1] = cia.latchB;
      out.timerControl[base] = cia.cra; out.timerControl[base + 1] = cia.crb;
      out.interrupts[i] = cia.icrStatus; out.interruptMasks[i] = cia.icrMask;
    }
    out.potConnected = m.potConnected;
    out.potX = m.potXSampled; out.potY = m.potYSampled;
    return out;
  }

  // Inspection buffers belong to the caller and never alias chip storage.
  createInspectionState() {
    return {
      pc: 0, a: 0, x: 0, y: 0, sp: 0, p: 0, instructionBoundary: false,
      instructionAddress: -1, instructionOpcode: -1,
      halted: false, irq: false, cycle: 0, raster: 0, vicBank: 0,
      cpuPort: 0, cpuDDR: 0, sidCount: 1, sid2Address: 0,
      vic: new Uint8Array(64), sid: new Uint8Array(64),
      sidModels: new Uint8Array(2), sidReadback: new Uint8Array(8), sidMix: 'stereo',
      palette: new Uint32Array(16), colorRam: new Uint8Array(1024),
      spritePointers: new Uint8Array(8), spriteBanks: new Uint16Array(8),
      spriteOffsets: new Uint16Array(8), spriteDma: new Uint8Array(8),
      spriteDisplay: new Uint8Array(8),
    };
  }

  inspectInto(out) {
    const m = this.machine, cpu = m.cpu, vic = m.vic2;
    out.pc = cpu.pc; out.a = cpu.a; out.x = cpu.x; out.y = cpu.y;
    out.sp = cpu.sp; out.p = cpu.getP();
    out.instructionBoundary = cpu.atInstructionBoundary();
    out.instructionAddress = cpu.instructionAddress;
    out.instructionOpcode = cpu.instructionAddress >= 0 ? cpu.instructionOpcode : -1;
    out.halted = cpu.halted; out.irq = cpu.irqLine;
    out.cycle = vic.cycleInLine; out.raster = vic.raster; out.vicBank = vic.currentVicBank;
    out.cpuPort = m.mem.peek(1); out.cpuDDR = m.mem.cpuDDR;
    out.vic.set(vic.regs); out.colorRam.set(m.mem.colorRam);
    out.spritePointers.set(vic.spritePointerValue);
    out.spriteBanks.set(vic.spriteDataBank); out.spriteOffsets.set(vic.spriteDataBase);
    out.spriteDma.set(vic.spriteDmaOn); out.spriteDisplay.set(vic.spriteDisplayOn);
    out.palette.set(C64_PALETTE);
    out.sid.fill(0); out.sid.set(m.mem.sid.regs);
    out.sidCount = m.sid2 ? 2 : 1;
    out.sid2Address = m.sid2 ? m.mem.sid2Address : 0;
    out.sidModels[0] = m.sidIs8580 ? 1 : 0; out.sidModels[1] = m.sid2?.is8580 ? 1 : 0;
    out.sidMix = m.sidMix;
    for (let reg = 0; reg < 4; reg++) {
      out.sidReadback[reg] = m.mem.sid.peek(0x19 + reg);
      out.sidReadback[4 + reg] = m.sid2 ? m.sid2.proxy.peek(0x19 + reg) : 0;
    }
    if (m.sid2) out.sid.set(m.sid2.proxy.regs, 32);
    return out;
  }

  // Mirrors CPU reads without acknowledging interrupts or changing bus latches.
  copyCpuMemory(address, target) {
    for (let i = 0; i < target.length; i++) target[i] = this.machine.mem.peekForCpu((address + i) & 0xFFFF);
    return target;
  }

  // Address is local to a 16 KB VIC window. An explicit bank permits inspecting
  // a sprite's latched source after the selected VIC bank has changed.
  copyVicMemory(address, target, bank = this.machine.vic2.currentVicBank) {
    if (!Number.isInteger(bank) || bank < 0 || bank > 0xC000 || (bank & 0x3FFF)) throw new RangeError('VIC bank must be a 16 KB base');
    for (let i = 0; i < target.length; i++) target[i] = this.machine.vic2._vicMemRead((address + i) & 0x3FFF, bank);
    return target;
  }

  cpuMemorySource(address) {
    address &= 0xFFFF;
    if (address < 2) return 'CPU port';
    const mem = this.machine.mem, source = mem._readPageArr[address >>> 8];
    if (source === mem.ram) return 'RAM';
    if (source && source === mem.basic) return 'BASIC ROM';
    if (source && source === mem.kernal) return 'KERNAL ROM';
    if (source && source === mem.charRom) return 'Character ROM';
    if (source === mem._openBus) return 'Open bus';
    if (source === null && address >= 0xD000 && address <= 0xDFFF) return 'I/O';
    return 'Cartridge';
  }

  vicMemorySource(address, bank = this.machine.vic2.currentVicBank) {
    address &= 0x3FFF;
    const mem = this.machine.mem;
    if (mem.cartMode === 'ultimax') return (address >= 0x3000 && mem.cartRomHi) ? 'Cartridge ROM' : 'RAM';
    const physical = bank + address;
    return ((physical >= 0x1000 && physical < 0x2000) || (physical >= 0x9000 && physical < 0xA000)) ? 'Character ROM' : 'RAM';
  }

  // Detailed provenance includes detached output-phase pixel sources and raw
  // rule transitions. Observers exist only during the requested recording.
  requestVicFrameCapture({ analysis = false, provenance = false } = {}) {
    this.cancelVicFrameCapture();
    this._vicCapture = new VicFrameCapture({ analysis: analysis || provenance, provenance });
    this.machine.vic2._frameCapture = this._vicCapture;
  }

  vicFrameCaptureStatus() { return this._vicCapture?.status ?? 'idle'; }

  takeVicFrameCapture() {
    if (this._vicCapture?.status !== 'ready') return null;
    const frame = this._vicCapture.frame;
    this._vicCapture = null;
    return frame;
  }

  cancelVicFrameCapture() {
    if (this.machine.vic2._frameCapture === this._vicCapture) this.machine.vic2._frameCapture = null;
    this._vicCapture?.cancel();
    this._vicCapture = null;
  }

  // ── Savestates ───────────────────────────────────────────────────────────
  serializeState() { return this.machine.serializeState(); }
  restoreState(s)  { this.machine.restoreState(s); }
  // JSON-serializable debug dump of CPU, chips and RAM.
  snapshot()       { return this.machine.snapshot(); }
}

// Console debugging (debug.js). Not part of what the app needs to run; another
// engine may leave parts of it out.
class MachineDebug {
  constructor(machine) { this._m = machine; }

  // VIC model toggles and the per-raster frame trace, by name:
  // 'frameTraceEnabled' | 'nmosBankDelay' | 'c64cBankGlitch' | 'captureDedupVerify'.
  getVicFlag(name)     { return !!this._m.vic2[vicFlag(name)]; }
  setVicFlag(name, on) { this._m.vic2[vicFlag(name)] = !!on; }

  // SID register-write capture: [cycle, reg, val, chip] rows.
  sidTraceStart(n)  { this._m.sidTraceStart(n); }
  sidTraceDump(reg) { return this._m.sidTraceDump(reg); }
  sidTraceBuffer()  { return this._m.sidTraceBuf || []; }

  // Per-master-cycle bus trace.
  get busTraceEnabled() { return !!this._m.busTraceEnabled; }
  get busTraceDepth()   { return this._m.busTraceDepth; }
  enableBusTrace(depth) { this._m.enableBusTrace(depth); }
  disableBusTrace()     { this._m.disableBusTrace(); }
  busTraceSnapshot(n)   { return this._m.busTraceSnapshot(n); }

  // The shared external data bus and the VIC's internal bus latches.
  busLatches() {
    return {
      externalDataBus8: this._m.mem.externalDataBus8 & 0xFF,
      vicInternalBus: this._m.vic2.vicInternalBus & 0xFF,
    };
  }
}

const VIC_FLAGS = new Set(['frameTraceEnabled', 'nmosBankDelay', 'c64cBankGlitch', 'captureDedupVerify']);
function vicFlag(name) {
  if (!VIC_FLAGS.has(name)) throw new Error(`Unknown VIC flag: ${name}`);
  return name;
}
