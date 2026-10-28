import assert from 'node:assert/strict';
import { capturedScreenUsage } from '../src/monitor/screen-usage.js';

// Kind 11 records actual matrix fetches. Configuration and pointer reads are
// deliberately mixed in to distinguish configured memory from observed use.
const events=[
  [1,0xd018,0x14,0],
  [2,0x47f8,0x80,63],
  [11,0x4000,0x41,50*63],
  [11,0x4001,0x42,50*63+1],
  [11,0x4000,0x43,58*63],
  [11,0x4800,0x44,66*63],
  [4,0x4400,0xff,70*63],
  [15,0x5000,0xff,70*63+1],
];
const frame={lines:312,cyclesPerLine:63,provenance:{count:events.length,
  kind:Uint8Array.from(events,e=>e[0]),address:Uint16Array.from(events,e=>e[1]),
  value:Uint8Array.from(events,e=>e[2]),tick:Uint16Array.from(events,e=>e[3])}};
const usage=capturedScreenUsage(frame);
assert.equal(usage.reads,4,'Screen usage counts actual matrix fetches only');
assert.equal(usage.cells,3,'Repeated fetches of one address remain one distinct screen cell');
assert.deepEqual(usage.regions.map(r=>r.base),[0x4000,0x4800],'D018 and sprite-pointer reads cannot invent an active screen region');
assert.equal(usage.regions[0].reads,3,'Separate row-buffer loads retain their observed fetch count');
assert.equal(usage.regions[0].firstAddress,0x4000,'A source link carries the first actual read address');
assert.equal(usage.regions[0].firstValue,0x41,'A source link preserves the recorded value, not current RAM');
assert.equal(usage.regions[0].firstTick,50*63,'A source link carries the corresponding recorded fetch time');
assert.equal(usage.rasters[50],2,'Raster marks count the reads on their recorded line');
assert.equal(usage.rasters[51],0,'Raster marks never extrapolate a fetched row into unobserved lines');
assert.equal(usage.pages[0x44],0,'RAM page outlines exclude a configured but unread screen region');
assert.equal(usage.pages[0x48],1,'RAM page outlines include screen regions selected later in the frame');
assert.equal(usage.status,'complete','A complete recording distinguishes absent reads from absent evidence');
assert.equal(capturedScreenUsage(frame),usage,'Screen usage is analyzed once per detached recording');
assert.equal(capturedScreenUsage({...frame,provenance:{...frame.provenance,overflow:true}}).status,'partial','Truncated provenance cannot imply complete source coverage');
assert.equal(capturedScreenUsage({...frame,overflow:true}).status,'partial','Frame overflow cannot imply complete source coverage');
assert.equal(capturedScreenUsage({provenance:{pixels:{version:1}}}).status,'unavailable','Pixel evidence alone cannot stand in for recorded matrix reads');
assert.equal(capturedScreenUsage({}).status,'unavailable','A picture without provenance never substitutes live register addresses');
assert.equal(capturedScreenUsage(null),null,'No captured frame remains an explicit waiting state');
const empty=capturedScreenUsage({...frame,provenance:{...frame.provenance,count:0}});
assert.equal(empty.reads,0,'A recording with no matrix fetches reports no observed screen reads');
assert.equal(empty.status,'complete','No matrix reads is distinct from unavailable provenance');
console.log('ok  - captured matrix usage, source links, read rasters, source pages, missing evidence and caching');
