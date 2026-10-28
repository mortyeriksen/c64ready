import assert from 'node:assert/strict';
import { explainVicWrite, capturedCodeActions, capturedCycleBudget } from '../src/monitor/code-actions.js';

assert.equal(explainVicWrite(0x21,0xf6).colour,6,'VIC colour registers use the low nibble');
assert.match(explainVicWrite(0x21,6).title,/background to blue/,'background colour explanation names the palette index');
assert.match(explainVicWrite(0,255).detail,/ninth bit.*D010/,'sprite X low byte does not determine the full X coordinate');
assert.match(explainVicWrite(0x18,0x18).detail,/Screen offset \$0400, character offset \$2000, bitmap offset \$2000/,'D018 offsets derive from screen, character and bitmap fields');
assert.match(explainVicWrite(0x19,0xf5).detail,/\$05/,'D019 acknowledges only the four interrupt flags selected by written ones');
assert.match(explainVicWrite(0x1e,255).title,/read-only/,'sprite collision register is not a writable setting');
assert.match(explainVicWrite(0x12,50).detail,/does not itself enable/,'raster target and raster interrupt enable are independent');
const frame={lines:1,cyclesPerLine:6,eventCount:3,eventKind:[0x21,64,0x15],eventValue:[6,0,3],eventTick:[0,1,2],eventCPU:[1,0,0],eventPC:[0x1234,0,0],eventOpcode:[0x8d,0,0],analysis:{bus:Uint8Array.from([1,5,9,17,0,3])}};
const actions=capturedCodeActions(frame);
assert.equal(actions.length,2,'IRQ assertions are not register writes');
assert.equal(actions[0].pc,0x1234,'instruction origin comes from capture');
assert.equal(actions[1].cpu,false,'missing CPU origin is retained, not inferred');
assert.deepEqual(capturedCycleBudget(frame),{total:6,available:2,vic:1,reu:1,halted:1,unknown:1},'bus budget partitions recorded CPU opportunities and missing evidence');
assert.equal(capturedCycleBudget({...frame,analysis:null}).unknown,6,'ordinary capture is not mistaken for zero CPU stalls');
assert.equal(capturedCycleBudget({...frame,analysis:{bus:Uint8Array.from([1|4|8|16])}}).reu,1,'overlapping holds count once with REU precedence');
console.log('ok  - captured code explanations and CPU frame budget');

const writes={eventCount:0,provenance:{count:7,kind:[8,5,1,1,12,7,12],address:[0x200,0,0xd400,0x400,0x400,0x401,0x401],tick:[0,3,3,7,7,8,8],value:[0x8d,34,34,5,5,9,9],aux:[0,1,0,0,0,0,0],pc:[0x200,0x200,0x200,0x200,0x200,0x200,0x200],sid2Address:0xd420}};
const mixed=capturedCodeActions(writes);
assert.equal(mixed[0].group,'Sound','captured SID writes enter the Sound action category');
assert.equal(mixed[0].address,0xd420,'SID 2 retains its independent mapped base address');
assert.equal(mixed[1].cpu,true,'a recorded CPU RAM write retains its dispatch origin');
assert.equal(mixed[2].cpu,false,'REU RAM changes cannot inherit the previously executing CPU instruction');
