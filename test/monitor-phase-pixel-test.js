import assert from 'node:assert/strict';
import { C64Machine } from '../src/machine.js';
import { MachineFacade } from '../src/machine-facade.js';
import { explainPixel } from '../src/monitor/provenance-model.js';
import { phasePixel } from '../src/monitor/pixel-phase.js';
import { analyzeBauerFrame, BAUER_RULES } from '../src/monitor/bauer-rules.js';

function machine() {
  const m=new C64Machine();m.mem.write(0,47);m.mem.write(1,53);
  m.mem.ram.set([0x4c,0,2],512);m.cpu.pc=512;
  m.mem.ram.fill(1,0x400,0x800);m.mem.colorRam.fill(7);
  m.mem.ram.fill(0x80,0x2000,0x2800);m.mem.ram.fill(0x40,0x3000,0x3800);
  for(const [r,v] of [[0x11,0x1b],[0x16,8],[0x18,0x18],[0x21,6]])m.vic2.write(r,v);
  return m;
}
function capture(writes) {
  const a=machine(),b=machine(),facade=new MachineFacade(b);
  facade.requestVicFrameCapture({provenance:true});
  for(let i=0;i<39312;i++) {
    a._runMasterCycle();b._runMasterCycle();
    for(const [line,cycle,reg,value] of writes)if(a.vic2.raster===line&&a.vic2.cycleInLine===cycle) {
      a.vic2.write(reg,value);b.vic2.write(reg,value);
    }
  }
  assert.deepEqual(b.serializeState(),a.serializeState(),'Read-only phase capture leaves complete execution state unchanged');
  assert.deepEqual(b.vic2.frameBuffer,a.vic2.frameBuffer,'Read-only phase capture leaves rendered pixels unchanged');
  assert.equal(b.vic2._captureObserver,null,'Completed phase capture removes its VIC observer');
  return facade.takeVicFrameCapture();
}
const y=60-15;
const base=capture([[60,25,0x18,0x1c],[61,10,0x18,0x18]]);
assert.equal(explainPixel(base,32,y).address,0x2009,'Bauer g-address: an earlier pixel retains the charset base sampled before the D018 write');
assert.equal(explainPixel(base,176,y).address,0x3009,'Bauer g-address: a later pixel uses the charset base sampled after the D018 write');
assert.equal(explainPixel(base,32,y).graphics.colourIndex,7,'Earlier character keeps its recorded high bit and colour RAM colour');
assert.equal(explainPixel(base,176,y).graphics.colourIndex,6,'Later character uses its recorded clear high bit and background colour');
assert.match(explainPixel(base,176,y).text,/output-stage controls/,'Dynamic tracing explains the output phase without a whole-frame veto');
const modes=capture([[60,25,0x11,0x3b],[61,10,0x11,0x1b]]);
assert.equal(explainPixel(modes,32,y).graphics.mode,'Standard text','Earlier pixel uses text even when the line ends in bitmap mode');
assert.equal(explainPixel(modes,176,y).graphics.mode,'Standard bitmap','Later pixel uses the mode at its output stage');
const scroll=capture([[60,25,0x16,11],[61,10,0x16,8]]);
assert.equal(explainPixel(scroll,179,y).graphics.shift,7,'Bauer shifter: XSCROLL 3 moves bit seven three pixels right');
const colours=capture([[60,25,0x21,2],[61,10,0x21,6]]);
assert.equal(explainPixel(colours,33,y).graphics.colourIndex,6,'Earlier background retains the colour before the output-stage write');
assert.equal(explainPixel(colours,177,y).graphics.colourIndex,2,'Later background uses the recorded output-stage colour');
const unchanged=capture([[60,25,0x11,0x1b],[60,30,0x16,8],[60,35,0x18,0x18]]);
assert.ok(explainPixel(unchanged,32,y).graphics,'Same-value graphics writes do not invalidate source attribution');
const report=analyzeBauerFrame(modes);
const idx=id=>BAUER_RULES.findIndex(r=>r.id===id);
assert.ok(report.summary[idx('graphics.mode.0')].match>0,'Text output has independent captured rule checks');
assert.ok(report.summary[idx('graphics.mode.2')].match>0,'Bitmap output has independent captured rule checks');
const index=y*384+176,old=modes.rgba[index*4];modes.rgba[index*4]^=255;
assert.equal(phasePixel(modes,index).colourMatch,false,'A corrupted final pixel disagrees with independently decoded captured source');
assert.equal(explainPixel(modes,176,y).graphics,undefined,'A disagreement is not presented as a proven pixel explanation');
modes.rgba[index*4]=old;
console.log('ok  - mid-frame charset, mode, scroll and colour tracing, same-value writes and capture equivalence');

for(const [writes,id] of [
  [[[60,56,0x16,0],[61,1,0x16,8]],'border.right-cancel'],
  [[[60,10,0x16,0],[60,17,0x16,8]],'border.left-cancel'],
]) {
  const borderFrame=capture(writes),result=analyzeBauerFrame(borderFrame).summary[idx(id)];
  assert.ok(result.match>0,`${id}: a real phase-complete capture resolves the specified CSEL cancellation`);
  assert.equal(result.mismatch,0,`${id}: the recorded final gate preserves the specified cancellation result`);
}
console.log('ok  - actual captured left and right border cancellation retains identical uncaptured output');

const { VicPixelCapture }=await import('../src/vic2-pixel-capture.js');
const idleCapture=new VicPixelCapture(),r=new Uint8Array(64);r[0x21]=6;
idleCapture.vic={raster:60,_regOffset:0,_is8565:false};
const seg={regs:r,nextRegs:r,cycle:20,cycleStart:72,idleByte:0x80,idleBytePrev:0};
idleCapture.idleSource(21,0x38ff,60);idleCapture.idle(seg,45,72,80);
assert.equal(idleCapture.data.address[45*384+72],0x38ff,'Idle attribution retains an observed VSP source address instead of inventing the normal idle address');
idleCapture.vic.raster=61;idleCapture.idle(seg,46,72,80);
assert.equal(idleCapture.data.source[46*384+72],0,'An idle source from an earlier raster is not reused without evidence');
console.log('ok  - idle output retains its observed source address and rejects stale source history');
