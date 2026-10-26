import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
import { Drive1541 } from '../src/drive1541.js';
import { createBlankD64 } from '../src/media/d64.js';
import { StorageRates, formatStorageRate } from '../src/monitor/storage-rates.js';

const m = new C64Machine(), f = new MachineFacade(m), out = f.createStorageInspection();
m.setD64(createBlankD64('RATE TEST','01')); m.truedriveEnabled = false;
m.setD64Drive9(createBlankD64('SECOND','02')); m.drive9Enabled = true;
m.mem.setCartridge({ mode:'8k', romLo:new Uint8Array(8192).fill(0xea) });
m.mem.write(0,0x2f); m.mem.write(1,0x37); m.attachReu('1764');
f.newBlankTape();
assert.equal(m.mem._storageRomCounter,null,'normal playback has no cartridge observer');
assert.equal(m.vdrive8._storageCounter,null,'normal playback has no virtual drive observer');
const before=m.serializeState();
f.setStorageMonitoring(true); f.inspectStorageInto(out);
assert.deepEqual(m.serializeState(),before,'enabling byte observation leaves machine state unchanged');
m.mem.read(0x8000); m.mem.read(0x8001); m.mem.read(0x4000);
f.copyCpuMemory(0x8000,new Uint8Array(32)); f.inspectInto(f.createInspectionState());
f.inspectStorageInto(out);
assert.equal(out.transfers[3].read,2,'CRT counts CPU ROM reads, excluding RAM and inspection');
m.mem.write(1,0x34); m.mem.read(0x8000);
f.inspectStorageInto(out);
assert.equal(out.transfers[3].read,2,'banked-out cartridge ROM does not count as a ROM read');
m.mem.dmaRead(0x4000); m.mem.dmaWrite(0x4001,0x5a);
f.inspectStorageInto(out);
assert.equal(out.transfers[4].read,1,'REU read direction counts C64 DMA bus reads');
assert.equal(out.transfers[4].write,1,'REU write direction counts C64 DMA bus writes');
const vd=m.vdrive8;
vd.channels[2]={data:new Uint8Array([1,2]),pos:0};vd.talk(2);vd.read();vd.read();vd.read();
vd.talk(15);vd.read();vd.channels[3]={out:[]};vd.listen(0x63);vd.write(5);vd.unlisten();
f.inspectStorageInto(out);
assert.equal(out.transfers[0].read,2,'virtual channel reads exclude timeout and command status bytes');
assert.equal(out.transfers[0].write,1,'virtual data channel writes count accepted data bytes');
assert.equal(out.transfers[1].read,0,'drive 9 has an independent stream');
m.mem.ram[0xba]=8;m.mem.ram[0xb7]=0;m.mem.ram[0xb9]=1;m.cpu.a=0;
m._trapLoad({loadFile:()=>new Uint8Array([0,0x20,4,5,6])});
f.inspectStorageInto(out);
assert.equal(out.transfers[0].read,5,'accelerated LOAD counts its three payload bytes once, excluding the address header');

const epoch=out.transfers[0].epoch;
m.setD64(createBlankD64('REPLACE','03'));f.inspectStorageInto(out);
assert.notEqual(out.transfers[0].epoch,epoch,'replacing media establishes a new rate baseline');
assert.equal(out.transfers[0].read,0,'new media excludes the previous disk totals');
const old=vd._storageCounter;
f.setStorageMonitoring(false);
assert.equal(m.mem._storageRomCounter,null,'closing Monitor detaches the CPU observer');
assert.equal(m.mem._storageDmaCounter,null,'closing Monitor detaches the DMA observer');
assert.equal(vd._storageCounter,null,'closing Monitor detaches the drive observer');
assert.equal(m.datasette._storageCounter,null,'closing Monitor detaches the tape observer');
vd.channels[2]={data:new Uint8Array([1]),pos:0};vd.talk(2);vd.read();
assert.equal(old[0],0,'normal playback cannot update the detached counter');
f.inspectStorageInto(out);
assert.equal(out.transfers[0].available,false,'inspection alone does not enable collection');
f.setStorageMonitoring(true);f.inspectStorageInto(out);
assert.ok(out.transfers[0].epoch>epoch,'reopening uses a new epoch without hidden-time traffic');

const drive=new Drive1541(new Uint8Array(16384),m.currentD64);
m.drive1541=drive;m.truedriveEnabled=true;f.inspectStorageInto(out);
for(let i=0;i<16;i++)drive._shiftIn(0);
f.inspectStorageInto(out);
assert.equal(out.transfers[0].read,2,'eight framed GCR bits count as one media byte');
drive.motorOn=true;drive.via2.regs[0x0c]=0xc0;drive.via2.regs[3]=0xff;
drive.currentSpeedZone=0;drive.bitCycleAccum=0;drive._advanceSpindle(32);
f.inspectStorageInto(out);
assert.equal(out.transfers[0].write,1,'one completed eight-bit surface write counts one GCR media byte');

