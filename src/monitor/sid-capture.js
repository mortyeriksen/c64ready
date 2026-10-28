// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// SID register addresses in provenance are chip-local. Equal-cycle writes form
// one inspection moment, in recording order, across both chips.
export function capturedSidTimeline(frame) {
  const p=frame?.provenance;
  if(!p?.sid || !p.kind || !p.tick || !p.address || !p.value || !p.aux) return null;
  const moments=[], chips=Math.min(2,p.sidCount), duration=frame.lines*frame.cyclesPerLine;
  for(let i=0;i<p.count;i++) {
    if(p.kind[i]!==5 || p.aux[i]>=chips || p.address[i]>24 || p.tick[i]>=duration) continue;
    let moment=moments.at(-1);
    if(!moment || moment.tick!==p.tick[i]) {moment={tick:p.tick[i],writes:[]};moments.push(moment);}
    moment.writes.push({chip:p.aux[i],register:p.address[i],value:p.value[i]});
  }
  return {initial:p.sid.slice(),chips,sid2Address:p.sid2Address,duration,moments,complete:!p.overflow&&!frame.overflow};
}

export function capturedSidState(timeline, position) {
  if(!timeline || (!timeline.complete && position>0)) return null;
  const registers=timeline.initial.slice();
  for(let i=0;i<Math.min(position,timeline.moments.length);i++) {
    for(const write of timeline.moments[i].writes) registers[write.chip*32+write.register]=write.value;
  }
  return registers;
}

export function sidPositionAt(timeline,tick) {
  let low=0,high=timeline?.moments.length??0;
  while(low<high) {const mid=(low+high)>>>1;if(timeline.moments[mid].tick<=tick)low=mid+1;else high=mid;}
  return low;
}

export function sidVoiceTrace(timeline,chip,voice) {
  const base=voice*7,offset=chip*32+base;
  let frequency=timeline.initial[offset]|timeline.initial[offset+1]<<8,gate=timeline.initial[offset+4]&1;
  const points=[{tick:0,frequency,gate}];
  for(const moment of timeline.moments) {
    let changed=false;
    for(const write of moment.writes) {
      if(write.chip!==chip)continue;
      if(write.register===base) {frequency=(frequency&0xff00)|write.value;changed=true;}
      if(write.register===base+1) {frequency=(frequency&255)|(write.value<<8);changed=true;}
      if(write.register===base+4) {gate=write.value&1;changed=true;}
    }
    if(changed)points.push({tick:moment.tick,frequency,gate});
  }
  points.push({tick:timeline.duration,frequency,gate});
  return points;
}
