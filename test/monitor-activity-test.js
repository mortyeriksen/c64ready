import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
import { ACTIVITY_CAPACITY, ACTIVITY_WINDOW_CYCLES } from '../src/monitor-activity-capture.js';
import { sidActivity, recentLoads } from '../src/monitor/activity-model.js';

const m=new C64Machine(),f=new MachineFacade(m),out=f.createMonitorActivityInspection();
f.inspectMonitorActivityInto(out);
assert.equal(m._monitorActivity,null,'Creating or reading history does not opt into recording');
m.configureSecondSid({enabled:true,address:0xd500});
m.mem.sid.write(0,10);m.sid2.proxy.write(0,20);
f.setMonitorActivityMonitoring(true);f.inspectMonitorActivityInto(out);
assert.equal(out.initialSid[32],20,'SID 2 has an independent initial register bank');
const epoch=out.epoch,buffer=out.value;
m.mem.sid.write(0,11);m.sid2.proxy.write(4,0x41);m.vic2.totalCycles+=100;
f.inspectMonitorActivityInto(out);
assert.equal(out.count,2,'Only actual writes after opt-in enter the history');
assert.equal(out.device[1],1,'SID 2 writes retain their chip identity');
assert.equal(out.value,buffer,'Inspection reuses detached typed-array buffers');
let sound=sidActivity(out);
assert.equal(sound.voices[0].pitchChanges,1,'Observed changed frequency bytes explain pitch activity');
assert.equal(sound.voices[3].gateStarts,1,'A zero-to-one gate transition starts the second chip envelope');
assert.equal(sound.voices[0].gateStarts,0,'SID 2 gate changes never affect SID 1 evidence');
out.value[0]=255;
assert.equal(m._monitorActivity.data.value[0],11,'Caller buffers cannot mutate recorded evidence');
// Advance the window without writing. The register baseline must move with expiry.
m.vic2.totalCycles+=ACTIVITY_WINDOW_CYCLES+1;f.inspectMonitorActivityInto(out);
assert.equal(out.count,0,'Writes older than eight emulated seconds expire even during silence');
assert.equal(out.initialSid[0],11,'Expired writes advance the retained register baseline');
assert.equal(sidActivity(out).voices[0].pitch[0],11,'Steady pitch survives event expiry');
for(let i=0;i<ACTIVITY_CAPACITY+4;i++)m.mem.sid.write(0,i&255);
f.inspectMonitorActivityInto(out);
assert.equal(out.count,ACTIVITY_CAPACITY,'Write floods cannot grow the allocated history');
assert.equal(out.truncated,true,'Capacity loss is disclosed explicitly');
f.setMonitorActivityMonitoring(false);
assert.equal(m._monitorActivity,null,'Closing Monitor removes the sparse write observer');
f.inspectMonitorActivityInto(out);assert.equal(out.count,0,'Stopping clears the retained activity');
f.setMonitorActivityMonitoring(true);f.inspectMonitorActivityInto(out);
assert.notEqual(out.epoch,epoch,'Reopening establishes a fresh recording identity');
m.configureSecondSid({enabled:false});assert.equal(m._monitorActivity,null,'Changing SID routing invalidates the old independent-chip history');
f.setMonitorActivityMonitoring(true);const saved=m.serializeState();m.restoreState(saved);
assert.equal(m._monitorActivity,null,'Restoring machine state detaches sparse observation');
f.setMonitorActivityMonitoring(true);m.reset();assert.equal(m._monitorActivity,null,'Reset detaches sparse observation');
console.log('ok  - opt-in sparse history, dual SID, bounded expiry and overflow, detached buffers and lifecycle');

