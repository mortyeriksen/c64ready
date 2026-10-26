// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { createCycleBudget } from './cycle-budget.js';
import { capturedCycleBudget } from './code-actions.js';
import { CodeTimeline } from './code-timeline.js';
import { captureLabel, recordedOrigin } from './capture-context.js';
import { hex } from './memory-sampler.js';
import { OPCODES } from './disassembly.js';

export function createCodeStory(root, { openCode, openFrame }) {
  root.innerHTML = `<p class="monitor-view-intro" data-story="warning" hidden>Capture buffer full. Recorded evidence is incomplete.</p>
    <div class="monitor-code-budget" data-story="budget">Waiting for the shared frame and its cycle budget.</div>
    <div class="monitor-code-time"><div data-story="line-budget"></div>
      <canvas width="630" height="24" data-story="timeline" aria-label="Recorded video writes on the same frame time axis"></canvas>
      <div class="monitor-code-transport"><button class="btn" data-story="previous" disabled>Previous action</button><input type="range" min="0" max="19655" value="0" data-story="seek" aria-label="Position in captured frame" disabled><button class="btn" data-story="next" disabled>Next action</button></div>
      <small data-story="cursor">One captured frame · CPU time above, video writes below</small>
    </div>
    <div class="monitor-code-groups" data-story="groups" aria-label="Filter recorded video actions"></div>
    <div class="monitor-code-story-body"><section class="monitor-code-line-actions"><h3 data-story="list-title">Actions on this line</h3><div class="monitor-code-action-list" data-story="list" aria-label="Recorded actions on the selected raster line"></div></section>
    <article class="monitor-code-action-detail"><small data-story="position"></small><h3 data-story="title">Pause on the moment you want to understand</h3><span class="monitor-code-swatch" data-story="swatch" hidden></span><p data-story="detail">Fixed register rules explain recorded video writes. They do not infer what the programmer intended.</p><code data-story="evidence"></code><div><button class="btn" data-story="video" disabled>See in Video</button> <button class="btn" data-story="assembly" disabled>Inspect assembly</button></div></article></div>
    <details class="monitor-help monitor-code-scope"><summary>What this capture explains</summary><p>One time cursor connects CPU availability, video actions and the explanation. Previous and Next action follow the selected category. A cycle with no recorded video write can still contain computation, sound or other work.</p><p>These actions are VIC-II writes. Available CPU cycles include wait loops, not just useful work. The budget counts each cycle once: REU holds first, then halted time, VIC-II stalls and available cycles. Assembly and registers use the current shared snapshot, which can differ from the capture.</p></details>`;
  const elements=new Map([...root.querySelectorAll('[data-story]')].map(element=>[element.dataset.story,element]));
  const el=name=>elements.get(name), timeline=new CodeTimeline();
  let facade=null,dirty=false;
  const lineBudget=createCycleBudget(el('line-budget'),tick=>seek(tick),{slider:false});

  function drawTimeline() {
    if(timeline.frame&&root.closest('[hidden]'))return;
    const canvas=el('timeline'),ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!timeline.frame)return;
    const style=getComputedStyle(root);
    ctx.fillStyle=style.getPropertyValue('--accent').trim();
    for(const i of timeline.indices)ctx.fillRect(timeline.actions[i].tick/timeline.total*630,4,2,16);
    ctx.fillStyle=style.getPropertyValue('--text').trim();ctx.fillRect(timeline.tick/timeline.total*630,0,2,24);
  }
  function render() {
    if(root.closest('[hidden]'))return;
    const frame=timeline.frame;if(!frame)return;
    if(dirty){dirty=false;renderCapture();}
    const action=timeline.action,line=timeline.line,cycle=timeline.tick%frame.cyclesPerLine+1;
    el('seek').value=timeline.tick;el('seek').setAttribute('aria-valuetext',`Raster ${line}, cycle ${cycle}`);
    el('cursor').textContent=`Raster ${line} · cycle ${cycle} · CPU availability and video writes share this time axis`;
    lineBudget.seek(timeline.tick);
    el('previous').disabled=timeline.neighbour(-1)<0;el('next').disabled=timeline.neighbour(1)<0;
    for(const button of el('groups').children)button.setAttribute('aria-pressed',String(button.dataset.group===timeline.group));
    const indices=timeline.lineIndices;
    el('list-title').textContent=`Line ${line} · ${indices.length} ${timeline.group==='All'?'video':timeline.group.toLowerCase()} action${indices.length===1?'':'s'}`;
    el('list').replaceChildren();
    for(const index of indices) {
      const item=timeline.actions[index],button=document.createElement('button');
      button.type='button';button.className='btn';button.textContent=`Cycle ${item.tick%frame.cyclesPerLine+1} · ${item.title}`;
      button.setAttribute('aria-pressed',String(index===timeline.selected));
      button.addEventListener('click',()=>{timeline.select(index);render();});el('list').append(button);
    }
    if(!indices.length){const note=document.createElement('p');note.textContent='No matching video writes on this line. Use Previous or Next action to find one.';el('list').append(note);}
    el('position').textContent=action?`${recordedOrigin(frame,action.event)} · action ${timeline.selected+1} of ${timeline.actions.length}`:`${captureLabel(frame)} · raster ${line}, cycle ${cycle}`;
    el('video').disabled=false;el('assembly').disabled=!action?.cpu;el('swatch').hidden=action?.colour===null||!action;
    if(action) {
      el('title').textContent=action.title;el('detail').textContent=action.detail;
      el('evidence').textContent=`$${hex(action.address)} ← $${hex(action.value,2)}. ${action.cpu?`Captured ${OPCODES[action.opcode].name} (opcode $${hex(action.opcode,2)}) at $${hex(action.pc)}.`:'No CPU instruction origin was recorded.'}`;
      if(action.colour!==null){const colour=frame.palette[action.colour];el('swatch').style.backgroundColor=`rgb(${colour>>>16&255},${colour>>>8&255},${colour&255})`;el('swatch').setAttribute('aria-label',`Captured palette colour ${action.colour}`);}
    }else {
      el('title').textContent=timeline.actions.length?'No matching video write at this cycle':'No video writes recorded in this frame';
      el('detail').textContent='The CPU may still be computing, playing sound, accessing storage or waiting. No video write here is not proof of an idle program.';
      el('evidence').textContent='Select an action marker or use Previous / Next action. The category filter stays selected.';
    }
    drawTimeline();
  }
  function seek(tick){timeline.seek(tick);render();}
  function accept(current,captured) {
    timeline.setFrame(captured,{reset:facade!==current});facade=current;
    root.dataset.captureLabel=captureLabel(captured);
    lineBudget.setFrame(captured,{render:false});dirty=true;render();
  }
  function renderCapture() {
    const captured=timeline.frame;
    const budget=capturedCycleBudget(captured);
    el('budget').textContent=budget.unknown===budget.total?'Cycle budget unavailable for this capture. Resume to record detailed evidence.':`CPU available: ${budget.available.toLocaleString()} / ${budget.total.toLocaleString()} cycles · VIC-II stalls: ${budget.vic.toLocaleString()} · REU holds: ${budget.reu.toLocaleString()} · halted: ${budget.halted.toLocaleString()}${budget.unknown?` · unrecorded: ${budget.unknown.toLocaleString()}`:''}`;
    el('budget').title='CPU time available includes wait loops. This is bus availability, not useful work or processor utilisation.';
    el('warning').hidden=!captured.overflow;
    el('seek').max=Math.max(0,timeline.total-1);el('seek').disabled=!timeline.total;el('groups').replaceChildren();
    for(const name of ['All','Colours','Sprites','Display','Interrupts']){
      const count=timeline.actions.filter(a=>name==='All'||a.group===name).length,button=document.createElement('button');
      button.type='button';button.className='btn';button.dataset.group=name;button.textContent=`${name} · ${count}`;button.disabled=!count;
      button.addEventListener('click',()=>{timeline.filter(name);render();});el('groups').append(button);
    }
  }
  el('seek').addEventListener('input',()=>seek(Number(el('seek').value)));
  el('timeline').addEventListener('click',event=>{
    if(!timeline.frame)return;
    const rect=el('timeline').getBoundingClientRect(),time=(event.clientX-rect.left)/rect.width*timeline.total;
    let closest=-1,distance=5/rect.width*timeline.total;
    for(const index of timeline.indices){const delta=Math.abs(timeline.actions[index].tick-time);if(delta<distance){distance=delta;closest=index;}}
    if(closest>=0){timeline.select(closest);render();}else seek(time);
  });
  for(const [name,direction] of [['previous',-1],['next',1]])el(name).addEventListener('click',()=>{timeline.step(direction);render();});
  el('video').addEventListener('click',()=>{if(timeline.frame)openFrame(facade,timeline.frame,timeline.tick);});
  el('assembly').addEventListener('click',()=>{const action=timeline.action;if(action?.cpu)openCode(action.pc,recordedOrigin(timeline.frame,action.event));});
  function clear() {
    facade=null;dirty=false;timeline.setFrame(null);lineBudget.setFrame(null);
    el('budget').textContent='Waiting for the shared frame and its cycle budget.';
    delete root.dataset.captureLabel;el('warning').hidden=true;
    el('list').replaceChildren();el('groups').replaceChildren();
    el('title').textContent='Waiting for a complete frame from this machine';
    for(const name of ['detail','position','evidence'])el(name).textContent='';
    el('swatch').hidden=true;
    el('cursor').textContent='One captured frame · CPU time above, video writes below';
    el('seek').value=0;
    for(const name of ['video','assembly','seek','previous','next'])el(name).disabled=true;
    drawTimeline();
  }
  return {
    accept,seek,clear,refresh:render,get tick(){return timeline.tick;},
    theme(){if(!root.closest('[hidden]')){drawTimeline();lineBudget.theme();}},
    update(current){if(facade&&facade!==current)clear();facade=current;if(dirty)render();},
    deactivate(){},
  };
}
