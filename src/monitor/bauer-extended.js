// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { POINTER_CYCLES, matrixAddress, graphicsAddress, spritePointerAddress, refreshAddress, spriteCrunch, irqOutput } from './bauer-model.js';
import { staticBorderCheck } from './provenance-model.js';
import { OUTPUT_RULES, prepareOutputRules } from './bauer-output-rules.js';

const rule=(id,section,title,requires,explanation)=>({id,section,title,requires,explanation});
export const EXTENDED_RULES = [
  rule('badline.den-latch','3.5','Display-enable latch','complete $D011 write history and initial latch','DEN during raster 48 enables bad lines for the rest of the frame. Clearing DEN later does not undo that latch.'),
  rule('bus.ba-generation','3.6.3 / 3.7.2','Bus warning windows','recorded DMA, complete bad-line history','Screen fetches and sprite DMA request the bus. BA warns the CPU before the VIC uses its half of the cycle.'),
  rule('bus.aec-generation','3.6.3','VIC bus takeover','three previous BA samples, DMA and bad-line history','The VIC waits through the three-cycle warning before taking the CPU bus for matrix or sprite fetches.'),
  rule('graphics.vc-reload','3.7.2 rule 2','Restart the screen row','cycle 14 VC, VCBASE and VMLI','At cycle 14, the video counter returns to the row base and the matrix-line index restarts at zero.'),
  rule('graphics.rc-reset','3.7.2 rule 2','Start the character at row zero','cycle 14 bad-line condition and row counter','A bad line at cycle 14 resets the character row counter, so the next graphics bytes describe the top row.'),
  rule('graphics.advance','3.7.2 rule 4','Move to the next screen cell','adjacent video counters and display state','Each graphics access in display state advances the video counter and matrix-line index.'),
  rule('graphics.row-finish','3.7.2 rule 5','Finish or repeat a character row','cycle 58/59 counters and stable control phase','At the end of a character, the next screen-row base comes from VC. A new bad line can keep display active, otherwise row seven ends display. Active display advances RC.'),
  rule('graphics.frame-base','3.7.2 rule 1','Start from the screen base','VCBASE before the first possible bad line','The screen-row base must be reset outside the bad-line range, ready for the first row. Bauer does not specify an exact reset cycle.'),
  rule('fetch.matrix-address','3.7.3','Find the screen cell','timed matrix address, video counter and $D018','The screen base selected by $D018 combines with the ten-bit video counter to address a screen cell.'),
  rule('fetch.graphics-address','3.7.3','Find character or bitmap bytes','timed graphics fetch, matrix code, mode and row counter','Text combines character-set base, character code and row. Bitmap combines bitmap base, video counter and row. ECM clears address bits 9 and 10.'),
  rule('fetch.sprite-pointer','3.8.1','Read the sprite pointer','timed VIC bus accesses and $D018','Each sprite pointer is read once per line from the last eight bytes of the selected screen block, even when that sprite is disabled.'),
  rule('sprite.advance-latch','3.8.1 rule 1','Allow the next sprite row','Y-expansion register and advance-line flags','Without Y expansion, the advance-line flag is held set. With expansion it can alternate to repeat rows.'),
  rule('sprite.dma-start','3.8.1 rule 2','Start fetching a sprite','cycles 55/56 enable, Y, DMA and MCBASE','An enabled sprite whose Y matches the raster starts DMA at cycle 55 or 56. Its data base resets to zero.'),
  rule('sprite.y-toggle','3.8.1 rule 3','Repeat an expanded sprite row','cycle 55/56 flags and stable $D017','At cycle 56, an active expanded sprite toggles its advance-line flag, alternating between repeating and advancing a row.'),
  rule('sprite.display-off','3.8.1 rule 4','Stop displaying a finished sprite','cycle 58 DMA and display flags','When sprite DMA is off at cycle 58, its display flag is switched off too.'),
  rule('sprite.row-advance','3.8.1 rule 7','Advance the sprite source row','cycle 15/16 counters, advance flags and $D017','At cycle 16, an advance flag loads MC into MCBASE. Reaching byte 63 ends DMA.'),
  rule('sprite.crunch','3.8.1 rule 7a','Crunch a sprite row','cycle 15 $D017 clear, previous flag and counters','Clearing Y expansion at cycle 15 while the advance flag was clear mixes alternating bits of MC and MCBASE, changing the next source row.'),
  rule('sprite.display-start','3.8.1 rule 4','Start displaying a sprite','cycle 58 DMA and Y match','At cycle 58, a matching sprite with DMA active starts its display. Enable controls DMA start, which is a separate decision.'),
  rule('sprite.fetch-sequence','3.8.1 rule 5','Fetch three sprite bytes','grouped sprite fetches and previous data counters','Three bytes form a sprite row and advance the six-bit data counter. This log groups the three reads at the row-access cycle. It checks byte order and counter progression, not individual half-cycle timing.'),
  rule('irq.raster','3.12','Reach the raster interrupt line','stable raster target, latch and line boundary','The raster comparison runs at cycle 1, or cycle 2 on raster zero. A new match sets the raster interrupt latch even when that source is masked.'),
  rule('irq.output','3.12','Request a CPU interrupt','IRQ latch and enable mask','A pending source requests an interrupt only when its matching enable bit is set. This is separate from the CPU accepting the request.'),
  rule('refresh.address','3.13','Keep DRAM refreshed','timed refresh bus addresses','Five accesses per raster line step downward through 256 DRAM row addresses. The sequence starts at $3FFF in raster zero.'),
  rule('border.stable-mask','3.9','Border mask with stable controls','stable border controls and complete pixel mask','Replaying the border comparators predicts the covered screen area when border controls stay fixed.'),
  rule('refresh.counter','3.13','Advance the DRAM refresh counter','refresh counter after each of the five refresh accesses','Each refresh access decrements REF with eight-bit wrap. Raster zero starts the sequence at 255.'),
  rule('fetch.sprite-block','3.8.1','Use the fetched sprite pointer','recorded pointer bytes and subsequent sprite data addresses','The latest pointer read selects the 64-byte sprite block. A later CPU change to pointer memory does not replace that already fetched pointer.'),
  rule('fetch.matrix-slot','3.7.2 rule 3','Store the screen cell in the row buffer','recorded matrix access and video matrix line index','A screen fetch stores its byte in the matrix-line position selected by VMLI, before the graphics access advances the index.'),
  rule('sprite.dma-stop','3.8.1 rule 7','Stop fetching after byte 63','cycle 16 sprite row base and DMA flag','After advancing the sprite row base, a base of 63 switches DMA off. Display shutdown is checked separately at cycle 58.'),
  ...OUTPUT_RULES,
];
const MATCH=1,MISMATCH=2,UNKNOWN=3,NA=0;
const verdict=(expected,actual)=>expected===actual?MATCH:MISMATCH;
export function prepareExtended(frame) {
  const n=19656,a=frame.analysis,q=a.sequencer,p=frame.provenance;
  const den=new Uint8Array(n),bad=new Uint8Array(n),matrix=new Uint8Array(n),writes=new Uint8Array(n);
  let latch=a.initial?.displayEnabled, armed=false;
  if(typeof latch==='boolean'&&!frame.overflow) {
    const sets=new Uint8Array(n);
    for(let i=0;i<frame.eventCount;i++)if(frame.eventKind[i]===0x11){writes[frame.eventTick[i]]=1;if(frame.eventValue[i]&16)sets[frame.eventTick[i]]=1;}
    for(let t=0;t<n;t++){
      const line=Math.floor(t/63),c=t%63+1;
      if(line===48&&c===1)latch=false;
      if(line===48&&(a.d011[t]&16))latch=true;
      if(t&&Math.floor((t-1)/63)===48&&sets[t-1])latch=true;
      den[t]=latch?1:0;bad[t]=line>=48&&line<=247&&(line&7)===(a.d011[t]&7)&&latch?1:0;
      if(c===1)armed=false;if(c>=12&&c<=54&&bad[t])armed=true;
      matrix[t]=armed&&c>=15&&c<=54?1:0;
    }
  }
  const eventHeads=new Int32Array(n).fill(-1),eventNext=new Int32Array(p?.count??0).fill(-1);
  const tails=new Int32Array(n).fill(-1);
  if(p&&!p.overflow)for(let i=0;i<p.count;i++) {
    const kind=p.kind[i];
    if(kind!==2&&kind!==3&&kind!==4&&kind!==11)continue;
    const t=p.tick[i];
    if(tails[t]<0)eventHeads[t]=i;else eventNext[tails[t]]=i;
    tails[t]=i;
  }
  const valid=!!(q?.version===1&&q.phase==='after-vic-before-cpu'&&q.registers?.length===n*64&&['bank','vc','vcBase','rc','vmli','display','refresh','irq','mask','dma','spriteDisplay'].every(k=>q[k]?.length===n)&&['mc','mcBase','advance'].every(k=>q[k]?.length===n*8));
  const spriteBlocks=new Uint8Array(n),pointerValues=new Int16Array(8).fill(-1);
  if(p&&!p.overflow&&!frame.overflow&&valid)for(let t=0;t<n;t++){
    const slot=POINTER_CYCLES.indexOf(t%63+1);
    for(let i=eventHeads[t];i>=0;i=eventNext[i]){
      if(slot>=0&&p.kind[i]===2&&p.address[i]===q.bank[t]+spritePointerAddress(q.registers[t*64+0x18],slot))pointerValues[slot]=p.value[i];
      if(p.kind[i]!==4)continue;
      const pointer=pointerValues[p.aux[i]],result=pointer===undefined||pointer<0?UNKNOWN:verdict(q.bank[t]+pointer*64,p.address[i]&0xffc0);
      spriteBlocks[t]=spriteBlocks[t]===MISMATCH||result===MISMATCH?MISMATCH:spriteBlocks[t]===UNKNOWN||result===UNKNOWN?UNKNOWN:result;
    }
  }else spriteBlocks.fill(UNKNOWN);
  return {spriteBlocks,output:prepareOutputRules(frame),den,bad,matrix,writes,eventHeads,eventNext,valid,denValid:typeof latch==='boolean'&&!frame.overflow,border:frame.border?staticBorderCheck(frame):null};
}
export function checkExtended(frame,t,id,context) {
  const a=frame.analysis,q=a.sequencer,p=frame.provenance,c=t%63+1,line=Math.floor(t/63),x=context;
  if(id==='badline.den-latch'&&line<48)return NA;
  if(id==='badline.den-latch')return !x.denValid||!a.vicValid[t]?UNKNOWN:verdict(x.den[t],a.denLatch[t]);
  if(id==='border.stable-mask')return x.border?.supported?(x.border.mismatches?MISMATCH:MATCH):UNKNOWN;
  if(x.output.has(id))return x.output.get(id)[t];
  if(!x.valid||!a.vicValid[t])return UNKNOWN;
  const registers=q.registers,base=t*64,previousBase=base-64;
  if(id==='irq.raster'){
    if(c!==(line===0?2:1))return NA;
    const target=registers[base+(0x12)]|((registers[base+(0x11)]&128)<<1);if(line!==target)return NA;
    if(!t||registers[previousBase+(0x12)]!==registers[base+(0x12)]||((registers[previousBase+(0x11)]^registers[base+(0x11)])&128))return UNKNOWN;
    return verdict(true,!!(q.irq[t]&1));
  }
  if(id==='irq.output')return verdict(irqOutput(q.irq[t],q.mask[t]),!!(q.irq[t]&128));
  if(id==='fetch.sprite-block')return x.spriteBlocks[t];
  if(id==='refresh.counter')return c>=11&&c<=15?verdict((255-line*5-(c-10))&255,q.refresh[t]):NA;
  if(id==='sprite.dma-stop'){
    if(c!==16)return NA;
    let applicable=false;
    for(let s=0;s<8;s++)if(q.mcBase[t*8+s]===63){applicable=true;if(q.dma[t]&(1<<s))return MISMATCH;}
    return applicable?MATCH:NA;
  }
  if(id==='graphics.frame-base')return line===47&&c===63?verdict(0,q.vcBase[t]):NA;
  if(id==='graphics.vc-reload')return c===14?verdict(true,q.vc[t]===q.vcBase[t]&&q.vmli[t]===0):NA;
  if(id==='graphics.rc-reset')return c===14&&x.bad[t]?verdict(0,q.rc[t]):NA;
  if(id==='graphics.advance')return c>=15&&c<=54&&q.display[t]&&t>0?verdict(true,q.vc[t]===((q.vc[t-1]+1)&1023)&&q.vmli[t]===((q.vmli[t-1]+1)&63)):NA;
  if(id==='graphics.row-finish'){
    if(c!==59)return NA;if(x.writes[t-1])return UNKNOWN;
    const before=t-1,active=x.bad[before]||q.rc[before]!==7&&q.display[before];
    return verdict(true,q.rc[t]===(active?(q.rc[before]+1)&7:q.rc[before])&&q.vcBase[t]===(q.rc[before]===7?q.vc[before]:q.vcBase[before])&&!!q.display[t]===!!active);
  }
  if(id==='bus.ba-generation'||id==='bus.aec-generation'){
    if(!x.denValid||t<3)return UNKNOWN;
    let sprite=false;for(let s=0;s<8;s++){const delta=(c-POINTER_CYCLES[s]+63)%63;if(q.dma[t]&(1<<s))sprite ||= delta<=1||delta>=60;}
    const demand=sprite||(c>=12&&c<=54&&(x.bad[t]||x.matrix[t]));
    const warning=!!(frame.flags[t-1]&16)&&!!(frame.flags[t-2]&16)&&!!(frame.flags[t-3]&16);
    return verdict(id==='bus.aec-generation'?!!demand&&warning:!!demand,!!(frame.flags[t]&(id==='bus.aec-generation'?32:16)));
  }
  if(id.startsWith('fetch.')||id==='refresh.address'){
    if(!p||p.overflow||frame.overflow)return UNKNOWN;
    const head=x.eventHeads[t];
    if(id==='refresh.address'){
      const address=refreshAddress(line,c);if(address===null)return NA;
      for(let i=head;i>=0;i=x.eventNext[i])if(p.kind[i]===2&&(p.address[i]&16383)===address)return MATCH;
      return MISMATCH;
    }
    if(id==='fetch.sprite-pointer'){
      const slot=POINTER_CYCLES.indexOf(c);if(slot<0)return NA;
      const address=q.bank[t]+spritePointerAddress(registers[base+0x18],slot);
      for(let i=head;i>=0;i=x.eventNext[i])if(p.kind[i]===2&&p.address[i]===address)return MATCH;
      return MISMATCH;
    }
    const kind=id==='fetch.matrix-address'||id==='fetch.matrix-slot'?11:3;
    let found=false;
    for(let i=head;i>=0;i=x.eventNext[i]) {
      if(p.kind[i]!==kind)continue;
      found=true;
      if(kind===3&&(c<15||c>54))return UNKNOWN;
      if(id==='fetch.matrix-slot'){if(p.aux[i]!==((q.vmli[t]-(q.display[t]?1:0))&63))return MISMATCH;continue;}
      const vc=(q.vc[t]-(q.display[t]?1:0))&1023;
      const expected=q.bank[t]+(kind===11?matrixAddress(registers[base+0x18],vc):graphicsAddress(registers[base+0x11],registers[base+0x18],(p.aux[i]>>>6)&255,vc,q.rc[t],!!q.display[t]));
      if(expected!==p.address[i])return MISMATCH;
    }
    return found?MATCH:kind===11&&x.matrix[t]?UNKNOWN:NA;
  }
  if(id==='sprite.fetch-sequence'){
    if(!p||p.overflow||frame.overflow||!t)return UNKNOWN;
    let applicable=false;
    for(let slot=0;slot<8;slot++){
      const delta=(c-POINTER_CYCLES[slot]+63)%63;if(delta!==1||!(q.dma[t]&(1<<slot)))continue;
      applicable=true;
      const end=q.mc[t*8+slot],start=(end-3)&63;
      if(c!==58&&((q.mc[(t-1)*8+slot]+3)&63)!==end)return MISMATCH;
      let count=0;
      for(let i=x.eventHeads[t];i>=0;i=x.eventNext[i])if(p.kind[i]===4&&p.aux[i]===slot) {
        if((p.address[i]&63)!==((start+count)&63))return MISMATCH;
        count++;
      }
      if(count!==3)return MISMATCH;
    }return applicable?MATCH:NA;
  }
  if(!id.startsWith('sprite.'))return UNKNOWN;
  if(!t||!a.vicValid[t-1])return UNKNOWN;
  let applicable=false;
  for(let s=0;s<8;s++){
    const bit=1<<s,j=t*8+s,k=j-8,dma=!!(q.dma[t]&bit),oldDma=!!(q.dma[t-1]&bit);
    let expected,actual;
    if(id==='sprite.advance-latch'){if(registers[base+(0x17)]&bit)continue;expected=1;actual=q.advance[j];}
    else if(id==='sprite.dma-start'){
      if((c!==55&&c!==56)||oldDma||!(registers[base+(0x15)]&bit)||registers[base+(s*2+1)]!==(line&255))continue;
      expected=true;actual=dma&&q.mcBase[j]===0;
    }else if(id==='sprite.y-toggle'){
      if(c!==56||!oldDma||!(registers[base+(0x17)]&bit))continue;
      if(registers[previousBase+(0x17)]!==registers[base+(0x17)])return UNKNOWN;
      expected=q.advance[k]^1;actual=q.advance[j];
    }else if(id==='sprite.display-start'){
      if(c!==58||!dma||registers[base+(s*2+1)]!==(line&255))continue;
      expected=bit;actual=q.spriteDisplay[t]&bit;
    }else if(id==='sprite.display-off'){
      if(c!==58||dma)continue;expected=0;actual=q.spriteDisplay[t]&bit;
    }else if(id==='sprite.row-advance'||id==='sprite.crunch'){
      if(c!==16||!oldDma)continue;
      const crunch=!!(registers[previousBase+(0x17)]&bit)&&!(registers[base+(0x17)]&bit)&&!q.advance[k];
      if((id==='sprite.crunch')!==crunch)continue;
      const advance=!(registers[base+(0x17)]&bit)||q.advance[k];
      expected=crunch?spriteCrunch(q.mcBase[k],q.mc[k]):advance?q.mc[k]:q.mcBase[k];actual=q.mcBase[j];
      if(actual===63&&dma)return MISMATCH;
    }else continue;
    applicable=true;if(expected!==actual)return MISMATCH;
  }
  return applicable?MATCH:NA;
}
