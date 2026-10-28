// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { createSidCaptureView } from './sid-capture-view.js';
import { appendPixelBits } from './pixel-detail.js';
import { createCycleBudget } from './cycle-budget.js';
import { capturedRam, memoryEvidence, provenanceEvents, instructionGroups, capturedInstructions, interruptIntervals, frameTechniques, staticBorderCheck, explainPixel } from './provenance-model.js';
import { captureLabel } from './capture-context.js';
import { hex } from './memory-sampler.js';

const TITLES={code:'Execution and interrupts',learn:'Why this pixel? · techniques',atlas:'Captured memory',sid:'Captured voice changes',storage:'Captured REU transfers'};
export function createEvidenceView(root,kind,openFrame,openMemory,{inline=false,onPosition=()=>{},openCode=null}={}){
  if(kind==='sid')return createSidCaptureView(root,openFrame,{onPosition});
  const panel=document.createElement(inline?'section':'details');panel.className=inline?'monitor-evidence monitor-evidence-inline':'monitor-help monitor-evidence';
  panel.innerHTML=` ${inline?'':`<summary>${TITLES[kind]}</summary>`}<div class="monitor-evidence-head"><b></b>${inline?'':'<button class="btn" type="button">Close</button>'}</div><div class="monitor-evidence-budget"></div><div class="monitor-evidence-body"><div class="monitor-evidence-visual"><canvas width="384" height="272" aria-label="Captured picture, click a pixel to explain its source"></canvas><label>RAM address $<input maxlength="4" value="0400" aria-label="Captured RAM address"></label><pre></pre><button class="btn" data-evidence="video">Inspect this cycle in Video</button></div><div class="monitor-evidence-report"></div></div>`;
  root.append(panel);
  const picture=panel.querySelector('canvas'), ctx=picture.getContext('2d'), report=panel.querySelector('.monitor-evidence-report'), address=panel.querySelector('input'), bytes=panel.querySelector('pre');
  const pages=new Map();
  let active=false,frame=null,tick=0,px=160,py=100,events=[],groups=[],instructions=[],intervals=[],findings=[],border=null;
  const budget=createCycleBudget(panel.querySelector('.monitor-evidence-budget'),value=>{seek(value);onPosition(tick);});
  panel.querySelector('.monitor-evidence-head button')?.addEventListener('click',()=>panel.open=false);
  panel.querySelector('[data-evidence="video"]').addEventListener('click',()=>{if(frame)openFrame(frame,tick);});
  panel.addEventListener('toggle',()=>{if(panel.open)render();});
  address.addEventListener('change',()=>{pages.clear();render();});
  picture.addEventListener('click',event=>{if(!frame)return;const b=picture.getBoundingClientRect();px=Math.min(383,Math.max(0,Math.floor((event.clientX-b.left)/b.width*384)));py=Math.min(271,Math.max(0,Math.floor((event.clientY-b.top)/b.height*272)));tick=(py+frame.rasterOffset)*frame.cyclesPerLine;budget.seek(tick);onPosition(tick);render();});
  function text(title,body){const section=document.createElement('section'),h=document.createElement('h3'),p=document.createElement('p');h.textContent=title;p.textContent=body;section.append(h,p);report.append(section);return section;}
  function jump(section,position){const button=document.createElement('button');button.className='btn';button.textContent='Inspect this moment';button.addEventListener('click',()=>{tick=position;budget.seek(tick);onPosition(tick);render();});section.append(button);}
  function showGraphics(pixel){
    const g=pixel.graphics;if(!g)return;
    const section=text('How the byte becomes a pixel',"Highlighted bits select this pixel's colour source.");
    appendPixelBits(section,pixel);
    const link=document.createElement('a');link.href='https://www.cebix.net/VIC-Article.txt';link.target='_blank';link.rel='noopener noreferrer';link.textContent=`Bauer §${g.rule}: ${g.mode}`;section.append(link);
  }
  function page(rows,key,size=12) {
    const last=Math.max(0,Math.ceil(rows.length/size)-1),index=Math.min(pages.get(key)??0,last);
    pages.set(key,index);
    if(last){
      const nav=document.createElement('nav');nav.className='monitor-evidence-pages';nav.setAttribute('aria-label',key);
      const label=document.createElement('span');label.textContent=`${key}: ${index*size+1}–${Math.min(rows.length,(index+1)*size)} of ${rows.length}`;
      nav.append(label);
      for(const [name,delta] of [['Previous',-1],['Next',1]]){
        const b=document.createElement('button');b.className='btn';b.textContent=name;b.disabled=delta<0?index===0:index===last;
        b.addEventListener('click',()=>{pages.set(key,index+delta);render();});nav.append(b);
      }
      report.append(nav);
    }
    return rows.slice(index*size,(index+1)*size);
  }
  function render(){
    if((inline?!active:!panel.open)||panel.closest('[hidden]'))return;
    budget.seek(tick);
    panel.classList.toggle('has-evidence',!!frame?.provenance);
    report.replaceChildren();ctx.clearRect(0,0,384,272);bytes.textContent='';address.disabled=!frame?.provenance;panel.querySelector('[data-evidence="video"]').disabled=!frame;panel.querySelector('.monitor-evidence-head b').textContent=captureLabel(frame);
    if(!frame?.provenance){text('Detailed evidence is not available','Open Code or use Inspect to capture a complete frame with memory, fetch, execution, SID and REU evidence.');return;}
    if(events===null){events=provenanceEvents(frame,kind==='code'?[9,10]:kind==='storage'?[6,7]:kind==='learn'?[]:undefined);groups=kind==='code'?instructionGroups(frame):[];instructions=kind==='code'?capturedInstructions(frame):[];intervals=kind==='code'?interruptIntervals(frame):[];findings=kind==='learn'?frameTechniques(frame):[];border=kind==='learn'?staticBorderCheck(frame):null;}
    const p=frame.provenance;
    if(p.overflow||frame.overflow)text('Recording reached its limit','Some events are missing. Counts are lower bounds and historical RAM reconstruction is unavailable.');
    const image=ctx.createImageData(frame.width,frame.height);image.data.set(frame.rgba);ctx.putImageData(image,0,0);ctx.strokeStyle='#fff';ctx.strokeRect(px-3,py-3,7,7);
    const usesRam=kind==='atlas'||kind==='learn'||kind==='storage';
    address.parentElement.hidden=!usesRam;bytes.hidden=!usesRam;
    const ram=usesRam?capturedRam(frame,tick):null,base=parseInt(address.value,16)&65535;
    function showBytes(source){bytes.textContent=ram?`Captured RAM after raster ${Math.floor(tick/frame.cyclesPerLine)}, cycle ${tick%frame.cyclesPerLine+1}\n$${hex(source)}: ${Array.from({length:16},(_,i)=>hex(ram[(source+i)&65535],2)).join(' ')}`:'Historical RAM unavailable: missing or incomplete writes.';}
    if(usesRam)showBytes(base);
    if(kind==='learn'){
      const pixel=explainPixel(frame,px,py);text(pixel.title,pixel.text);showGraphics(pixel);if(pixel.address!==undefined){address.value=hex(pixel.address);showBytes(pixel.address);const section=text('Recorded source',`$${hex(pixel.address)}${pixel.value!==undefined?` supplied byte $${hex(pixel.value,2)}`:''}. This is source evidence, not proof of the programmer’s intent.`);if(pixel.tick!==undefined)jump(section,pixel.tick);if(openMemory){const button=document.createElement('button');button.className='btn';button.textContent='Inspect captured source in Memory';button.addEventListener('click',()=>openMemory(frame,pixel.tick??tick,pixel.address));section.append(button);}}
      text('Independent border check',border.supported?`${border.checked.toLocaleString()} pixel positions checked against the six Bauer comparator rules: ${border.mismatches} mismatches. Stable border controls only.`:border.reason);
      for(const finding of findings){const section=text(`${finding.status}: ${finding.title}`,finding.text);jump(section,finding.tick);}
    }else if(kind==='atlas'){
      text('The memory used at this moment','This view reconstructs underlying RAM from the frame-boundary snapshot and actual recorded RAM changes through the selected cycle. It does not substitute current memory or pretend RAM beneath ROM is ROM.');
      text('Mapping at frame start',`CPU port $${hex(p.cpuPort,2)}, DDR $${hex(p.cpuDDR,2)}, VIC bank $${hex(p.vicBank)}. Cartridge mode ${p.cartMode}. Later mapping effects are visible in actual fetched bytes, not inferred from this initial mapping.`);
      const chain=memoryEvidence(frame,base,tick);
      if(chain.writer!==null){
        const i=chain.writer,section=text('Last recorded change to this byte',`$${hex(base)} became $${hex(p.value[i],2)} at raster ${Math.floor(p.tick[i]/63)}, cycle ${p.tick[i]%63+1}.`);jump(section,p.tick[i]);
        if(openCode&&chain.origin!==null){const b=document.createElement('button');b.className='btn';b.textContent='Follow the captured instruction in Code';b.addEventListener('click',()=>openCode(p.pc[i],null,frame,p.tick[i]));section.append(b);}
      }else text('No earlier change recorded',chain.complete?'This byte retains its frame-start value through the selected cycle. Its earlier writer is outside this recording.':'The write history is incomplete.');
      for(const i of page(chain.consumers,'Later graphics consumers')){const section=text(p.kind[i]===15?'Later renderer source':'Later video fetch',`$${hex(base)} supplied $${hex(p.value[i],2)} at raster ${Math.floor(p.tick[i]/63)}, cycle ${p.tick[i]%63+1}. This establishes an address relationship, not that the earlier value survived intervening writes.`);jump(section,p.tick[i]);}
      const accesses=page(events.filter(e=>((e.address-base)&65535)<16&&[0,1,2,3,4,6,7,11,15].includes(e.kind)),'Memory accesses',20);
      for(const e of accesses)text(`Cycle ${e.tick}: $${hex(e.address)} → $${hex(e.value,2)}`,`Recorded ${(['CPU read','CPU write','VIC bus read','graphics fetch','sprite fetch','SID write','REU read','REU write'][e.kind]??(e.kind===15?'renderer source sample':'event'))}.`);
    }else if(kind==='code'){
      const interrupts=events.filter(e=>e.kind===9||e.kind===10);
      text('Executed instructions',`${groups.reduce((n,g)=>n+g.count,0)} dispatches, ${groups.length} distinct address/opcode pairs, ${interrupts.length} interrupt acceptances. An interval includes bus stalls and interrupt entry, not just instruction execution. The final incomplete interval is excluded.`);
      for(const g of page(groups,'Instruction groups')){const section=text(`${g.name} at $${hex(g.address)} · ${g.count} times`,`Captured opcode $${hex(g.opcode,2)}. ${g.elapsed} elapsed master cycles across ${g.completeIntervals} complete dispatch intervals. Repetition alone does not prove a wait loop.`);jump(section,g.first);if(openMemory){const link=document.createElement('button');link.className='btn';link.textContent='Source in Memory';link.addEventListener('click',()=>openMemory(frame,g.first,g.address));section.append(link);}}
      for(const span of page(intervals,'Interrupt intervals'))text(`${span.kind} service interval`, `${span.start===null?'Entry is outside the recorded evidence':`Accepted at cycle ${span.start}`}. ${span.end===null?'Return is outside this frame':`RTI completes at cycle ${span.end}, returning to $${hex(span.returnAddress)}`}. ${span.start!==null&&span.end!==null?`${span.end-span.start+1} elapsed cycles, including nested work and stalls.`:''}`);
      for(const row of page(instructions,'Captured instructions'))text(`Captured instruction $${hex(row.address)}`,`${row.bytes.slice(0,row.size).map(value=>value===null?'??':hex(value,2)).join(' ')} · cycle ${row.tick}. Operand bytes come from recorded reads, not current memory.`);
      for(const e of page(interrupts,'Interrupt acceptances')){const section=text(e.kind===9?'IRQ accepted':'NMI accepted',`CPU acceptance at raster ${Math.floor(e.tick/63)}, cycle ${e.tick%63+1}. VIC assertions and CIA sources require separate evidence.`);jump(section,e.tick);}
    }else{
      const transfers=events.filter(e=>e.kind===6||e.kind===7);
      text('REU bus transfers',`${transfers.length} C64-side accesses recorded. Reads can belong to stash, swap or verify, so a read alone is not labelled a completed transfer. Drive/tape file attribution is not captured.`);
      for(const e of page(transfers,'REU accesses',24)){const section=text(`$${hex(e.address)} ${e.kind===6?'→ REU read':'← REU write'} $${hex(e.value,2)}`,`Expansion address $${hex(e.aux&0xffffff,6)}, command type ${(e.aux>>>24)&3} (0 stash, 1 fetch, 2 swap, 3 verify). Actual access at raster ${Math.floor(e.tick/63)}, cycle ${e.tick%63+1}.`);jump(section,e.tick);if(openMemory&&e.kind===7&&p.kind[e.index+1]===12&&p.address[e.index+1]===e.address&&p.tick[e.index+1]===e.tick){const b=document.createElement('button');b.className='btn';b.textContent='Follow the RAM destination';b.addEventListener('click',()=>openMemory(frame,e.tick,e.address));section.append(b);}}
    }
  }
  function setFrame(value){pages.clear();frame=value;tick=kind==='learn'&&frame?(py+frame.rasterOffset)*frame.cyclesPerLine:0;events=null;groups=[];instructions=[];intervals=[];findings=[];border=null;budget.setFrame(value,{render:false});if(!value){report.replaceChildren();bytes.textContent='';}render();}
  function seek(position){tick=Math.max(0,Math.min((frame?.lines*frame?.cyclesPerLine||1)-1,position));render();}
  return {remember(){const saved={frame,tick,open:panel.open,address:address.value,pages:new Map(pages)};return()=>{setFrame(saved.frame);tick=saved.tick;address.value=saved.address;pages.clear();for(const [key,value] of saved.pages)pages.set(key,value);panel.open=saved.open;render();};},setFrame,seek,setActive(value){active=value;render();},inspect(value,position,source){setFrame(value);tick=position;address.value=hex(source);panel.open=true;render();},theme(){render();}};
}

