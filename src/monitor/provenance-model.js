// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { decodeGraphicsPixel } from './graphics-pixel.js';
import { OPCODES } from './disassembly.js';
import { hex } from './memory-sampler.js';
import { borderComparators, stepBorderComparators } from './border-rules.js';
import { ghostByteFinding } from './ghost-bytes.js';
import { explainPhasePixel } from './pixel-phase.js';

export function capturedRam(frame,tick=frame.lines*frame.cyclesPerLine-1){
  const p=frame?.provenance;if(!p||p.overflow||!p.memoryComplete)return null;
  const bytes=p.ram.slice();for(let i=0;i<p.count;i++)if(p.kind[i]===12&&p.tick[i]<=tick)bytes[p.address[i]]=p.value[i];return bytes;
}
export function provenanceEvents(frame,kind){
  const p=frame?.provenance,out=[];if(!p)return out;
  for(let i=0;i<p.count;i++)if(kind===undefined||p.kind[i]===kind)out.push({index:i,tick:p.tick[i],kind:p.kind[i],address:p.address[i],value:p.value[i],aux:p.aux[i],pc:p.pc[i]});
  return out;
}
export function instructionGroups(frame){
  const events=provenanceEvents(frame,8),groups=new Map();
  for(let i=0;i<events.length;i++){
    const e=events[i],key=e.address*256+e.value;
    if(!groups.has(key))groups.set(key,{address:e.address,opcode:e.value,name:OPCODES[e.value].name,count:0,elapsed:0,completeIntervals:0,first:e.tick});
    const g=groups.get(key);g.count++;if(i+1<events.length){g.elapsed+=events[i+1].tick-e.tick;g.completeIntervals++;}
  }
  return [...groups.values()].sort((a,b)=>b.count-a.count);
}
export function frameTechniques(frame){
  const findings=[],p=frame?.provenance;
  const lines=new Map();
  for(let i=0;i<frame.eventCount;i++)if(frame.eventKind[i]>=0x20&&frame.eventKind[i]<=0x24){const line=Math.floor(frame.eventTick[i]/frame.cyclesPerLine);if(!lines.has(line))lines.set(line,[]);lines.get(line).push(i);}
  const split=[...lines].filter(([,events])=>events.length>1);
  if(split.length)findings.push({title:'Repeated colour writes within raster lines',status:'Observed',text:`${split.length} lines contain multiple colour writes. These are timed register actions, not proof that every write changed a visible pixel.`,tick:frame.eventTick[split[0][1][0]]});
  let pointerChanges=0,first=0;
  for(let l=1;l<frame.lines;l++)for(let s=0;s<8;s++)if((frame.spriteDma[l]&frame.spriteDma[l-1]&(1<<s))&&(frame.pointers[l*8+s]!==frame.pointers[(l-1)*8+s]||frame.spriteBanks[l*8+s]!==frame.spriteBanks[(l-1)*8+s])){pointerChanges++;if(!first)first=l*frame.cyclesPerLine;}
  if(pointerChanges)findings.push({title:'Sprite sources change during DMA',status:'Observed',text:`${pointerChanges} line-end source changes. This can support sprite reuse or long sprite effects, but does not alone prove multiplexing or crunch.`,tick:first});
  if(p){const positions=new Map();for(let i=0;i<frame.eventCount;i++)if(frame.eventKind[i]<16&&frame.eventKind[i]%2){const slot=frame.eventKind[i]>>1;if(!positions.has(slot))positions.set(slot,new Set());positions.get(slot).add(frame.eventValue[i]);}
    for(const [slot,values] of positions)if(values.size>1)findings.push({title:`Sprite ${slot} is repositioned vertically`,status:'Candidate',text:`${values.size} different Y settings were written. Inspect its DMA and fetch intervals before interpreting this as reuse.`,tick:0});
    const irq=provenanceEvents(frame,9);if(irq.length)findings.push({title:'CPU accepts interrupts during the frame',status:'Observed',text:`${irq.length} IRQ acceptances recorded. An acceptance is distinct from the earlier interrupt assertion.`,tick:irq[0].tick});
  }
  findings.push(ghostByteFinding(frame));
  return findings;
}
export function staticBorderCheck(frame){
  if(frame?.overflow)return {supported:false,reason:'The register-write history is incomplete.'};
  const a=frame?.analysis;if(!a?.border||!a.initial)return {supported:false,reason:'Detailed border evidence is missing.'};
  const d011=a.initial.registers[0x11],d016=a.initial.registers[0x16];
  for(let i=0;i<frame.eventCount;i++)if((frame.eventKind[i]===0x11&&((frame.eventValue[i]^d011)&0x18))||(frame.eventKind[i]===0x16&&((frame.eventValue[i]^d016)&8)))return {supported:false,reason:'Border controls change during the frame. This independent adapter covers stable controls only, not timed latch tricks.'};
  if(a.border.initial.pendingTransitions)return {supported:false,reason:'Pending border transitions at frame start need a phase-aware adapter.'};
  const compare=borderComparators(d011,d016);let state={mainClosed:a.border.initial.mainClosed,verticalClosed:a.border.initial.verticalClosed},mismatches=0,checked=0;
  for(let raster=0;raster<frame.lines;raster++){
    state=stepBorderComparators(state,{raster,x:compare.left,endOfLine:false,d011,d016});
    const open=state.mainClosed===false,y=raster-frame.rasterOffset;
    if(y>=0&&y<frame.height)for(let x=0;x<frame.width;x++){
      const closed=!(open&&x>=compare.left+8&&x<compare.right+8);checked++;if(!!frame.border[y*frame.width+x]!==closed)mismatches++;
    }
    state=stepBorderComparators(state,{raster,x:compare.right,endOfLine:false,d011,d016});
    state=stepBorderComparators(state,{raster,x:0,endOfLine:true,d011,d016});
  }
  return {supported:true,checked,mismatches};
}
export function explainPixel(frame,x,y){
  const index=y*frame.width+x,p=frame.provenance,line=y+frame.rasterOffset;
  if(x<0||x>=frame.width||y<0||y>=frame.height)return {title:'Outside the captured picture',text:''};
  if(frame.border[index])return {title:'The border covers this pixel',text:'The recorded border mask closes the display here. Graphics and sprites underneath do not determine this visible pixel.'};
  if(!p||p.overflow||frame.overflow)return {title:'Pixel source evidence is missing',text:'Capture detailed evidence to connect this pixel to memory.'};
  const regs=p.lineRegs.subarray(line*64,line*64+64),slot=frame.owners[index];
  const spriteVisible=slot<8&&!!p.visibleSprites[index];
  if(spriteVisible){
    const changed=[];for(let i=0;i<frame.eventCount;i++)if([slot*2,slot*2+1,0x10,0x17,0x1b,0x1c,0x1d].includes(frame.eventKind[i]))changed.push(i);
    const source=frame.spriteBanks[line*8+slot]+frame.pointers[line*8+slot]*64;
    for(let l=1;l<frame.lines;l++)if(frame.pointers[l*8+slot]!==frame.pointers[(l-1)*8+slot]||frame.spriteBanks[l*8+slot]!==frame.spriteBanks[(l-1)*8+slot]){changed.push(l);break;}
    if(changed.length)return {title:`Sprite ${slot} covers this pixel`,text:'Position, source, expansion, mode or priority changes during this frame. Its line-end source is evidence, but not an exact pixel-fetch attribution.',address:source};
    const sx=regs[slot*2]+((regs[0x10]>>slot&1)*256)+8,sy=regs[slot*2+1]+1-frame.rasterOffset;
    if(sx-8>=0x164)return {title:`Sprite ${slot} at the right-edge start window`,text:'Same-line starts and wrapped source sequencing need additional pixel-pipeline evidence.',address:source};
    const px=Math.floor((x-sx)/((regs[0x1d]>>slot&1)+1)),py=Math.floor((y-sy)/((regs[0x17]>>slot&1)+1));
    if(px<0||px>=24||py<0||py>=21)return {title:`Sprite ${slot} coverage`,text:'This pixel is outside the normal sprite rectangle. A crunch, wrap or other sequence needs further evidence.',address:source};
    const address=source+py*3+(px>>3),tick=line*frame.cyclesPerLine+Math.min(62,Math.floor(x/8)+12);
    let fetch=-1;for(let i=0;i<p.count;i++)if(p.kind[i]===4&&p.aux[i]===slot&&p.address[i]===address&&p.tick[i]<=tick)fetch=i;
    if(fetch<0)return {title:`Sprite ${slot} coverage`,text:'The matching source-byte fetch is outside this capture or not resolved.',address};
    const shift=regs[0x1c]&(1<<slot)?6-(px&6):7-(px&7),bits=p.value[fetch]>>shift&(regs[0x1c]&(1<<slot)?3:1);
    return {title:`Sprite ${slot} → byte → pixel`,text:`Recorded fetch $${hex(address)} = $${hex(p.value[fetch],2)}. Pixel code ${bits} comes from ${regs[0x1c]&(1<<slot)?'two bits':'one bit'} at offset ${px&7}. Geometry is derived for a stable normal sprite.`,address,tick:p.tick[fetch],value:p.value[fetch]};
  }
  if(p.pixels?.version===1)return explainPhasePixel(frame,index);
  if((regs[0x11]&0x40)&&((regs[0x11]&0x20)||(regs[0x16]&0x10)))return {title:'Graphics pixel in an invalid mode',text:'This combination of graphics modes needs additional pipeline evidence. The captured source log remains available.'};
  for(let i=0;i<frame.eventCount;i++)if([0x11,0x16,0x18].includes(frame.eventKind[i]))return {title:'Graphics settings change within this frame',text:'This capture does not contain output-stage source details. Resume to record a new frame that can trace graphics changes within the line.'};
  const col=Math.floor((x-32-(regs[0x16]&7))/8);if(col<0||col>=40)return {title:'Graphics edge',text:'This position is outside the normal character columns.'};
  let fetch=-1,changed=false;for(let i=0;i<p.count;i++)if((p.kind[i]===3||p.kind[i]===15)&&(p.aux[i]&63)===col&&Math.floor(p.tick[i]/frame.cyclesPerLine)===line){if(fetch>=0&&(p.value[i]!==p.value[fetch]||p.address[i]!==p.address[fetch]||p.aux[i]!==p.aux[fetch]))changed=true;fetch=i;}
  if(changed)return {title:'The character source changes within this line',text:'Multiple source samples disagree. Exact attribution needs per-pixel pipeline evidence.'};
  if(fetch<0)return {title:'Graphics fetch not recorded',text:'No normal character fetch resolves this position. It may be idle graphics or an unsupported rendering path.'};
  const value=p.value[fetch],matrix=(p.aux[fetch]>>6)&255,colour=(p.aux[fetch]>>14)&15;
  const decoded=decodeGraphicsPixel({d011:regs[0x11],d016:regs[0x16],matrix,colour,value,offset:(x-32-(regs[0x16]&7))&7});
  const selected=decoded.selected;
  let colourIndex=selected.index;
  if(selected.register!==undefined){
    let unstable=false;
    for(let i=0;i<frame.eventCount;i++)if(frame.eventKind[i]===selected.register)unstable=true;
    colourIndex=unstable?null:regs[selected.register]&15;
  }
  const bits=decoded.bitCount===2?`Bits ${decoded.shift+1}–${decoded.shift} are ${decoded.code.toString(2).padStart(2,'0')}`:`Bit ${decoded.shift} is ${decoded.code}`;
  const text=`${p.kind[fetch]===15?'Recorded renderer source sample, not an independently timed bus fetch. ':''}${decoded.mode}. ${decoded.character===null?`Screen byte $${hex(matrix,2)} supplies cell colours.`:`Screen code $${hex(matrix,2)} selects character ${decoded.character}.`} Source $${hex(p.address[fetch])} = $${hex(value,2)}. ${bits}, selecting ${selected.label}. ${colourIndex===null?'That background register changes during the frame, so its exact pixel colour is unresolved.':`Colour index ${colourIndex}.`} This code counts as ${decoded.foreground?'foreground':'background'} for sprite priority. ${slot<8?'Recorded sprite coverage also exists here.':''}`;
  return {title:`${decoded.mode} → bits → colour`,text,address:p.address[fetch],tick:p.tick[fetch],value,graphics:{...decoded,colourIndex,matrix,colour}};
}

