import assert from 'node:assert/strict';
import { buildFrameStory, spriteIntervals, frameStory } from '../src/monitor/frame-story.js';
import { VicFrameCapture } from '../src/vic2-frame-capture.js';

const frame=new VicFrameCapture({analysis:true}).frame;
frame.owners.fill(255);frame.border.fill(1);
frame.analysis.initial.registers[0x21]=6;
frame.eventCount=4;frame.eventKind.set([0x21,0x21,0x21,0x18]);frame.eventValue.set([0xf6,14,3,0x10]);frame.eventTick.set([10,70*63+20,70*63+26,100*63]);
frame.flags[51*63+14]=12;
frame.spriteDma[60]=3;frame.spriteDma[61]=3;frame.spriteDma[62]=3;frame.spriteDma[64]=1;
frame.pointers[60*8]=0x80;frame.pointers[61*8]=0x80;frame.pointers[62*8]=0x90;frame.pointers[64*8]=0x90;
frame.spriteBanks[60*8]=0x4000;frame.spriteBanks[61*8]=0x4000;frame.spriteBanks[62*8]=0x4000;frame.spriteBanks[64*8]=0x4000;
frame.analysis.bus.fill(1);frame.analysis.bus[60*63]=5;frame.analysis.bus[60*63+1]=13;
frame.border[0]=0;frame.owners[0]=0;
const story=buildFrameStory(frame),colour=story.moments.find(m=>m.id==='colour');
assert.equal(colour.changes.length,2,'VIC colour registers use four bits, ignored upper-bit writes are not colour changes');
assert.deepEqual(colour.changes.map(c=>[c.before,c.after]),[[6,14],[14,3]],'before values follow initial captured registers and ordered writes');
assert.equal(colour.tick,70*63+20,'colour stop retains the CPU write tick without shifting it to a pixel');
assert.match(colour.evidence,/must be checked/,'a register change does not claim visible pixel causality');
assert.equal(story.moments.find(m=>m.id==='sources').precision,'line-end','pointer changes remain line-end evidence');
assert.equal(story.moments.find(m=>m.id==='border').precision,'line','uncovered picture rows do not invent sub-line timing');
assert.match(story.moments.find(m=>m.id==='dma').summary,/1 CPU cycles/,'REU holds are excluded from VIC-attributed CPU stalls');
assert.equal(story.budget.total,312*63,'PAL frame budget has 312 lines of 63 cycles');
assert.equal(story.budget.reu,1,'REU bus hold remains separate in the frame budget');
assert.ok(story.stops.length>4,'the chronological story is not capped at four observations');
assert.ok(story.moments.every(moment=>story.stops.some(stop=>stop.id===moment.id)),'every overview observation has a navigable story stop');
assert.ok(story.stops.every((m,i,all)=>!i||m.tick>=all[i-1].tick),'representative stops follow captured time');
assert.deepEqual(spriteIntervals(frame,0),[
 {start:60,end:61,pointer:0x80,bank:0x4000,address:0x6000,slot:0},
 {start:62,end:62,pointer:0x90,bank:0x4000,address:0x6400,slot:0},
 {start:64,end:64,pointer:0x90,bank:0x4000,address:0x6400,slot:0},
],'pointer or DMA gaps separate source intervals without inferring object identity');
assert.strictEqual(frameStory(frame),frameStory(frame),'a detached frame reuses its derived story');
assert.equal(buildFrameStory(null),null,'no frame has no invented story');
frame.analysis=null;
assert.equal(buildFrameStory(frame).moments.find(m=>m.id==='colour').changes[0].before,null,'missing initial evidence is unknown rather than zero');
frame.overflow=true;
assert.equal(buildFrameStory(frame).incomplete,true,'overflow remains explicit in the frame story');
console.log('ok  - deterministic frame stories, register masks, evidence phases, source intervals and budgets');

const long=new VicFrameCapture({analysis:true}).frame;
long.owners.fill(255);long.border.fill(1);long.spriteDma.fill(1,20,83);
for(let line=20;line<83;line++){const tick=(line+1)*63-1;long.analysis.vicValid[tick]=1;long.analysis.sequencer.mcBase[tick*8]=(1+(line-20)*3)&63;}
const run=buildFrameStory(long).moments.find(m=>m.id==='extended-sprites');
assert.equal(run.intervals[0].end-run.intervals[0].start+1,63,'continuous sprite DMA is described by its recorded line-end span');
assert.equal(run.intervals[0].wraps,2,'six-bit sprite row-base counters wrap twice in the synthetic unaligned run');
assert.match(run.evidence,/not proof/,'extended DMA is not asserted to be a visible object or a proven crunch trigger');
long.spriteDma.fill(0);long.spriteDma.fill(1,20,62);
assert.equal(buildFrameStory(long).moments.some(m=>m.id==='extended-sprites'),false,'a normal 42-line expanded DMA interval is not classified as longer than normal');
console.log('ok  - extended DMA observations retain counter evidence without inferring object identity');