export function createSectionEvidence(root,kind,openFrame,openMemory,options={}) {
  const modes=document.createElement('div');modes.className='monitor-section-modes monitor-evidence-modes';
  const live=document.createElement('button'),captured=document.createElement('button');
  for(const button of [live,captured]){button.type='button';button.className='btn';}
  live.textContent=kind==='sid'?'SID settings':'Live memory';captured.textContent=TITLES[kind];modes.append(live,captured);root.prepend(modes);
  const holder=document.createElement('div');holder.className='monitor-section-evidence';root.append(holder);
  const evidence=createEvidenceView(holder,kind,openFrame,openMemory,{...options,inline:true});
  const recent=options.recentPane?document.createElement('button'):null;
  if(recent){recent.type='button';recent.className='btn';recent.textContent='Recent activity';modes.insertBefore(recent,captured);recent.addEventListener('click',()=>select('recent'));}
  let active=false,selected=false;
  function select(value){selected=value;const isCaptured=value===true,isRecent=value==='recent';root.classList.toggle('is-captured-evidence',isCaptured);root.classList.toggle('is-recent-activity',isRecent);holder.hidden=!isCaptured;live.setAttribute('aria-pressed',String(!value));captured.setAttribute('aria-pressed',String(isCaptured));recent?.setAttribute('aria-pressed',String(isRecent));if(options.recentPane)options.recentPane.hidden=!isRecent;evidence.setActive(active&&isCaptured);}
  live.addEventListener('click',()=>select(false));captured.addEventListener('click',()=>select(true));select(false);
  return {...evidence,remember(){const restore=evidence.remember(),wasSelected=selected;return()=>{select(wasSelected);restore();};},setActive(value){active=value;evidence.setActive(active&&selected===true);},inspect(...args){select(true);evidence.inspect(...args);},live(){select(false);}};
}
