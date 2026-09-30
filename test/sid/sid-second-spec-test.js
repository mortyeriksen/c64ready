import assert from 'node:assert/strict';
import { C64Machine } from '../../src/machine.js';
import { CartridgeDevice } from '../../src/cartridges/device.js';
import { parseSid, sidToPrg } from '../../src/media/sid.js';
import { createOpenMedia } from '../../src/media/open.js';
import { loadSidIntoContext } from './sid-test-loader.js';

const machine = new C64Machine();
const mem = machine.mem;
mem.write(0, 0x2F); mem.write(1, 0x37);
mem.write(0xD420, 0x12);
assert.equal(mem.sid.regs[0], 0x12, 'disabled SID 2 leaves the primary SID mirrors intact');
for (const address of [0xD420, 0xD500, 0xD7E0, 0xDE00, 0xDF00, 0xDFE0]) {
  machine.configureSecondSid({ enabled: true, address, is8580: false });
  mem.write(address, 0x34);
  assert.equal(machine.sid2.proxy.regs[0], 0x34, 'selected 32-byte window writes SID 2');
  assert.equal(mem.sid.regs[0], 0x12, 'SID 2 writes cannot reach SID 1');
  mem.write(address + 31, 0x56);
  assert.equal(mem.read(address + 1), 0x56, 'SID 2 write-only reads use its own bus latch');
  assert.equal(mem.read(0xD401), 0x12, 'SID 1 bus latch is independent');
  assert.equal(mem.read(address + 25), 255, 'unconnected SID 2 POTX reads high');
  assert.equal(mem.read(address + 26), 255, 'unconnected SID 2 POTY reads high');
  mem.write(1, 0x34);
  mem.write(address, 0x77);
  assert.equal(machine.sid2.proxy.regs[0], 0x34, 'banked-out I/O writes RAM instead of SID 2');
  assert.equal(mem.read(address), 0x77, 'banked-out I/O reads underlying RAM');
  mem.write(1, 0x37);
}
for (const address of [0xD400, 0xD410, 0xD421, 0xD800, 0xDC00, 0xE000, NaN]) {
  assert.throws(() => machine.configureSecondSid({ enabled: true, address }), /address/, 'invalid SID 2 windows are refused');
}
machine.configureSecondSid({ enabled: false });
machine.attachReu();
assert.throws(() => machine.configureSecondSid({ enabled: true, address: 0xDF00 }), /conflicts/, 'REU reserves $DF00');
assert.throws(() => machine.configureSecondSid({ enabled: true, address: 0xDFE0 }), /conflicts/, 'REU mirrors also reserve the upper DFxx windows');
machine.detachReu();
machine.configureSecondSid({ enabled: true, address: 0xDF00 });
assert.throws(() => machine.attachReu(), /conflicts/, 'REU insertion also checks SID 2 collision');
assert.throws(() => mem.installCartridge(new CartridgeDevice({ id: 'test' })), /conflicts/, 'cartridge insertion checks expansion SID collision');
machine.configureSecondSid({ enabled: false });
mem.installCartridge(new CartridgeDevice({ id: 'test' }));
assert.throws(() => machine.configureSecondSid({ enabled: true, address: 0xDE00 }), /cartridge/, 'SID insertion checks the cartridge slot');
mem.installCartridge(null);
machine.configureSecondSid({ enabled: true, address: 0xD420, is8580: false });
const second = machine.sid2;
mem.write(0xD42E, 0x00); mem.write(0xD42F, 0x10); mem.write(0xD432, 0x20);
const phase = second.voices[2].phase;
for (let i = 0; i < 100; i++) machine._runMasterCycle();
assert.equal(second.voices[2].phase, (phase + 100 * 0x1000) & 0xFFFFFF, 'SID 2 oscillator advances once per master cycle');
assert.equal(mem.read(0xD43B), second.voices[2].readOsc3(), 'SID 2 OSC3 reads its own oscillator');
assert.equal(mem.read(0xD43C), second.voices[2].env3, 'SID 2 ENV3 reads its own envelope');
mem.write(0xD420, 0x71);
const busCycle = second.proxy.busValueCycle;
mem.peek(0xD439);
assert.equal(second.proxy.busValueCycle, busCycle, 'debug peek does not refresh SID 2 bus TTL');
assert.equal(second.proxy.busValue, 0x71, 'debug peek does not load SID 2 bus');
machine.sidCycleCounter = 0xFFFFFFF0;
mem.write(0xD420, 0x71);
machine.sidCycleCounter = 16;
assert.equal(mem.read(0xD421), 0x71, 'SID bus TTL survives uint32 cycle wrap');
machine.sidCycleCounter = (0xFFFFFFF0 + 0x1D00) >>> 0;
assert.equal(mem.read(0xD421), 0, '6581 bus decays at its documented TTL');
const last = (Atomics.load(machine.sidCtrl, 0) - 1) & 131071;
assert.equal(machine.sidRing32[last * 2 + 1] & 32, 32, 'SID 2 ring events carry the second-chip selector');
const saved = machine.serializeState();
const restored = new C64Machine(); restored.restoreState(saved);
assert.equal(restored.sid2.address, 0xD420, 'snapshot restores the second SID mapping');
assert.equal(restored.sid2.is8580, false, 'snapshot restores the independent chip model');
assert.deepEqual(restored.sid2.voices[2].serialize(), second.voices[2].serialize(), 'snapshot restores SID 2 oscillator and envelope state');
assert.equal(restored.sid2.proxy.busValue, second.proxy.busValue, 'snapshot restores SID 2 bus latch');
const oldState = { ...saved }; delete oldState.sid2;
restored.restoreState(oldState);
assert.equal(restored.sid2, null, 'legacy snapshots restore a single-chip machine');
const beforeReset = second.voices[2].phase;
machine.softReset({ allowSoft: true });
assert.equal(second.voices[2].phase, beforeReset, 'soft reset preserves SID 2 oscillator phase');
machine.reset();
assert.equal(second.voices[2].phase, 0x555555, 'power cycle seeds SID 2 oscillator phase');

