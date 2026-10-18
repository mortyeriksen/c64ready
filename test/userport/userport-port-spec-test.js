// The user port device host (src/userport.js) against the rules it promises:
// CIA2 port pins as the 6526 datasheet describes them (outputs drive the
// latch, inputs float high, PC low for the cycle after a port B access, FLAG
// sets ICR bit 4 on a falling edge), wired-AND with the device, callbacks only
// on change, timers on the cycle asked for, a throwing device unplugged.

import { C64Machine } from '../../src/machine.js';
import { MachineFacade } from '../../src/machine-facade.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// A machine that can run master cycles safely: RAM full of NOPs, ROMs banked
// out, I/O in.
function makeMachine() {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.write(0x0001, 0x35);
  return m;
}
const cycle = (m, n = 1) => { for (let i = 0; i < n; i++) m._runMasterCycle(); };

function recorder() {
  const log = [];
  let port = null;
  const factory = (p) => {
    port = p;
    return {
      onPortB: (v) => log.push(['pb', v]),
      onPA2: (v) => log.push(['pa2', v]),
      onPC2: () => log.push(['pc2', p.now()]),
      onTimer: (c) => log.push(['timer', c]),
      reset: () => log.push(['reset']),
      detach: () => log.push(['detach']),
    };
  };
  return { log, factory, port: () => port };
}

// ── No device: the port reads as it always has ─────────────────────────────
{
  const m = makeMachine();
  m.cia2.write(0x03, 0x00);
  expect(m.cia2.read(0x01) === 0xFF, `unplugged input pins read $FF, got $${m.cia2.read(0x01).toString(16)}`);
  expect(m.cia2.readPortB === null && m.cia2.writePortB === null, 'no port B hooks while nothing is plugged in');
  ok('nothing plugged in: CIA2 port B inputs float high, no hooks');
}

// ── Wired-AND on port B ─────────────────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.attachUserport('test.rec', r.factory);
  const port = r.port();
  m.cia2.write(0x03, 0x00);                      // all inputs
  port.drivePB(0x11, 0x10);                     // PB0 low, PB4 high
  let v = m.cia2.read(0x01);
  expect((v & 0x01) === 0, 'input pin the device pulls low reads 0');
  expect((v & 0x10) !== 0, 'input pin the device drives high reads 1');
  expect((v & 0xEE) === 0xEE, 'pins the device releases read high (pull-ups)');
  m.cia2.write(0x03, 0x01);                      // PB0 output
  m.cia2.write(0x01, 0x01);
  v = m.cia2.read(0x01);
  expect((v & 0x01) === 1, 'an output pin reads its latch (6526 port read of an output bit)');
  ok('port B: device and pull-ups meet as a wired-AND on input pins');
}

// ── Callbacks fire on change only ──────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.attachUserport('test.rec', r.factory);
  m.cia2.write(0x01, 0x00);                      // latch change, all still inputs: pins unchanged
  expect(!r.log.some(([k]) => k === 'pb'), 'a latch write on input pins changes no pin, so no onPortB');
  m.cia2.write(0x03, 0x06);                      // PB1, PB2 outputs at latch 0
  const pb = r.log.filter(([k]) => k === 'pb');
  expect(pb.length === 1 && pb[0][1] === 0xF9, `PB1/PB2 driven low once: ${JSON.stringify(pb)}`);
  m.cia2.write(0x01, 0x00);
  expect(r.log.filter(([k]) => k === 'pb').length === 1, 'same levels again: no second onPortB');
  ok('onPortB reports the C64-driven levels, and only when they change');
}

// ── PA2 ────────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.cia2.write(0x02, 0x3F);                      // the KERNAL's usual DDRA: PA2 output
  m.cia2.write(0x00, 0x07);
  m.attachUserport('test.rec', r.factory);
  expect(r.port().c64PA2() === 1, 'PA2 output high reads 1');
  m.cia2.write(0x00, 0x03);
  m.cia2.write(0x02, 0x3B);                      // PA2 back to input: pulled up
  const pa = r.log.filter(([k]) => k === 'pa2').map(([, v]) => v);
  expect(pa.join(',') === '0,1', `PA2 went low then floated high: ${pa}`);
  ok('PA2: the device sees the latch when PA2 is an output, high when an input');
}

// ── PC2 ────────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.attachUserport('test.rec', r.factory);
  const port = r.port();
  const t0 = port.now();
  m.cia2.write(0x01, 0x55);                      // a port B write
  cycle(m, 5);
  let pcs = r.log.filter(([k]) => k === 'pc2');
  expect(pcs.length === 1, `one PC2 pulse per access, got ${pcs.length}`);
  expect(pcs[0] && pcs[0][1] === t0 + 2, `PC2 low on the cycle after the access (tick ${t0 + 2}), got ${pcs[0]?.[1]}`);
  r.log.length = 0;
  m.cia2.read(0x01);                             // a port B read strobes too
  cycle(m, 3);
  expect(r.log.filter(([k]) => k === 'pc2').length === 1, 'a port B read strobes PC2');
  r.log.length = 0;
  m.cia2.peek(0x01);                             // the debugger's peek must not
  m.cia2.write(0x03, 0x00);                      // nor a DDRB write
  m.cia2.read(0x00);                             // nor port A
  cycle(m, 3);
  expect(!r.log.some(([k]) => k === 'pc2'), 'peek, DDRB and port A accesses leave PC2 alone');
  ok('PC2 goes low for one cycle following a read or write of port B (6526 datasheet)');
}

