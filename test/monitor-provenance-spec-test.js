import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { staticBorderCheck, capturedInstructions, capturedRam } from '../src/monitor/provenance-model.js';
import { MachineFacade } from '../src/machine-facade.js';

const a=new C64Machine(),b=new C64Machine();
for(const m of [a,b]){m.mem.write(0,0x2f);m.mem.write(1,0x35);m.mem.ram.set([0xa9,6,0x8d,0x21,0xd0,0x8d,0x00,0xd4,0xee,0x00,0x04,0x4c,0,2],0x200);m.cpu.pc=0x200;}
const facade=new MachineFacade(b),read=b.mem.read,graphics=b.vic2._vicMemRead;
facade.requestVicFrameCapture({provenance:true});
assert.equal(b.mem.read,read,'waiting capture does not replace memory accesses');
for(let i=0;i<39312;i++){a._runMasterCycle();b._runMasterCycle();}
const frame=facade.takeVicFrameCapture();
assert.ok(frame?.provenance,'explicit provenance capture returns detached evidence');
assert.deepEqual(b.serializeState(),a.serializeState(),'provenance capture leaves execution state identical to uncaptured run');
assert.deepEqual(b.vic2.frameBuffer,a.vic2.frameBuffer,'provenance capture leaves final pixels identical');
assert.equal(b.mem.read,read,'completion restores the exact memory reader');
assert.equal(b.vic2._vicMemRead,graphics,'completion restores the exact graphics reader');
const p=frame.provenance;
assert.equal(p.overflow,false,'bounded simple-program capture is complete');
assert.ok(p.kind.subarray(0,p.count).includes(5),'SID register writes are recorded');
assert.ok(p.kind.subarray(0,p.count).includes(8),'instruction dispatches are recorded');
assert.ok(p.kind.subarray(0,p.count).includes(15),'dense capture retains renderer-source samples separately from timed bus fetches');
assert.ok(p.kind.subarray(0,p.count).includes(12),'actual RAM changes are recorded');
assert.equal(staticBorderCheck(frame).mismatches,0,'stable captured border agrees with independent comparator prediction');
assert.ok(capturedInstructions(frame).some(row=>row.opcode===0x8d&&row.bytes[1]===0x21&&row.bytes[2]===0xd0),'instruction operands come from actual historical CPU reads');
assert.deepEqual(capturedRam(frame),b.mem.ram,'historical RAM includes the final captured phi2 write');
const saved=p.ram.slice();b.mem.ram.fill(0);assert.deepEqual(p.ram,saved,'historical RAM does not alias live memory');
facade.requestVicFrameCapture({provenance:true});for(let i=0;i<19656;i++)b._runMasterCycle();facade.cancelVicFrameCapture();
assert.equal(b.mem.read,read,'cancellation restores observers');
facade.requestVicFrameCapture();assert.equal(b.vic2._frameCapture.provenance,null,'ordinary capture has no provenance buffers or observers');facade.cancelVicFrameCapture();
console.log('ok  - opt-in provenance, actual writes, detached memory and captured/uncaptured equivalence');

const device=new C64Machine(),df=new MachineFacade(device);
device.mem.write(0,0x2f);device.mem.write(1,0x35);device.mem.ram.set([0x4c,0,2],0x200);device.cpu.pc=0x200;
device.configureSecondSid({enabled:true,address:0xd420});device.attachReu('1750');
df.requestVicFrameCapture({provenance:true});while(df.vicFrameCaptureStatus()==='waiting')device._runMasterCycle();
assert.ok(device.cpu._captureObserver,'recording activates fixed CPU observer');
const memRead=device.mem.read;
device._sidWrite(0,0x12,0);device._sidWrite(0,0x34,1);
device.mem.ram[0x2000]=0x5a;
const reu=device.reu;
for(const [reg,value] of [[2,0],[3,0x20],[4,0],[5,0],[6,0],[7,1],[8,0],[1,0x90]])reu.ioWrite(0xdf00+reg,value);
while(df.vicFrameCaptureStatus()==='recording')device._runMasterCycle();
const dp=df.takeVicFrameCapture().provenance;
assert.ok(Array.from({length:dp.count},(_,i)=>i).some(i=>dp.kind[i]===5&&dp.aux[i]===1&&dp.value[i]===0x34),'second SID register stream keeps its own chip identity');
assert.ok(Array.from({length:dp.count},(_,i)=>i).some(i=>dp.kind[i]===6&&dp.address[i]===0x2000&&dp.value[i]===0x5a),'REU read records the actual C64 byte without an additional read');
assert.equal(device.mem.read,memRead,'capture never replaces a hot memory method');
assert.equal(device.cpu._captureObserver,null,'completion clears the CPU observer');
assert.equal(device.mem._captureObserver,null,'completion clears the DMA observer');
assert.equal(device.vic2._captureObserver,null,'completion clears the VIC observer');
df.requestVicFrameCapture({provenance:true});while(df.vicFrameCaptureStatus()==='waiting')device._runMasterCycle();device.reset();
assert.equal(device.cpu._captureObserver,null,'reset clears a recording observer');
assert.equal(device.vic2._captureObserver,null,'reset clears the VIC recording observer');
console.log('ok  - dual SID and REU provenance, stable hot methods, completion and reset cleanup');

