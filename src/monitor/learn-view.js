// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { captureLabel, recordedOrigin } from './capture-context.js';
import { LEARN_SOURCE, LEARN_QUESTIONS, borderEvidence, frameFindings, spriteCoverage, relatedWrites, spriteSourceAtLine, picturePoint } from './learn-model.js';
import { createBauerView } from './bauer-view.js';
import { frameEvidence } from './frame-evidence.js';
import { hex } from './memory-sampler.js';
import { OPCODES, registerMeaning } from './disassembly.js';

export function createLearnView(root, { openCode, openMemory, openFrame, onCapture }) {
  root.innerHTML = `<div class="monitor-section-head"><h2 id="monitor-learn-title">Video</h2><div class="monitor-video-modes" role="group" aria-label="Video view"><button class="btn" data-learn="replay" aria-pressed="false">Replay frame</button><button class="btn" aria-pressed="true">Explain frame</button></div><button type="button" class="btn" data-learn="capture">Capture frame</button></div>
    <div class="monitor-learn-status" data-learn="status" role="status">Capture a moment from any running program to inspect how the frame was built.</div>
    <div class="monitor-learn-topics" role="group" aria-label="Questions about the captured frame">${Object.entries(LEARN_QUESTIONS).map(([key,value]) => `<button type="button" class="btn" data-topic="${key}" aria-pressed="${key === 'sprites'}">${key === 'sprites' ? 'Picture' : key === 'border' ? 'Border' : 'Rules'}</button>`).join('')}</div>
    <div class="monitor-learn-overview" data-learn="overview" role="group" aria-label="In this frame"></div>
    <div class="monitor-learn-timeline"><canvas data-learn="timeline" width="984" height="40" aria-label="Frame observations: sprite slots, open border lines, source changes, bad-line conditions and VIC writes" title="Rows, top to bottom: sprite slots, open border lines, source changes, bad-line conditions, VIC writes"></canvas><input data-learn="seek" type="range" min="0" max="19655" value="0" aria-label="Selected frame cycle"><div><button type="button" class="btn" data-learn="back-finding" aria-label="Previous observation">←</button><button type="button" class="btn" data-learn="next-finding" aria-label="Next observation">→</button><span data-learn="observation"></span><button type="button" class="btn" data-learn="timing-link">Inspect timing</button><button type="button" class="btn" data-learn="origin" hidden>Open code now ↗</button></div></div>
    <section class="monitor-bauer" data-learn="bauer" hidden></section>
    <div class="monitor-learn-body"><div class="monitor-learn-visual"><canvas width="384" height="272" data-learn="picture" aria-label="Captured picture. Select a sprite below to highlight its coverage."></canvas><div data-learn="slots" class="monitor-learn-slots" role="group" aria-label="Sprite coverage in this capture"></div><span data-learn="hint"></span></div>
    <div class="monitor-learn-explanation"><h3 data-learn="question"></h3><div class="monitor-learn-facts" data-learn="facts"></div><p data-learn="finding"></p><div class="monitor-learn-chain" data-learn="chain"></div><div class="monitor-border-evidence" data-learn="border-evidence" hidden></div><button type="button" class="btn" data-learn="memory" hidden>Inspect source memory now ↗</button><div class="monitor-learn-write"><b data-learn="write-title">Follow a register write</b><p data-learn="write"></p><div><button type="button" class="btn" data-learn="previous" aria-label="Previous related write">←</button><button type="button" class="btn" data-learn="next" aria-label="Next related write">→</button><button type="button" class="btn" data-learn="write-timing" disabled>Show on timeline</button><button type="button" class="btn" data-learn="code" disabled>Open code ↗</button></div></div><button type="button" class="btn" data-learn="frame" disabled>Replay this moment ↗</button></div></div>
    <details class="monitor-help"><summary>Reference and capture limits</summary><p data-learn="reference"></p><a href="${LEARN_SOURCE}" target="_blank" rel="noopener noreferrer">Bauer’s VIC-II reference ↗</a><p>The reference describes VIC-II behavior. Analysis applies to the captured frame without identifying the running program. Sprite coverage can include pixels hidden by foreground graphics. Pointers and banks are recorded at line end, not at the selected pixel’s fetch time. A related register write is evidence to inspect, not proof that it caused the selected object. RAM writes to pointer tables and earlier setup are not recorded here. Code and Memory read current memory when opened.</p></details>
    <details class="monitor-help monitor-learn-live"><summary>Live source inspector (current machine)</summary><div data-monitor="lesson-visual"></div></details>`;
  const el = name => root.querySelector(`[data-learn="${name}"]`);
  const bauer = createBauerView(el('bauer'), position => { selectedTick=position; line=Math.floor(position/63); renderTimeline(); });
  const picture = el('picture'), ctx = picture.getContext('2d');
  const original = document.createElement('canvas'); original.width = 384; original.height = 272;
  const originalCtx = original.getContext('2d');
  const isolated = document.createElement('canvas'); isolated.width = 384; isolated.height = 272;
  const isolatedCtx = isolated.getContext('2d');
  let crop = { x: 0, y: 0, width: 384, height: 272 };
  let facade = null, frame = null, topic = 'sprites', sprite = -1, line = 0, events = [], eventIndex = 0, pending = false;
  let selectedTick=0, selectedGroup='sprites', selectedObservation=null, findings=frameFindings(null);
  let counts = new Uint32Array(8), evidence = null, bg;
  const slots = [];
  for (let s = -1; s < 8; s++) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = s < 0 ? 'All' : String(s);
    button.setAttribute('aria-label', s < 0 ? 'Show whole captured picture' : `Select captured sprite ${s}`);
    button.addEventListener('click', () => {
      sprite = s;
      if (frame && s >= 0) { const p = frame.owners.findIndex((owner,i) => owner === s && !frame.border[i]); line = Math.floor(p / frame.width) + frame.rasterOffset; }
      if (frame && s>=0) { selectedGroup='sprites'; selectedTick=line*63; bauer.seek(selectedTick); }
      eventIndex = 0; render();
    });
    slots.push(button); el('slots').append(button);
  }
  function renderOverview() {
    el('overview').replaceChildren();
    for (const group of findings) {
      const button=document.createElement('button'); button.type='button'; button.className='btn';
      button.dataset.finding=group.id; button.disabled=!group.points.length;
      button.textContent=`${group.points.length} ${group.label}`;
      button.addEventListener('click',()=>selectFinding(group.id,0));
      el('overview').append(button);
    }
    renderTimeline();
  }
  function selectFinding(id,index) {
    const group=findings.find(g=>g.id===id), point=group?.points[index];
    if (!point) return;
    selectedGroup=id; selectedObservation=point; selectedTick=point.tick; line=point.line;
    bauer.deactivate();
    if (id==='sprites' || id==='pointers') { topic='sprites'; sprite=point.slot; }
    else if (id==='border') { topic='border'; sprite=-1; }
    else topic='timing';
    bauer.seek(point.tick,id==='badlines'?0:undefined);
    render(); renderTimeline();
  }
  function currentObservation(group) {
    return selectedObservation?.tick===selectedTick && group.points.includes(selectedObservation)
      ? selectedObservation : group.points.find(point=>point.tick===selectedTick);
  }
  function renderTimeline() {
    const canvas=el('timeline'), context=canvas.getContext('2d');
    const style=getComputedStyle(root), accent=style.getPropertyValue('--accent').trim() || '#fff';
    context.clearRect(0,0,canvas.width,canvas.height);
    for (let row=0;row<findings.length;row++) {
      context.fillStyle=accent; context.globalAlpha=findings[row].id===selectedGroup?1:.3;
      for (const point of findings[row].points) context.fillRect(point.tick/19656*984,row*8,2,6);
    }
    context.globalAlpha=1; context.fillStyle=style.getPropertyValue('--text').trim() || '#fff';
    context.fillRect(selectedTick/19656*984,0,1,40);
    el('seek').value=selectedTick; el('seek').disabled=!frame;
    const group=findings.find(g=>g.id===selectedGroup), point=currentObservation(group);
    const observationIndex=group.points.indexOf(point);
    const at=`${captureLabel(frame)} · Raster ${Math.floor(selectedTick/63)} · cycle ${selectedTick%63+1}`;
    el('seek').setAttribute('aria-valuetext',at);
    let detail=point?group.label:`${group.label} · no indexed observation at this cycle`;
    if (point?.slot!==undefined) detail+=` · slot ${point.slot}`;
    if (point?.precision==='line') detail+=' · line observation, not an exact fetch time';
    if (point?.precision==='line-end') detail+=' · sampled at line end';
    if (point?.event!==undefined) detail=`$${hex(0xD000+frame.eventKind[point.event])} ← $${hex(frame.eventValue[point.event],2)} · recorded write, not proof of a pixel effect`;
    el('observation').textContent=frame?`${at} · ${detail}`:'Capture a frame to explore its observations';
    el('back-finding').disabled=observationIndex>=0?observationIndex===0:!group.points.some(p=>p.tick<selectedTick);
    el('next-finding').disabled=observationIndex>=0?observationIndex===group.points.length-1:!group.points.some(p=>p.tick>selectedTick);
    el('timing-link').disabled=!frame; el('timing-link').hidden=topic==='timing';
    el('origin').hidden=point?.event===undefined || !frame.eventCPU[point.event];
    for (const button of el('overview').children) button.setAttribute('aria-pressed',String(button.dataset.finding===selectedGroup));
  }
  function theme() { const style = getComputedStyle(root); bg = style.getPropertyValue('--ui-bg').trim(); bauer.theme(); render(); renderTimeline(); }
  function setFrame(current, captured) {
    facade = current; frame = captured; pending = false; el('capture').disabled = false; sprite = -1; line = 0; eventIndex = 0;
    findings=frameFindings(frame); selectedObservation=null; selectedTick=0; selectedGroup=findings.find(group=>group.points.length)?.id || 'sprites';
    renderOverview(); bauer.setFrame(frame);
    counts = spriteCoverage(frame); evidence = frameEvidence(frame);
    const image = originalCtx.createImageData(frame.width, frame.height); image.data.set(frame.rgba); originalCtx.putImageData(image,0,0);
    theme(); el('status').textContent = `${captureLabel(frame)} · recorded evidence, live C64 can keep playing${frame.overflow ? ' · event buffer full, writes may be missing' : ''}`;
  }
  function renderWrite() {
    const event = events[eventIndex];
    el('previous').disabled = !events.length; el('next').disabled = !events.length;
    el('write-timing').disabled=event===undefined;
    el('code').disabled = event === undefined || !frame.eventCPU[event];
    if (event === undefined) { el('write-title').textContent = 'No related write in this frame'; el('write').textContent = 'The setting may have been established earlier. No instruction is attributed to it.'; return; }
    const address = 0xD000 + frame.eventKind[event], tick = frame.eventTick[event];
    el('write-title').textContent = `Related write ${eventIndex + 1} / ${events.length}`;
    el('write').textContent = `$${hex(address)} ← $${hex(frame.eventValue[event],2)} · ${registerMeaning(address)} · raster ${Math.floor(tick / frame.cyclesPerLine)}, cycle ${tick % frame.cyclesPerLine + 1}`;
    el('code').textContent = frame.eventCPU[event] ? `${OPCODES[frame.eventOpcode[event]].name} at $${hex(frame.eventPC[event])} ↗` : 'No captured CPU origin';
  }
  function render() {
    el('bauer').hidden = topic !== 'timing';
    for (const help of root.querySelectorAll(':scope > .monitor-help')) help.hidden = topic === 'timing';
    root.querySelector('.monitor-learn-body').hidden = topic === 'timing';
    renderTimeline();
    const question = LEARN_QUESTIONS[topic];
    el('question').textContent = topic === 'sprites' && sprite >= 0 ? 'How is this part of the picture drawn?' : question.title; el('reference').textContent = question.reference;
    el('hint').textContent = question.hint;
    el('finding').hidden=false; el('chain').hidden=false;
    el('slots').hidden = topic !== 'sprites';
    for (const button of root.querySelectorAll('[data-topic]')) button.setAttribute('aria-pressed', String(button.dataset.topic === topic));
    el('border-evidence').hidden=topic!=='border';
    if (topic === 'timing') return;
    slots.forEach((button,index) => { button.disabled = !frame || (index > 0 && !counts[index - 1]); button.setAttribute('aria-pressed', String(sprite === index - 1)); });
    ctx.fillStyle = bg || '#000'; ctx.fillRect(0,0,384,272);
    el('frame').disabled = !frame; el('memory').hidden = !frame || topic !== 'sprites' || sprite < 0;
    if (!frame) { el('border-evidence').replaceChildren(); el('facts').textContent = '1 Capture → 2 Select → 3 Follow the evidence'; el('finding').textContent = 'Open the Monitor while a program runs. Capture records the next complete frame without seeking through the demo.'; el('chain').textContent = ''; events = []; renderWrite(); return; }
    crop = { x: 0, y: 0, width: frame.width, height: frame.height };
    ctx.drawImage(original,0,0);
    if (topic === 'sprites' && sprite >= 0 || topic === 'border') {
      const image = originalCtx.getImageData(0,0,384,272);
      let left = frame.width, right = -1, top = frame.height, bottom = -1;
      for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
        const i = y * frame.width + x;
        const selected = topic === 'sprites' ? frame.owners[i] === sprite && !frame.border[i] : (x < 32 || x >= 352 || y < 36 || y >= 236) && !frame.border[i];
        if (selected) { left = Math.min(left,x); right = Math.max(right,x); top = Math.min(top,y); bottom = Math.max(bottom,y); }
        if (!selected) { image.data[i*4] *= .15; image.data[i*4+1] *= .15; image.data[i*4+2] *= .15; }
      }
      isolatedCtx.putImageData(image,0,0);
      if (topic === 'sprites' && right >= left) {
        const ratio = frame.width / frame.height;
        const width = Math.min(frame.width, Math.max(96, right-left+33, (bottom-top+33)*ratio)), height = width / ratio;
        crop = { x: Math.max(0,Math.min(frame.width-width,(left+right+1-width)/2)), y: Math.max(0,Math.min(frame.height-height,(top+bottom+1-height)/2)), width, height };
        el('hint').textContent = `Sprite ${sprite} close-up · choose All to return to the whole frame`;
      }
      ctx.imageSmoothingEnabled = false; ctx.drawImage(isolated,crop.x,crop.y,crop.width,crop.height,0,0,384,272);
    }
    const cursorY=(line-frame.rasterOffset-crop.y)/crop.height*272;
    if (cursorY>=0 && cursorY<272) {
      ctx.strokeStyle=getComputedStyle(root).getPropertyValue('--accent').trim();
      ctx.beginPath(); ctx.moveTo(0,cursorY+.5); ctx.lineTo(384,cursorY+.5); ctx.stroke();
    }
    const used = counts.filter(n => n > 0).length;
    el('facts').textContent = topic === 'sprites' ? `${used} / 8 slots with unmasked coverage` : topic === 'border' ? `${evidence.openBorderPixels.toLocaleString()} unmasked pixels outside 320 × 200` : `${evidence.badLines} bad lines · ${evidence.writes} VIC writes`;
    el('finding').textContent = topic === 'sprites' ? sprite < 0 ? 'Choose a slot or click the captured picture to follow a sprite.' : `Sprite ${sprite} covers ${counts[sprite].toLocaleString()} unmasked pixel positions. Some may be hidden behind foreground graphics.` : topic === 'border' ? 'This isolates where the border mask was open outside the normal screen. Dark areas are dimmed for comparison.' : 'Lit cells show when the VIC owned the bus. Compare this pattern with related writes.';
    if (topic === 'sprites' && sprite >= 0) { const source = spriteSourceAtLine(frame,sprite,line); el('chain').textContent = `Line ${line} end: bank $${hex(source.bank)} + pointer $${hex(source.pointer,2)} × 64 → $${hex(source.address)}`; }
    else el('chain').textContent = topic === 'sprites' ? `${evidence.pointerChanges} pointer/bank changes between adjacent DMA-active lines` : topic === 'timing' ? '63 cycles across × 312 raster lines down' : 'Normal screen: 320 × 200 pixels';
    if (topic==='border') renderBorder();
    events = relatedWrites(frame,topic,sprite); eventIndex = Math.min(eventIndex,Math.max(0,events.length-1)); renderWrite();
  }
  function renderBorder() {
    const panel=el('border-evidence'), observed=borderEvidence(frame,selectedTick);
    panel.replaceChildren();
    if (!observed) return;
    const stages=[
      ['See',observed.pixelsAvailable?`${observed.uncovered} pixel positions outside the normal screen are uncovered on line ${observed.line}. ${observed.spriteCoverage} have recorded sprite coverage.`:'This raster line is outside the captured picture.'],
      ['Understand','The border covers graphics and sprites. Opening it reveals what is underneath, rather than creating extra graphics.'],
      ['Inspect',`Recorded gates at cycle ${selectedTick%63+1}: main ${observed.mainClosed?'closed':'open'}, vertical ${observed.verticalClosed?'closed':'open'}.`],
    ];
    for (const [heading,text] of stages) {
      const row=document.createElement('p'), label=document.createElement('b');
      label.textContent=heading+' · '; row.append(label,document.createTextNode(text)); panel.append(row);
    }
    const actions=document.createElement('div'); actions.className='monitor-border-actions';
    const next=observed.transitions.find(point=>point.tick>selectedTick);
    const button=document.createElement('button'); button.className='btn'; button.type='button';
    button.textContent='Next gate change on line'; button.disabled=!next;
    button.addEventListener('click',()=>{ bauer.seek(next.tick); render(); }); actions.append(button);
    for (const event of observed.writes) {
      const link=document.createElement('button'); link.className='btn'; link.type='button';
      link.textContent=`Earlier $${hex(0xD000+frame.eventKind[event])} write ↗`;
      link.title='Related control write before this cycle, not a proven cause';
      link.addEventListener('click',()=>{
        const group=findings.find(g=>g.id==='writes');
        selectFinding('writes',group.points.findIndex(point=>point.event===event));
      }); actions.append(link);
    }
    panel.append(actions);
    const note=document.createElement('small');
    note.textContent=observed.incompleteWrites?'Write history is incomplete. Border transitions are observed, not independently replayed.':observed.writes.length?'Earlier control writes are related evidence, not proof of causation. Border transitions are not independently replayed.':'No earlier $D011/$D016 write is recorded in this frame. Setup may predate the capture. Border transitions are not independently replayed.';
    panel.append(note);
    el('facts').textContent=`Line ${observed.line} · ${observed.transitions.length} recorded gate changes`;
    el('finding').hidden=true; el('chain').hidden=true;
  }
  function request() { if (!facade?.requestVicFrameCapture) return; facade.requestVicFrameCapture({ analysis: true, provenance: true }); pending = true; el('capture').disabled = true; el('status').textContent = 'Waiting for the next complete frame…'; }
  function update(current, paused) {
    if (facade !== current) { deactivate(true); facade = current; theme(); }
    el('capture').disabled = pending || !facade.requestVicFrameCapture;
    if (topic === 'timing') bauer.update();
    if (!pending) return;
    const status = facade.vicFrameCaptureStatus();
    if (status === 'ready') { const captured = facade.takeVicFrameCapture(); if (captured) { setFrame(facade,captured); onCapture(facade,captured); } }
    else if (status === 'waiting' || status === 'recording') el('status').textContent = paused ? 'Resume the C64 to finish this capture.' : 'Recording one complete frame…';
    else { pending = false; el('status').textContent = 'Capture cancelled. Choose Capture frame.'; }
  }
  function deactivate(clear = false) { bauer.deactivate(); if (pending) { facade?.cancelVicFrameCapture(); el('status').textContent = frame ? 'Captured frame retained · new capture cancelled' : 'Capture cancelled. Choose Capture frame.'; } pending = false; if (clear) { findings=frameFindings(null); selectedTick=0; bauer.setFrame(null); facade = null; frame = null; evidence = null; counts.fill(0); renderOverview(); el('status').textContent = 'Capture the moment you want to understand.'; render(); } }
  el('seek').addEventListener('input',()=>{ selectedTick=Number(el('seek').value); line=Math.floor(selectedTick/63); bauer.seek(selectedTick); render(); });
  el('timing-link').addEventListener('click',()=>{ topic='timing'; bauer.seek(selectedTick); render(); });
  for (const [name,forward] of [['back-finding',false],['next-finding',true]]) el(name).addEventListener('click',()=>{
    const group=findings.find(g=>g.id===selectedGroup);
    const index=group.points.indexOf(currentObservation(group));
    const point=index>=0?group.points[index+(forward?1:-1)]:forward?group.points.find(p=>p.tick>selectedTick):group.points.findLast(p=>p.tick<selectedTick);
    if (point) selectFinding(group.id,group.points.indexOf(point));
  });
  el('write-timing').addEventListener('click',()=>{
    const event=events[eventIndex], group=findings.find(g=>g.id==='writes');
    selectFinding('writes',group.points.findIndex(p=>p.event===event));
  });
  el('origin').addEventListener('click',()=>{
    const point=currentObservation(findings.find(g=>g.id===selectedGroup));
    if (point?.event!==undefined && frame.eventCPU[point.event]) openCode(frame.eventPC[point.event],recordedOrigin(frame,point.event));
  });
  el('capture').addEventListener('click',request);
  for (const button of root.querySelectorAll('[data-topic]')) button.addEventListener('click',() => { bauer.deactivate(); topic = button.dataset.topic; eventIndex = 0; render(); });
  picture.addEventListener('click', event => {
    if (!frame) return;
    const rect = picture.getBoundingClientRect(), point = picturePoint(event.clientX-rect.left,event.clientY-rect.top,rect.width,rect.height,frame.width,frame.height);
    if (!point) return;
    const x = Math.min(frame.width-1,Math.floor(crop.x + point.x / frame.width * crop.width));
    const y = Math.min(frame.height-1,Math.floor(crop.y + point.y / frame.height * crop.height));
    const i = y * frame.width + x;
    if (topic==='border' || frame.border[i] || ((x<32 || x>=352 || y<36 || y>=236) && frame.owners[i]>=8)) { topic = 'border'; sprite = -1; }
    else if (frame.owners[i] < 8) { topic = 'sprites'; sprite = frame.owners[i]; line = y + frame.rasterOffset; }
    else { topic = 'sprites'; sprite = -1; }
    line=y+frame.rasterOffset; selectedGroup=topic==='border'?'border':'sprites'; selectedTick=line*63; bauer.seek(selectedTick);
    eventIndex = 0; render();
  });
  for (const [name,delta] of [['previous',-1],['next',1]]) el(name).addEventListener('click',() => { if (events.length) { eventIndex = (eventIndex+delta+events.length)%events.length; renderWrite(); } });
  el('code').addEventListener('click',() => { const i = events[eventIndex]; if (i !== undefined && frame.eventCPU[i]) openCode(frame.eventPC[i],recordedOrigin(frame,i)); });
  el('memory').addEventListener('click',() => { if (frame && sprite >= 0) { const source = spriteSourceAtLine(frame,sprite,line); openMemory(source.address,'sprites',source.bank); } });
  el('replay').addEventListener('click',() => openFrame(facade,frame,selectedTick));
  el('frame').addEventListener('click',() => { if (frame) openFrame(facade,frame,selectedTick); });
  renderOverview(); render();
  return { update, deactivate, theme, setFrame, request, inspect(current,captured,position) { if(frame!==captured) setFrame(current,captured); bauer.seek(position); render(); }, selectSprite(slot) { slots[slot+1]?.click(); } };
}