function load(machine,address,bytes,{verify=false,device=8,found=true,secondary=1}={}){
  machine.mem.ram[0xba]=device;machine.mem.ram[0xb9]=secondary;machine.mem.ram[0xb7]=0;
  machine.cpu.a=verify?1:0;machine.cpu.x=0;machine.cpu.y=0x30;
  machine.cpu.sp=0xfd;machine.mem.ram[0x1fe]=0;machine.mem.ram[0x1ff]=2;
  machine._trapLoad({loadFile:()=>found?Uint8Array.of(address&255,address>>>8,...bytes):null});
}
const plain=new C64Machine(),observed=new C64Machine(),facade=new MachineFacade(observed),activity=facade.createMonitorActivityInspection();
for(const machine of [plain,observed]){machine.mem.write(0,47);machine.mem.write(1,53);machine.mem.ram.set([0xa9,0x41,0x8d,4,0xd4,0x4c,0,2],512);machine.cpu.pc=512;}
facade.setMonitorActivityMonitoring(true);
for(const machine of [plain,observed])load(machine,0x2000,[1,2,3]);
facade.inspectMonitorActivityInto(activity);
assert.deepEqual(recentLoads(activity,8).map(l=>[l.address,l.bytes,l.ramBytes]),[[0x2000,3,3]],'A successful LOAD records the exact address and confirmed RAM byte count');
for(const machine of [plain,observed]){load(machine,0x2000,[1],{verify:true});load(machine,0x2000,[1],{found:false});}
facade.inspectMonitorActivityInto(activity);
assert.equal(recentLoads(activity,8).length,1,'VERIFY and failed loads do not invent completed RAM transfers');
for(const machine of [plain,observed])load(machine,0xd020,[2],{device:9});
facade.inspectMonitorActivityInto(activity);
assert.equal(recentLoads(activity,9)[0].ramBytes,0,'I/O destinations are not presented as confirmed RAM');
for(const machine of [plain,observed])load(machine,0x2000,[4,5],{secondary:0});
facade.inspectMonitorActivityInto(activity);
assert.equal(recentLoads(activity,8).at(-1).address,0x3000,'Secondary address zero uses the CPU-supplied LOAD destination');
for(let i=0;i<39312;i++){plain._runMasterCycle();observed._runMasterCycle();if(i%400===0)facade.inspectMonitorActivityInto(activity);}
assert.deepEqual(observed.serializeState(),plain.serializeState(),'Sparse SID/load recording and inspection preserve complete machine execution');
assert.deepEqual(observed.vic2.frameBuffer,plain.vic2.frameBuffer,'Sparse recording preserves rendered output');
facade.setMonitorActivityMonitoring(false);
for(let i=0;i<1000;i++){plain._runMasterCycle();observed._runMasterCycle();}
assert.deepEqual(observed.serializeState(),plain.serializeState(),'Execution stays identical after sparse recording stops');
console.log('ok  - successful LOAD destinations, missing/verify/I/O distinctions and observed/unobserved execution equivalence');

const other=new C64Machine(),otherFacade=new MachineFacade(other);
otherFacade.setMonitorActivityMonitoring(true);other.mem.sid.write(0,99);
otherFacade.inspectMonitorActivityInto(out);
assert.equal(out.value[out.first%out.value.length],99,'A replacement facade cannot reuse another recorder epoch or stale copied entries');
console.log('ok  - recording identities remain distinct across machine replacement');

const short=new C64Machine(),sf=new MachineFacade(short),so=sf.createMonitorActivityInspection();
sf.setMonitorActivityMonitoring(true);short.vic2.totalCycles=10;short.mem.sid.write(1,0x40);short.mem.sid.write(4,1);
short.vic2.totalCycles=11;short.mem.sid.write(1,0);short.mem.sid.write(4,0);short.vic2.totalCycles=100;sf.inspectMonitorActivityInto(so);
const brief=sidActivity(so,1).voices[0];
assert.equal(brief.high[0],0x4000,'Plot ranges retain short frequency changes between plotted endpoints');
assert.equal(brief.low[0],0,'Plot ranges retain the low setting in the same interval');
assert.equal(brief.gate[0],1,'Gate bands retain brief gate-on activity before the interval ends');
assert.equal(brief.pitch[0],0,'The pitch line ends at the final observed setting');
console.log('ok  - brief register changes remain visible in bounded activity plots');
