// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { sidActivity } from './activity-model.js';

export function createSidActivityView(root){
  root.innerHTML='<p>Watch pitch and gate changes over the last eight emulated seconds. Pause to hold the history.</p><div class="monitor-sid-activity-chips"></div><p class="monitor-tag" data-activity="note"></p>';
  const holder=root.querySelector('div'),note=root.querySelector('[data-activity="note"]');
  let epoch=-1,lastCycle=-1,lastSummary=-1,lastPaused=false,panels=[];
  function update(activity,paused=false){
    if(!activity?.active){note.textContent='Waiting for SID write observations.';holder.replaceChildren();epoch=-1;return;}
    const holding=paused&&!lastPaused;lastPaused=paused;
    if(!holding&&epoch===activity.epoch&&lastCycle===activity.endCycle)return;
    // Plot at most ten times a second. Prose changes only every two seconds.
    if(!holding&&epoch===activity.epoch&&activity.endCycle-lastCycle<98524)return;
    const data=sidActivity(activity);
    if(epoch!==activity.epoch){
      epoch=activity.epoch;lastSummary=-1;holder.replaceChildren();panels=[];
      for(let chip=0;chip<2;chip++){
        const inactive=chip>=activity.sidCount;
        const panel=document.createElement('section');panel.classList.toggle('is-inactive',inactive);
        panel.innerHTML=`<header><h3>SID ${chip+1}</h3><span class="monitor-tag">${inactive?'Not enabled · Enable in Options → Sound':'Recorded writes'}</span></header><div class="monitor-sid-activity-voices"></div><p></p>`;
        const voices=[];
        for(let v=0;v<3;v++){
          const item=document.createElement('section');item.innerHTML=`<b>Voice ${v+1}</b><svg viewBox="0 0 480 90" role="img" aria-label="Recorded frequency settings, with gate-on bands"><path class="monitor-sid-gates"/><path class="monitor-sid-ranges"/><path class="monitor-sid-pitches"/></svg><p></p>`;
          if(inactive){item.querySelector('svg').setAttribute('aria-hidden','true');item.querySelector('p').textContent='Not enabled';}
          panel.querySelector('div').append(item);voices.push({range:item.querySelector('.monitor-sid-ranges'),pitch:item.querySelector('.monitor-sid-pitches'),gate:item.querySelector('.monitor-sid-gates'),text:item.querySelector('p')});
        }
        if(inactive)panel.querySelector(':scope > p').textContent='Three more voices, with their own filter and output.';
        holder.append(panel);panels.push({voices,text:panel.querySelector(':scope > p')});
      }
    }
    const summaries=holding||lastSummary<0||activity.endCycle-lastSummary>=1970496;
    for(const v of data.voices){
      const view=panels[v.chip].voices[v.voice],n=v.pitch.length;let pitch='',gate='',range='';
      for(let i=0;i<n;i++){
        const x=i*480/n,y=76-v.pitch[i]/65535*68;
        if(v.high[i]!==v.low[i])range+=`M${x.toFixed(1)},${(76-v.high[i]/65535*68).toFixed(1)}V${(76-v.low[i]/65535*68).toFixed(1)} `;
        pitch+=`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)} `;
        if(v.gate[i])gate+=`M${x.toFixed(1)},84h${(480/n).toFixed(1)}v5h-${(480/n).toFixed(1)}z `;
      }
      view.range.setAttribute('d',range);view.pitch.setAttribute('d',pitch);view.gate.setAttribute('d',gate);
      if(summaries)view.text.textContent=v.description;
    }
    if(summaries){for(let i=0;i<data.filters.length;i++){const f=data.filters[i];panels[i].text.textContent=`Filter cutoff: ${f.cutoffChanges?'changing':'steady'} · volume register: ${f.volumeChanges?'changing':'steady'}`;}lastSummary=activity.endCycle;}
    note.textContent=`${data.seconds.toFixed(1)} s of recorded writes${data.truncated?' · buffer limit reached, earlier writes omitted':''}. Lines show frequency-register settings on a fixed scale. Vertical ranges retain brief changes. Bottom bands mark gate on within each plotted interval. These are not measured audio or detected notes.`;
    lastCycle=activity.endCycle;
  }
  return {update};
}
