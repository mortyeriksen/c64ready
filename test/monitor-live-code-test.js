import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
import { liveCodeSummary } from '../src/monitor/live-code.js';
import { OPCODES } from '../src/monitor/disassembly.js';

const m=new C64Machine(), f=new MachineFacade(m), out=f.createInspectionState();
f.inspectInto(out);
assert.equal(out.instructionAddress,-1,'unstarted CPU has no dispatched instruction');
assert.equal(liveCodeSummary(out).action,'Instruction unavailable','missing identity does not decode RAM at PC');
m.mem.write(0,0x2f);m.mem.write(1,0x34);
m.mem.ram.set([0x8d,0xea,0x30,0xea],0x200);m.cpu.pc=0x200;
m.cpu.clock();m.cpu.clock();
f.inspectInto(out);
assert.equal(out.instructionAddress,0x200,'instruction address remains the opcode start while operands are fetched');
assert.equal(out.instructionOpcode,0x8d,'snapshot preserves dispatched STA rather than the NOP-looking operand');
assert.equal(liveCodeSummary(out).action,'Storing a value','STA is described by its storage semantics');
m.mem.ram[0x200]=0xea;
const before=m.serializeState();f.inspectInto(out);
assert.equal(out.instructionOpcode,0x8d,'self-modified instruction memory cannot replace dispatched identity');
assert.deepEqual(m.serializeState(),before,'instruction inspection leaves every machine state and bus latch unchanged');
while(!m.cpu.atInstructionBoundary())m.cpu.clock();f.inspectInto(out);
assert.equal(liveCodeSummary(out).sample,'Last instruction · sampled','boundary samples label the completed instruction honestly');
assert.equal(liveCodeSummary(out,true).sample,'Paused sample','pause labels the held observation');
m.cpu.I=0;m.cpu._pollI=0;m.cpu.sampledIrq=true;m.cpu.irqLine=true;m.cpu.clock();f.inspectInto(out);
assert.equal(out.instructionAddress,-1,'hardware interrupt entry has no ordinary opcode origin');
assert.equal(liveCodeSummary(out).action,'Instruction unavailable','hardware entry does not reuse the previous instruction');
assert.equal(liveCodeSummary(out).irq,true,'IRQ request reflects the sampled line');

const sample={pc:0x300,instructionAddress:0x200,instructionOpcode:0xa9,p:0,irq:false};
assert.equal(liveCodeSummary(sample).action,'Loading a value','immediate LDA does not claim a memory data read');
sample.instructionOpcode=0xad;
assert.equal(liveCodeSummary(sample).action,'Reading memory','absolute LDA describes a memory read');
sample.p=4;sample.irq=true;
assert.equal(liveCodeSummary(sample).irqAllowed,false,'I bit masks IRQ even when its line is asserted');
sample.p=0;
assert.equal(liveCodeSummary(sample).irqAllowed,true,'clear I bit permits IRQ without claiming handler entry');
sample.halted=true;
assert.equal(liveCodeSummary(sample).action,'CPU stopped','a halted CPU does not imply continuing instruction work');
sample.halted=false;
for(let opcode=0;opcode<256;opcode++) {
  sample.instructionOpcode=opcode;
  assert.equal(typeof liveCodeSummary(sample).action,'string',`NMOS opcode ${OPCODES[opcode].name} has a plain-language description`);
}
for(const invalid of [-1,256,undefined]) {
  sample.instructionOpcode=invalid;
  assert.equal(liveCodeSummary(sample).action,'Instruction unavailable','invalid opcode evidence is never guessed');
}
console.log('ok  - live instruction semantics, dispatch identity, interrupt/reset gaps, IRQ flags and read-only inspection');
