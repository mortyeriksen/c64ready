// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { voiceDescription } from './sound-model.js';

export function createLiveSound(root, caption, navigate) {
  root.innerHTML = `<div class="monitor-live-voices">${Array.from({length:6},(_,i)=>`<button type="button" data-live-voice="${i}"><span></span><canvas width="256" height="64" aria-hidden="true"></canvas></button>`).join('')}</div>`;
  root.append(caption);
  const buttons = [...root.querySelectorAll('[data-live-voice]')];
  const labels = buttons.map(button=>button.querySelector('span'));
  const contexts = buttons.map(button=>button.querySelector('canvas').getContext('2d'));
  buttons.forEach((button,i)=>button.addEventListener('click',()=>navigate('sid',{chip:Math.floor(i/3),voice:i%3})));
  let accent, ink, background;
  return {
    theme() {
      const style = getComputedStyle(root);
      accent = style.getPropertyValue('--accent').trim();
      ink = style.getPropertyValue('--dim').trim();
      background = style.getPropertyValue('--control-bg').trim();
    },
    update(state, history, now, sampleDetails) {
      for(let v=0;v<6;v++) {
        const button=buttons[v], chip=Math.floor(v/3), voiceIndex=v%3;
        button.hidden=v>=state.sidCount*3;
        if(button.hidden)continue;
        const voice=sampleDetails?voiceDescription(state.sid,chip,voiceIndex):null;
        labels[v].textContent=`${state.sidCount===2?`SID ${chip+1} · `:''}V${voiceIndex+1}${sampleDetails?` ${voice.wave} · ${Math.round(voice.hz)} Hz`:''}`;
        button.title=`Inspect SID ${chip+1}, voice ${voiceIndex+1}${sampleDetails?`. Gate ${voice.gate?'on':'off'}, ${voice.route}`:''}`;
        button.setAttribute('aria-label',`${button.title}. Sampled pitch history.`);
        const ctx=contexts[v];
        ctx.fillStyle=background;ctx.fillRect(0,0,256,64);
        for(let t=0;t<history.count;t++) {
          const i=history.index(t);
          if(v>=history.voices[i])continue;
          const pitch=Math.log2(history.frequency[v][i]+1)/16;
          ctx.fillStyle=history.gates[i]&(1<<v)?accent:ink;
          ctx.fillRect(256*(history.times[i]-now+8000)/8000,3+(1-pitch)*58,3,3);
        }
      }
    },
  };
}
