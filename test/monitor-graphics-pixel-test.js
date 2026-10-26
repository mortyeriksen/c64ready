import assert from 'node:assert/strict';
import { decodeGraphicsPixel } from '../src/monitor/graphics-pixel.js';
import { explainPixel } from '../src/monitor/provenance-model.js';

const sample = { d011: 0, d016: 0, matrix: 0xa5, colour: 11, value: 0x1b, offset: 0 };
for (const [d011,d016,colour,expected,rule] of [
  [0,0x10,11,[0x21,0x22,0x23,3],'3.7.3.2'],
  [0x20,0x10,11,[0x21,10,5,11],'3.7.3.4'],
]) {
  for (let pair=0;pair<4;pair++) {
    const p=decodeGraphicsPixel({...sample,d011,d016,colour,offset:pair*2});
    assert.equal(p.code,pair,`Bauer §${rule}: paired pixels decode from bits 7–6 through 1–0`);
    assert.equal(p.selected.register??p.selected.index,expected[pair],`Bauer §${rule}: code ${pair} selects its specified colour source`);
    assert.equal(p.foreground,pair>=2,`Bauer §${rule}: only codes 10 and 11 count as foreground`);
    assert.deepEqual(decodeGraphicsPixel({...sample,d011,d016,colour,offset:pair*2+1}),p,`Bauer §${rule}: both pixels of a pair have the same source`);
  }
}
const mono=decodeGraphicsPixel({...sample,d016:0x10,colour:7,value:0x80});
assert.equal(mono.bitCount,1,'Bauer §3.7.3.2: colour RAM bit 3 clear retains single-width character pixels');
assert.equal(mono.selected.index,7,'Bauer §3.7.3.2: single-colour character retains the low three colour bits');
for(const [value,expected] of [[0,5],[128,10]])assert.equal(decodeGraphicsPixel({...sample,d011:0x20,value}).selected.index,expected,'Bauer §3.7.3.3: clear/set bitmap bits select low/high screen-byte nibbles');
const extended=decodeGraphicsPixel({...sample,d011:0x40,value:0});
assert.equal(extended.character,0x25,'Bauer §3.7.3.5: extended background leaves six character-index bits');
assert.equal(extended.selected.register,0x23,'Bauer §3.7.3.5: top screen-code bits select one of four backgrounds');
for (const [d011,d016,colour,paired,rule] of [[0x40,0x10,7,false,'3.7.3.6'],[0x40,0x10,11,true,'3.7.3.6'],[0x60,0,11,false,'3.7.3.7'],[0x60,0x10,11,true,'3.7.3.8']]) {
  for (let offset=0;offset<8;offset++) {
    const decoded=decodeGraphicsPixel({...sample,d011,d016,colour,offset});
    assert.equal(decoded.selected.index,0,`Bauer §${rule}: invalid graphics output is black`);
    assert.equal(decoded.bitCount,paired?2:1,`Bauer §${rule}: invalid modes retain the specified data width`);
    const code=paired?(sample.value>>(6-(offset&6)))&3:(sample.value>>(7-offset))&1;
    assert.equal(decoded.foreground,paired?code>=2:code===1,`Bauer §${rule}: black pixels retain their foreground classification`);
  }
}

const width=384,height=272,line=51;
function fixture(d011,d016,colour){
  const lineRegs=new Uint8Array(312*64);lineRegs[line*64+0x11]=d011;lineRegs[line*64+0x16]=d016;lineRegs[line*64+0x21]=6;
  return {width,height,lines:312,cyclesPerLine:63,rasterOffset:15,eventCount:0,eventKind:[],eventValue:[],border:new Uint8Array(width*height),owners:new Uint8Array(width*height).fill(255),provenance:{count:1,kind:[15],tick:[line*63+16],address:[0x2000],value:[0x1b],aux:[(0xa5<<6)|(colour<<14)],lineRegs,visibleSprites:new Uint8Array(width*height)}};
}
const frame=fixture(0x20,0x10,11);
assert.equal(explainPixel(frame,36,36).graphics.colourIndex,5,'Captured multicolour bitmap code 10 resolves the screen low nibble without current memory');
assert.match(explainPixel(frame,36,36).text,/renderer source sample/,'Renderer samples retain their distinct evidence label');
frame.eventCount=1;frame.eventKind=[0x21];
assert.equal(explainPixel(frame,32,36).graphics.colourIndex,null,'Changing background register prevents line-end colour from being claimed as exact pixel colour');
assert.equal(explainPixel(frame,36,36).graphics.colourIndex,5,'Background register changes do not invalidate a screen-byte colour');
frame.overflow=true;
assert.equal(explainPixel(frame,36,36).graphics,undefined,'Incomplete register history prevents stable-mode attribution');
frame.overflow=false;frame.eventKind=[0x16];
assert.equal(explainPixel(frame,36,36).graphics,undefined,'Mode or scrolling writes need phase-aware source attribution');
const conflict=fixture(0,0x10,11);Object.assign(conflict.provenance,{count:2,kind:[15,15],tick:[line*63+16,line*63+17],address:[0x2000,0x2000],value:[0x1b,0x1c],aux:[0,0]});
assert.match(explainPixel(conflict,32,36).title,/source changes/,'Conflicting graphics samples reject pixel attribution');
console.log('ok  - Bauer graphics modes and captured pixel evidence limits');

const { C64Machine } = await import('../src/machine.js');
const { MachineFacade } = await import('../src/machine-facade.js');
for (const [d011,d016,expected,mode] of [[0x1b,0x18,4,'multicolour text'],[0x3b,8,10,'bitmap'],[0x3b,0x18,5,'multicolour bitmap'],[0x5b,8,11,'extended-background text']]) {
  const machine=new C64Machine();
  machine.mem.write(0,0x2f);machine.mem.write(1,0x35);
  machine.mem.ram.set([0x4c,0,2],0x200);machine.cpu.pc=0x200;
  machine.mem.ram.fill(0xa5,0x400,0x800);machine.mem.ram.fill(0x1b,0x2000,0x4000);
  for(let i=0;i<1000;i++)machine.mem.write(0xd800+i,11);
  for(const [reg,value] of [[0x11,d011],[0x16,d016],[0x18,0x18],[0x21,6],[0x22,3],[0x23,4]])machine.vic2.write(reg,value);
  const facade=new MachineFacade(machine);facade.requestVicFrameCapture({provenance:true});
  for(let i=0;i<39312;i++)machine._runMasterCycle();
  const captured=facade.takeVicFrameCapture();
  const resolved=explainPixel(captured,36,36);
  assert.equal(resolved.graphics?.colourIndex,expected,`Bauer §3.7.3: real ${mode} capture retains the source bytes required by the pixel rule`);
}
console.log('ok  - real captures resolve all supported graphics modes');
