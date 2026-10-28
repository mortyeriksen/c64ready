import assert from 'node:assert/strict';
import { prepareObservationRules } from '../src/monitor/bauer-observation-rules.js';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
const e={version:2,count:1,kind:[],tick:[100],a:[],b:[],c:[],d:[],e:[],f:[],g:[]};
const frame={lines:312,cyclesPerLine:63,provenance:{rules:e}};
function check(id,kind,values,expected=1){e.kind[0]=kind;for(const [i,key] of ['a','b','c','d','e','f','g'].entries())e[key][0]=values[i]??0;assert.equal(prepareObservationRules(frame).get(id)[100],expected,`${id}: ${expected===1?'specified transition is accepted':'incorrect transition is rejected'}`);}
check('register.readback',10,[0x16,0xc8,8]);
check('register.readback',10,[0x16,8,8],2);
check('register.raster-read',10,[0x11,0x9b,0x1b,300]);
check('register.raster-read',10,[0x12,44,255,300]);
check('register.raster-read',10,[0x12,255,255,300],2);
check('register.read-only',11,[0x1e,3,3,255]);
check('register.read-only',11,[0x1e,3,255,255],2);
check('irq.collision-first',5,[0x1f,0,1,1,0,2,0x82]);
check('irq.collision-first',5,[0x1f,1,2,3,0,2,0]);
check('irq.collision-first',5,[0x1f,1,2,3,0,2,0x82],2);
check('irq.raster-edge',12,[10,20,20,0,1,0,1]);
check('irq.raster-edge',12,[10,20,20,0,1,1,1],2);
check('irq.raster-edge',12,[20,20,20,0,1,3,0]);
check('sprite.mc-reload',13,[0,60,60]);
check('sprite.mc-reload',13,[0,60,63],2);
check('sprite.byte-order',16,[0,0x12,0x34,0x56,0x123456]);
check('sprite.byte-order',16,[0,0x12,0x34,0x56,0x563412],2);
check('lightpen.frame-reset',14,[0,1,206,0,8,1]);
check('lightpen.frame-reset',14,[1,0,17,28,8,1]);
check('lightpen.frame-reset',14,[1,1,17,28,8,1],2);
check('bus.fetch-latch',15,[0x5a,0x5a,0x5a]);
check('bus.fetch-latch',15,[0x5a,0x5a,0],2);
check('memory.vic-map',15,[0,0,0,1,0x1000,0x8000]);
check('memory.vic-map',15,[0,0,0,0,0x1000,0x4000]);
check('memory.vic-map',15,[0,0,0,0,0x1000,0x8000],2);
check('memory.colour-bus',18,[3,0xab,0xa3]);
check('memory.colour-bus',18,[3,0xab,3],2);
check('memory.port-underlay',19,[1,0x35,0xab,0xab,0x35]);
check('memory.port-underlay',19,[1,0x35,0xab,0x35,0x35],2);
e.overflow=true;assert.equal(prepareObservationRules(frame).get('memory.port-underlay')[100],3,'Overflow never certifies incomplete bus evidence');e.overflow=false;e.version=1;
assert.equal(prepareObservationRules(frame).get('irq.collision-first')[100],3,'Older captures without IRQ inputs remain unknown');
console.log('ok  - independent register, interrupt, counter, lightpen and memory-bus predicates');

const a=new C64Machine(),b=new C64Machine(),f=new MachineFacade(b);
for(const m of [a,b]){m.mem.write(0,47);m.mem.write(1,53);m.mem.ram.set([0x4c,0,2],512);m.cpu.pc=512;m.vic2.setLightpenLevel(0);}
f.requestVicFrameCapture({provenance:true});
for(let i=0;i<39312;i++){
  for(const m of [a,b]){
    m._runMasterCycle();
    if(m.vic2.raster===100&&m.vic2.cycleInLine===20){
      m.vic2.read(0x16);m.vic2.read(0x12);m.vic2.write(0x1e,255);m.vic2.write(0x12,100);
      m.vic2._applySpriteBgBits(1);m.vic2.write(0x19,2);m.vic2._applySpriteBgBits(2);
      m.mem.read(0xd800);m.mem.write(1,53);
    }
  }
}
assert.deepEqual(b.serializeState(),a.serializeState(),'Additional observation sites preserve every serialized machine value');
assert.deepEqual(b.vic2.frameBuffer,a.vic2.frameBuffer,'Additional observation sites preserve rendered pixels');
const captured=f.takeVicFrameCapture(),rows=prepareObservationRules(captured);
assert.equal(captured.provenance.rules.overflow,false,'Synthetic observation stream fits its fixed capacity');
for(const [id,row] of rows){
  if(id==='sprite.byte-order')continue;
  assert.ok(row.includes(1),`${id}: a real capture supplies applicable observations`);
  assert.equal(row.includes(2),false,`${id}: actual observations meet the independent rule`);
}
console.log('ok  - actual observation wiring, full execution and pixel equivalence');