// ── FLAG2 ──────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.attachUserport('test.rec', r.factory);
  const port = r.port();
  m.cia2.read(0x0D);                             // clear ICR
  port.setFlag(1);
  cycle(m, 2);
  expect((m.cia2.read(0x0D) & 0x10) === 0, 'FLAG held high sets nothing');
  port.setFlag(0);
  cycle(m, 2);
  expect((m.cia2.read(0x0D) & 0x10) !== 0, 'a falling FLAG edge sets ICR bit 4');
  port.setFlag(1);
  m.cia2.write(0x0D, 0x90);                      // enable the FLAG interrupt
  port.setFlag(0);
  cycle(m, 3);
  expect(m._nmiSources.cia2 === true, 'with FLAG enabled in the mask, CIA2 asserts /NMI');
  ok('FLAG2: a negative edge sets ICR bit 4, an NMI when enabled');
}

// ── Timers ─────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.attachUserport('test.rec', r.factory);
  const port = r.port();
  const at = port.now() + 100;
  port.wakeAt(at);
  cycle(m, 99);
  expect(!r.log.some(([k]) => k === 'timer'), 'no timer before its cycle');
  cycle(m, 1);
  const t = r.log.filter(([k]) => k === 'timer');
  expect(t.length === 1 && t[0][1] === at, `timer on cycle ${at}, got ${JSON.stringify(t)}`);
  port.wakeAt(port.now() + 10);
  port.cancelWake();
  cycle(m, 20);
  expect(r.log.filter(([k]) => k === 'timer').length === 1, 'a cancelled timer does not fire');
  ok('wakeAt fires onTimer on exactly the cycle asked for, cancelWake drops it');
}

// ── Reset and unplug ───────────────────────────────────────────────────────
{
  const m = makeMachine();
  const r = recorder();
  m.attachUserport('test.rec', r.factory);
  m.cia2.write(0x03, 0x01);
  r.log.length = 0;
  m._resetChips();
  expect(r.log.some(([k]) => k === 'reset'), 'C64 /RESET reaches the device');
  expect(r.log.some(([k, v]) => k === 'pb' && v === 0xFF), 'after /RESET all CIA2 pins are inputs and float high');
  r.log.length = 0;
  m.detachUserport();
  expect(r.log.some(([k]) => k === 'detach'), 'unplugging calls detach');
  expect(m.userport === null && m.cia2.readPortB === null, 'unplugged: no host, no hooks');
  ok('/RESET is passed on, unplugging detaches and removes the hooks');
}

// ── A throwing device is unplugged ─────────────────────────────────────────
{
  const m = makeMachine();
  let port = null, seen = null;
  m.attachUserport('test.bad', (p) => {
    port = p;
    return { onPortB() { throw new Error('boom'); } };
  });
  m.userport.onError = (id, err) => { seen = [id, err.message]; };
  port.drivePB(0x01, 0x00);
  m.cia2.write(0x03, 0x02);
  expect(seen && seen[0] === 'test.bad' && seen[1] === 'boom', `onError told which device failed: ${seen}`);
  expect(m.userport.device === null, 'the failing device is unplugged');
  m.cia2.write(0x03, 0x00);
  expect(m.cia2.read(0x01) === 0xFF, 'its pins are released');
  ok('an exception in a device unplugs it and the C64 runs on');
}

// ── Save states ────────────────────────────────────────────────────────────
{
  const make = (id) => (p) => {
    let n = 0;
    return { onPortB() { n++; }, serialize: () => ({ n }), deserialize: (s) => { n = s.n; }, get n() { return n; } };
  };
  const a = makeMachine();
  const devA = a.attachUserport('test.state', make('a'));
  a.cia2.write(0x03, 0x01);
  a.cia2.write(0x03, 0x00);
  const snap = a.serializeState();
  const b = makeMachine();
  const devB = b.attachUserport('test.state', make('b'));
  b.restoreState(snap);
  expect(devB.n === devA.n && devA.n === 2, `device state restored (${devA.n} → ${devB.n})`);
  expect(b.userportRestoreMismatch === null, 'same device: no mismatch noted');
  const c = makeMachine();
  c.attachUserport('test.other', make('c'));
  c.restoreState(snap);
  expect(c.userportRestoreMismatch === 'test.state', 'another device plugged in: the snapshot device is noted');
  ok('save states carry the device state to the same device, and note a different one');
}