export function interruptIntervals(frame){
  const p=frame?.provenance,stack=[],spans=[];if(!p)return spans;
  for(let i=0;i<p.count;i++){
    if(p.kind[i]===9||p.kind[i]===10||(p.kind[i]===8&&p.value[i]===0))stack.push({kind:p.kind[i]===9?'IRQ':p.kind[i]===10?'NMI':'BRK',start:p.tick[i],end:null,returnAddress:null});
    if(p.kind[i]===14){const span=stack.pop()??{kind:'Entry before capture or BRK',start:null};span.end=p.tick[i];span.returnAddress=p.address[i];spans.push(span);}
  }
  return spans.concat(stack).sort((a,b)=>(a.start??0)-(b.start??0));
}
export function capturedInstructions(frame){
  const p=frame?.provenance,rows=[];if(!p)return rows;
  let current=null;
  for(let i=0;i<p.count;i++){
    if(p.kind[i]===9||p.kind[i]===10)current=null;
    if(p.kind[i]===8){current={address:p.address[i],opcode:p.value[i],tick:p.tick[i],bytes:[p.value[i],null,null],size:OPCODES[p.value[i]].size};rows.push(current);}
    if(current&&p.kind[i]===0){const offset=(p.address[i]-current.address)&65535;if(offset>0&&offset<current.size&&current.bytes[offset]===null)current.bytes[offset]=p.value[i];}
  }
  return rows;
}
