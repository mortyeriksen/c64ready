import assert from 'node:assert/strict';
import { VicFrameCapture } from '../src/vic2-frame-capture.js';
import { buildFrameSummary, frameSummary } from '../src/monitor/frame-summary.js';
import { VicPixelCapture } from '../src/vic2-pixel-capture.js';

function capture() {
  const frame=new VicFrameCapture({analysis:true,provenance:true}).frame;
  frame.border.fill(1);frame.owners.fill(255);return frame;
}
function pixel(frame,x,y,slot){const i=y*frame.width+x;frame.border[i]=0;frame.owners[i]=slot;frame.provenance.visibleSprites[i]=1;}
const edges=capture();
for(const [x,y,slot] of [[10,5,0],[370,250,1],[10,100,2],[370,100,3]])pixel(edges,x,y,slot);
const allEdges=buildFrameSummary(edges);
assert.match(allEdges.title,/all four borders/,'all-edge summary requires visible sprite output in every edge');
assert.ok(allEdges.paragraphs.some(p=>p.includes('black side areas')),'black sprite output is explained when recorded on both sides');
assert.ok(!allEdges.paragraphs.some(p=>p.includes('change image sources')),'an all-border picture does not imply sprite source changes');
assert.ok(allEdges.cards.every(c=>c.crops.every(r=>r.x>=0&&r.y>=0&&r.x+r.w<=384&&r.y+r.h<=272)),'picture grabs remain inside the recorded image');
assert.strictEqual(frameSummary(edges),frameSummary(edges),'the same detached frame reuses its summary');
const missing={...edges,provenance:null};
assert.doesNotMatch(buildFrameSummary(missing).title,/all four borders/,'missing visibility evidence cannot establish visible output in every border');
assert.match(buildFrameSummary(missing).paragraphs[0],/evidence is missing/,'missing source evidence is explained rather than replaced with current memory');
assert.equal(buildFrameSummary({...edges,overflow:true}).cards.length,0,'incomplete history suppresses definitive illustration claims');
assert.match(buildFrameSummary({...edges,provenance:{...edges.provenance,overflow:true}}).title,/partial/,'provenance overflow remains explicit');
const upper=capture();
for(let slot=0;slot<8;slot++)pixel(upper,40+slot*24,8,slot);
const top=buildFrameSummary(upper);
assert.match(top.title,/Eight sprite slots share the top border/,'eight visible slots entirely above the normal display qualify for the upper-border summary');
assert.equal(top.cards.length,1,'upper-border coverage alone does not invent ghost graphics or extended DMA');
pixel(upper,50,100,0);
assert.doesNotMatch(buildFrameSummary(upper).title,/Eight sprite slots share the top border/,'visible coverage within the normal screen disqualifies the upper-only claim');
const screen=capture();screen.flags[70*63+14]=8;
assert.match(buildFrameSummary(screen).title,/Screen data feeds/,'recorded screen fetches support a general graphics-pipeline summary');
screen.spriteDma[80]=1;screen.spriteDma[81]=1;screen.pointers[80*8]=1;screen.pointers[81*8]=2;
assert.ok(buildFrameSummary({...screen}).cards.some(c=>c.storyId==='sources'),'source changes remain inspectable without a visible sprite crop');
const before=screen.pointers.slice();buildFrameSummary(screen);
assert.deepEqual(screen.pointers,before,'summary analysis leaves captured source evidence untouched');
assert.equal(buildFrameSummary(null),null,'no capture produces no invented abstract');
console.log('ok  - evidence-qualified summaries, all-border and upper-only output, general graphics, missing evidence and cached captures');

for(const [reg,value,id] of [
  [0x11,0x20,'mode-switch'],[0x16,0x10,'mode-switch'],[0x11,1,'fine-scroll'],[0x16,1,'fine-scroll'],
  [0x11,8,'window'],[0x16,8,'window'],[0x11,0x10,'display-enable'],
  [0x18,0x10,'screen-memory'],[0x18,2,'shape-memory'],[0x1b,1,'priority'],
  [0x17,1,'expansion'],[0x1d,1,'expansion'],[0x1c,1,'sprite-colours'],[0x15,1,'sprite-enable'],
]){
  const f=capture();f.eventCount=1;f.eventKind[0]=reg;f.eventValue[0]=value;f.eventTick[0]=60*63;
  const result=buildFrameSummary(f),card=result.cards.find(c=>c.id===id);
  assert.ok(card,`${id}: the changed control bit produces a supported explanation`);
  assert.ok(result.title!== 'The picture, with limited source evidence',`${id}: supported controls can lead the abstract`);
  assert.ok(card.storyId,`${id}: the explanation links to a recorded story stop`);
  assert.match(card.evidence,/does not prove a visible effect/,`${id}: register evidence does not invent visible results`);
  const same={...f,analysis:{...f.analysis,initial:{...f.analysis.initial,registers:f.analysis.initial.registers.slice()}}};same.analysis.initial.registers[reg]=value;
  assert.ok(!buildFrameSummary(same).cards.some(c=>c.id===id),`${id}: an unchanged value is not a change`);
  assert.ok(!buildFrameSummary({...f,analysis:null}).cards.some(c=>c.id===id),`${id}: a missing previous value cannot establish changed bits`);
}
const ignored=capture();ignored.eventCount=2;ignored.eventKind.set([0x11,0x18]);ignored.eventValue.set([0x80,1]);
assert.equal(buildFrameSummary(ignored).cards.length,0,'raster-target high bit and unused D018 bit do not become graphics-control changes');

