import assert from 'node:assert/strict';
import { prepareOutputRules, OUTPUT_RULES } from '../src/monitor/bauer-output-rules.js';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
import { analyzeBauerFrame, BAUER_RULES } from '../src/monitor/bauer-rules.js';
const n=19656;
function fixture() {
  const regs=new Uint8Array(n*64);for(let t=0;t<n;t++){regs[t*64+0x11]=0x1b;regs[t*64+0x16]=8;}
  return {lines:312,cyclesPerLine:63,width:384,height:272,rasterOffset:15,flags:new Uint8Array(n),eventCount:0,eventTick:[],eventKind:[],eventValue:[],
    analysis:{vicValid:new Uint8Array(n).fill(1),sequencer:{registers:regs,display:new Uint8Array(n)},border:{before:new Uint8Array(n).fill(3),after:new Uint8Array(n).fill(3),latch:new Uint8Array(n).fill(1),lineEndGates:new Uint8Array(n).fill(3),lineEndValid:new Uint8Array(n).fill(1)}},
    provenance:{rules:{version:1,count:0,kind:[],tick:[],a:[],b:[],c:[],d:[],e:[],f:[],g:[]}}};
}
const frame=fixture(),b=frame.analysis.border;
const left=51*63+14,right=51*63+54,topEnd=51*63+62,bottomLeft=251*63+14,bottomEnd=251*63+62;
b.after[left]=0;b.latch[topEnd]=0;
b.before[right]=0;b.after[right]=1;
let checks=prepareOutputRules(frame);
for(const [id,t] of [['border.main.right',right],['border.vertical.top.left',left],['border.main.left',left],['border.vertical.top.line',topEnd],['border.vertical.bottom.left',bottomLeft],['border.vertical.bottom.line',bottomEnd]]) {
  assert.equal(checks.get(id)[t],1,`${id}: recorded gate obeys its specified comparator operation`);
}
b.after[right]=0;checks=prepareOutputRules(frame);
assert.equal(checks.get('border.main.right')[right],2,'Bauer §3.9 rule 1: a missing main-border SET is a mismatch');
assert.equal(checks.get('border.main.right')[right-1],0,'Bauer §3.9: the right comparator does not apply before its X coordinate');
const t=70*63+55;
frame.eventCount=1;frame.eventTick=[t];frame.eventKind=[0x16];frame.eventValue=[0];b.before[70*63+54]=0;b.lineEndGates[70*63+54]=0;
assert.equal(prepareOutputRules(frame).get('border.right-cancel')[t],1,'Bauer §3.14.1: cycle 56 CSEL change preserves the open pre-close gate');
frame.eventTick=[70*63+54];
assert.equal(prepareOutputRules(frame).get('border.right-cancel')[70*63+54],0,'Bauer §3.14.1: a cycle 55 write cannot certify the cycle 56 trick');
const lt=71*63+16;frame.eventTick=[lt];frame.analysis.sequencer.registers[lt*64+0x16]=0;frame.eventValue=[8];
assert.equal(prepareOutputRules(frame).get('border.left-cancel')[lt],1,'Bauer §3.14.1: cycle 17 CSEL change can retain the closed left border');
function event(kind,a,b,c,d=0,e=0,f=0,g=0) {
  const p=frame.provenance.rules;p.count=1;Object.assign(p,{kind:[kind],tick:[20],a:[a],b:[b],c:[c],d:[d],e:[e],f:[f],g:[g]});
  return prepareOutputRules(frame);
}
assert.equal(event(8,1,2,0,3,3).get('collision.sprites')[20],1,'Bauer §3.8.2: two distinct sprite outputs set both collision bits');
assert.equal(event(8,1,1,0,1,0).get('collision.sprites')[20],1,'Bauer §3.8.2: a repeated output cannot collide with itself');
assert.equal(event(8,1,1,0,1,1).get('collision.sprites')[20],2,'Bauer §3.8.2: a self-collision is rejected');
assert.equal(event(9,1,2,0,2).get('collision.graphics')[20],1,'Bauer §3.8.2: foreground and opaque sprite output collide');
assert.equal(event(9,0,2,0,2).get('collision.graphics')[20],2,'Bauer §3.8.2: background cannot create a graphics collision');
assert.equal(event(3,15,5,10).get('irq.acknowledge')[20],1,'Bauer §3.12: ones acknowledge only their matching IRQ sources');
assert.equal(event(3,15,0,0).get('irq.acknowledge')[20],2,'Bauer §3.12: a zero write must not erase pending IRQ sources');
assert.equal(event(4,0x1e,5,0).get('collision.read-clear')[20],1,'Bauer §3.8.2: reading the sprite collision register clears its bits');
assert.equal(event(4,0x1f,5,5).get('collision.read-clear')[20],2,'Bauer §3.8.2: retained post-read collision bits are a mismatch');
assert.equal(event(5,0x1e,1,4,5).get('collision.latch')[20],1,'Bauer §3.8.2: a later collision preserves earlier collision bits');
assert.equal(event(5,0x1f,1,4,4).get('collision.latch')[20],2,'Bauer §3.8.2: a collision must not erase earlier bits');
assert.equal(event(2,1,0,0,0x641e,1,100|(20<<9),8).get('lightpen.edge')[20],1,'Bauer §3.11: a cycle 20 edge latches X/2=30 and raster100, and sets the lightpen IRQ');
assert.equal(event(2,3,0x641e,0,0x641e,1,101|(20<<9),8).get('lightpen.edge')[20],1,'Bauer §3.11: a later falling edge retains the first coordinates');
assert.equal(event(2,1,0x641e,0,0x641e,0,311|(20<<9),0).get('lightpen.edge')[20],1,'VICE addendum: an edge on PAL raster311 does not latch');
assert.equal(event(2,1,0,0,0x641f,1,100|(20<<9),8).get('lightpen.edge')[20],2,'Bauer §3.11: incorrect X coordinates fail the lightpen rule');
assert.equal(event(1,0x800000,0xffffff,(24<<3)|(32<<8),0,0xffff00,(16<<3)|(40<<8),32|(40<<10)).get('sprite.shift')[20],1,'Bauer §3.8.1 rule 6: eight monochrome outputs consume eight source bits');
assert.equal(event(1,0x800000,0xffffff,(24<<3)|(32<<8)|(1<<21),0,0xfffff0,(20<<3)|(40<<8),32|(40<<10)).get('sprite.shift')[20],1,'Bauer §3.8.1 rule 6: eight expanded outputs consume four source bits');
assert.equal(event(1,0x800000,0xffffff,(24<<3)|(32<<8),0x800000,0xffffff,(24<<3)|(40<<8),32|(40<<10)).get('sprite.shift')[20],2,'Bauer §3.8.1 rule 6: an unshifted source cannot pass advancing output');
for(const [bits,expected] of [[0,0],[1,3],[2,7],[3,9]])assert.equal(event(7,bits<<22,(0xffffff<<1)|1,bits?1:0,expected,7,3,9).get('sprite.pixel')[20],1,`Bauer §3.8.1: multicolour code ${bits} selects its specified transparent/colour output`);
assert.equal(event(7,0x800000,0xffffff<<1,1,3,7,3,9).get('sprite.pixel')[20],2,'Bauer §3.8.1: monochrome one must select its own sprite colour');
frame.provenance.rules.overflow=true;
assert.equal(prepareOutputRules(frame).get('sprite.pixel')[20],3,'An overflowing raw transition log cannot certify sprite pixels');
assert.ok(OUTPUT_RULES.every(r=>r.coverage!=='reference'),'Output rules have executable captured-evidence checks');
console.log('ok  - border comparisons and timed cancellations, sprite output, IRQ acknowledge, collision latches and lightpen rules');