function header(version, secondAddress, thirdAddress = 0) {
  const bytes = new Uint8Array(0x81);
  bytes.set([80, 83, 73, 68]); bytes[5] = version; bytes[7] = 0x7C;
  bytes[10] = 0x10; bytes[15] = 1; bytes[17] = 1;
  bytes[0x77] = 0x60; bytes[0x7A] = secondAddress; bytes[0x7B] = thirdAddress;
  bytes[0x7D] = 0x10; bytes[0x7E] = 0x60;
  return bytes;
}
assert.equal(parseSid(header(3, 0x42)).secondSidAddress, 0xD420, 'v3 encodes SID 2 at $Dxx0');
assert.equal(parseSid(header(3, 0x42)).secondChip, 1, 'bits 6-7 select SID 2 model');
assert.equal(parseSid(header(2, 0x42)).secondSidAddress, 0, 'v2 reserved bytes do not enable SID 2');
const legacy = header(2, 0x50);
legacy[0x76] = 0x24; legacy[0x77] = 0x24;
assert.equal(parseSid(legacy).secondSidAddress, 0xD500, 'legacy stereo header selects its second address');
assert.equal(parseSid(legacy).secondChip, 2, 'legacy stereo high flags byte selects 8580');
legacy[0x76] = 0x14;
assert.equal(parseSid(legacy).secondChip, 1, 'legacy stereo high flags byte selects 6581');
legacy[0x7A] = 0x43;
assert.equal(parseSid(legacy).secondSidAddress, 0, 'legacy stereo rejects invalid second addresses');
for (const value of [0, 0x40, 0x43, 0x80, 0xDE, 0xFF]) {
  assert.equal(parseSid(header(3, value)).secondSidAddress, 0, 'HVSC invalid address values mean no additional chip');
}
assert.throws(() => sidToPrg(header(4, 0x42, 0x50)), /Three-SID/, 'three-chip tunes are refused before playback');