function graphics(f,mode,x=64,y=80,colour=8){
  f.provenance.pixels??=new VicPixelCapture().data;
  const p=f.provenance.pixels,i=y*384+x;
  f.border[i]=0;p.source[i]=1;p.sample[i]=1|(colour<<16)|(mode<<20);p.address[i]=0x2000;p.tick[i]=(y+15)*63+18;
  f.rgba[i*4+3]=255;return i;
}
for(let mode=0;mode<8;mode++){
  const f=capture(),i=graphics(f,mode),result=buildFrameSummary(f),card=result.cards.find(c=>c.id===`graphics-${mode}`);
  assert.ok(card,`mode ${mode}: matching output-phase pixels support a graphics explanation`);
  assert.ok(card.point,`mode ${mode}: the explanation retains a selectable evidence pixel`);
  assert.notEqual(result.paragraphs[0],card.text,`mode ${mode}: the abstract and card explain different levels of detail`);
  const bad={...f,rgba:f.rgba.slice()};bad.rgba[i*4]=123;
  assert.ok(!buildFrameSummary(bad).cards.some(c=>c.id===`graphics-${mode}`),`mode ${mode}: mismatching final colour suppresses a verified pixel claim`);
}
const single=capture();graphics(single,1,64,80,0);
assert.ok(buildFrameSummary(single).cards.some(c=>c.id==='graphics-9'&&c.title.includes('fine detail')),'multicolour text with the cell flag clear explains retained single-bit detail');
const mixed=capture();graphics(mixed,0);graphics(mixed,2,160,120);
assert.match(buildFrameSummary(mixed).title,/different graphics rules/,'different verified output modes can lead the summary');
assert.equal(buildFrameSummary(mixed).cards.find(c=>c.id==='mixed-graphics').crops.length,2,'mixed modes have two actual picture contexts');
const detail=capture();graphics(detail,0);const detailIndex=graphics(detail,0,160,90);
detail.provenance.pixels.sample[detailIndex]=0x80|(8<<16);detail.provenance.foreground[detailIndex]=1;
detail.palette[8]=0x224466;detail.rgba.set([34,68,102,255],detailIndex*4);
assert.deepEqual(buildFrameSummary(detail).cards.find(c=>c.id==='graphics-0').point,{x:160,y:90},'a verified coloured foreground pattern is preferred over a blank background sample');
const noForeground={...mixed,provenance:{...mixed.provenance,foreground:undefined}};
assert.ok(!buildFrameSummary(noForeground).cards.some(c=>c.category==='graphics'),'missing foreground evidence cannot certify a pixel mode');
const idle=capture();const idleIndex=graphics(idle,2);idle.provenance.pixels.source[idleIndex]=3;
assert.ok(!buildFrameSummary(idle).cards.some(c=>c.id==='graphics-2'),'idle-source samples do not become ordinary bitmap-memory explanations');

const busy=capture();busy.analysis.bus.fill(1);busy.analysis.bus.fill(5,70*63,70*63+40);
const busCard=buildFrameSummary(busy).cards.find(c=>c.id==='bus-sharing');
assert.match(busCard.evidence,/40 of 19,656 cycles/,'bus-sharing explanation counts recorded VIC stalls');
assert.match(busCard.text,/not a measure of how useful/,'bus cost does not claim useful CPU work');
const longSprite=capture();longSprite.spriteDma.fill(1,100,150);
assert.ok(buildFrameSummary(longSprite).cards.some(c=>c.storyId==='extended-sprites'),'extended fetching is explainable away from the top border');

const varied=capture();
varied.eventCount=6;varied.eventKind.set([0x11,0x18,0x1b,0x17,0x20,0x1c]);varied.eventValue.set([1,0x12,1,1,1,1]);
for(let i=0;i<6;i++)varied.eventTick[i]=(60+i*10)*63;
const variedResult=buildFrameSummary(varied);
assert.ok(variedResult.cards.length>3,'additional supported explanations remain available beyond the first three cards');
assert.equal(new Set(variedResult.cards.slice(0,3).map(c=>c.category)).size,3,'the first page covers three different mechanisms');
assert.deepEqual(buildFrameSummary(varied),variedResult,'the same evidence always produces the same order and prose');
assert.ok(variedResult.cards.every(c=>c.crops.every(r=>r.x>=0&&r.y>=0&&r.x+r.w<=384&&r.y+r.h<=272)),'all additional picture contexts stay within the frame');
const modeVariety=structuredClone(varied);modeVariety.eventCount++;modeVariety.eventKind[6]=0x16;modeVariety.eventValue[6]=0x10;modeVariety.eventTick[6]=130*63;
graphics(modeVariety,0);graphics(modeVariety,2,160,120);
const opening=buildFrameSummary(modeVariety).cards.slice(0,3);
assert.ok(opening.some(c=>c.id==='mixed-graphics'),'verified mixed-mode pixels receive an opening card');
assert.ok(!opening.some(c=>c.id==='mode-switch'),'related mode writes do not crowd out a different opening mechanism');
console.log('ok  - diverse control, pixel-mode and bus explanations, deterministic ranking, unknown evidence and additional findings');
