import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
import { InspectionSnapshot } from '../src/monitor/inspection-snapshot.js';

const m=new C64Machine(), facade=new MachineFacade(m);
m.mem.write(0,0x2f);m.mem.write(1,0x37);
m.mem.basic=new Uint8Array(8192).fill(0xa5);m.mem.kernal=new Uint8Array(8192).fill(0xe5);
m.mem.charRom=new Uint8Array(4096).fill(0xc5);m.vic2.charRom=m.mem.charRom;m.mem.write(1,0x34);m.mem.write(1,0x37);
m.mem.ram[0xa000]=0x11;m.mem.ram[0x5000]=0x51;
m.cia1.matrix[0]=0xfe;m.joyPort2=0xef;
m.cia1.timerA=0x1234;m.cia1.latchA=0x4567;m.cia1.cra=1;
m.cia2.timerB=0x9876;m.cia2.crb=9;m.cia1.icrStatus=0x81;m.cia1.icrMask=1;
m.potConnected=true;m.potXSampled=31;m.potYSampled=63;
const before=m.serializeState(), snapshot=new InspectionSnapshot(facade);
assert.equal(snapshot.capture(0),true,'first inspection establishes one shared observation');
assert.deepEqual(m.serializeState(),before,'shared inspection leaves all machine state and interrupt latches unchanged');
assert.equal(snapshot.controls.keyboard[0],0xfe,'keyboard inspection preserves active-low matrix bits');
assert.equal(snapshot.controls.ports[1],0xef,'port inspection preserves the actual active-low fire signal');
assert.equal(snapshot.controls.timerCounts[0],0x1234,'CIA timer count is copied without clocking it');
assert.equal(snapshot.controls.timerLatches[0],0x4567,'CIA reload value is independent of the current count');
assert.equal(snapshot.controls.timerControl[3],9,'CIA2 timer B retains its start and one-shot bits');
assert.equal(snapshot.controls.interrupts[0],0x81,'inspection retains pending interrupt status without acknowledging it');
assert.equal(snapshot.controls.potX,31,'paddle inspection copies the sampled value rather than restarting conversion');
assert.equal(snapshot.bytes[0xa000],0x11,'shared RAM remains underlying RAM');
assert.equal(snapshot.cpuBytes[0xa000],0xa5,'CPU-visible bytes preserve the captured ROM mapping');
assert.equal(snapshot.vicBytes[0x1000],0xc5,'captured VIC bank zero includes character ROM');
assert.equal(snapshot.vicBytes[0x5000],0x51,'captured VIC bank one includes its RAM source');
const refs=[snapshot.state,snapshot.storage,snapshot.controls,snapshot.bytes,snapshot.cpuBytes,snapshot.vicBytes];
m.mem.write(1,0x34);m.mem.ram[0xa000]=0x99;m.cia1.matrix[0]=255;m.cia1.timerA=7;
assert.equal(snapshot.capture(99),false,'inspection requests inside the 100 ms interval reuse the observation');
assert.equal(snapshot.controls.timerCounts[0],0x1234,'held inspection values do not track later machine mutations');
assert.equal(snapshot.cpuMemorySource(0xa000),'BASIC ROM','memory source labels stay with the captured bytes');
const bytes=new Uint8Array(2);snapshot.copyCpuMemory(0xa000,bytes);
assert.equal(bytes[0],0xa5,'navigation reads the existing snapshot without accessing hardware');
assert.equal(snapshot.capture(100),true,'the next 100 ms interval collects a new observation');
assert.equal(snapshot.cpuMemorySource(0xa000),'RAM','source labels refresh together with their bytes');
assert.equal(snapshot.cpuBytes[0xa000],0x99,'CPU bytes refresh together with the captured register state');
assert.equal(snapshot.controls.timerCounts[0],7,'control values refresh in the same observation');
assert.ok(refs.every((ref,i)=>ref===[snapshot.state,snapshot.storage,snapshot.controls,snapshot.bytes,snapshot.cpuBytes,snapshot.vicBytes][i]),'inspection buffers are reused between observations');
assert.equal(snapshot.capture(9500),true,'a delayed callback collects one current observation');
assert.equal(snapshot.capture(9500),false,'delayed callbacks never create a catch-up burst');
assert.equal(snapshot.revision,3,'one revision identifies each complete shared observation');
const originalByte=m.mem.ram[0];
snapshot.controls.keyboard[0]=0;snapshot.bytes[0]=originalByte^255;
assert.equal(m.cia1.matrix[0],255,'snapshot keyboard storage does not alias hardware');
assert.equal(m.mem.ram[0],originalByte,'snapshot RAM does not alias hardware');

// Compare execution with and without repeated inspection at arbitrary cycles.
const a=new C64Machine(),b=new C64Machine();
for(const machine of [a,b]) {
  machine.mem.write(0,0x2f);machine.mem.write(1,0x35);
  machine.mem.ram.set([0xee,0,4,0x4c,0,2],0x200);machine.cpu.pc=0x200;
  machine.configureSecondSid({enabled:true,address:0xd420});machine.attachReu('1750');
  machine.mem.ram[0x2000]=0x5a;
  for(const [reg,value] of [[2,0],[3,0x20],[4,0],[5,0],[6,0],[7,0],[8,1],[1,0x90]])machine.reu.ioWrite(0xdf00+reg,value);
}
const during=new InspectionSnapshot(new MachineFacade(b));
for(let i=0;i<19656;i++) {
  a._runMasterCycle();b._runMasterCycle();
  if(i%997===0) {
    const cycles=b.vic2.totalCycles, dma=b.reu.dmaActive;
    during.capture(i*1000);
    assert.equal(b.vic2.totalCycles,cycles,'inspection does not execute extra master cycles');
    assert.equal(b.reu.dmaActive,dma,'inspection does not drain an REU transfer');
  }
}
assert.deepEqual(b.serializeState(),a.serializeState(),'joined sampling preserves execution with dual SID and REU DMA');
console.log('ok  - 100 ms shared observations, detached reusable buffers, banking and side-effect-free controls');
console.log('ok  - sampled and unsampled execution remain identical, including dual SID and active REU transfers');

for (const rate of [1,10,25,50]) {
  const scheduled=new InspectionSnapshot(facade,rate), interval=1000/rate;
  assert.equal(scheduled.capture(0),true,`${rate}/s starts with one shared sample`);
  assert.equal(scheduled.capture(interval-.01),false,`${rate}/s does not capture before its deadline`);
  assert.equal(scheduled.capture(interval),true,`${rate}/s captures at the requested interval`);
  assert.equal(scheduled.capture(interval*100),true,`${rate}/s takes one sample after a delayed callback`);
  assert.equal(scheduled.capture(interval*100),false,`${rate}/s never replays a backlog of missed samples`);
}
const adjustable=new InspectionSnapshot(facade),sharedBuffer=adjustable.bytes;
adjustable.capture(0);adjustable.setRate(50);adjustable.capture(5);
assert.equal(adjustable.capture(24),false,'Changing rate establishes a fresh deadline without a catch-up burst');
assert.equal(adjustable.capture(25),true,'The faster rate takes effect on the same snapshot instance');
assert.equal(adjustable.bytes,sharedBuffer,'Rate changes preserve shared snapshot buffers');
assert.throws(()=>adjustable.setRate(0),RangeError,'Unsupported rates cannot disable or spin the scheduler');
console.log('ok  - selectable 1/10/25/50 Hz scheduling and buffer-preserving rate changes');