const irqA=new C64Machine(),irqB=new C64Machine();
for(const m of [irqA,irqB]){
  m.mem.write(0,0x2f);m.mem.write(1,0x35);
  m.mem.ram.set([0x58,0x4c,1,2],0x200);
  m.mem.ram.set([0xee,0,4,0xa9,1,0x8d,0x19,0xd0,0x40],0x300);
  m.mem.ram[0xfffe]=0;m.mem.ram[0xffff]=3;m.cpu.pc=0x200;
  m.vic2.write(0x12,100);m.vic2.write(0x1a,1);
}
const irqFacade=new MachineFacade(irqB);irqFacade.requestVicFrameCapture({provenance:true});
for(let i=0;i<39312;i++){irqA._runMasterCycle();irqB._runMasterCycle();}
const irqFrame=irqFacade.takeVicFrameCapture();
assert.deepEqual(irqB.serializeState(),irqA.serializeState(),'recording interrupt acceptance and RTI does not change IRQ execution');
assert.ok(irqFrame.provenance.kind.subarray(0,irqFrame.provenance.count).includes(9),'raster IRQ acceptance is recorded');
assert.ok(irqFrame.provenance.kind.subarray(0,irqFrame.provenance.count).includes(14),'actual RTI completion is recorded');
console.log('ok  - IRQ/RTI capture preserves interrupt execution');

const spriteMachine=new C64Machine(),spriteFacade=new MachineFacade(spriteMachine);
spriteMachine.mem.write(0,0x2f);spriteMachine.mem.write(1,0x35);
spriteMachine.mem.ram.set([0x4c,0,2],0x200);spriteMachine.cpu.pc=0x200;
spriteMachine.mem.ram[0x7f8]=0x80;spriteMachine.mem.ram[0x2000]=0x80;
spriteMachine.vic2.write(0x18,0x14);spriteMachine.vic2.write(0,24);spriteMachine.vic2.write(1,60);spriteMachine.vic2.write(0x15,1);
spriteFacade.requestVicFrameCapture({provenance:true});for(let i=0;i<39312;i++)spriteMachine._runMasterCycle();
const spriteFrame=spriteFacade.takeVicFrameCapture();
const {explainPixel}=await import('../src/monitor/provenance-model.js');
const spritePixel=explainPixel(spriteFrame,32,46);
assert.equal(spritePixel.address,0x2000,'Bauer 3.8.1: a normal sprite starts on Y+1 and resolves its first fetched byte');
assert.equal(spritePixel.value,0x80,'stable sprite explanation uses the recorded byte rather than current RAM');
console.log('ok  - actual stable sprite pixel resolves its historical source byte');

for(const [name,mutate,complete] of [
  ['keyboard paste',m=>m.bufferKeyboardText('A'),false],
  ['empty keyboard paste',m=>m.bufferKeyboardText(''),true],
  ['PRG injection',m=>m.loadPRG(Uint8Array.of(0,0x20,0x5a)),false],
  ['rejected PRG',m=>m.loadPRG(Uint8Array.of(0)),true],
  ['SYS injection',m=>m.injectSys(512),false],
  ['RUN injection',m=>m.injectRun(),false],
  ['LOAD injection',m=>m.injectLoadAndRun(),false],
  ['serial EOF status',m=>{m._serialDrive={read:()=>({byte:0x41,eoi:true,timeout:false})};m._serialTrap(0xee13);},false],
  ['serial timeout status',m=>{m._serialDrive={read:()=>({byte:0,eoi:false,timeout:true})};m._serialTrap(0xee13);},false],
  ['serial data without status write',m=>{m._serialDrive={read:()=>({byte:0x41,eoi:false,timeout:false})};m._serialTrap(0xee13);},true],
]) {
  const plain=new C64Machine(),recorded=new C64Machine(),cf=new MachineFacade(recorded);
  for(const m of [plain,recorded]){
    m.mem.write(0,0x2f);m.mem.write(1,0x35);
    m.mem.ram.set([0x4c,0,2],0x200);m.cpu.pc=0x200;
    m.cpu.sp=0xfd;m.mem.ram[0x1fe]=0xff;m.mem.ram[0x1ff]=1;
  }
  cf.requestVicFrameCapture({provenance:true});
  while(cf.vicFrameCaptureStatus()==='waiting'){plain._runMasterCycle();recorded._runMasterCycle();}
  mutate(plain);mutate(recorded);
  while(cf.vicFrameCaptureStatus()==='recording'){plain._runMasterCycle();recorded._runMasterCycle();}
  const capture=cf.takeVicFrameCapture();
  assert.equal(capture.provenance.memoryComplete,complete,`${name}: historical RAM completeness accounts for unrecorded host writes`);
  if(complete)assert.deepEqual(capturedRam(capture),recorded.mem.ram,`${name}: complete history still reconstructs RAM`);
  else assert.equal(capturedRam(capture),null,`${name}: historical reconstruction rejects missing writes`);
  assert.deepEqual(recorded.serializeState(),plain.serializeState(),`${name}: capture preserves machine behavior`);
  assert.deepEqual(recorded.vic2.frameBuffer,plain.vic2.frameBuffer,`${name}: capture preserves output pixels`);
}
console.log('ok  - host RAM writes invalidate historical reconstruction without changing execution');
