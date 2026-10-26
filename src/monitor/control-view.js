// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { controlSummary } from './live-model.js';
import { hex } from './memory-sampler.js';

const KEYS = [
  ['DEL','RETURN','→','F7','F1','F3','F5','↓'],
  ['3','W','A','4','Z','S','E','L SHIFT'],
  ['5','R','D','6','C','F','T','X'],
  ['7','Y','G','8','B','H','U','V'],
  ['9','I','J','0','M','K','O','N'],
  ['+','P','L','−','.',':','@',','],
  ['£','*',';','HOME','R SHIFT','=','↑','/'],
  ['1','←','CTRL','2','SPACE','C=','Q','STOP'],
].flat();

export function createControlView(root) {
  root.innerHTML=`<p data-controls="summary"></p><div class="monitor-control-ports">${[1,2].map(port=>`<section><h3>Control port ${port}</h3><div class="monitor-input-signals" data-controls="port-${port}">${['Up','Down','Left','Right','Fire'].map(name=>`<span>${name}</span>`).join('')}</div></section>`).join('')}</div><section><h3>Keyboard matrix</h3><p class="monitor-note">The CIA scans eight groups of eight switches. Highlighted keys connect a row and column.</p><div class="monitor-keyboard-matrix" data-controls="keys" role="img" aria-label="Eight by eight C64 key matrix">${KEYS.map(name=>`<i>${name}</i>`).join('')}</div><p class="monitor-note" data-controls="paddles"></p></section><section><h3>Timers and interrupts</h3><div class="monitor-controls-table"><table><thead><tr><th>Timer</th><th>State</th><th>Counts</th><th>Reload</th><th>Clock source</th></tr></thead><tbody>${['CIA1 A','CIA1 B','CIA2 A','CIA2 B'].map((name,i)=>`<tr data-timer="${i}"><th>${name}</th><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table></div><p data-controls="interrupts"></p><p class="monitor-note">Timers count down and reload or stop. Underflow can request an interrupt when enabled in the mask. Started describes the control bit. Timer counts are snapshots, not measured rates. Reading them does not advance timers or acknowledge interrupts. CIA1 can request IRQ, while CIA2 can request NMI.</p></section>`;
  const el=name=>root.querySelector(`[data-controls="${name}"]`);
  return { update(state) {
    const summary=controlSummary(state); el('summary').textContent=`${summary.title} · ${summary.detail}`;
    root.querySelectorAll('section').forEach(section=>section.hidden=!state);
    if(!state) return;
    for(let port=0;port<2;port++) [...el(`port-${port+1}`).children].forEach((node,i)=>node.classList.toggle('is-active',!(state.ports[port]&(1<<i))));
    const held=[];
    [...el('keys').children].forEach((node,i)=>{const active=!(state.keyboard[i>>3]&(1<<(i&7)));node.classList.toggle('is-active',active);if(active)held.push(KEYS[i]);});
    el('keys').setAttribute('aria-label',held.length?`Keys held: ${held.join(', ')}`:'Keyboard matrix: no keys held');
    for(let i=0;i<4;i++) {
      const cells=root.querySelector(`[data-timer="${i}"]`).children, control=state.timerControl[i];
      cells[1].textContent=`${control&1?'Started':'Stopped'} · ${control&8?'one-shot':'repeat'}`;
      cells[2].textContent=`$${hex(state.timerCounts[i])}`; cells[3].textContent=`$${hex(state.timerLatches[i])}`;
      cells[4].textContent=i%2?['System cycles','CNT input','Timer A underflows','Timer A + CNT high'][(control>>5)&3]:control&32?'CNT input':'System cycles';
    }
    el('interrupts').textContent=Array.from(state.interrupts,(status,i)=>`CIA${i+1} pending $${hex(status&31,2)} · mask $${hex(state.interruptMasks[i],2)}`).join(' / ');
    el('paddles').textContent=state.potConnected?`SID paddle samples: X ${state.potX}, Y ${state.potY}. These pins can also serve a mouse.`:'Paddle pins disconnected. No device type is inferred from idle input.';
  } };
}
