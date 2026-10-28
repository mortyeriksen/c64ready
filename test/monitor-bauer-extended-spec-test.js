import assert from 'node:assert/strict';
import { matrixAddress, graphicsAddress, spritePointerAddress, spriteDataAddress, refreshAddress, advanceGraphics, spriteCrunch, spritePixel, spritePriority, collisionBits, irqOutput, acknowledgeIrq, lightpenLatch } from '../src/monitor/bauer-model.js';
import { BAUER_RULES, analyzeBauerFrame, checkBauerRule, RESULT } from '../src/monitor/bauer-rules.js';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
assert.equal(matrixAddress(0x18,999),0x7e7,'Bauer 3.7.3: matrix combines screen base with the ten-bit VC');
assert.equal(graphicsAddress(0,0x18,65,0,3),0x220b,'Bauer 3.7.3.1: character base, code and row form the graphics address');
assert.equal(graphicsAddress(32,8,0,999,7),0x3f3f,'Bauer 3.7.3.3: bitmap base, VC and row form the address');
assert.equal(graphicsAddress(64,0,255,0,7),0x1ff,'Bauer 3.7.3.5: ECM forces address bits 9 and 10 low');
assert.equal(graphicsAddress(0,0,0,0,0,false),0x3fff,'Bauer 3.7.3.9: idle graphics reads the final bank byte');
assert.equal(graphicsAddress(64,0,0,0,0,false),0x39ff,'Bauer 3.7.3.9: ECM also masks the idle address');
assert.equal(spritePointerAddress(0x10,7),0x7ff,'Bauer 3.8.1: pointer seven is the final byte of the screen block');
assert.equal(spriteDataAddress(128,62),0x203e,'Bauer 3.8.1: pointer selects a 64-byte block and MC selects a byte');
assert.equal(refreshAddress(0,11),0x3fff,'Bauer 3.13: first refresh reads $3FFF');
assert.equal(refreshAddress(1,15),0x3ff6,'Bauer 3.13: five rows per raster decrement the refresh address');
assert.equal(refreshAddress(51,12),0x3fff,'Bauer 3.13: refresh counter wraps after 256 accesses');
const initial={vc:15,vcBase:40,rc:7,vmli:9,display:false};
assert.deepEqual(advanceGraphics(initial,14,true),{vc:40,vcBase:40,rc:0,vmli:0,display:true},'Bauer 3.7.2 rule 2: bad-line cycle 14 reloads VC, clears VMLI and RC');
assert.equal(advanceGraphics({...initial,display:true,vc:1023},20,false,true).vc,0,'Bauer 3.7.2 rule 4: VC wraps at ten bits');
assert.equal(advanceGraphics({...initial,display:true},58,false).display,false,'Bauer 3.7.2 rule 5: row seven without a bad line ends display');
assert.equal(advanceGraphics({...initial,display:true},58,true).rc,0,'Bauer 3.7.2 rule 5: a bad line keeps display active and RC wraps');
assert.equal(spriteCrunch(0b101010,0b010101),0b010101,'Bauer 3.8.1 rule 7a: crunch interleaves AND and OR bits');
assert.equal(spritePixel(0x800000,0,false,false,{own:7}),7,'Bauer 3.8.1: a one-bit sprite selects its own colour');
assert.equal(spritePixel(0x400000,0,true,false,{own:7,shared0:3,shared1:9}),3,'Bauer 3.8.1: sprite pair 01 selects shared colour zero');
assert.equal(spritePixel(0x800000,1,false,true,{own:7}),7,'Bauer 3.8.1 rule 6: X expansion repeats a sprite pixel');
assert.equal(spritePixel(0,0,false,false,{own:7}),null,'Bauer 3.8.1: zero sprite data is transparent');
assert.equal(spritePriority(3,true,1),-1,'Bauer 3.8.2: foreground inherits the priority of the first overlapping sprite');
assert.equal(collisionBits(5,false).sprites,5,'Bauer 3.8.2: two opaque sprite outputs collide independently of visible priority');
assert.equal(collisionBits(1,true).graphics,1,'Bauer 3.8.2: opaque sprite output collides with foreground');
assert.equal(irqOutput(3,2),true,'Bauer 3.12: a matching enabled pending source asserts IRQ');
assert.equal(irqOutput(1,2),false,'Bauer 3.12: pending masked sources do not assert IRQ');
assert.equal(acknowledgeIrq(15,5),10,'Bauer 3.12: only written one bits acknowledge IRQ latches');
const lp=lightpenLatch({triggered:false},{fallingEdge:true,x:60,raster:300});
assert.deepEqual(lp,{triggered:true,x:30,y:44},'Bauer 3.11: lightpen stores upper eight X bits and lower eight raster bits');
assert.deepEqual(lightpenLatch(lp,{fallingEdge:true,x:80,raster:301}),lp,'Bauer 3.11: subsequent lightpen edges in the frame are ignored');

