// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { graphicsAddress } from './bauer-model.js';
import { hex } from './memory-sampler.js';

// Idle graphics g-accesses differ from discarded idle bus accesses.
export function ghostByteFinding(frame) {
  const p=frame?.provenance,a=frame?.analysis,q=a?.sequencer;
  const base={title:'Ghost bytes (idle graphics)',rule:'3.7.3.9',topic:'timing'};
  if(!p||p.overflow||frame.overflow||!q?.display||!q.bank||!q.registers||!a.vicValid) {
    return {...base,status:'Insufficient evidence',text:'A ghost byte is the byte the VIC repeats instead of normal character or bitmap data while its graphics sequencer is idle. Capture detailed evidence to check its source, values and timing.'};
  }
  const reads=new Map(),sources=new Map();
  let open=0,pattern=0,first=null,firstOpen=null;
  for(let i=0;i<p.count;i++) {
    if(p.kind[i]!==2)continue;
    const tick=p.tick[i],cycle=tick%frame.cyclesPerLine+1;
    if(cycle<16||cycle>55||!a.vicValid[tick]||q.display[tick]!==0)continue;
    const d011=q.registers[tick*64+0x11],d016=q.registers[tick*64+0x16];
    const address=q.bank[tick]+graphicsAddress(d011,0,0,0,0,false);
    if(p.address[i]!==address)continue;
    const key=tick*65536+address,value=p.value[i];
    if(reads.has(key)) {
      if(reads.get(key)!==value)return {...base,status:'Insufficient evidence',text:'Source samples disagree within an idle graphics access. This capture cannot establish which ghost byte was fetched.'};
      continue;
    }
    reads.set(key,value);
    if(!sources.has(address))sources.set(address,new Set());
    sources.get(address).add(value);
    const sample={tick,address,value};
    first??=sample;
    if(frame.flags&&!(frame.flags[tick]&3)) {
      open++;firstOpen??=sample;
      if(value&&!(d011&0x20)&&!((d011&0x40)&&(d016&0x10)))pattern++;
    }
  }
  if(!first)return {...base,status:'Not observed',text:'No matching idle graphics reads were recorded. A read of the last bank byte alone is not enough: the sequencer must be idle during a graphics-fetch cycle. This is not proof that the program never uses ghost bytes.'};
  const selected=firstOpen??first;
  const sourceText=[...sources].map(([address,values])=>`$${hex(address)}: ${[...values].slice(0,8).map(value=>'$'+hex(value,2)).join(', ')}${values.size>8?'…':''}`).join(' · ');
  return {...base,...selected,status:pattern?'Candidate':'Observed',
    text:`${reads.size} idle graphics accesses read ${sources.size} source address${sources.size===1?'':'es'}. The VIC repeats this byte with zero screen and colour data. The source is bank + $3FFF, or bank + $39FF when ECM is set. ${open?`${open} accesses coincide with both border gates open. ${pattern?'Nonzero bytes in text modes could produce a repeated pattern.':'These samples alone do not establish a visible byte pattern.'}`:'All matching accesses have a border gate closed at the fetch cycle.'} Fetch timing does not prove which final pixels are visible, or that the program intended an effect.`,
    evidence:`Recorded VIC bus reads: ${sourceText}. Ordinary idle bus accesses outside the graphics-fetch window are excluded.`,
  };
}
