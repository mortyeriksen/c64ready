import assert from 'node:assert/strict';
import { IecDevices } from '../../src/iec.js';
import { C64Machine } from '../../src/machine.js';
import { readAsset } from '../external-assets.js';

let total = 0;
function test(name, fn) { fn(); total++; console.log(`ok  - ${name}`); }
function busFixture() {
  let controller = 7;
  const bus = new IecDevices(1000000, () => { bus.inputs = (controller & 4) | (controller & bus.outputs & 3); });
  const tick = (n = 1) => { for (let i = 0; i < n; i++) bus.tick(); };
  const set = value => { controller = value; bus.sync(); tick(2); };
  function byte(value, eoi = false) {
    set(controller | 3);
    if (eoi) tick(270);
    assert.equal(bus.inputs & 1, 1, 'IEC ready listener releases DATA before the first bit');
    set(controller & ~2);
    for (let bit = 0; bit < 8; bit++) {
      set((controller & ~3) | ((value >> bit) & 1));
      set(controller | 2);
      set(controller & ~2);
    }
    assert.equal(bus.inputs & 1, 0, 'IEC listener acknowledges the completed byte by pulling DATA low');
  }
  const commands = (...values) => {
    set(0); byte(values[0]); for (const value of values.slice(1)) byte(value);
    set(4); // attention released, CLK held, talker releases DATA below
    set(5);
  };
  return { bus, tick, set, byte, commands };
}
test('additional devices reserve drive addresses and reject collisions', () => {
  const f = busFixture();
  for (const address of [0, 3, 8, 9, 31, 4.5]) assert.throws(() => f.bus.plug(address, 'a', () => ({})), /addresses/);
  f.bus.plug(4, 'a', () => ({}));
  assert.throws(() => f.bus.plug(4, 'b', () => ({})), /already/);
  f.bus.plug(5, 'b', () => ({}));
  assert.equal(f.bus.devices.size, 2);
});
test('open collector outputs combine every additional device', () => {
  const f = busFixture(); let a, b;
  f.bus.plug(4, 'a', p => { a = p; return {}; }); f.bus.plug(5, 'b', p => { b = p; return {}; });
  a.drive(1, 0); b.drive(2, 0);
  assert.equal(f.bus.inputs, 4);
  a.drive(0, 3); assert.equal(f.bus.inputs, 5);
  f.bus.unplug(5); assert.equal(f.bus.inputs, 7);
  b.drive(3, 0); assert.equal(f.bus.inputs, 7, 'a detached handle cannot pull the bus');
});
test('an exception disconnects only the failing device and releases its pins', () => {
  const f = busFixture(); let error;
  f.bus.onError = (address, id) => { error = [address, id]; };
  f.bus.plug(4, 'bad', p => { p.drive(1, 0); return { onLines() { throw new Error('bad'); } }; });
  f.bus.plug(5, 'good', () => ({})); f.tick();
  assert.deepEqual(error, [4, 'bad']); assert.equal(f.bus.devices.size, 1); assert.equal(f.bus.inputs, 7);
});
test('disconnecting a faulty device still delivers the bus state to the following device', () => {
  const f = busFixture(), received = [];
  f.bus.plug(4, 'bad', () => ({ onLines() { throw new Error('bad'); } }));
  f.bus.plug(5, 'good', () => ({ onLines: levels => received.push(levels) }));
  f.tick();
  assert.deepEqual(received, [7], 'a fault cannot suppress another device\'s initial bus notification');
});
test('timers, line levels and independent device state survive snapshots', () => {
  const f = busFixture(); let count = 0, p;
  const factory = port => { p = port; return { onTimer() { count++; }, serialize: () => count, deserialize(s) { count = s; } }; };
  f.bus.plug(4, 'timer', factory); p.wakeAt(100); f.tick(20);
  const saved = f.bus.serialize(); count = 9;
  assert.deepEqual(f.bus.deserialize(saved), []); f.tick(80); assert.equal(count, 1);
  saved.devices.push({ address: 5, id: 'missing' });
  assert.deepEqual(f.bus.deserialize(saved), [{ address: 5, id: 'missing' }]);
});
test('standard serial receives only addressed data, including EOI and binary bytes', () => {
  const f = busFixture(), got = [], other = [];
  f.bus.plug(4, 'a', p => p.createListener({ onByte: (b, channel, eoi) => got.push([b, channel, eoi]) }));
  f.bus.plug(5, 'b', p => p.createListener({ onByte: b => other.push(b) }));
  f.commands(0x24, 0x67);
  f.byte(0); f.byte(255, true);
  assert.deepEqual(got, [[0, 7, false], [255, 7, true]]); assert.deepEqual(other, []);
  f.commands(0x3F);
});
test('multiple LISTEN addresses receive the same stream and TALK to another device preserves listeners', () => {
  const f = busFixture(), a = [], b = [];
  f.bus.plug(4, 'a', p => p.createListener({ onByte: (value, channel) => a.push([value, channel]) }));
  f.bus.plug(5, 'b', p => p.createListener({ onByte: (value, channel) => b.push([value, channel]) }));
  f.commands(0x24, 0x25, 0x74, 0x48);
  f.byte(65);
  assert.deepEqual(a, [[65, 20]]); assert.deepEqual(b, [[65, 20]]);
});
test('IEC works without either drive and remains independent of the user port', () => {
  const m = new C64Machine(); m.reset();
  assert.throws(() => m.attachIecDevice(8, 'bad', () => ({})), /reserved/);
  assert.equal(m.iec, null, 'reserved address rejection leaves the bus configuration alone');
  let port;
  m.attachIecDevice(4, 'test', p => { port = p; return {}; });
  m.attachUserport('other', () => ({}));
  m.cia2.write(2, 0x3F); m.cia2.write(0, 0);
  port.drive(1, 0); for (let i = 0; i < 3; i++) { m._iecClock(); m.iec.tick(); }
  assert.equal(m.cia2.read(0) & 0x80, 0);
  m.detachIecDevice(4); assert.equal(m.cia2.read(0) & 0x80, 0x80);
  assert.equal(m.userport.deviceId, 'other');
});
const kernal = readAsset('kernal'), basic = readAsset('basic'), charRom = readAsset('chargen');
if (!kernal || !basic || !charRom) console.log('ok  - KERNAL PRINT# to IEC #4 # SKIP local C64 ROMs missing');
else test('unmodified KERNAL prints to device 4 on the real IEC lines', () => {
  const m = new C64Machine(); m.loadROMs({ kernal, basic, charRom }); m.reset();
  const got = [];
  m.attachIecDevice(4, 'receiver', p => p.createListener({ onByte: (b, sa, eoi, kind) => { if (kind === 'data') got.push(b); } }));
  for (let i = 0; i < 160; i++) m.runFrame();
  const command = 'OPEN1,4:PRINT#1,"HELLO":CLOSE1\r';
  let typed = 0;
  for (let i = 0; i < 200; i++) { typed += m.bufferKeyboardText(command.slice(typed)); m.runFrame(); }
  assert.equal(Buffer.from(got).toString('ascii'), 'HELLO\r');
});
const driveRom = readAsset('drive1541');
if (kernal && basic && charRom && driveRom) test('IEC device 4 coexists with physical drives 8 and 9', () => {
  const m = new C64Machine(); m.loadROMs({ kernal, basic, charRom }); m.attachDrive(driveRom); m.reset();
  m.attachDrive9(driveRom);
  const got = [];
  m.attachIecDevice(4, 'receiver', p => p.createListener({ onByte: (b, sa, eoi, kind) => { if (kind === 'data') got.push(b); } }));
  for (let i = 0; i < 180; i++) m.runFrame();
  const command = 'OPEN1,4:PRINT#1,"BOTH DRIVES":CLOSE1\r'; let at = 0;
  for (let i = 0; i < 220; i++) { at += m.bufferKeyboardText(command.slice(at)); m.runFrame(); }
  assert.equal(Buffer.from(got).toString('ascii'), 'BOTH DRIVES\r');
  assert(m.drive1541 && m.drive1541b);
  m.detachIecDevice(4);
  assert(m.drive1541 && m.drive1541b, 'disconnecting additional devices leaves both drives attached');
});
else console.log('ok  - additional IEC device with both drives # SKIP C64 or 1541 ROM missing');
console.log(`all ${total} passed`);