assert.equal(vd._storageCounter,null,'switching drive paths detaches the old observer');
const tape=m.datasette;
tape.tapData=new Uint8Array([1,0,32,0,0,1]);tape.tapVersion=1;tape.pos=0;tape.atEnd=false;tape.cyclesUntilEdge=0;
f.inspectStorageInto(out);
tape._loadNextPulse();tape.secondsAtFraction(.5);
f.inspectStorageInto(out);
assert.equal(out.transfers[2].read,0,'TAP inspection and preload do not count as transport');
tape.pressKey('PLAY');tape.setMotor(true);tape._motorStartupRemaining=0;tape.clock(8);
f.inspectStorageInto(out);
assert.equal(out.transfers[2].read,4,'a transported long TAP pulse consumes four stream bytes');
tape._recBuf=new Uint8Array(32);tape._recLen=0;tape._encCarry=0;tape._emitPulse(32);
f.inspectStorageInto(out);
assert.equal(out.transfers[2].write,1,'a short recorded TAP pulse produces one stream byte');
f.setStorageMonitoring(false);
assert.equal(drive._storageCounter,null,'closing Monitor detaches a replacement hardware drive');

const rates=new StorageRates(), transfers=f.createStorageInspection().transfers;
Object.assign(transfers[0],{available:true,epoch:1,read:9000,scope:'File/channel bytes'});
rates.sample(transfers,0);
assert.equal(rates.values[0].ready,false,'first observation does not turn cumulative totals into a burst');
transfers[0].read+=100;rates.sample(transfers,100);
assert.equal(rates.values[0].read,1000,'100 bytes over 100 ms means 1000 bytes per second');
for(let t=200;t<=1000;t+=100) rates.sample(transfers,t);
assert.equal(rates.values[0].total,100,'one-second window preserves a short between-snapshot transfer');
rates.sample(transfers,1100);
assert.equal(rates.values[0].total,0,'a quiet full window returns to zero');
transfers[0].write=200;rates.sample(transfers,3100);
assert.equal(rates.values[0].write,100,'delayed observations average over elapsed time without a false spike');
transfers[0].epoch=2;transfers[0].read=0;transfers[0].write=0;rates.sample(transfers,3200);
assert.equal(rates.values[0].ready,false,'a new source epoch clears the old rate window');
assert.equal(formatStorageRate(1800),'1.8 kB/s','decimal kB rates use 1000 bytes per kilobyte');
assert.equal(formatStorageRate(50,true),'0.1 kB/s','Storage can consistently display kB/s');

const a=new C64Machine(), b=new C64Machine();
for(const machine of [a,b]) {
  machine.mem.write(0,0x2f);machine.mem.write(1,0x37);
  machine.mem.setCartridge({mode:'8k',romLo:new Uint8Array(8192).fill(0xea)});
  machine.mem.ram.set([0xad,0,0x80,0xee,0,4,0x4c,0,2],0x200);machine.cpu.pc=0x200;
  machine.attachReu('1764');
  for(const [r,v] of [[2,0],[3,0x20],[7,16],[8,0],[1,0x90]])machine.reu.ioWrite(0xdf00+r,v);
}
const bf=new MachineFacade(b);bf.setStorageMonitoring(true);
for(let i=0;i<19656;i++){a._runMasterCycle();b._runMasterCycle();}
assert.deepEqual(b.serializeState(),a.serializeState(),'byte counters preserve CPU, VIC, SID, CIA and REU execution');
bf.setStorageMonitoring(false);
for(let i=0;i<19656;i++){a._runMasterCycle();b._runMasterCycle();}
assert.deepEqual(b.serializeState(),a.serializeState(),'execution remains identical after Monitor collection stops');
console.log('ok  - scoped storage byte counts, detached observers, rate windows and unchanged execution');

for(const hz of [1,10,25,50]){
 const samples=new StorageRates(),counts=new MachineFacade(new C64Machine()).createStorageInspection().transfers;
 Object.assign(counts[0],{available:true,epoch:1,scope:'File/channel bytes'});
 for(let i=0;i<=hz*2;i++){counts[0].read=i*1000/hz;samples.sample(counts,i*1000/hz);}
 assert.ok(Math.abs(samples.values[0].read-1000)<.0001,`${hz}/s retains the complete throughput interval without undercounting`);
 counts[0].read+=1000;samples.sample(counts,2020);
 const held=samples.values[0].read;
 assert.ok(held>1000,'A burst contributes to the measured byte rate');
 for(let i=1;i<=hz+1;i++)samples.sample(counts,2020+i*1000/hz);
 assert.equal(samples.values[0].read,0,`${hz}/s expires a burst after the one-second rate window`);
}
