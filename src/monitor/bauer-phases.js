// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { POINTER_CYCLES } from './bauer-model.js';

// Bauer 3.6.1/3.6.3: a PAL line begins at X=404 and wraps after X=503.
export function palBeamX(cycle, pixel = 0) {
  return (404 + (cycle - 1) * 8 + pixel) % 504;
}

// These are reference access slots, not timestamps manufactured for recorded reads.
export function palAccess(cycle, phase, dma, matrix) {
  for(let slot=0;slot<8;slot++) {
    const delta=(cycle-POINTER_CYCLES[slot]+63)%63;
    if(delta===0 && phase===1)return {type:'pointer',slot};
    if((dma&(1<<slot)) && (delta===1 || delta===0&&phase===2))
      return {type:'sprite',slot,byte:delta===0?1:phase===1?2:3};
  }
  if(phase===2)return {type:matrix&&cycle>=15&&cycle<=54?'matrix':'cpu'};
  if(cycle>=11&&cycle<=15)return {type:'refresh'};
  return {type:cycle>=16&&cycle<=55?'graphics':'idle'};
}

export function spriteXMatch(cycle, x) {
  if(x<0||x>=504)return -1;
  for(let pixel=0;pixel<8;pixel++)if(palBeamX(cycle,pixel)===x)return pixel;
  return -1;
}

// The logical display latch is reconstructed separately from the renderer flag.
// Unknown initial or missing states stay unknown until a rule establishes a value.
export function logicalDisplayTrace(frame) {
  const n=frame.lines*frame.cyclesPerLine,a=frame.analysis,q=a?.sequencer;
  const out=new Uint8Array(n).fill(2);
  if(frame.overflow||!a?.vicValid||!a.d011||!a.denLatch||!q?.rc)return out;
  let display=2;
  for(let t=0;t<n;t++) {
    if(!a.vicValid[t]){display=2;continue;}
    const line=Math.floor(t/63),cycle=t%63+1;
    const bad=line>=48&&line<=247&&(line&7)===(a.d011[t]&7)&&!!a.denLatch[t];
    if(bad)display=1;
    else if(cycle===58&&t>0&&a.vicValid[t-1]&&q.rc[t-1]===7)display=0;
    out[t]=display;
  }
  return out;
}

const names={pointer:'sprite pointer',sprite:'sprite data',matrix:'screen cell + colour',cpu:'CPU half-cycle',refresh:'DRAM refresh',graphics:'graphics byte',idle:'discarded idle read'};
export function describeBauerPhases(frame,tick,logical) {
  const a=frame?.analysis,q=a?.sequencer;
  if(frame?.lines!==312||frame.cyclesPerLine!==63||frame.overflow||!Number.isInteger(tick)||tick<0||tick>=19656||!a?.vicValid?.[tick]||q?.registers?.length!==19656*64||q.dma?.length!==19656||q.spriteDisplay?.length!==19656||a.d011?.length!==19656||a.denLatch?.length!==19656)return null;
  const cycle=tick%63+1,line=Math.floor(tick/63);
  let armed=false;
  for(let c=12;c<=Math.min(cycle,54);c++) {
    const t=line*63+c-1;
    if(!a.vicValid[t])return null;
    if(line>=48&&line<=247&&(line&7)===(a.d011[t]&7)&&a.denLatch[t])armed=true;
  }
  const phases=[1,2].map(phase=>{
    const access=palAccess(cycle,phase,q.dma[tick],armed);
    return `ϕ${phase}: ${names[access.type]}${access.slot===undefined?'':` ${access.slot}`}${access.byte?` · byte ${access.byte}/3`:''}`;
  });
  const matches=[];
  for(let slot=0;slot<8;slot++) {
    const x=q.registers[tick*64+slot*2]|(((q.registers[tick*64+0x10]>>>slot)&1)<<8);
    const pixel=spriteXMatch(cycle,x);
    if(pixel>=0)matches.push(`Sprite ${slot} X matches at pixel ${pixel+1}/8${q.spriteDisplay[tick]&(1<<slot)?' · display enabled':' · display disabled'}`);
  }
  const display=logical?.[tick]??2;
  return {phases,matches,beam:`Beam X ${palBeamX(cycle)} → ${palBeamX(cycle,7)}`,display:display===2?'Logical display state unresolved':`Logical display state: ${display?'display':'idle'}`};
}
