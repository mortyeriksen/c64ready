
import { C64Machine } from '../src/machine.js';
import { CYCLES_PER_LINE } from '../src/vic2.js';

async function run() {
  const machine = new C64Machine();
  const vic = machine.vic2;
  const cpu = machine.cpu;

  // Handler at $9000: INC $0500, RTI
  machine.mem.ram[0x9000] = 0xEE; machine.mem.ram[0x9001] = 0x00; machine.mem.ram[0x9002] = 0x05;
  machine.mem.ram[0x9003] = 0x40;
  machine.mem.ram[0xFFFE] = 0x00; machine.mem.ram[0xFFFF] = 0x90;

  // Main loop: NOP, JMP $0400
  machine.mem.ram[0x0400] = 0xEA;
  machine.mem.ram[0x0401] = 0x4C; machine.mem.ram[0x0402] = 0x00; machine.mem.ram[0x0403] = 0x04;
  cpu.pc = 0x0400;
  cpu.I = 0;

  console.log('--- Measuring CPU cycles available with sprites ---');

  // Baseline: no sprites
  vic.regs[0x15] = 0x00;
  let t0 = vic.totalCycles;
  let cpuT0 = 0; // we don't have cpu.totalCycles, so we'll count instructions or something
  // Actually, we can just run 1000 master cycles and see how many instructions the CPU executed.
  let instructions = 0;
  for (let i = 0; i < 1000; i++) {
    const oldPc = cpu.pc;
    machine._runMasterCycle();
    if (cpu.atInstructionBoundary() && cpu.pc !== oldPc) instructions++;
  }
  console.log(`Baseline (no sprites):Executed ~some instructions in 1000 master cycles`);

  // Let's use a more direct approach: measure cycles stolen.
  // We can hook cpu.clock to count actual CPU cycles.
  let cpuClockCount = 0;
  const origCpuClock = cpu.clock.bind(cpu);
  cpu.clock = () => {
    cpuClockCount++;
    origCpuClock();
  };

  // 1 sprite (sp0)
  vic.regs[0x15] = 0x01;
  vic.spriteDmaOn[0] = 1;
  vic.regs[0x01] = 50; 
  
  // Drive to line 50 cycle 1
  while (!(vic.raster === 50 && vic.cycleInLine === 1)) machine._runMasterCycle();
  
  cpuClockCount = 0;
  let masterCycles = 0;
  while (vic.raster === 50) {
    machine._runMasterCycle();
    masterCycles++;
  }
  console.log(`Line 50 (1 sprite): Master cycles=${masterCycles}, CPU cycles=${cpuClockCount}`);
  console.log(`Stolen cycles = ${masterCycles - cpuClockCount}`);
  // Expected for 1 sprite: 2 cycles stolen (58, 59).
  // If my theory is right, it will be 4 cycles stolen (56, 57, 58, 59).

  // 8 sprites
  vic.regs[0x15] = 0xFF;
  for (let s = 0; s < 8; s++) {
    vic.spriteDmaOn[s] = 1;
    vic.regs[s * 2 + 1] = 60;
  }
  while (!(vic.raster === 60 && vic.cycleInLine === 1)) machine._runMasterCycle();
  cpuClockCount = 0;
  masterCycles = 0;
  while (vic.raster === 60) {
    machine._runMasterCycle();
    masterCycles++;
  }
  console.log(`Line 60 (8 sprites): Master cycles=${masterCycles}, CPU cycles=${cpuClockCount}`);
  console.log(`Stolen cycles = ${masterCycles - cpuClockCount}`);
  // Expected for 8 sprites: 16 cycles stolen.
  // If my theory is right, it will be 16 + 16 = 32 cycles stolen.
}

run();
