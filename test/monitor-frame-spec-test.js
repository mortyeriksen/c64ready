import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';

const machine = new C64Machine(), facade = new MachineFacade(machine), vic = machine.vic2;
// A stable synthetic CPU loop and text screen, with no external ROMs.
machine.mem.write(0, 0x2F); machine.mem.write(1, 0x34);
machine.mem.ram.set([0x4C, 0x00, 0x02], 0x200); machine.cpu.pc = 0x200;
const run = n => { for (let i = 0; i < n; i++) machine._runMasterCycle(); };
run(500);
facade.requestVicFrameCapture();
assert.equal(facade.vicFrameCaptureStatus(), 'waiting', 'a mid-frame request waits for a complete frame boundary');
assert.equal(vic.frameTraceEnabled, false, 'capture does not enable console tracing');
while (facade.vicFrameCaptureStatus() === 'waiting') run(1);
assert.equal(vic.raster, 0, 'recording begins at raster zero');
assert.equal(facade.takeVicFrameCapture(), null, 'partial captures are never returned');
// A write on the final phi2 belongs to the outgoing frame.
run(19655);
vic.clock(1);
vic.write(0x20, 3);
vic.phi2();
assert.equal(facade.vicFrameCaptureStatus(), 'ready', 'one full PAL frame completes capture');
assert.equal(vic._frameCapture, null, 'completed capture removes its hooks from the running chip');
const frame = facade.takeVicFrameCapture();
assert.equal(frame.endCycle - frame.startCycle, 312 * 63, 'a PAL capture contains exactly 312 lines of 63 cycles');
assert.equal(frame.eventTick[frame.eventCount - 1], 19655, 'final-cycle writes belong to the captured frame, not the following frame');
assert.equal(frame.eventKind[frame.eventCount - 1], 0x20, 'VIC register write identity is retained');
assert.equal(frame.eventValue[frame.eventCount - 1], 3, 'VIC register write value is retained');
assert.equal(frame.flags[0x33 * 63 + 29] & 4, 4, 'DEN and YSCROLL=3 make raster $33 a bad line');
assert.equal(frame.flags[0x34 * 63 + 29] & 4, 0, 'the following raster is not a standard-text bad line');
assert.equal(frame.flags[100 * 63 + 29] & 3, 0, 'both border gates are open inside the normal display');
assert.equal(frame.flags[29] & 2, 2, 'vertical border remains closed on raster zero');
assert.ok(frame.flags.some(value => value & 8), 'enabled standard text captures screen-memory fetches');
assert.ok(frame.border.some(value => value), 'visible border pixels are captured');
const image = frame.rgba.slice(), flags = frame.flags.slice();
run(19656);
assert.deepEqual(frame.rgba, image, 'replay pixels never alias the running framebuffer');
assert.deepEqual(frame.flags, flags, 'replay timing never aliases live cycle history');
assert.equal(facade.takeVicFrameCapture(), null, 'a completed capture transfers ownership only once');
facade.requestVicFrameCapture(); facade.cancelVicFrameCapture();
assert.equal(vic._frameCapture, null, 'cancel releases pending capture immediately');
vic.frameTraceEnabled = true;
facade.requestVicFrameCapture(); facade.cancelVicFrameCapture();
assert.equal(vic.frameTraceEnabled, true, 'capture cancellation preserves independent console tracing');
vic.frameTraceEnabled = false;
facade.requestVicFrameCapture(); vic.reset();
assert.equal(facade.vicFrameCaptureStatus(), 'cancelled', 'reset invalidates partial capture');
facade.requestVicFrameCapture(); vic.deserialize(vic.serialize());
assert.equal(facade.vicFrameCaptureStatus(), 'cancelled', 'state restore invalidates partial capture');
console.log('ok  - bounded frame capture, complete-frame ownership, final phi2 events and lifecycle');

const reference = new C64Machine(), observed = new C64Machine();
for (const m of [reference, observed]) {
  m.mem.write(0, 0x2F); m.mem.write(1, 0x34);
  m.mem.ram.set([0x4C, 0x00, 0x02], 0x200); m.cpu.pc = 0x200;
}
new MachineFacade(observed).requestVicFrameCapture();
for (let i = 0; i < 39312; i++) { reference._runMasterCycle(); observed._runMasterCycle(); }
assert.deepEqual(observed.serializeState(), reference.serializeState(), 'capturing preserves the synthetic machine state and rendered output');
console.log('ok  - recorded border and bad-line state follows standard text rules, capture preserves execution');

const writer = new C64Machine(), writerFacade = new MachineFacade(writer);
writer.mem.write(0, 0x2F); writer.mem.write(1, 0x37);
writer.mem.ram.set([0xA9, 3, 0x8D, 0x20, 0xD0, 0x4C, 0x00, 0x02], 0x200);
writer.cpu.pc = 0x200;
writerFacade.requestVicFrameCapture();
for (let i = 0; i < 39312; i++) writer._runMasterCycle();
const writes = writerFacade.takeVicFrameCapture();
const store = writes.eventKind.findIndex((kind, index) => index < writes.eventCount && kind === 0x20 && writes.eventCPU[index]);
assert.ok(store >= 0, 'a CPU STA to VIC has a recorded instruction origin');
assert.equal(writes.eventPC[store], 0x0202, 'STA origin is its opcode address, not the following program counter');
assert.equal(writes.eventOpcode[store], 0x8D, 'capture preserves the dispatched STA opcode');
assert.equal(writes.eventValue[store], 3, 'captured write retains the actual bus value');
writer.mem.ram[0x0202] = 0xEA;
assert.equal(writes.eventOpcode[store], 0x8D, 'self-modification after capture cannot change the recorded opcode');
console.log('ok  - captured VIC writes retain the CPU opcode and instruction origin');