// ── A restore the device was not part of still shows it the lines ──────────
{
  const a = makeMachine();
  a.cia2.write(0x03, 0x06);                      // PB1, PB2 outputs, latch 0: both low
  const snap = a.serializeState();               // nothing on the port
  const b = makeMachine();
  const seen = [];
  b.attachUserport('test.lines', () => ({ onPortB: (v) => seen.push(v) }));
  b.restoreState(snap);
  expect(seen.length === 1 && seen[0] === 0xF9, `the device hears the restored lines: ${seen.map((v) => v.toString(16))}`);
  ok('after a restore without its state, the device is told the C64 lines');
}

// ── API 2: the serial pins (SP1 5, CNT1 4, SP2 7, CNT2 6) ──────────────────
{
  const m = makeMachine();
  let port = null;
  m.attachUserport('test.serial', (p) => { port = p; return {}; });
  expect(port.apiVersion === 2, `API version 2: ${port.apiVersion}`);
  expect(port.c64Serial() === 0x0F, 'both CIAs in input mode leave all four lines high');
  for (const bit of [0, 1, 1, 0, 1, 0, 0, 1]) {
    port.driveSerial(0x0C, bit ? 0x04 : 0x00);   // SP2 = bit, CNT2 low
    cycle(m);
    port.driveSerial(0x0C, (bit ? 0x04 : 0x00) | 0x08);   // CNT2 rises
    cycle(m);
  }
  expect(m.cia2.read(0x0C) === 0x69, `8 bits on SP2 clocked by CNT2 fill CIA2's SDR: $${m.cia2.read(0x0C).toString(16)}`);
  expect((m.cia2.read(0x0D) & 0x08) !== 0, 'and set ICR bit 3');
  ok('API 2: a device clocks bits into CIA2 through SP2 and CNT2');
}

{
  const m = makeMachine();
  const heard = [];
  m.attachUserport('test.serial', () => ({ onSerial: (v) => heard.push(v) }));
  m.cia1.write(0x04, 3); m.cia1.write(0x05, 0);
  m.cia1.write(0x0E, 0x51);                      // CIA1 output mode, Timer A running
  m.cia1.write(0x0C, 0x00);
  cycle(m, 120);
  const sp1Lows = heard.filter((v) => !(v & 0x01)).length;
  expect(heard.length >= 16 && sp1Lows > 0, `the device hears CIA1 send on SP1/CNT1: ${heard.length} changes`);
  expect(heard.every((v) => (v & 0x0C) === 0x0C), 'CIA2 lines stay high');
  ok('API 2: onSerial reports CIA1 sending on SP1 and CNT1');
}

{
  const m = makeMachine();
  const seen = [];
  m.attachUserport('test.pb7', () => ({ onPortB: (v) => seen.push(v & 0x80) }));
  m.cia2.write(0x06, 9); m.cia2.write(0x07, 0);
  m.cia2.write(0x0F, 0x13);                      // Timer B, pulse on PB7
  cycle(m, 40);
  expect(seen[0] === 0 && seen.filter((v) => v).length >= 3, `PB7 drops, then pulses: ${seen.map((v) => v ? 1 : 0).join('')}`);
  ok('API 2: PB7 as a timer output reaches the device through onPortB');
}

{
  const m = makeMachine();
  let port = null;
  m.attachUserport('test.serial', (p) => { port = p; return {}; });
  port.driveSerial(0x0F, 0x00);
  m.detachUserport();
  expect(m.cia1._spLevel === 1 && m.cia1._cntLevel === 1 && m.cia2._spLevel === 1 && m.cia2._cntLevel === 1,
    'unplugging releases SP and CNT on both CIAs');
  ok('API 2: unplugging releases the serial lines');
}

// ── Through the facade, as the UI uses it ───────────────────────────────────
{
  const m = makeMachine();
  const c64 = new MachineFacade(m);
  let reported = null;
  c64.attachUserport('test.facade', () => ({ onPortB() { throw new Error('bad'); } }), '1.0', (id, err) => { reported = [id, err.message]; });
  expect(c64.userportDeviceId === 'test.facade', 'userportDeviceId names the plugged-in device');
  m.cia2.write(0x03, 0x02);
  expect(reported && reported[0] === 'test.facade' && reported[1] === 'bad', 'the error handler given to attachUserport hears a failing device');
  expect(c64.userportDeviceId === null, 'and the failed device is gone');
  c64.attachUserport('test.facade', () => ({}), '1.0', () => {});
  c64.detachUserport();
  expect(c64.userportDeviceId === null && m.userport === null, 'detachUserport unplugs');
  m.userportRestoreMismatch = 'test.other';
  expect(c64.takeUserportRestoreMismatch() === 'test.other' && c64.takeUserportRestoreMismatch() === null, 'the snapshot mismatch is read once');
  ok('the facade: plug, unplug, error handler and snapshot note');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
