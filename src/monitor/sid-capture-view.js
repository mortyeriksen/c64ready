// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { capturedSidTimeline, capturedSidState, sidPositionAt, sidVoiceTrace } from './sid-capture.js';
import { voiceDescription, filterDescription } from './sound-model.js';
import { registerMeaning } from './disassembly.js';
import { hex } from './memory-sampler.js';

export function createSidCaptureView(root,openFrame,{onPosition=()=>{}}={}) {
  const panel=document.createElement('section');panel.className='monitor-sid-capture';
  panel.innerHTML=`<p class="monitor-sid-capture-intro">Step through the sound settings written during one frame. Graphs show pitch and gate settings, not recorded audio.</p><div class="monitor-sid-capture-nav"><button class="btn" data-sid-step="-1">← Previous</button><label><span data-sid-position></span><input type="range" min="0" max="0" step="1" value="0" aria-label="Recorded SID change"></label><button class="btn" data-sid-step="1">Next →</button></div><p data-sid-change></p><div class="monitor-sid-capture-chips"></div><div class="monitor-sid-capture-footer"><small data-sid-status></small><button class="btn" data-sid-video>Inspect this moment in Video →</button></div>`;
  root.append(panel);
  const slider=panel.querySelector('input'),positionLabel=panel.querySelector('[data-sid-position]'),change=panel.querySelector('[data-sid-change]'),status=panel.querySelector('[data-sid-status]'),video=panel.querySelector('[data-sid-video]'),chips=[];
  for(let chip=0;chip<2;chip++) {
    const section=document.createElement('section');section.className='monitor-sid-capture-chip';section.dataset.capturedSid=chip;
    section.innerHTML=`<h3>SID ${chip+1} <small></small></h3><div class="monitor-sid-capture-voices"></div><p class="monitor-sid-capture-filter"></p>`;
    const voices=[];
    for(let voice=0;voice<3;voice++) {
      const card=document.createElement('section');card.className='monitor-sid-capture-voice';card.dataset.capturedVoice=voice;
      card.innerHTML=`<header><b>Voice ${voice+1}</b><strong></strong></header><div class="monitor-sid-capture-plot"><svg viewBox="0 0 600 64" preserveAspectRatio="none" role="img" aria-label="Voice ${voice+1} pitch and gate settings across the frame"><path class="monitor-sid-capture-pitch"/><path class="monitor-sid-capture-gate"/></svg><i></i></div><p class="monitor-sid-capture-settings"></p><div class="monitor-sid-capture-values"><small></small><code></code></div>`;
      section.querySelector('.monitor-sid-capture-voices').append(card);
      voices.push({card,frequency:card.querySelector('strong'),pitch:card.querySelector('.monitor-sid-capture-pitch'),gate:card.querySelector('.monitor-sid-capture-gate'),cursor:card.querySelector('i'),settings:card.querySelector('p'),details:card.querySelector('small'),bytes:card.querySelector('code')});
    }
    chips.push({section,identity:section.querySelector('h3 small'),filter:section.querySelector('.monitor-sid-capture-filter'),voices});panel.querySelector('.monitor-sid-capture-chips').append(section);
  }
  let frame=null,timeline=null,dirty=false,active=false,position=0;
  function tick(){return position?timeline.moments[position-1].tick:0;}
  function drawTraces() {
    for(let chip=0;chip<2;chip++)for(let voice=0;voice<3;voice++) {
      const item=chips[chip].voices[voice];let pitch='',gate='';
      if(timeline?.complete && chip<timeline.chips) {
        const points=sidVoiceTrace(timeline,chip,voice);
        for(let i=0;i<points.length-1;i++) {
          const point=points[i],x=600*point.tick/timeline.duration,end=600*points[i+1].tick/timeline.duration,y=49-44*Math.log2(1+point.frequency)/16;
          pitch+=`${i?'V':'M'+x+' '}${y}H${end}`;
          if(point.gate)gate+=`M${x} 59H${end}`;
        }
      }
      item.pitch.setAttribute('d',pitch);item.gate.setAttribute('d',gate);
    }
  }
  function prepare() {if(dirty){timeline=capturedSidTimeline(frame);dirty=false;position=Math.min(position,timeline?.moments.length??0);drawTraces();}}
  function render() {
    if(!active)return;
    prepare();
    const count=timeline?.moments.length??0,moment=position?timeline.moments[position-1]:null,registers=capturedSidState(timeline,position);
    slider.max=count;slider.value=position;slider.disabled=!count;
    positionLabel.textContent=moment?`Change ${position} / ${count} · raster ${Math.floor(moment.tick/frame.cyclesPerLine)}, cycle ${moment.tick%frame.cyclesPerLine+1}`:'Frame start · before recorded writes';
    slider.setAttribute('aria-valuetext',positionLabel.textContent);
    for(const button of panel.querySelectorAll('[data-sid-step]'))button.disabled=Number(button.dataset.sidStep)<0?position===0:position===count;
    change.textContent=!timeline?'No captured SID evidence yet.':!moment?(count?`${count} moments with SID writes. Choose Next to follow the first change.`:timeline.complete?'No SID writes in this frame. The captured settings stay unchanged.':'No SID writes are available in this incomplete recording.'):
      moment.writes.map(write=>`SID ${write.chip+1} · ${write.register<21?registerMeaning(0xd400+write.register).replace(/^SID /,''):['Filter cutoff low','Filter cutoff high','Resonance / routing','Filter mode / volume'][write.register-21]}: $${hex(write.value,2)}`).join(' · ');
    status.textContent=!timeline?'Open Monitor with the machine powered on to capture a frame.':!timeline.complete?'Incomplete recording. Later voice settings and traces cannot be reconstructed reliably.':'The line marks the selected moment. Upper trace: pitch setting. Lower bar: gate on. Gate off can still sound during release.';
    video.disabled=!timeline;
    for(let chip=0;chip<2;chip++) {
      const item=chips[chip],enabled=!!timeline&&chip<timeline.chips,base=chip?timeline?.sid2Address:0xd400;
      item.section.classList.toggle('is-inactive',!enabled);
      item.identity.textContent=enabled?`$${hex(base)}`:timeline?'Not enabled in this capture':'No capture';
      for(let voice=0;voice<3;voice++) {
        const row=item.voices[voice],state=enabled&&registers?voiceDescription(registers,chip,voice):null;
        row.card.classList.toggle('is-changed',enabled&&!!moment?.writes.some(w=>w.chip===chip&&w.register>=voice*7&&w.register<voice*7+7));
        row.cursor.hidden=!enabled||!timeline.complete;row.cursor.style.left=`${timeline?100*tick()/timeline.duration:0}%`;
        row.frequency.textContent=state?`${state.hz.toFixed(1)} Hz${state.note?' ≈ '+state.note:''}`:'—';
        row.settings.textContent=state?`${state.wave} · Gate ${state.gate?'on':'off'} · ${state.route}`:'';
        row.details.textContent=state?`Pulse ${state.pulsePercent.toFixed(1)}% · ADSR ${state.adsr.join('/')} · Sync ${state.control&2?'on':'off'} · Ring ${state.control&4?'on':'off'} · Test ${state.control&8?'on':'off'}`:'';
        row.bytes.textContent=state?`$${hex(base+voice*7)}: ${Array.from(registers.subarray(chip*32+voice*7,chip*32+voice*7+7),n=>hex(n,2)).join(' ')}`:'';
      }
      const r=registers,offset=chip*32;
      item.filter.classList.toggle('is-changed',enabled&&!!moment?.writes.some(w=>w.chip===chip&&w.register>=21));
      item.filter.textContent=enabled&&r?`Cutoff ${(r[offset+21]&7)|(r[offset+22]<<3)} · Resonance ${r[offset+23]>>>4} · Volume ${r[offset+24]&15}. ${filterDescription(r,chip)}`:enabled?'Settings unavailable after missing writes.':'Three additional voices with an independent filter.';
    }
  }
  function select(value) {prepare();if(!timeline)return;position=Math.max(0,Math.min(timeline.moments.length,value));onPosition(tick());render();}
  slider.addEventListener('input',()=>select(Number(slider.value)));
  for(const button of panel.querySelectorAll('[data-sid-step]'))button.addEventListener('click',()=>select(position+Number(button.dataset.sidStep)));
  video.addEventListener('click',()=>{if(timeline)openFrame(frame,tick());});
  return {
    setFrame(value){frame=value;timeline=null;dirty=true;position=0;if(!value){drawTraces();}render();},
    setActive(value){active=value;render();},
    seek(value){prepare();position=sidPositionAt(timeline,value);render();},
    inspect(value,at){this.setFrame(value);this.seek(at);},
    remember(){const savedFrame=frame,savedPosition=position;return()=>{frame=savedFrame;dirty=true;position=savedPosition;render();};},
    theme:render,
  };
}