const { SIDProcessor } = loadSidIntoContext({ sampleRate: 44100 });
const tone = [[24, 15], [0, 0x45], [1, 0x1D], [5, 0], [6, 0xF0], [4, 0x21]];
async function processor(engine, dual, is8580 = true, mix = 'stereo') {
  const p = new SIDProcessor();
  const shared = new SharedArrayBuffer(16 + 131072 * 8);
  p.port.onmessage({ data: { type: 'init', shared, engine, is8580,
    secondSid: { enabled: dual, address: 0xD420, is8580: false, mix } } });
  if (engine === 'wasm') { await p.wasmReady; await p.second?.ready; }
  p._needCycleSync = false; p.currentCycle = 0; p.fadeInRemaining = 0;
  return p;
}
function push(p, chip, cycle, reg, val) {
  const wi = Atomics.load(p.sidCtrl, 0), off = (wi & 131071) * 2;
  p.sidRing32[off] = cycle >>> 0; p.sidRing32[off + 1] = reg | (chip << 5) | (val << 8);
  Atomics.store(p.sidCtrl, 0, wi + 1);
}
for (const engine of ['resid', 'wasm']) {
  const dual = await processor(engine, true);
  const primary = await processor(engine, false);
  const secondary = await processor(engine, false, false);
  const mono = await processor(engine, true, true, 'mono');
  for (const [reg, val] of tone) {
    push(dual, 0, 1000, reg, val); push(primary, 0, 1000, reg, val); push(mono, 0, 1000, reg, val);
  }
  for (const [reg, val] of tone) {
    const val2 = reg === 1 ? 0x35 : val;
    push(dual, 1, 1100, reg, val2); push(secondary, 0, 1100, reg, val2); push(mono, 1, 1100, reg, val2);
  }
  const left = new Float32Array(128), right = new Float32Array(128);
  const one = new Float32Array(128), two = new Float32Array(128), mixed = new Float32Array(128);
  let different = false;
  for (let block = 0; block < 48; block++) {
    dual.process([], [[left, right]]); primary.process([], [[one]]); secondary.process([], [[two]]); mono.process([], [[mixed]]);
    assert.deepEqual(left, one, `${engine}: SID 1 stereo channel matches independent single chip`);
    assert.deepEqual(right, two, `${engine}: SID 2 stereo channel matches independent single chip`);
    for (let i = 0; i < 128; i++) {
      assert.equal(mixed[i], Math.fround((left[i] + right[i]) * 0.5), `${engine}: mono is the equal-gain sum`);
      if (left[i] !== right[i]) different = true;
    }
  }
  assert.ok(different, `${engine}: stereo channels carry independent signals`);
  dual.port.onmessage({ data: { type: 'engine', engine: 'resid' } });
  assert.equal(dual.second.sid.v1.freq, 0x3545, 'engine switching replays SID 2 registers');
  dual.port.onmessage({ data: { type: 'reset', is8580: true } });
  assert.equal(dual.second.regShadow[24], 0, 'soft reset clears SID 2 register shadow');
  assert.equal(dual.second.sid.filter.vol, 0, 'soft reset silences SID 2');
  dual.port.onmessage({ data: { type: 'second', secondSid: { enabled: false } } });
  assert.equal(dual.second, null, 'disabling SID 2 releases its renderer');
}
// A recreated second chip cannot consume queued writes from its predecessor.
for (const engine of ['resid', 'wasm']) {
  const p = await processor(engine, true);
  push(p, 1, 0, 24, 15);
  p.port.onmessage({ data: { type: 'second', secondSid: { enabled: true, address: 0xD500, is8580: false, generation: 1 } } });
  await p.second.ready;
  p._needCycleSync = false;
  p.process([], [[new Float32Array(128), new Float32Array(128)]]);
  assert.equal(p.second.regShadow[24], 0, 'readdressing rejects stale second-chip events');
  p.port.onmessage({ data: { type: 'second', secondSid: { enabled: false } } });
  push(p, 0, p.currentCycle, 24, 7);
  p.process([], [[new Float32Array(128)]]);
  assert.equal(p.regShadow[24], 7, 'primary writes still apply after disabling SID 2');
}
// Binding a snapshot's already-filled ring must retain its register replay.
{
  const p = await processor('resid', false);
  push(p, 0, 1000, 24, 13);
  const shared = p.sidCtrl.buffer;
  p.port.onmessage({ data: { type: 'init', shared, is8580: true, engine: 'resid' } });
  p._needCycleSync = false;
  for (let i = 0; i < 4; i++) p.process([], [[new Float32Array(128)]]);
  assert.equal(p.regShadow[24], 13, 'init preserves register writes already queued on the new ring');
  assert.equal(p.second, null, 'single-chip init allocates no second renderer');
}
{
  const calls = [];
  const open = createOpenMedia({ isRunning: () => true, getAutorunEnabled: () => true,
    configureSid: tune => calls.push(tune?.secondSidAddress ?? 0),
    prg: () => calls.push('loaded'), save: () => true });
  await open({ bytes: header(3, 0x50), name: 'two.sid', mediaType: 'sid', saveToLibrary: false });
  assert.deepEqual(calls, [0xD500, 'loaded'], 'tune hardware is configured before the PRG starts');
  calls.length = 0;
  await open({ bytes: new Uint8Array([0, 16, 0x60]), name: 'one.prg', mediaType: 'prg', saveToLibrary: false });
  assert.deepEqual(calls, [0, 'loaded'], 'ordinary PRG restores configured hardware preferences');
}
{
  const calls = [];
  let accept = false;
  const open = createOpenMedia({
    confirmSid: async tune => { calls.push(tune.secondSidAddress); return accept; },
    isRunning: () => false, powerOn: () => { calls.push('power'); return true; },
    reset: () => { calls.push('reset'); return true; }, getAutorunEnabled: () => true,
    configureSid: () => calls.push('configure'), prg: () => calls.push('play'),
    save: () => { calls.push('save'); return true; },
  });
  const request = { bytes: header(3, 0x50), name: 'dual.sid', mediaType: 'sid', reset: true };
  const cancelled = await open(request);
  assert.deepEqual(calls, [0xD500], 'cancel leaves power, hardware and running program unchanged');
  assert.match(cancelled.message, /cancelled/, 'cancel reports that playback did not start');
  calls.length = 0; accept = true;
  await open(request);
  assert.deepEqual(calls, [0xD500, 'power', 'reset', 'configure', 'play', 'save'], 'confirmation precedes hardware changes and playback');
}
console.log('ok - second SID: mapping, bus, readback, lifecycle, metadata, stereo and mono in both engines');
