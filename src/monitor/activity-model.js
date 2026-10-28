// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const PAL_CLOCK=985248;
export function recentLoads(activity,device) {
  const result=[];if(!activity?.active)return result;
  for(let seq=activity.first;seq<activity.next;seq++){
    const i=seq%activity.kind.length;
    if(activity.kind[i]===1&&activity.device[i]===device&&activity.value[i])result.push({sequence:seq,address:activity.address[i],bytes:activity.value[i],ramBytes:activity.ramBytes[i]});
  }
  return result;
}

// Reconstruct register settings from retained writes, never from current RAM.
export function sidActivity(activity,bins=160) {
  if(!activity?.active)return null;
  const start=activity.startCycle,end=activity.endCycle,span=Math.max(1,end-start),regs=activity.initialSid.slice();
  const voices=Array.from({length:activity.sidCount*3},(_,index)=>({chip:Math.floor(index/3),voice:index%3,pitch:new Uint16Array(bins),low:new Uint16Array(bins),high:new Uint16Array(bins),gate:new Uint8Array(bins),pitchChanges:0,gateStarts:0,pulseChanges:0,waveChanges:0}));
  const filters=Array.from({length:activity.sidCount},()=>({cutoffChanges:0,volumeChanges:0}));
  let seq=activity.first,writes=0;
  for(let bin=0;bin<bins;bin++){
    const until=start+(bin+1)/bins*span;
    for(const v of voices){const offset=v.chip*32+v.voice*7;v.low[bin]=v.high[bin]=regs[offset]|(regs[offset+1]<<8);v.gate[bin]=regs[offset+4]&1;}
    for(;seq<activity.next;seq++){
      const i=seq%activity.kind.length;if(activity.cycle[i]>until)break;
      if(activity.kind[i]!==0)continue;
      const chip=activity.device[i],reg=activity.address[i],offset=chip*32,old=regs[offset+reg],value=activity.value[i];
      regs[offset+reg]=value;writes++;
      if(old===value||chip>=activity.sidCount)continue;
      if(reg<21){const v=voices[chip*3+Math.floor(reg/7)],part=reg%7;
        if(part<2){v.pitchChanges++;const base=offset+v.voice*7,frequency=regs[base]|(regs[base+1]<<8);v.low[bin]=Math.min(v.low[bin],frequency);v.high[bin]=Math.max(v.high[bin],frequency);}
        if(part===2||(part===3&&((old^value)&15)))v.pulseChanges++;
        if(part===4){v.gate[bin]|=value&1;if(!(old&1)&&(value&1))v.gateStarts++;if((old^value)&240)v.waveChanges++;}
      }else if((reg===21&&((old^value)&7))||reg===22)filters[chip].cutoffChanges++;
      else if(reg===24&&((old^value)&15))filters[chip].volumeChanges++;
    }
    for(const v of voices){const offset=v.chip*32+v.voice*7;v.pitch[bin]=regs[offset]|(regs[offset+1]<<8);v.gate[bin]|=regs[offset+4]&1;}
  }
  for(const v of voices){
    const changes=[];
    if(v.gateStarts)changes.push(`${v.gateStarts} envelope ${v.gateStarts===1?'start':'starts'}`);
    if(v.pitchChanges)changes.push('pitch changes');
    if(v.pulseChanges)changes.push('pulse width changes');
    if(v.waveChanges)changes.push('waveform switches');
    v.description=changes.length?changes.join(' · '):'Settings held steady';
  }
  return {seconds:span/PAL_CLOCK,voices,filters,writes,truncated:activity.truncated};
}
