// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { formatStorageRate } from './storage-rates.js';
import { menuIcon } from './menu-icons.js';
import { createLiveSound } from './live-sound.js';
import { LiveWindowSummary } from './live-summary.js';
import { LiveCardHistory } from './live-history.js';
import { hex } from './memory-sampler.js';
import { graphicsLayout } from './setup-model.js';
import { activeStorageDevice, STORAGE_DEVICES } from './storage-model.js';
import { LIVE_COMPONENTS, videoMode, enabledSpriteCount, soundSummary, controlSummary } from './live-model.js';
import { liveCodeSummary, showLiveSampleDetails } from './live-code.js';
import { createLiveVideoView, capturedSpriteEnables } from './live-video.js';

// Connections describe hardware relationships, not unrecorded bus transfers.
export function createMachineView(root, navigate, openGuide) {
  root.innerHTML=`<div class="monitor-machine-heading"><h2>The living machine</h2><button type="button" class="monitor-sampling-rate" data-monitor="sampling-rate">↻ 10 samples/s</button></div><div class="monitor-machine-board monitor-live-board"><svg class="monitor-machine-wires" aria-hidden="true"><path/><path class="monitor-external-wire"/></svg>${LIVE_COMPONENTS.map((c,i)=>`<article class="monitor-live-card" data-card="${c.key}" style="--card-column:${i%3+1};--card-row:${i<3?1:3}"><div class="monitor-live-copy"><small class="monitor-live-chip">${c.chip}</small><h3>${menuIcon(c.view)}<span>${c.title}</span></h3><strong data-live="${c.key}-status"></strong><span class="monitor-live-detail" data-live="${c.key}-detail"></span><span class="monitor-live-detail" data-live="${c.key}-extra"></span>${c.key==='cpu'?`<div class="monitor-code-signals"><span data-live="cpu-irq" role="img" title="IRQ request line at this sample. Short requests can occur between samples."><i aria-hidden="true"></i>IRQ request</span><span data-live="cpu-mask" role="img" title="CPU I flag is clear. Interrupt polling and instruction timing still determine acceptance."><i aria-hidden="true"></i>IRQ allowed</span></div>`:`<p>${c.purpose}</p>`}<div class="monitor-live-actions"><button type="button" data-machine="${c.key}">Inspect ${c.action} ↗</button><button type="button" data-about="${c.key}">ⓘ About</button></div></div><div class="monitor-card-snapshot">${c.key==='vic'?`<div data-live="vic-visual" role="group"></div>`:c.key==='sid'?`<div class="monitor-live-sound" data-live="sid-visual" role="group"></div>`:`<canvas width="256" height="224" data-live="${c.key}-visual" role="img"></canvas>`}${c.key==='cpu'?`<div class="monitor-code-location"><span>EXECUTION LOCATIONS</span><strong data-live="cpu-source"></strong></div><div class="monitor-code-plot"><span class="monitor-code-high">$FFFF</span><span class="monitor-code-low">$0000</span><div class="monitor-code-times"><span data-live="cpu-duration"></span><span>now →</span></div></div>`:''}${c.key==='storage-link'?`<div class="monitor-live-devices">${['8','9','Tape','CRT','REU'].map((name,index)=>`<button type="button" data-device="${index}" aria-label="Inspect ${STORAGE_DEVICES[index]}">${name}</button>`).join('')}</div><div class="monitor-storage-rate"><strong data-live="storage-rate"></strong><span data-live="storage-rate-scope"></span></div>`:''}<small data-live="${c.key}-caption"${c.key==='vic'?' hidden':''}></small></div></article>`).join('')}<span class="monitor-live-bus" title="Solid: C64 connections. Dashed: external storage." aria-label="Shared address and data connections. Solid lines connect C64 components, dashed lines connect external storage.">Shared address and data connections</span></div>`;
  const el=name=>root.querySelector(`[data-live="${name}"]`);
  const liveVideo=createLiveVideoView(el('vic-visual'));
  const liveSound=createLiveSound(el('sid-visual'),el('sid-caption'),navigate);
  const cards=LIVE_COMPONENTS.map(c=>root.querySelector(`[data-card="${c.key}"]`));
  const board=root.querySelector('.monitor-live-board'), wires=root.querySelector('.monitor-machine-wires');
  const visualScale=Object.fromEntries(LIVE_COMPONENTS.map(c=>[c.key,1]));
  let storagePlotTop=178, cpuPlotTop=82, cpuPlotBottom=172;
  const layoutWires=()=>{
    if(!board.clientWidth||!board.clientHeight)return;
    const b=board.getBoundingClientRect(), boxes=cards.map(card=>card.getBoundingClientRect());
    for(let i=0;i<cards.length;i++) {
      const height=boxes[i].height-2, caption=el(LIVE_COMPONENTS[i].key+'-caption').getBoundingClientRect().height;
      visualScale[LIVE_COMPONENTS[i].key]=height>0?Math.max(.2,(height-caption)/height):1;
    }
    const cpuIndex=LIVE_COMPONENTS.findIndex(c=>c.key==='cpu');
    const high=root.querySelector('.monitor-code-high').getBoundingClientRect(), low=root.querySelector('.monitor-code-low').getBoundingClientRect();
    const cpuScale=224/((boxes[cpuIndex].height-2)*visualScale.cpu);
    cpuPlotTop=(high.bottom-boxes[cpuIndex].top+5)*cpuScale;
    cpuPlotBottom=Math.max(cpuPlotTop+4,(low.top-boxes[cpuIndex].top-5)*cpuScale);
    const storageIndex=LIVE_COMPONENTS.findIndex(c=>c.key==='storage-link');
    const rateBox=root.querySelector('.monitor-storage-rate').getBoundingClientRect();
    storagePlotTop=Math.min(202,Math.max(140,(rateBox.bottom-boxes[storageIndex].top+8)*224/((boxes[storageIndex].height-2)*visualScale['storage-link'])));
    const y=(boxes[0].bottom+boxes[3].top)/2-b.top;
    const points=boxes.map(r=>({x:r.left+r.width/2-b.left,top:r.top-b.top,bottom:r.bottom-b.top}));
    const left=points[0].x,right=points[2].x;
    let path=`M${left},${y}H${right}`;
    for(let i=0;i<5;i++)path+=`M${points[i].x},${i<3?points[i].bottom:points[i].top}V${y}`;
    wires.setAttribute('viewBox',`0 0 ${b.width} ${b.height}`);wires.children[0].setAttribute('d',path);wires.children[1].setAttribute('d',`M${points[5].x},${y}V${points[5].top}`);
  };
  const observer=new ResizeObserver(layoutWires);observer.observe(board);cards.forEach((card,i)=>{observer.observe(card);observer.observe(el(LIVE_COMPONENTS[i].key+'-caption'));});
  let primary=0, memoryPage=4, owner=null, lastDraw=-Infinity, lastPaused=false, reuObserved=false;
  const summaries=new LiveWindowSummary();
  let recentSummary=null;
  let capturedSprites=null;
  const history=new LiveCardHistory(), pages=new Uint16Array(256), ages=new Float64Array(256);
  const contexts=Object.fromEntries(LIVE_COMPONENTS.filter(c=>c.key!=='vic'&&c.key!=='sid').map(c=>[c.key,el(c.key+'-visual').getContext('2d')]));
  const guideKeys=['drive','drive','tape','crt','reu'];
  for(const c of LIVE_COMPONENTS) {
    const inspect=()=>navigate(c.view,c.key==='ram'?memoryPage<<8:c.key==='storage-link'?primary:undefined);
    root.querySelector(`[data-machine="${c.key}"]`).addEventListener('click',inspect);
    root.querySelector(`[data-card="${c.key}"]`).addEventListener('click',event=>{
      if(!event.target.closest('button, a, input, select, textarea')) inspect();
    });
    const about=root.querySelector(`[data-about="${c.key}"]`);about.setAttribute('aria-label',`About ${c.title}`);
    about.addEventListener('click',()=>openGuide(c.key==='storage-link'?guideKeys[primary]:c.guide));
  }
  root.querySelectorAll('[data-device]').forEach(button=>button.addEventListener('click',()=>navigate('storage',Number(button.dataset.device))));

  let accent,quiet,ink,background;
  function theme(){const s=getComputedStyle(root);accent=s.getPropertyValue('--accent').trim();quiet=s.getPropertyValue('--border').trim();ink=s.getPropertyValue('--dim').trim();background=s.getPropertyValue('--control-bg').trim();liveSound.theme();lastDraw=-Infinity;}
  function text(key,status,detail='',extra='',caption='') {if(!lastPaused&&['cpu','ram','vic','sid'].includes(key)){[status,detail]=recentSummary?.[key]??[LIVE_COMPONENTS.find(c=>c.key===key).purpose,'Gathering recent observations…'];}el(key+'-status').textContent=status;el(key+'-detail').textContent=detail;el(key+'-extra').textContent=extra;el(key+'-caption').textContent=caption;el(key+'-visual').setAttribute('aria-label',`${status}. ${detail}. ${caption}`);}
  function observe(facade,state,sampler,storage,paused) {
    const now=facade.capturedAt;
    if(facade!==owner){owner=facade;reuObserved=false;history.reset();summaries.reset();ages.fill(0);pages.fill(0);theme();}
    history.sample(state,storage,facade.cpuMemorySource(state.pc),now,paused,facade.intervalMs);
    reuObserved ||= history.storage.reuChanged;
    recentSummary=summaries.observe(state,sampler,now,paused);
  }
  function update(facade,state,sampler,storage,paused,controls) {
    observe(facade,state,sampler,storage,paused);
    const now=facade.capturedAt;
    const fresh=now!==lastDraw;
    lastDraw=now;lastPaused=paused;
    const sampleDetails=showLiveSampleDetails(facade.rate,paused);
    for(const [key,ctx] of Object.entries(contexts)){ctx.resetTransform();ctx.clearRect(0,0,256,224);ctx.fillStyle=background;ctx.fillRect(0,0,256,224);ctx.scale(1,key==='ram'||key==='controls'?1:visualScale[key]);}
    const layout=graphicsLayout(state), source=facade.cpuMemorySource(state.pc);
    const code=liveCodeSummary(state,paused);
    text('cpu',code.action,code.evidence,`PC $${hex(state.pc)}${sampleDetails?` · ${code.sample}`:''}`,paused?'Paused · samples held':'Sampled CPU positions');
    el('cpu-source').textContent=sampleDetails?source.replace(/ ROM$/, ''):'CPU positions';
    el('cpu-source').title=`Current mapping at CPU position $${hex(state.pc)}: ${source}`;
    for(const [name,active] of [['irq',code.irq],['mask',code.irqAllowed]]) {
      const indicator=el('cpu-'+name);
      indicator.classList.toggle('is-active',active);
      indicator.setAttribute('aria-label',`${name==='irq'?'IRQ request':'IRQ allowed by CPU flag'}: ${active?'yes':'no'}`);
    }
    const cpu=contexts.cpu;
    cpu.strokeStyle=quiet;cpu.setLineDash([2,5]);
    for(let line=0;line<4;line++){const y=cpuPlotTop+(cpuPlotBottom-cpuPlotTop)*line/3;cpu.beginPath();cpu.moveTo(12,y);cpu.lineTo(244,y);cpu.stroke();}
    cpu.setLineDash([]);
    for(let t=0;t<history.count;t++) {
      const i=history.index(t);cpu.globalAlpha=.3+.7*(t+1)/history.count;
      cpu.fillStyle=history.source[i]===0?accent:history.source[i]===1?ink:quiet;
      cpu.fillRect(history.seconds?12+232*(history.times[i]-history.times[history.index(0)])/(history.seconds*1000):244,cpuPlotTop+(1-history.pc[i]/65535)*(cpuPlotBottom-cpuPlotTop),2.5,4);
    }
    cpu.globalAlpha=1;
    el('cpu-duration').textContent=history.count>1?`${history.seconds.toFixed(1)}s ago`:'first sample';
    el('cpu-visual').setAttribute('aria-label',`Sampled CPU positions across $0000 to $FFFF, oldest to newest. Current mapping: ${source}. Clusters suggest repetition, not a proven loop or time percentage.`);
    let changed=0, count=0, best=0;
    pages.set(sampler.pages);
    changed=sampler.changed;
    for(let p=0;p<256;p++) {
      if(pages[p]) { count++; ages[p]=now+1000; if(pages[p]>best){best=pages[p];memoryPage=p;} }
      else if(fresh&&ages[p]<=now) ages[p]=0;
    }
    text('ram',`${count} / 256 pages changed`,`${changed.toLocaleString()} byte location${changed===1?'':'s'} observed changing`,'Explore graphics in Memory','RAM activity');
    const ram=contexts.ram;
    for(let p=0;p<256;p++){ram.globalAlpha=pages[p]?1:ages[p]?Math.max(.25,(ages[p]-now)/1000):1;ram.fillStyle=pages[p]||ages[p]?accent:quiet;ram.fillRect(p%16*16+1,Math.floor(p/16)*12+1,13,9);}
    ram.globalAlpha=1;
    const r=state.vic;
    text('vic',videoMode(state),`${enabledSpriteCount(r[0x15])} / 8 sprite slots enabled`,`${layout.bitmapOn?'Bitmap':'Patterns'} from ${facade.vicMemorySource(layout.bitmapOn?layout.bitmap:layout.characters,layout.bank)}`,'Configured window · sprite slots');
    if(capturedSprites!==null) {
      const detail=`${enabledSpriteCount(capturedSprites)} / 8 sprite slots enabled during the captured frame`;
      el('vic-detail').textContent=detail;
      el('vic-visual').setAttribute('aria-label',detail);
    }
    liveVideo.update(state,capturedSprites);
    const sound=soundSummary(state);text('sid',sound.title,sound.waves,sampleDetails?sound.filter:'','Pitch settings');
    liveSound.update(state,history,now,sampleDetails);
    const control=controlSummary(controls);text('controls',control.title,control.detail,controls?`${control.keys} keyboard keys held`:'',controls?'Port signals · sampled state':'Observation unavailable');
    const ic=contexts.controls;ic.font='15px monospace';
    for(let port=0;port<2;port++){ic.fillStyle=ink;ic.fillText(`Port ${port+1}`,16,24+port*82);for(let i=0;i<5;i++){const x=16+i*46,y=38+port*82;ic.fillStyle=controls&&!(controls.ports[port]&(1<<i))?accent:quiet;ic.fillRect(x,y,37,30);ic.fillStyle=background;ic.fillText(['↑','↓','←','→','F'][i],x+12,y+21);}}
    for(let i=0;i<4;i++){ic.fillStyle=controls?.timerControl[i]&1?accent:quiet;ic.fillRect(16+i*57,178,47,12);}
    const present=[storage.drives[0].hasMedia,storage.drives[1].hasMedia,storage.tape.hasMedia,storage.cartridge.inserted,storage.reu.attached];
    const busy=[storage.drives[0].motor||storage.drives[0].led,storage.drives[1].motor||storage.drives[1].led,storage.tape.motor||storage.tape.recording,false,storage.reu.active||reuObserved];
    for(let i=0;i<busy.length;i++) busy[i] ||= (storage.rates?.[i]?.total??0)>0;
    primary=activeStorageDevice(storage,primary,reuObserved);
    let detail='',extra='';
    if(primary<2){const d=storage.drives[primary];detail=d.label|| (d.hasMedia?'Disk inserted':'No disk inserted');extra=busy[primary]?'Motor / indicator active':d.mode==='accelerated'?'Accelerated drive · no motor samples':'Drive idle';}
    else if(primary===2){detail=storage.tape.hasMedia?`${Math.round(storage.tape.fraction*100)}% of tape`:'No tape inserted';extra=storage.tape.recording?'Recording':storage.tape.motor?'Motor running':storage.tape.key;}
    else if(primary===3){detail=storage.cartridge.label||'Cartridge inserted';extra=`${storage.cartridge.mode} · bank ${storage.cartridge.bank}`;}
    else {detail=`${storage.reu.bytes/1024} KB expansion`;extra=busy[4]?'Transfer observed':'No recent transfer observed';}
    const activeCount=busy.filter(Boolean).length;
    text('storage-link',activeCount>1?`${activeCount} devices active`:present.some(Boolean)||busy.some(Boolean)?STORAGE_DEVICES[primary]:'No media',detail,extra,primary<2?'Motor / LED samples':primary===2?'Transport samples':primary===3?'Mapped memory':'Transfer observations');
    root.querySelectorAll('[data-device]').forEach((button,i)=>{button.classList.toggle('is-present',present[i]);button.classList.toggle('is-active',busy[i]);button.setAttribute('aria-pressed',String(primary===i));button.title=`${STORAGE_DEVICES[i]}: ${busy[i]?'activity observed':present[i]?'present':'empty'}`;});
    const rate=storage.rates?.[primary];
    el('storage-rate').textContent=!rate?.available?'— B/s':rate.ready?formatStorageRate(rate.total):'Measuring…';
    el('storage-rate-scope').textContent=rate?.scope||'No media';
    el('storage-link-caption').textContent='Byte rate · history';
    const st=contexts['storage-link'];
    if(rate){const peak=Math.max(1,...rate.history);for(let t=0;t<rate.historyCount;t++){const i=(rate.historyCursor-rate.historyCount+t+401)%401,value=rate.history[i];const h=Math.max(1,value/peak*Math.max(4,208-storagePlotTop));st.fillStyle=value?accent:quiet;st.fillRect(256*(rate.historyTimes[i]-now+8000)/8000,208-h,2.5,h);}}
    reuObserved=false;

  }
  return { update,observe,theme, setFrame(frame){capturedSprites=capturedSpriteEnables(frame);}, reset(){capturedSprites=null;owner=null;history.reset();summaries.reset();lastDraw=-Infinity;}, activate(){lastDraw=-Infinity;} };
}