const m=new C64Machine();m.mem.write(0,47);m.mem.write(1,53);m.mem.ram.set([0x4c,0,2],512);m.cpu.pc=512;
m.vic2.write(0x15,3);m.vic2.write(0x1c,2);m.vic2.write(0x1d,1);m.vic2.write(0x1b,1);
for(let s=0;s<2;s++){m.vic2.write(s*2,24);m.vic2.write(s*2+1,55);m.mem.ram[0x7f8+s]=128+s;}
m.mem.ram.fill(0xff,0x2000,0x2080);
const facade=new MachineFacade(m);facade.requestVicFrameCapture({provenance:true});
for(let i=0;i<39312;i++) {
  m._runMasterCycle();
  if(m.vic2.raster===100&&m.vic2.cycleInLine===20){m.vic2.setLightpenLevel(1);m.vic2.setLightpenLevel(0);}
  if(m.vic2.raster===100&&m.vic2.cycleInLine===25){m.vic2.read(0x1e);m.vic2.write(0x19,15);}
}
const captured=facade.takeVicFrameCapture(),report=analyzeBauerFrame(captured);
for(const id of ['sprite.shift','sprite.pixel','sprite.priority','collision.sprites','collision.graphics','collision.latch','collision.read-clear','irq.acknowledge','lightpen.edge']) {
  const result=report.summary[BAUER_RULES.findIndex(r=>r.id===id)];
  assert.ok(result.match>0,`${id}: synthetic machine input creates recorded evidence`);
  assert.equal(result.mismatch,0,`${id}: actual capture obeys its independently specified invariant`);
}
console.log('ok  - actual captured sprite shifts, colours, priority, collisions, acknowledgement and lightpen edges');

const early=fixture();early.flags[50*63]=4;
assert.equal(prepareOutputRules(early).get('graphics.display-start')[50*63],2,'Bauer §3.7.1: a fully specified logical display flag must respond to a bad-line condition');
early.analysis.sequencer.displayPhase='render-window';
assert.equal(prepareOutputRules(early).get('graphics.display-start')[50*63],3,'A rendering-stage flag does not certify a missing logical-entry phase');
const malformed=fixture();delete malformed.analysis.border.before;
assert.equal(prepareOutputRules(malformed).get('border.main.left')[left],3,'Missing border transition inputs remain insufficient evidence');
console.log('ok  - renderer-stage boundaries and missing comparator inputs remain explicitly unknown');

const { VicRuleCapture }=await import('../src/vic2-rule-capture.js');
const bounded=new VicRuleCapture();bounded.capture={tick:()=>123};bounded.data.count=bounded.data.capacity;
const last=bounded.data.capacity-1;bounded.data.kind[last]=3;bounded.data.c[last]=7;
bounded.add(3,15,15);bounded.finishIrq(0);
assert.equal(bounded.data.count,bounded.data.capacity,'Raw rule observations stop at their allocated capacity');
assert.equal(bounded.data.overflow,true,'An overflowing rule stream advertises incomplete evidence');
assert.equal(bounded.data.c[last],7,'An overflowing IRQ record cannot overwrite an earlier event');
console.log('ok  - bounded transition recording preserves older evidence on overflow');
