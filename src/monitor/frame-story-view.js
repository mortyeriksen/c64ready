// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { spriteIntervals } from './frame-story.js';
import { recordedOrigin } from './capture-context.js';
import { hex } from './memory-sampler.js';

function node(tag, text, className) {
  const el=document.createElement(tag); if(text!==undefined)el.textContent=text;
  if(className)el.className=className; return el;
}
function paragraph(parent,title,text) {
  const section=node('section'); section.append(node('h3',title),node('p',text)); parent.append(section); return section;
}
function button(parent,text,action) {
  const el=node('button',text,'monitor-context-link');el.type='button';el.addEventListener('click',action);parent.append(el);return el;
}
export function appendFrameStory(parent, story, choose) {
  paragraph(parent,'How this picture was built',story.summary);
  if(story.incomplete)paragraph(parent,'Partial recording','Some event history is missing. The observations below describe retained evidence only.');
  const list=node('div',undefined,'monitor-story-findings');parent.append(list);
  for(const moment of story.moments) {
    const b=button(list,'',()=>choose(moment.id));
    b.append(node('strong',moment.title),node('span',moment.summary),node('small',`Raster ${moment.line} · ${moment.precision} evidence →`));
  }
}

// Picture excerpts show final output. They are not before/after simulations.
export function appendPicturePatch(parent,frame,x,y,size=17) {
  const canvas=node('canvas',undefined,'monitor-story-patch');canvas.width=size;canvas.height=size;
  canvas.setAttribute('aria-label',`Recorded picture around pixel ${x}, ${y}. The centre square marks the selected pixel.`);
  const ctx=canvas.getContext('2d'),data=ctx.createImageData(size,size),half=size>>1;
  for(let py=0;py<size;py++)for(let px=0;px<size;px++) {
    const sx=x+px-half,sy=y+py-half;
    if(sx<0||sy<0||sx>=frame.width||sy>=frame.height)continue;
    const src=(sy*frame.width+sx)*4,dst=(py*size+px)*4;
    for(let ch=0;ch<4;ch++)data.data[dst+ch]=frame.rgba[src+ch];
  }
  ctx.putImageData(data,0,0);ctx.strokeStyle='#ff6db6';ctx.lineWidth=.15;ctx.strokeRect(half,half,1,1);parent.append(canvas);
}
export function appendStoryMoment(parent,frame,moment,tick,{seek,pixel,openCode,openMemory,rules}) {
  if(!moment){paragraph(parent,'Select a frame-story stop','Choose a numbered stop below the picture or an observation in This frame.');return;}
  const change = moment.changes?.find(e=>e.tick===tick) ?? moment.changes?.find(e=>e.tick===moment.tick);
  const selectedTick = change?.tick ?? tick, line=Math.floor(selectedTick/frame.cyclesPerLine);
  paragraph(parent,moment.title,moment.summary);
  const y=line-frame.rasterOffset;
  if(y>=0&&y<frame.height){
    const preview=node('canvas',undefined,'monitor-story-row');preview.width=frame.width;preview.height=9;
    const ctx=preview.getContext('2d'),data=ctx.createImageData(frame.width,9);
    for(let dy=0;dy<9;dy++){const sy=y+dy-4;if(sy>=0&&sy<frame.height)data.data.set(frame.rgba.subarray(sy*frame.width*4,(sy+1)*frame.width*4),dy*frame.width*4);}
    ctx.putImageData(data,0,0);preview.setAttribute('aria-label',`Final recorded picture around raster ${line}`);parent.append(preview);
    parent.append(node('p',`Picture around raster ${line}. This is the final output, not a simulation of the write.`, 'monitor-story-note'));
    button(parent,'Explain a pixel on this row →',()=>pixel(moment.point?.y===y?moment.point.x:Math.min(frame.width-1,Math.max(0,(selectedTick%frame.cyclesPerLine)*8-80)),y));
  } else parent.append(node('p','This timing sample lies outside the captured picture.','monitor-story-note'));
  if(change){
    const compare=node('div',undefined,'monitor-story-compare');
    for(const [label,value] of [['Before',change.before],['Written',change.after]]){
      const box=node('div');box.append(node('small',`${label} · $${hex(0xd000+change.register)}`),node('strong',value===null?'Unknown':`$${hex(value,2)}`));
      if(change.register>=0x20&&change.register<=0x24&&value!==null&&frame.palette){const swatch=node('i');swatch.style.backgroundColor='#'+(frame.palette[value&15]&0xffffff).toString(16).padStart(6,'0');box.append(swatch);}
      compare.append(box);
    }parent.append(compare);
  }
  if(moment.regions){
    const regions=node('div',undefined,'monitor-story-border-regions');parent.append(regions);
    for(const region of moment.regions){
      const b=button(regions,'',()=>pixel(region.point.x,region.point.y));b.disabled=!region.point;
      const slots=[];for(let s=0;s<8;s++)if(region.slots&(1<<s))slots.push(s);
      b.append(node('strong',region.label),node('span',region.uncovered?`${region.uncovered.toLocaleString()} uncovered positions`:'Border covers this region'),node('small',region.spritePixels===null?'Visible sprite evidence unavailable':`${region.spritePixels.toLocaleString()} visible sprite pixels${slots.length?` · slots ${slots.join(', ')}`:''}`));
      if(region.graphicsSamples!==null)b.append(node('small',`${region.graphicsSamples.toLocaleString()} graphics-source samples`));
    }
    parent.append(node('p','Choose an edge to explain a recorded pixel there. Sprite counts include black pixels. Corners count toward both adjacent edges. Source samples still need the per-pixel consistency check.','monitor-story-note'));
  }
  const chain=node('ol',undefined,'monitor-story-chain');parent.append(chain);
  const first=node('li');chain.append(first);
  paragraph(first,change?'1 · The program writes a setting':'1 · Locate the recorded evidence',change?`$${hex(0xd000+change.register)} receives $${hex(change.after,2)} at raster ${line}, cycle ${selectedTick%frame.cyclesPerLine+1}. CPU writes are visible to the VIC on the following cycle.`:moment.evidence);
  const second=node('li');chain.append(second);paragraph(second,'2 · The VIC uses its hardware rules',moment.mechanism);
  if(change){
    const next=change.tick+1,a=frame.analysis,regs=a?.sequencer?.registers;
    const valid=next<frame.flags.length&&a?.vicValid?.[next]&&regs;
    second.append(node('p',valid?`Next-cycle recorded $${hex(0xd000+change.register)}: $${hex(regs[next*64+change.register],2)}. This setting sample is separate from final pixel attribution.`:'The next-cycle control sample is unavailable.'));
  }
  const third=node('li');chain.append(third);paragraph(third,'3 · Check the picture',change?moment.evidence:'Follow the row, sprite coverage and pixel sources in this recording. Source changes and DMA intervals do not, by themselves, identify the objects the author intended.');
  if((moment.kind??moment.id)==='sources'){
    const list=node('div',undefined,'monitor-story-source-changes');parent.append(list);
    for(const sample of moment.points){
      const i=sample.line*8+sample.slot,before=frame.spriteBanks[i-8]+frame.pointers[i-8]*64,after=frame.spriteBanks[i]+frame.pointers[i]*64;
      button(list,`Row ${sample.line} · slot ${sample.slot}: $${hex(before)} → $${hex(after)}`,()=>seek(sample.tick));
    }
    parent.append(node('p','Addresses above are consecutive line-end observations while DMA remains active. A changed source does not establish the exact fetch or visible seam.','monitor-story-note'));
    let related=-1;for(let i=0;i<frame.eventCount;i++)if(frame.eventKind[i]===0x18&&frame.eventTick[i]<selectedTick)related=i;
    if(related>=0){paragraph(parent,'Related memory-selector write',`The latest earlier $D018 write was $${hex(frame.eventValue[related],2)} at raster ${Math.floor(frame.eventTick[related]/frame.cyclesPerLine)}, cycle ${frame.eventTick[related]%frame.cyclesPerLine+1}. It is related evidence, not a proof of the source change’s cause.`);if(frame.eventCPU[related])button(parent,'Follow the memory-selector instruction in Code →',()=>openCode(frame.eventPC[related],recordedOrigin(frame,related),frame,frame.eventTick[related]));}
  }
  if((moment.kind??moment.id)==='dma'){
    let available=0,blocked=0,unknown=0;for(let c=0;c<frame.cyclesPerLine;c++){const b=frame.analysis?.bus[line*frame.cyclesPerLine+c]??0;if(!(b&1))unknown++;else if(b&28)blocked++;else available++;}
    const active=[];for(let slot=0;slot<8;slot++)if(frame.spriteDma[line]&(1<<slot))active.push(slot);
    paragraph(parent,`CPU time on raster ${line}`,`${available} / ${frame.cyclesPerLine} cycles available, ${blocked} blocked or externally held, ${unknown} unknown. Active sprite DMA slots at line end: ${active.length?active.join(', '):'none'}. The five signal rows show the per-cycle evidence.`);
  }
  if(moment.intervals){for(const interval of moment.intervals)paragraph(parent,`Slot ${interval.slot} · rows ${interval.start}–${interval.end}`,`${interval.end-interval.start+1} active line-end samples. ${interval.counterSamples} counter samples available, with ${interval.wraps} observed decreases in the row-base counter. These line-end observations do not expose every half-cycle transition.`);}
  if(moment.ghost){if(moment.point){paragraph(parent,'Source of the selected picture pixel',`Renderer source $${hex(moment.point.address)} supplies $${hex(moment.point.value,2)}. Its decoded colour matches this final pixel. This output-stage sample is separate from timed bus-fetch evidence.`);button(parent,'Inspect this pixel’s recorded source in Memory →',()=>openMemory(frame,moment.point.tick,moment.point.address));}paragraph(parent,'Idle-source bus evidence',moment.ghost.evidence);button(parent,'Inspect the first recorded idle read in Memory →',()=>openMemory(frame,moment.ghost.tick,moment.ghost.address));}
  if(moment.changes?.length){
    const label=node('label','Changed settings in this frame','monitor-story-occurrences');const select=node('select');select.setAttribute('aria-label','Recorded setting change');
    for(const e of moment.changes){const option=node('option',`Line ${Math.floor(e.tick/frame.cyclesPerLine)}, cycle ${e.tick%frame.cyclesPerLine+1} · $${hex(0xd000+e.register)} ← $${hex(e.after,2)}`);option.value=e.tick;select.append(option);}
    select.value=change?.tick??moment.tick;select.addEventListener('change',()=>seek(Number(select.value)));label.append(select);parent.append(label);
    if(change&&frame.eventCPU[change.event])button(parent,`Follow recorded instruction $${hex(frame.eventPC[change.event])} in Code →`,()=>openCode(frame.eventPC[change.event],recordedOrigin(frame,change.event),frame,frame.eventTick[change.event]));
  }
  button(parent,`Rules behind this observation · Bauer §${moment.rule} →`,rules);
}
export function appendSpriteIntervals(parent,frame,slot,seek,openMemory) {
  const intervals=spriteIntervals(frame,slot);
  paragraph(parent,'Source intervals in this picture',`${intervals.length} intervals of consecutive active line-end samples. A gap in DMA or a changed source starts another interval. These are not a count of visible objects.`);
  const list=node('div',undefined,'monitor-story-intervals');parent.append(list);
  for(const interval of intervals){
    const row=node('div');list.append(row);
    button(row,`Rows ${interval.start}–${interval.end} · $${hex(interval.address)} →`,()=>seek((interval.start+1)*frame.cyclesPerLine-1));
    const description=node('small',`Pointer $${hex(interval.pointer,2)} · bank $${hex(interval.bank)}`);row.append(description);
    button(row,'Source bytes',()=>openMemory(frame,(interval.start+1)*frame.cyclesPerLine-1,interval.address));
  }
}
