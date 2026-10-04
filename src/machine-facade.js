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
  detachReu()         { this.machine.detachReu(); }

  // ── Memory (read-only views) ─────────────────────────────────────────────
  // The 64K of RAM, as the CPU sees it with every ROM banked out.
  ram()     { return this.machine.mem.ram; }
  // Character ROM as loaded, or null before the ROMs are in.
  charRom() { return this.machine.mem.charRom ?? null; }

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