const m=new C64Machine();m.mem.write(0,47);m.mem.write(1,52);m.mem.ram.set([76,0,2],512);m.cpu.pc=512;
const f=new MachineFacade(m);f.requestVicFrameCapture({analysis:true,provenance:true});
for(let i=0;i<39312;i++)m._runMasterCycle();
const frame=f.takeVicFrameCapture(),report=analyzeBauerFrame(frame);
const index=id=>BAUER_RULES.findIndex(rule=>rule.id===id);
assert.equal(report.summary[index('graphics.vc-reload')].match,312,'Bauer rule 2 is checked at each captured cycle-14 boundary');
assert.equal(report.summary[index('refresh.address')].match,1560,'Bauer 3.13: the detached log contains all five refresh addresses per PAL line');
assert.equal(report.summary[index('fetch.sprite-pointer')].match,2496,'Bauer 3.8.1: all eight sprite pointers are fetched on all 312 lines');
frame.analysis.sequencer.vc[13]^=1;
assert.equal(checkBauerRule(frame,13,index('graphics.vc-reload')),RESULT.mismatch,'a corrupted recorded VC cannot pass the cycle-14 reload rule');
frame.analysis.sequencer.vc[13]^=1;
const t=60*63;frame.analysis.denLatch[t]^=1;
assert.equal(checkBauerRule(frame,t,index('badline.den-latch')),RESULT.mismatch,'DEN-latch generation is checked independently of the recorded latch');
assert.equal(m.vic2._frameCapture,null,'completed detailed capture removes the VIC observer');
assert.equal(m.cpu._captureObserver,null,'completed detailed capture removes the CPU observer');
assert.equal(m.mem._captureObserver,null,'completed detailed capture removes the memory observer');
f.requestVicFrameCapture({provenance:true});for(let i=0;i<19657;i++)m._runMasterCycle();f.cancelVicFrameCapture();
assert.ok(!m.vic2._frameCapture&&!m.vic2._captureObserver&&!m.cpu._captureObserver&&!m.mem._captureObserver,'cancelling a recording removes every sampling observer');
console.log('ok  - independent Bauer equations, indexed captured boundaries, missing evidence and capture cleanup');

for(const expanded of [0,255]) {
  const machine=new C64Machine();machine.mem.write(0,47);machine.mem.write(1,53);
  machine.mem.ram.set([76,0,2],512);machine.cpu.pc=512;machine.vic2.write(0x15,255);machine.vic2.write(0x17,expanded);
  for(let s=0;s<8;s++){machine.vic2.write(s*2+1,55+s);machine.mem.ram[0x7f8+s]=128+s;}
  const facade=new MachineFacade(machine);facade.requestVicFrameCapture({analysis:true,provenance:true});
  for(let i=0;i<39312;i++)machine._runMasterCycle();
  const captured=facade.takeVicFrameCapture(),checked=analyzeBauerFrame(captured);
  for(const id of ['sprite.dma-start','sprite.row-advance','sprite.fetch-sequence','sprite.display-start','bus.ba-generation','bus.aec-generation']){
    const row=checked.summary[index(id)];
    assert.ok(row.match>0&&row.mismatch===0,`${id}: staggered synthetic sprites obey the independent rule with expansion ${expanded}`);
  }
  assert.equal(checked.summary[index('sprite.mc-reload')].match,312,'Bauer 3.8.1 rule 4: directly recorded reloads copy MCBASE before later grouped accesses on every line');
}
console.log('ok  - synthetic sprite DMA, expanded rows, grouped bytes and continuous bus-warning windows');

assert.equal(report.summary[index('refresh.counter')].match,1560,'Bauer 3.13: REF decrements after every refresh access');
frame.analysis.sequencer.refresh[10]^=1;
assert.equal(checkBauerRule(frame,10,index('refresh.counter')),RESULT.mismatch,'Bauer 3.13: a wrong post-fetch REF counter is detected');
frame.analysis.sequencer.refresh[10]^=1;
const dmaTick=15;frame.analysis.sequencer.mcBase[dmaTick*8]=63;frame.analysis.sequencer.dma[dmaTick]|=1;
assert.equal(checkBauerRule(frame,dmaTick,index('sprite.dma-stop')),RESULT.mismatch,'Bauer 3.8.1 rule 7: DMA cannot remain enabled after the row base reaches 63');
console.log('ok  - refresh counter and sprite DMA termination have independent failure checks');

const pointerTick=57,dataTick=58;
frame.analysis.sequencer.bank.fill(0);
frame.analysis.sequencer.registers[pointerTick*64+0x18]=0x10;
const pointerFrame={...frame,provenance:{...frame.provenance,count:4,kind:[2,4,4,4],tick:[pointerTick,dataTick,dataTick,dataTick],address:[0x7f8,0x2000,0x2001,0x2002],value:[128,1,2,3],aux:[0,0,0,0]}};
assert.equal(checkBauerRule(pointerFrame,dataTick,index('fetch.sprite-block')),RESULT.match,'Bauer 3.8.1: fetched pointer 128 selects sprite bytes in block $2000');
pointerFrame.provenance.address[2]=0x2041;
assert.equal(checkBauerRule(pointerFrame,dataTick,index('fetch.sprite-block')),RESULT.mismatch,'Bauer 3.8.1: the same row offset in a different sprite block fails');
const matrixTick=20*63+19;
frame.analysis.sequencer.vmli[matrixTick]=6;frame.analysis.sequencer.display[matrixTick]=1;
const matrixFrame={...frame,provenance:{...frame.provenance,count:1,kind:[11],tick:[matrixTick],address:[0x405],value:[1],aux:[5]}};
assert.equal(checkBauerRule(matrixFrame,matrixTick,index('fetch.matrix-slot')),RESULT.match,'Bauer 3.7.2 rule 3: a screen fetch uses VMLI before the graphics increment');
matrixFrame.provenance.aux[0]=6;
assert.equal(checkBauerRule(matrixFrame,matrixTick,index('fetch.matrix-slot')),RESULT.mismatch,'Bauer 3.7.2 rule 3: storing in the next matrix slot fails');
