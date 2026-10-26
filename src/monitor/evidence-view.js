// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { appendPixelBits } from './pixel-detail.js';
import { createCycleBudget } from './cycle-budget.js';
import { capturedRam, provenanceEvents, instructionGroups, capturedInstructions, interruptIntervals, frameTechniques, staticBorderCheck, explainPixel } from './provenance-model.js';
import { captureLabel } from './capture-context.js';
import { hex } from './memory-sampler.js';

const TITLES={code:'Execution and interrupts',learn:'Why this pixel? · techniques',atlas:'Captured memory',sid:'Captured voice changes',storage:'Captured REU transfers'};
export function createEvidenceView(root,kind,openFrame,openMemory,{inline=false,onPosition=()=>{}}={}){
  const panel=document.createElement(inline?'section':'details');panel.className=inline?'monitor-evidence monitor-evidence-inline':'monitor-help monitor-evidence';
  panel.innerHTML=` ${inline?'':`<summary>${TITLES[kind]}</summary>`}<div class="monitor-evidence-head"><b></b>${inline?'':'<button class="btn" type="button">Close</button>'}</div><div class="monitor-evidence-budget"></div><div class="monitor-evidence-body"><div class="monitor-evidence-visual"><canvas width="384" height="272" aria-label="Captured picture, click a pixel to explain its source"></canvas><label>RAM address $<input maxlength="4" value="0400" aria-label="Captured RAM address"></label><pre></pre><button class="btn" data-evidence="video">Inspect this cycle in Video</button></div><div class="monitor-evidence-report"></div></div>`;
  root.append(panel);
  const picture=panel.querySelector('canvas'), ctx=picture.getContext('2d'), report=panel.querySelector('.monitor-evidence-report'), address=panel.querySelector('input'), bytes=panel.querySelector('pre');
  let active=false,frame=null,tick=0,px=160,py=100,events=[],groups=[],findings=[],border=null;
  const budget=createCycleBudget(panel.querySelector('.monitor-evidence-budget'),value=>{seek(value);onPosition(tick);});
  panel.querySelector('.monitor-evidence-head button')?.addEventListener('click',()=>panel.open=false);
  panel.querySelector('[data-evidence="video"]').addEventListener('click',()=>{if(frame)openFrame(frame,tick);});
  panel.addEventListener('toggle',()=>{if(panel.open)render();});
  address.addEventListener('change',()=>render());
  picture.addEventListener('click',event=>{if(!frame)return;const b=picture.getBoundingClientRect();px=Math.min(383,Math.max(0,Math.floor((event.clientX-b.left)/b.width*384)));py=Math.min(271,Math.max(0,Math.floor((event.clientY-b.top)/b.height*272)));tick=(py+frame.rasterOffset)*frame.cyclesPerLine;budget.seek(tick);onPosition(tick);render();});
  function text(title,body){const section=document.createElement('section'),h=document.createElement('h3'),p=document.createElement('p');h.textContent=title;p.textContent=body;section.append(h,p);report.append(section);return section;}
  function jump(section,position){const button=document.createElement('button');button.className='btn';button.textContent='Inspect this moment';button.addEventListener('click',()=>{tick=position;budget.seek(tick);onPosition(tick);render();});section.append(button);}
  function showGraphics(pixel){
    const g=pixel.graphics;if(!g)return;
    const section=text('How the byte becomes a pixel',"Highlighted bits select this pixel's colour source.");
    appendPixelBits(section,pixel);
    const link=document.createElement('a');link.href='https://www.cebix.net/VIC-Article.txt';link.target='_blank';link.rel='noopener noreferrer';link.textContent=`Bauer §${g.rule}: ${g.mode}`;section.append(link);
  }
  function render(){
    if((inline?!active:!panel.open)||panel.closest('[hidden]'))return;
    budget.seek(tick);
    panel.classList.toggle('has-evidence',!!frame?.provenance);
    report.replaceChildren();ctx.clearRect(0,0,384,272);bytes.textContent='';address.disabled=!frame?.provenance;panel.querySelector('[data-evidence="video"]').disabled=!frame;panel.querySelector('.monitor-evidence-head b').textContent=captureLabel(frame);
    if(!frame?.provenance){text('Detailed evidence is not available','Open Code or use Inspect to capture a complete frame with memory, fetch, execution, SID and REU evidence.');return;}
    if(events===null){events=provenanceEvents(frame);groups=kind==='code'?instructionGroups(frame):[];findings=kind==='learn'?frameTechniques(frame):[];border=kind==='learn'?staticBorderCheck(frame):null;}
    const p=frame.provenance;
    if(p.overflow||frame.overflow)text('Recording reached its limit','Some events are missing. Counts are lower bounds and historical RAM reconstruction is unavailable.');
    const image=ctx.createImageData(frame.width,frame.height);image.data.set(frame.rgba);ctx.putImageData(image,0,0);ctx.strokeStyle='#fff';ctx.strokeRect(px-3,py-3,7,7);
    const ram=capturedRam(frame,tick),base=parseInt(address.value,16)&65535;
    function showBytes(source){bytes.textContent=ram?`Captured RAM after raster ${Math.floor(tick/frame.cyclesPerLine)}, cycle ${tick%frame.cyclesPerLine+1}\n$${hex(source)}: ${Array.from({length:16},(_,i)=>hex(ram[(source+i)&65535],2)).join(' ')}`:'Historical RAM unavailable: missing or incomplete writes.';}
    showBytes(base);
    if(kind==='learn'){
      const pixel=explainPixel(frame,px,py);text(pixel.title,pixel.text);showGraphics(pixel);if(pixel.address!==undefined){address.value=hex(pixel.address);showBytes(pixel.address);const section=text('Recorded source',`$${hex(pixel.address)}${pixel.value!==undefined?` supplied byte $${hex(pixel.value,2)}`:''}. This is source evidence, not proof of the programmer’s intent.`);if(pixel.tick!==undefined)jump(section,pixel.tick);if(openMemory){const button=document.createElement('button');button.className='btn';button.textContent='Inspect captured source in Memory';button.addEventListener('click',()=>openMemory(frame,pixel.tick??tick,pixel.address));section.append(button);}}
      text('Independent border check',border.supported?`${border.checked.toLocaleString()} pixel positions checked against the six Bauer comparator rules: ${border.mismatches} mismatches. Stable border controls only.`:border.reason);
      for(const finding of findings){const section=text(`${finding.status}: ${finding.title}`,finding.text);jump(section,finding.tick);}
    }else if(kind==='atlas'){
      text('The memory used at this moment','This view reconstructs underlying RAM from the frame-boundary snapshot and actual recorded RAM changes through the selected cycle. It does not substitute current memory or pretend RAM beneath ROM is ROM.');
      text('Mapping at frame start',`CPU port $${hex(p.cpuPort,2)}, DDR $${hex(p.cpuDDR,2)}, VIC bank $${hex(p.vicBank)}. Cartridge mode ${p.cartMode}. Later mapping effects are visible in actual fetched bytes, not inferred from this initial mapping.`);
      const accesses=events.filter(e=>e.address>=base&&e.address<base+16&&e.kind!==12).slice(0,20);
      for(const e of accesses)text(`Cycle ${e.tick}: $${hex(e.address)} → $${hex(e.value,2)}`,`Recorded ${(['CPU read','CPU write','VIC bus read','graphics fetch','sprite fetch','SID write','REU read','REU write'][e.kind]??(e.kind===15?'renderer source sample':'event'))}.`);
    }else if(kind==='code'){
      const interrupts=events.filter(e=>e.kind===9||e.kind===10);
      text('Executed instructions',`${groups.reduce((n,g)=>n+g.count,0)} dispatches, ${groups.length} distinct address/opcode pairs, ${interrupts.length} interrupt acceptances. An interval includes bus stalls and interrupt entry, not just instruction execution. The final incomplete interval is excluded.`);
      for(const g of groups.slice(0,12)){const section=text(`${g.name} at $${hex(g.address)} · ${g.count} times`,`Captured opcode $${hex(g.opcode,2)}. ${g.elapsed} elapsed master cycles across ${g.completeIntervals} complete dispatch intervals. Repetition alone does not prove a wait loop.`);jump(section,g.first);if(openMemory){const link=document.createElement('button');link.className='btn';link.textContent='Source in Memory';link.addEventListener('click',()=>openMemory(frame,g.first,g.address));section.append(link);}}
      for(const span of interruptIntervals(frame).slice(0,12))text(`${span.kind} service interval`, `${span.start===null?'Entry is outside the recorded evidence':`Accepted at cycle ${span.start}`}. ${span.end===null?'Return is outside this frame':`RTI completes at cycle ${span.end}, returning to $${hex(span.returnAddress)}`}. ${span.start!==null&&span.end!==null?`${span.end-span.start+1} elapsed cycles, including nested work and stalls.`:''}`);
      for(const row of capturedInstructions(frame).slice(0,12))text(`Captured instruction $${hex(row.address)}`,`${row.bytes.slice(0,row.size).map(value=>value===null?'??':hex(value,2)).join(' ')} · cycle ${row.tick}. Operand bytes come from recorded reads, not current memory.`);
      for(const e of interrupts.slice(0,12)){const section=text(e.kind===9?'IRQ accepted':'NMI accepted',`CPU acceptance at raster ${Math.floor(e.tick/63)}, cycle ${e.tick%63+1}. VIC assertions and CIA sources require separate evidence.`);jump(section,e.tick);}
    }else if(kind==='sid'){
      text('Sound over this captured frame',`${events.filter(e=>e.kind===5).length} exact SID writes across ${p.sidCount} chip(s). These are register transitions, not sampled audio or measured loudness.`);
      for(let chip=0;chip<p.sidCount;chip++)for(let voice=0;voice<3;voice++){
        const base=voice*7,initial=chip*32+base,voiceEvents=events.filter(e=>e.kind===5&&e.aux===chip&&e.address>=base&&e.address<base+7);
        const section=text(`SID ${chip+1} · voice ${voice+1}`,`${voiceEvents.length} writes. Initial pitch register ${p.sid[initial]|p.sid[initial+1]<<8}. Gate, pitch, waveform and envelope settings are recorded independently.`);
        const canvas=document.createElement('canvas');canvas.width=600;canvas.height=55;canvas.className='monitor-evidence-voice';section.append(canvas);
        const c=canvas.getContext('2d'),style=getComputedStyle(panel);let frequency=p.sid[initial]|p.sid[initial+1]<<8,gate=p.sid[initial+4]&1,previous=0;c.strokeStyle=style.getPropertyValue('--accent').trim();
        for(const e of [...voiceEvents,{tick:frame.lines*frame.cyclesPerLine,address:-1}]){const x=e.tick/(frame.lines*frame.cyclesPerLine)*600,y=50-45*Math.log2(1+frequency)/16;c.globalAlpha=gate?1:.3;c.beginPath();c.moveTo(previous,y);c.lineTo(x,y);c.stroke();previous=x;if(e.address===base)frequency=(frequency&0xff00)|e.value;if(e.address===base+1)frequency=(frequency&255)|(e.value<<8);if(e.address===base+4)gate=e.value&1;}
        if(voiceEvents.length)jump(section,voiceEvents[0].tick);
      }
      for(let chip=0;chip<p.sidCount;chip++)text(`SID ${chip+1} filter and volume`,`${events.filter(e=>e.kind===5&&e.aux===chip&&e.address>=0x15&&e.address<=0x18).length} writes to cutoff, resonance/routing or mode/volume. Model-specific audio response is not reconstructed here.`);
    }else{
      const transfers=events.filter(e=>e.kind===6||e.kind===7);
      text('REU bus transfers',`${transfers.length} C64-side accesses recorded. Reads can belong to stash, swap or verify, so a read alone is not labelled a completed transfer. Drive/tape file attribution is not captured.`);
      for(const e of transfers.slice(0,24)){const section=text(`$${hex(e.address)} ${e.kind===6?'→ REU read':'← REU write'} $${hex(e.value,2)}`,`Expansion address $${hex(e.aux&0xffffff,6)}, command type ${(e.aux>>>24)&3} (0 stash, 1 fetch, 2 swap, 3 verify). Actual access at raster ${Math.floor(e.tick/63)}, cycle ${e.tick%63+1}.`);jump(section,e.tick);}
    }
  }
  function setFrame(value){frame=value;tick=kind==='learn'&&frame?(py+frame.rasterOffset)*frame.cyclesPerLine:0;events=null;groups=[];findings=[];border=null;budget.setFrame(value,{render:false});if(!value){report.replaceChildren();bytes.textContent='';}render();}
  function seek(position){tick=Math.max(0,Math.min((frame?.lines*frame?.cyclesPerLine||1)-1,position));render();}
  return {setFrame,seek,setActive(value){active=value;render();},inspect(value,position,source){setFrame(value);tick=position;address.value=hex(source);panel.open=true;render();},theme(){render();}};
}
