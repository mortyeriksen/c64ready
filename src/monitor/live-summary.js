// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { liveCodeSummary } from './live-code.js';
import { videoMode, enabledSpriteCount } from './live-model.js';

// Sample counts describe observations, never time spent in an instruction.
export class LiveWindowSummary {
  constructor(){this.pages=new Uint8Array(256);this.actions=new Map();this.modes=new Set();this.reset();}
  reset(){this.lastTime=-Infinity;this.start=-Infinity;this.value=null;this.clearWindow();}
  clearWindow(){this.count=0;this.pages.fill(0);this.actions.clear();this.modes.clear();this.spriteMin=8;this.spriteMax=0;this.voices=0;}
  observe(state,sampler,time,paused){
    if(time===this.lastTime)return this.value;
    if(time-this.lastTime>2500){this.clearWindow();this.start=time;this.value=null;}
    this.lastTime=time;
    if(paused){if(this.count)this.publish();this.clearWindow();this.start=time;return this.value;}
    if(time-this.start>=2000){this.publish();this.clearWindow();this.start=time;}
    this.count++;
    const action=liveCodeSummary(state).action;
    this.actions.set(action,(this.actions.get(action)??0)+1);
    for(let i=0;i<256;i++)if(sampler.pages[i])this.pages[i]=1;
    this.modes.add(videoMode(state));
    const sprites=enabledSpriteCount(state.vic[0x15]);this.spriteMin=Math.min(this.spriteMin,sprites);this.spriteMax=Math.max(this.spriteMax,sprites);
    this.voices=Math.max(this.voices,state.sidCount*3);
    return this.value;
  }
  publish(){
    if(!this.count)return;
    let action='Instruction unavailable',largest=0,pages=0;
    for(const [name,count] of this.actions)if(count>largest){action=name;largest=count;}
    for(const changed of this.pages)pages+=changed;
    this.value={
      cpu:['Executes the program',`Recent samples: ${action.toLowerCase()}.`],
      ram:[`${pages} / 256 pages changed`,'Different RAM pages observed changing in the recent window.'],
      vic:[this.modes.size===1?[...this.modes][0]:`${this.modes.size} graphics setups observed`,`${this.spriteMin===this.spriteMax?this.spriteMin:`${this.spriteMin}–${this.spriteMax}`} sprite slots enabled across recent samples.`],
      sid:[`${this.voices} available voices`,'Pitch trails show recent register settings, not measured audio.'],
    };
  }
}