const upper=new VicFrameCapture({analysis:true}).frame;
upper.owners.fill(255);upper.border.fill(1);
for(let slot=0;slot<8;slot++){
 const pixel=5*384+32+slot*24;upper.owners[pixel]=slot;upper.border[pixel]=0;
 upper.spriteDma[20]|=1<<slot;upper.spriteDma[21]|=1<<slot;
 upper.pointers[20*8+slot]=0x80;upper.pointers[21*8+slot]=0x90;
}
const upperStory=buildFrameStory(upper);
assert.equal(upperStory.moments.find(m=>m.id==='sprites').points.length,8,'all eight sprite slots remain discoverable when coverage is entirely above the normal screen');
assert.equal(upperStory.moments.find(m=>m.id==='sprites').line,20,'upper-border coverage retains its actual raster, not a clamped screen row');
assert.equal(upperStory.moments.find(m=>m.id==='sources').points.length,8,'upper-border pointer changes retain all simultaneous slots');
assert.ok(upperStory.stops.every(m=>m.line<51),'upper-border findings stay above the normal display start');
assert.equal(buildFrameStory({...upper,analysis:null}).moments.find(m=>m.id==='sources').points.length,8,'line-end source evidence survives without inventing cycle-accurate inputs');
console.log('ok  - all sprite slots and simultaneous source changes remain visible in upper-border analysis');

const {borderRegions}=await import('../src/monitor/border-regions.js');
const edges=new VicFrameCapture({provenance:true}).frame;
edges.border.fill(1);edges.owners.fill(255);
for(const [x,y,slot] of [[10,5,0],[370,250,1],[10,100,2],[370,100,3]]){
 const i=y*384+x;edges.border[i]=0;edges.owners[i]=slot;edges.provenance.visibleSprites[i]=1;
}
const regions=borderRegions(edges);
assert.deepEqual(regions.map(r=>r.uncovered),[1,1,2,2],'top, bottom, left and right include corner pixels in both adjacent regions');
assert.deepEqual(regions.map(r=>r.slots),[1,2,5,10],'all four edges retain independently recorded visible sprite slots');
assert.deepEqual(regions.map(r=>r.spritePixels),[1,1,2,2],'visible sprite counts use the output mask rather than mere sprite coverage');
assert.equal(buildFrameStory(edges).moments.find(m=>m.id==='border').title,'Sprite output reaches all four borders','the all-border story is derived from visible sprite output at every edge');
edges.provenance=null;
assert.ok(borderRegions(edges).every(r=>r.spritePixels===null),'missing visibility evidence is unknown rather than zero visible sprites');
console.log('ok  - all-border output distinguishes covered area, visible sprites and missing evidence');

const full=new VicFrameCapture({analysis:true}).frame;
full.border.fill(1);full.owners.fill(255);
full.eventCount=5;
full.eventKind.set([0x21,0x21,0x21,0x21,0x21]);
full.eventValue.set([1,2,3,4,5]);
full.eventTick.set([20*63+10,20*63+20,140*63+10,260*63+10,310*63+10]);
for(const line of [20,21,260,261]){full.spriteDma[line]=3;full.pointers[line*8]=line&1?0x90:0x80;full.pointers[line*8+1]=line&1?0x91:0x81;}
const fullStory=buildFrameStory(full);
assert.deepEqual(fullStory.stops.filter(s=>s.kind==='colour').map(s=>s.line),[20,140,260,310],'changed settings remain navigable through the bottom border and vertical blanking');
assert.equal(fullStory.stops.filter(s=>s.kind==='colour'&&s.line===20).length,1,'same-line register writes share a story stop with their individual occurrences');
assert.deepEqual(fullStory.stops.filter(s=>s.kind==='sources').map(s=>s.line),[21,261],'source changes below the normal screen remain navigable');
assert.equal(fullStory.stops.find(s=>s.kind==='sources'&&s.line===261).points.length,2,'simultaneous source changes retain both slots in the later stop');
assert.equal(new Set(fullStory.stops.map(s=>s.id)).size,fullStory.stops.length,'every chronological stop has a unique navigation identity');
assert.ok(fullStory.stops.every((s,i,all)=>!i||s.tick>=all[i-1].tick),'all stops follow capture time including non-picture timing');
const edgeStory=buildFrameStory(edges);
assert.equal(edgeStory.stops.find(s=>s.id==='border:bottom').line,265,'the bottom-border story anchors to recorded output below the normal screen');
assert.equal(edgeStory.stops.filter(s=>s.id.startsWith('border:')).length,4,'each uncovered edge has an explicit navigable story stop');
console.log('ok  - full-frame story navigation includes later writes, sprite sources and every uncovered edge');

full.eventCount=8;
full.eventKind.set([0x16,0x16,0x16,0x16,0x16,0x16,0x16,0x16]);
full.eventValue.set([8,0,8,0,8,0,8,0]);
full.eventTick.set([100*63+10,100*63+50,101*63+12,101*63+50,102*63+10,102*63+50,260*63+10,260*63+50]);
const repeated=buildFrameStory(full).stops.filter(s=>s.kind==='mode');
assert.deepEqual(repeated.map(s=>[s.line,s.endLine]),[[100,102],[260,260]],'only consecutive identical register sequences combine into a story range');
assert.equal(repeated[0].changes.length,8,'grouping repeated lines retains individual write timing for inspection');
assert.equal(repeated[0].writeCount,6,'a repeated range counts only its own setting changes');
console.log('ok  - repeated setting sequences stay compact without losing later occurrences');
