import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MemorySampler, regionHint } from '../src/monitor/memory-sampler.js';
import { previewMask } from '../src/monitor/preview.js';

const ram = new Uint8Array(65536);
ram[0] = 99;
const sampler = new MemorySampler();
sampler.sample(ram);
assert.equal(sampler.changed, 0, 'first observation establishes a baseline, not fabricated writes');
ram[0] = 42; ram[255] = 17; ram[256] = 23; ram[65535] = 7;
assert.equal(sampler.bytes[0], 99, 'observations are independent of later RAM changes');
const original = ram.slice();
sampler.sample(ram);
assert.equal(sampler.changed, 4, 'count includes each changed byte once');
assert.equal(sampler.pages[0], 2, 'page zero contains addresses $0000 through $00FF');
assert.equal(sampler.pages[1], 1, 'address $0100 belongs to page one');
assert.equal(sampler.pages[255], 1, 'address $FFFF belongs to the final page');
assert.deepEqual(ram, original, 'inspection never writes to machine RAM');
sampler.sample(ram);
assert.equal(sampler.changed, 0, 'unchanged RAM clears the current change count');
assert.equal(sampler.pages[0], 0, 'page activity represents only the latest sample');
assert.equal(sampler.observedPages[0], 1, 'previously observed pages remain discoverable after activity stops');
ram[0] = 1; ram[0] = 42;
sampler.sample(ram);
assert.equal(sampler.changed, 0, 'a write restored between samples cannot be reported as an observed change');
ram.fill(0xAA, 0x200, 0x300);
sampler.sample(ram);
assert.equal(sampler.pages[2], 256, 'a fully changed page does not overflow its counter');
sampler.reset(); ram.fill(0);
assert.equal(sampler.observedPages[0], 0, 'a new visit clears earlier observed page changes');
sampler.sample(ram);
assert.equal(sampler.changed, 0, 'new sessions establish a fresh baseline');
assert.match(regionHint(4), /Programs can move/, 'default screen hints do not claim active graphics addresses');
assert.match(regionHint(0xD0), /does not show chip registers/, 'RAM below I/O is distinguished from chip registers');
const source = readFileSync(new URL('../src/monitor/monitor.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /facade\.(machine|mem|vic2|cpu)\b|serializeState\(/, 'Monitor uses facade views without chip access');
assert.doesNotMatch(source.slice(source.indexOf('function sample()'), source.indexOf('function cleanup()')), /snapshot\(/, 'continuous sampling never serializes snapshots');

const mask = new Uint8Array(16384);
ram.fill(0); ram[0] = 0x81; ram[7] = 0x40; ram[8] = 0x80;
previewMask(ram, 0, 'tiles', null, mask);
assert.equal(mask[0], 1, 'high bit is the leftmost pixel');
assert.equal(mask[7], 1, 'low bit is the rightmost pixel');
assert.equal(mask[7 * 64 + 1], 1, 'eighth byte is the bottom tile row');
assert.equal(mask[8], 1, 'ninth byte begins the next tile');
ram.fill(0); ram[0] = 2;
const rom = new Uint8Array(4096); rom[16] = 0x80; rom[2048 + 16] = 0x01;
previewMask(ram, 0, 'upper', rom, mask);
assert.equal(mask[0], 1, 'screen code selects its eight-byte glyph in the first ROM set');
previewMask(ram, 0, 'lower', rom, mask);
assert.equal(mask[7], 1, 'second character set starts 2048 bytes into ROM');
ram.fill(0); ram[62] = 1; ram[63] = 255; ram[64] = 128;
previewMask(ram, 0, 'sprites', null, mask);
assert.equal(mask[20 * 48 + 23], 1, '63rd sprite byte supplies its final eight pixels');
assert.equal(mask[24], 1, 'next sprite starts at the next 64-byte slot');
assert.equal(mask.reduce((sum, bit) => sum + bit, 0), 2, '64th byte of each sprite slot is not image data');

console.log('ok  - read-only sampled RAM, page boundaries, baseline lifecycle and facade boundary');
console.log('ok  - character, screen-code and sprite interpretation');

const { LiveCardHistory } = await import('../src/monitor/live-history.js');
const history = new LiveCardHistory();
const live = {pc:0x1234,sidCount:2,sid:new Uint8Array(64)};
live.sid[0]=0x34;live.sid[1]=0x12;live.sid[4]=1;live.sid[32]=0x78;live.sid[33]=0x56;live.sid[36]=1;
const devices = {drives:[{motor:true,led:false},{motor:false,led:false}],tape:{motor:false,recording:false},cartridge:{inserted:true,mode:'8k'},reu:{attached:true,bytes:131072,activity:0,active:false}};
history.sample(live,devices,'RAM',0,false);
assert.equal(history.frequency[3][0],0x5678,'Live history samples the second SID independently');
assert.equal(history.gates[0],9,'Live history keeps each voice gate separately');
assert.equal(history.storage.rows[3][0],1,'Live history distinguishes mapped cartridge memory from transfer activity');
history.sample(live,devices,'RAM',25,false);
assert.equal(history.count,1,'Live history bounds sampling to display inspection intervals');
history.sample(live,devices,'RAM',1000,true);
assert.equal(history.count,1,'pausing does not append invented activity');
history.sample(live,devices,'KERNAL ROM',2000,false);
assert.equal(history.count,1,'resuming starts a new history window rather than joining across a pause');
assert.equal(history.source[0],1,'Live history distinguishes ROM execution samples');
for(let i=1;i<=100;i++) history.sample(live,devices,'RAM',2000+i*100,false);
assert.equal(history.count,81,'Live histories retain the endpoints of an eight-second window');
assert.equal(history.seconds,8,'Live execution trail spans the actual recorded sample times');
history.sample(live,devices,'RAM',200000,false);
assert.equal(history.count,1,'time away from Live does not create a continuous execution trail');

const { memoryRegions, rolesForPage, byteSummary } = await import('../src/monitor/memory-model.js');
const state = { vic: new Uint8Array(64), vicBank: 0x4000, pc: 0x9000 };
const vicMemory = new Uint8Array(16384);
state.vic[0x18] = 0x24;
state.vic[0x15] = 1;
vicMemory[0xbf8] = 0xc0;
let regions = memoryRegions(state, vicMemory);
assert.equal(regions.find(r => r.kind === 'screen').start, 0x4800, 'D018 screen nibble selects 1 KB units inside the CIA-selected VIC bank');
assert.equal(regions.find(r => r.kind === 'characters').start, 0x5000, 'D018 character selector addresses 2 KB aligned character data');
assert.equal(regions.find(r => r.kind === 'sprite').start, 0x7000, 'sprite pointer selects a 64-byte source within the VIC bank');
assert.equal(regions.find(r => r.kind === 'pointers').start, 0x4bf8, 'sprite pointers occupy the last eight bytes of the configured 1 KB screen block');
assert.equal(rolesForPage(regions, 0x20).length, 0, 'unreferenced RAM is not classified as graphics or code from its byte patterns');
assert.equal(rolesForPage(regions, 0x4c).some(r => r.kind === 'screen'), false, 'screen role stops at the 1000-cell display matrix');
state.vic[0x11] = 0x20; state.vic[0x18] = 0x28;
regions = memoryRegions(state, vicMemory);
assert.equal(regions.find(r => r.kind === 'bitmap').start, 0x6000, 'D018 bit 3 selects the bitmap half of the VIC bank');
assert.equal(regions.some(r => r.kind === 'characters'), false, 'bitmap configuration does not identify an active character set');
assert.deepEqual(byteSummary(new Uint8Array([0, 0, 7, 255])), { nonzero: 2, distinct: 3 }, 'byte summary reports values without inventing program meaning');
console.log('ok  - configured memory roles, sprite pointers and honest unknown-byte summaries');

const interval = new MemorySampler(), intervalRam = new Uint8Array(65536), intervalPages = new Uint16Array(256);
interval.sample(intervalRam);
assert.equal(interval.consumeInterval(intervalPages),0,'a baseline reports no observed changes');
intervalRam[0xff]=1; intervalRam[0x100]=2; intervalRam[0xffff]=3;
interval.sample(intervalRam);
intervalRam[0xff]=4; interval.sample(intervalRam);
assert.equal(interval.consumeInterval(intervalPages),3,'display intervals count distinct observed-changing addresses, not repeated changes');
assert.equal(intervalPages[0],1,'the last address of a page belongs to that page');
assert.equal(intervalPages[1],1,'the first address of a page belongs to the new page');
assert.equal(intervalPages[255],1,'the final address is included in interval observations');
assert.equal(interval.consumeInterval(intervalPages),0,'consuming an interval clears its observations');
assert.equal(intervalPages.reduce((a,b)=>a+b,0),0,'consuming an empty interval clears the destination counts');
intervalRam.fill(9,0x400,0x500);interval.sample(intervalRam);
interval.consumeInterval(intervalPages);
assert.equal(intervalPages[4],256,'a fully changed interval page retains all 256 addresses');
interval.reset();interval.sample(intervalRam);
assert.equal(interval.consumeInterval(intervalPages),0,'reopening establishes a baseline without carrying earlier activity');

const { videoMode, enabledSpriteCount, soundSummary, controlSummary } = await import('../src/monitor/live-model.js');
const overview={vic:new Uint8Array(64),sidCount:2,sidModels:new Uint8Array([0,1]),sid:new Uint8Array(64)};
overview.vic[0x11]=0x10;
assert.equal(videoMode(overview),'Characters','DEN with BMM/ECM clear selects standard character configuration');
overview.vic[0x11]=0x30;overview.vic[0x16]=0x10;
assert.equal(videoMode(overview),'Bitmap · multicolour','BMM and MCM select multicolour bitmap configuration');
overview.vic[0x11]=0x70;
assert.equal(videoMode(overview),'Invalid graphics mode','ECM with BMM is an invalid graphics mode');
assert.equal(enabledSpriteCount(0x81),2,'D015 bits count enabled hardware slots, not rendered objects');
overview.sid[4]=0x21;overview.sid[36]=0x40;overview.sid[55]=1;overview.sid[56]=0x10;
const sounds=soundSummary(overview);
assert.equal(sounds.title,'6 voices · 6581 + 8580','dual SID summaries preserve the configured model of each chip');
assert.equal(sounds.waves,'1 saw voice · 1 pulse voice','waveform families include selections from both SIDs');
assert.equal(sounds.filter,'Voice filter routed on 1 SID','voice routing requires both a selected input and a filter mode');
const controls={keyboard:new Uint8Array(8).fill(255),ports:new Uint8Array([255,255]),timerControl:new Uint8Array([1,0,9,0])};
assert.equal(controlSummary(controls).timers,2,'CIA START bits indicate started timers without estimating their event rate');
controls.ports[1]=0xef;
assert.equal(controlSummary(controls).title,'Port 2 input active','active-low port bits report signals without inferring a controller type');
controls.keyboard[0]=0x7e;
assert.equal(controlSummary(controls).keys,2,'active-low matrix bits count held keys');
assert.equal(controlSummary(null).title,'Input readings unavailable','missing observations are not presented as idle hardware');
console.log('ok  - Live interval observations, graphics modes, dual SID and active-low control summaries');

for(const rate of [1,10,25,50]){
 const h=new LiveCardHistory(),interval=1000/rate;
 for(let i=0;i<5;i++)h.sample(live,devices,'RAM',i*interval,false,interval);
 assert.equal(h.count,5,`${rate}/s Live history follows the selected sampling interval`);
 assert.equal(h.storage.count,5,`${rate}/s Storage history shares the Live observation rate`);
 h.sample(live,devices,'RAM',4*interval,false,interval);
 assert.equal(h.count,5,'Rendering the same shared snapshot does not duplicate a history point');
}

for(const rate of [1,10,25,50]){
 const h=new LiveCardHistory(),interval=1000/rate;
 for(let t=0;t<=12000;t+=interval)h.sample(live,devices,'RAM',t,false,interval);
 assert.equal(h.seconds,8,`${rate}/s retains eight seconds of observed time`);
 assert.equal(h.storage.seconds,8,`${rate}/s storage history retains eight seconds too`);
 assert.ok(h.count<=401,'the highest sampling rate remains bounded');
}

const {graphicsMemoryGroups}=await import('../src/monitor/memory-model.js');
{
  const state={vic:new Uint8Array(64),vicBank:0x8000,pc:0};
  const bytes=new Uint8Array(16384);
  state.vic[0x18]=0x18;state.vic[0x11]=32;state.vic[0x15]=3;
  bytes[0x7f8]=0x80;bytes[0x7f9]=0x81;
  const groups=graphicsMemoryGroups(state,bytes);
  assert.equal(groups[0].regions[0].start,0x8400,'Screen marker follows the VIC bank and screen base');
  assert.equal(groups[1].regions[0].start,0xa000,'Bitmap marker follows the selected bitmap half-bank');
  assert.deepEqual(groups[2].regions.map(r=>r.start),[0xa000,0xa040],'Sprite markers follow each enabled slot pointer even inside bitmap data');
  state.vic[0x15]=0;state.vic[0x11]=0;state.vic[0x18]=0x14;
  const textGroups=graphicsMemoryGroups(state,bytes);
  assert.equal(textGroups[1].regions[0].start,0x9000,'Character marker retains the VIC address even where character ROM is mapped');
  assert.equal(textGroups[2].regions.length,0,'No enabled sprites produces no claimed sprite source');
}

const {graphicsSourceLabel}=await import('../src/monitor/live-memory.js');
const routes={vicMemorySource:address=>address>=0x1000&&address<0x2000?'Character ROM':'RAM'};
assert.equal(graphicsSourceLabel(routes,{start:0,size:8000},0),'Mixed VIC sources','A bitmap crossing the character-ROM window is not labelled entirely RAM');
assert.equal(graphicsSourceLabel(routes,{start:0x1000,size:2048},0),'Character ROM','A configured ROM character set names the VIC-visible source');

const {bitmapPatternPixels,invalidGraphicsMode,screenPixels,screenBytePixels}=await import('../src/monitor/setup-model.js');
{
  const state={vic:new Uint8Array(64),palette:new Uint32Array([0,0xffffff]),colorRam:new Uint8Array(1024)};
  const memory=new Uint8Array(16384),out=new Uint8ClampedArray(320*200*4),actual=new Uint8ClampedArray(out.length);
  state.vic[0x18]=0x18;memory[1024]=0xc1;memory[8192+8]=128;memory[8192]=128;
  for(const [control1,control2] of [[64,16],[96,0],[96,16]]) {
    state.vic[0x11]=control1;state.vic[0x16]=control2;
    assert.equal(invalidGraphicsMode(state),true,'ECM combined with bitmap or multicolour selects an invalid graphics mode');
    screenPixels(actual,memory,state);
    assert.equal(actual.every((value,index)=>value===(index%4===3?255:0)),true,'Invalid-mode graphics output remains black independently of the diagnostic preview');
  }
  for(const [control1,control2] of [[0,0],[0,16],[32,0],[32,16],[64,0]]) {
    state.vic[0x11]=control1;state.vic[0x16]=control2;
    assert.equal(invalidGraphicsMode(state),false,'The five valid mode combinations allow reconstructed previews');
  }
}
{
  const state={vic:new Uint8Array(64),palette:new Uint32Array([0x123456,0xabcdef])};
  const memory=new Uint8Array(16384),out=new Uint8ClampedArray(320*200*4);
  state.vic[0x18]=8;state.vic[0x11]=96;memory[8192]=128;memory[8192+8]=64;
  bitmapPatternPixels(out,memory,state);
  assert.deepEqual([...out.slice(0,4)],[0xab,0xcd,0xef,255],'Raw bitmap preview exposes bit 7 at the top-left even when invalid mode blanks the screen');
  assert.deepEqual([...out.slice(4,8)],[0x12,0x34,0x56,255],'Raw bitmap zero uses the monochrome background colour');
  assert.deepEqual([...out.slice(9*4,9*4+4)],[0xab,0xcd,0xef,255],'Bitmap cell data advances horizontally after each eight-byte character cell');
}
{
  const state={vic:new Uint8Array(64),vicBank:0,pc:0},memory=new Uint8Array(16384);
  const {memoryRegions}=await import('../src/monitor/memory-model.js');
  const sources=memoryRegions(state,memory,true).filter(r=>r.kind==='sprite');
  assert.equal(sources.length,8,'Memory inspection retains all configured sprite pointers, independently of enable bits');
  assert.equal(sources.every(r=>!r.enabled),true,'Disabled slots do not claim active sprite output');
  assert.equal(memoryRegions(state,memory).some(r=>r.kind==='sprite'),false,'Live overview still limits its markers to enabled sprites');
}

// Visible ownership selects the pixel even when one slot is reused elsewhere.
const { spritePreviewPixel } = await import('../src/monitor/sprite-preview.js');
const spriteFrame={width:4,height:2,owners:new Uint8Array([0,255,0,0,255,0,255,1]),border:new Uint8Array([0,0,1,0,0,0,0,0])};
const spriteCrop={left:0,top:0,right:3,bottom:1,pixels:3};
assert.deepEqual(spritePreviewPixel(spriteFrame,0,spriteCrop,1,0),{x:3,y:0},'Sprite preview click selects the visible instance nearest the clicked point');
assert.deepEqual(spritePreviewPixel(spriteFrame,0,spriteCrop,.5,1),{x:1,y:1},'Sprite preview padding and transparency resolve to a pixel owned by the chosen slot');
assert.equal(spritePreviewPixel(spriteFrame,0,{pixels:0}),null,'An empty sprite crop cannot invent a source pixel');
console.log('ok  - captured sprite links select visible ownership rather than the first fetch');

spriteFrame.provenance={visibleSprites:new Uint8Array([1,0,0,0,0,1,0,0])};
assert.deepEqual(spritePreviewPixel(spriteFrame,0,spriteCrop,1,0),{x:1,y:1},'Sprite preview navigation excludes coverage hidden behind foreground graphics');

{
  const state={vic:new Uint8Array(64)},memory=new Uint8Array(16384),out=new Uint8ClampedArray(320*200*4);
  state.vic[0x18]=0x20;memory[2048]=255;memory[2049]=0;
  screenBytePixels(out,memory,state);
  assert.deepEqual([...out.slice(0,4)],[255,255,255,255],'Screen-byte map reads the screen base selected by D018');
  assert.deepEqual([...out.slice(8*4,9*4)],[32,32,32,255],'Adjacent screen bytes become adjacent brightness cells');
}
