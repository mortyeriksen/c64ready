// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { recentLoads } from './activity-model.js';
import { TapePulseWindow, TAPE_CLOCK_HZ } from './tape-pulses.js';
import { cartridgeWindows, reuFrameAccesses } from './storage-analysis-model.js';
import { reuSettings } from './storage-model.js';
import { formatStorageRate } from './storage-rates.js';
import { hex } from './memory-sampler.js';

export function createStorageAnalysis(root, { openCode, openMemory, openFrame, openCapturedMemory }) {
  root.innerHTML = `<div class="monitor-storage-plot-head"><b data-plot="title"></b><button type="button" class="btn" data-plot="zoom" hidden>Zoom ×2</button></div>
    <canvas width="800" height="190" tabindex="0" data-plot="canvas" aria-label="Storage activity diagram"></canvas>
    <div class="monitor-storage-plot-axis"><span data-plot="left"></span><span data-plot="right"></span></div>
    <strong class="monitor-storage-reading" data-plot="reading"></strong><p data-plot="note"></p>
    <div data-plot="loads" class="monitor-storage-loads"></div><div class="monitor-storage-plot-links"><button type="button" class="monitor-storage-link" data-plot="video" hidden>Inspect cycle in Video ↗</button><button type="button" class="monitor-storage-link" data-plot="memory" hidden>Inspect captured RAM ↗</button></div>`;
  const el = name => root.querySelector(`[data-plot="${name}"]`), canvas = el('canvas'), ctx = canvas.getContext('2d');
  const tape = new TapePulseWindow();
  let current = null, history = null, selected = 0, frame = null, frameData = null;
  let pulses = [], accessIndex = 0, zoom = false, windows = [];
  let ink, accent, dim, bg, border;
  function theme() {
    const style = getComputedStyle(root);
    ink = style.getPropertyValue('--text').trim(); accent = style.getPropertyValue('--accent').trim();
    dim = style.getPropertyValue('--dim').trim(); bg = style.getPropertyValue('--ui-bg').trim(); border = style.getPropertyValue('--border').trim();
  }
  function text(value, x, y, colour = dim, size = 15) { ctx.fillStyle = colour; ctx.font = `${size}px monospace`; ctx.textAlign = 'left'; ctx.fillText(value,x,y); }
  function line(x,y,endX,endY,colour=border,width=1) { ctx.strokeStyle=colour; ctx.lineWidth=width; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(endX,endY); ctx.stroke(); }
  function empty(message) { text(message,25,100,dim,18); }
  function showPulse() {
    const total = pulses.reduce((sum,p)=>sum+p.cycles,0);
    el('left').textContent='0 ms'; el('right').textContent=`${(total/TAPE_CLOCK_HZ*1000).toFixed(2)} ms`;
    if (tape.pending) { empty('Finding pulse boundaries near the tape head…'); el('reading').textContent='Reading TAP timing in bounded steps'; return; }
    if (!pulses.length) { empty(current.storage.tape.hasMedia ? 'No pulse entries at this position' : 'Insert a tape to explore its pulses'); el('reading').textContent='No pulse timing at this position'; return; }
    for(let i=0;i<=8;i++) line(20+i*95,15,20+i*95,160);
    line(20,45,780,45); line(20,125,780,125);
    let x=20,level=125;
    ctx.strokeStyle=accent;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,level);
    for(const p of pulses) {
      const width=p.cycles/total*760;
      if(tape.version===2){ctx.lineTo(x+width,level);x+=width;level=level===125?45:125;ctx.lineTo(x,level);}
      else {ctx.lineTo(x+width/2,125);ctx.lineTo(x+width/2,45);ctx.lineTo(x+width,45);ctx.lineTo(x+width,125);x+=width;}
    }
    ctx.stroke();
    const shortest=Math.min(...pulses.map(p=>p.cycles)),longest=Math.max(...pulses.map(p=>p.cycles));
    el('reading').textContent=`${pulses.length} ${tape.version===2?'half-waves':'pulses'} · ${shortest}–${longest} cycles · ${(shortest/TAPE_CLOCK_HZ*1e6).toFixed(0)}–${(longest/TAPE_CLOCK_HZ*1e6).toFixed(0)} µs`;

  }
  function drive() {
    const d=current.storage.drives[selected],rate=current.storage.rates?.[selected];
    const loads=recentLoads(current.activity,selected+8);
    const loadKey=loads.map(l=>l.sequence).join(',')+':'+(current.activity?.epoch??0)+':'+!!current.activity?.truncated;
    if(el('loads').dataset.key!==loadKey){
      el('loads').dataset.key=loadKey;el('loads').replaceChildren();
      for(const load of loads.slice(-3).reverse()){
        const row=document.createElement('div'),button=document.createElement('button'),description=document.createElement('span');
        button.type='button';button.className='monitor-storage-link';button.textContent=`$${hex(load.address)}–$${hex((load.address+load.bytes-1)&65535)} ↗`;
        button.addEventListener('click',()=>openMemory(load.address));button.title='Inspect this address in current memory';
        description.textContent=`Completed accelerated LOAD · ${load.bytes.toLocaleString()} bytes · ${load.ramBytes===load.bytes?'RAM destination':'CPU destination, partly I/O or special mapping'}`;
        row.append(description,button);el('loads').append(row);
      }
      if(loads.length){const note=document.createElement('small');note.textContent=`Latest retained loads from eight emulated seconds${current.activity?.truncated?', earlier records omitted at the buffer limit':''}. Links show current memory, which may have changed.`;el('loads').append(note);}
    }
    el('loads').hidden=!loads.length;
    const mechanism=d.hardware && d.mode!=='accelerated';
    el('title').textContent=mechanism?'Head position over time':'File/channel rate over time';
    el('left').textContent=mechanism?`${history.seconds.toFixed(1)} s ago`:'Recent rate samples';el('right').textContent='now';
    el('note').textContent=mechanism?'Dots are sampled positions, not a trace of every step. Media reads do not measure bytes delivered over the serial cable.':'Accelerated loading bypasses mechanical timing. This plot uses the measured file/channel rate.';
    if(!d.available || !d.hasMedia){empty(!d.available?'Drive not connected':'Insert a disk to observe its activity');el('reading').textContent='No disk activity';return;}
    if(mechanism) {
      for(const track of [1,18,35,42]){const y=160-(track-1)/41*140;line(55,y,780,y);text(String(track),8,y+5);}
      for(let i=0;i<history.count;i++){
        const track=history.heads[selected][(history.cursor-history.count+i+401)%401]; if(!Number.isFinite(track))continue;
        ctx.fillStyle=accent;ctx.beginPath();ctx.arc(55+(history.count===1?1:i/(history.count-1))*725,160-(track-1)/41*140,3,0,Math.PI*2);ctx.fill();
      }
      el('reading').textContent=`Track ${d.halfTrack/2} · drive CPU $${hex(d.pc)} · motor ${d.motor?'on':'off'} · LED ${d.led?'on':'off'}`;
    } else {
      const count=rate?.historyCount??0;let max=1;
      for(let i=0;i<count;i++)max=Math.max(max,rate.history[i]);
      for(let i=0;i<count;i++){const value=rate.history[(rate.historyCursor-count+i+401)%401];ctx.fillStyle=accent;ctx.fillRect(20+(count===1?1:i/(count-1))*750,160-value/max*125,6,Math.max(1,value/max*125));}
      text(formatStorageRate(max,true),20,20);el('reading').textContent=rate?.ready?`Read ${formatStorageRate(rate.read,true)} · write ${formatStorageRate(rate.write,true)}`:'Waiting for transfer observations';
    }
  }
  function cartridge() {
    const c=current.storage.cartridge;
    windows=c.inserted?cartridgeWindows(current):[];
    el('title').textContent='What the CPU can see'; el('left').textContent='$0000';el('right').textContent='$FFFF';
    for(let page=0;page<256;page++) {ctx.fillStyle=windows.some(w=>page*256>=w.start&&page*256<w.end)?accent:border;ctx.fillRect(20+page*760/256,25,760/256,42);}
    text('$8000',400,87);text('$A000',495,87);text('$E000',685,87);
    text('Sampled bank selections',20,119);
    const banks=[];
    for(let i=0;i<history.count;i++) {const bank=history.banks[(history.cursor-history.count+i+401)%401];if(bank>=0&&banks.at(-1)!==bank)banks.push(bank);else if(bank<0&&banks.at(-1)!==null)banks.push(null);}
    const tail=banks.slice(-9);tail.forEach((bank,i)=>{text(bank===null?'—':String(bank),20+i*82,159,i===tail.length-1?accent:dim,23);if(i<tail.length-1)text('→',65+i*82,159);});
    el('reading').textContent=!c.inserted?'No cartridge inserted':windows.length?windows.map(w=>`$${hex(w.start)}–$${hex(w.end-1)}`).join(' · ')+' · CPU-visible cartridge memory':'No CPU-visible cartridge window';
    el('note').textContent='Click a mapped window to inspect its code. Bank history contains samples, so brief switches can be missed.';
  }
  function reu() {
    const r=current.storage.reu,s=reuSettings(r.registers,r.bankMask);
    frameData ??= reuFrameAccesses(frame);
    const data=frameData,events=data.accesses;
    el('title').textContent='Current command settings';el('left').textContent='Captured frame start';el('right').textContent='frame end';
    if(!r.attached){empty('Attach an REU to explore memory transfers');el('reading').textContent='No REU attached';el('note').textContent='Expansion RAM is separate from the C64’s 64 KB.';return;}
    for(const [x,label,address] of [[20,'C64 RAM','$'+hex(s.c64)],[470,'EXPANSION RAM','$'+hex(s.reu,6)]]){ctx.strokeStyle=border;ctx.lineWidth=1;ctx.strokeRect(x,8,310,88);text(label,x+16,32);text(address,x+16,64,ink,26);}
    const command=r.registers[1]&3;
    text(['→','←','⇄','≟'][command],375,61,accent,32);text(s.operation,20,118,dim,14);
    for(const e of events){const x=20+e.tick/Math.max(1,data.cycles)*760;ctx.fillStyle=e.write?ink:accent;ctx.fillRect(x,143,2,e.write?32:20);}
    line(20,177,780,177);
    accessIndex=Math.min(accessIndex,Math.max(0,events.length-1));
    const e=events[accessIndex];
    if(e){line(20+e.tick/data.cycles*760,138,20+e.tick/data.cycles*760,180,ink,2);el('reading').textContent=`${data.incomplete?'At least ':''}${events.length.toLocaleString()} ${events.length===1?'access':'accesses'} · ${e.write?'write':'read'} $${hex(e.address)} · REU $${hex(e.expansion,6)} · byte $${hex(e.value,2)}`;}
    else el('reading').textContent=!data.available?'Waiting for a detailed frame':data.incomplete?'Incomplete frame: no REU accesses recorded':'No REU accesses in this frame';
    el('note').textContent=e?`Selected access: raster ${Math.floor(e.tick/frame.cyclesPerLine)}, cycle ${e.tick%frame.cyclesPerLine+1}. ${data.incomplete?'Capture limit reached. ':''}Accesses do not prove a completed transfer.`:'The diagram shows current registers, not transfer progress. Pause to hold a frame for inspection.';
    el('video').hidden=!e;el('memory').hidden=!e;
  }
  function draw() {
    if(!current)return;if(!ink)theme();ctx.fillStyle=bg;ctx.fillRect(0,0,800,190);
    el('loads').hidden=selected>1;
    el('zoom').hidden=selected!==2;el('video').hidden=true;el('memory').hidden=true;
    canvas.tabIndex=[3,4].includes(selected)?0:-1;
    canvas.setAttribute('aria-label',selected===2?'Tape waveform reconstructed from TAP pulse timing.':selected===3?'CPU memory map. Click a cartridge window, or press Enter to inspect the first mapped window.':selected===4?'REU recorded accesses. Click an access or use Left and Right arrows to select.':'Sampled drive activity');
    if(selected<2)drive();else if(selected===3)cartridge();else if(selected===4)reu();else {
      el('title').textContent=current.storage.tape.recording?'Recorded pulse timing':'Pulse timing near the tape head';
      el('note').textContent=tape.incomplete?'Incomplete TAP entry at this position.':'Reconstructed TAP timing. Pulse lengths carry information interpreted by the loader.';
      showPulse();
    }
  }
  function update(snapshot,selectedDevice,samples) {
    if(current!==snapshot){tape.reset();frameData=null;}
    current=snapshot;selected=selectedDevice;history=samples;
    if(selected===2){tape.sample(snapshot.facade.tape);pulses=tape.window(zoom?10000:20000);}
    draw();
  }
  canvas.addEventListener('click',event=>{
    if(selected<3)return;
    const bounds=canvas.getBoundingClientRect(),x=Math.max(0,Math.min(1,((event.clientX-bounds.left)/bounds.width*800-20)/760));
    if(selected===3){const address=Math.min(65535,Math.floor(x*65536)),w=windows.find(w=>address>=w.start&&address<w.end);if(w)openCode(address);}
    else if(selected===4&&frameData?.accesses.length){const tick=x*frameData.cycles;accessIndex=frameData.accesses.reduce((best,e,i)=>Math.abs(e.tick-tick)<Math.abs(frameData.accesses[best].tick-tick)?i:best,0);draw();}
  });
  canvas.addEventListener('keydown',event=>{
    if(selected===3&&event.key==='Enter'&&windows.length){event.preventDefault();openCode(windows[0].start);return;}
    if(!['ArrowLeft','ArrowRight'].includes(event.key)||selected!==4)return;
    event.preventDefault();event.stopPropagation();const delta=event.key==='ArrowLeft'?-1:1;
    accessIndex=Math.max(0,Math.min((frameData?.accesses.length??0)-1,accessIndex+delta));draw();
  });
  el('zoom').addEventListener('click',()=>{zoom=!zoom;el('zoom').textContent=zoom?'Zoom out':'Zoom ×2';pulses=tape.window(zoom?10000:20000);draw();});
  el('video').addEventListener('click',()=>{const e=frameData?.accesses[accessIndex];if(e)openFrame(frame,e.tick);});
  el('memory').addEventListener('click',()=>{const e=frameData?.accesses[accessIndex];if(e)openCapturedMemory(frame,e.tick,e.address);});
  return {update,theme,setFrame(value){frame=value;frameData=null;accessIndex=0;},reset(){el('loads').replaceChildren();delete el('loads').dataset.key;current=null;frame=null;frameData=null;tape.reset();pulses=[];}};
}
