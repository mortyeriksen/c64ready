import { C64Machine } from '../src/machine.js';
import fs from 'fs';

const machine = new C64Machine();
machine.loadROMs({
  kernal: fs.readFileSync('roms/kernal.bin'),
  basic: fs.readFileSync('roms/basic.bin'),
  charRom: fs.readFileSync('roms/chargen.bin'),
});
machine.reset();

// Disable display/sprites to keep timing clean
machine.vic2.write(0x11, 0x00);
machine.vic2.write(0x15, 0x00);

// Let's run a few frames to stabilize
for (let i = 0; i < 100; i++) {
  machine.runFrame();
}

// Drive to raster 0x50, cycle 55
let safety = 200000;
while (--safety && !(machine.vic2.raster === 0x50 && machine.vic2.cycleInLine === 55)) {
  C64Machine.prototype._runMasterCycle.call(machine);
}

console.log("Tracing $D012 reads starting from L50.cy55:");
for (let step = 0; step < 15; step++) {
  const r = machine.vic2.raster;
  const cy = machine.vic2.cycleInLine;
  const val = machine.mem.read(0xD012);
  const visible = machine.vic2._cpuVisibleRaster();
  const lineEnded = machine.vic2._lineJustEnded;
  console.log(`Step ${step}: live_raster=$${r.toString(16)} cy=${cy} _lineJustEnded=${lineEnded} _cpuVisibleRaster()=$${visible.toString(16)} read(0xD012)=$${val.toString(16)}`);
  C64Machine.prototype._runMasterCycle.call(machine);
}
