// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { decodeGraphicsPixel } from './graphics-pixel.js';
import { hex } from './memory-sampler.js';

// Decode detached output-phase evidence. No live memory or emulator imports.
export function phasePixel(frame,index) {
  const p=frame.provenance?.pixels;
  if(p?.version!==1||p.phase!=='renderer-output'||!p.source[index])return null;
  const sample=p.sample[index],mode=(sample>>>20)&7;
  const value=sample&255,matrix=(sample>>>8)&255,colour=(sample>>>16)&15,offset=(sample>>>23)&7;
  const decoded=decodeGraphicsPixel({d011:(mode&6)<<4,d016:(mode&1)<<4,value,matrix,colour,offset});
  const selected=decoded.selected;
  let colourIndex=selected.register===undefined?selected.index:(p.backgrounds[index]>>>((selected.register-0x21)*4))&15;
  if(sample&0x40000000)colourIndex=(sample>>>26)&15;
  const palette=frame.palette?.[colourIndex],rgba=frame.rgba,pos=index*4;
  const colourMatch=palette===undefined||!rgba?null:
    rgba[pos]===(palette>>>16&255)&&rgba[pos+1]===(palette>>>8&255)&&rgba[pos+2]===(palette&255);
  const foregroundMatch=frame.provenance.foreground?.[index]===undefined?null:
    !!frame.provenance.foreground[index]===decoded.foreground;
  return {...decoded,colourIndex,matrix,colour,value,address:p.address[index],tick:p.tick[index],
    evidence:p.source[index]===4?'empty':p.source[index]===3?'idle':'renderer',colourMatch,foregroundMatch,modeCode:mode};
}

export function explainPhasePixel(frame,index) {
  const pixel=phasePixel(frame,index);
  if(!pixel)return {title:'This pixel needs more source evidence',text:'The captured picture is available, but this output path did not retain a source byte for this pixel.'};
  const {value,address,tick,matrix,colourIndex}=pixel;
  if(pixel.evidence==='empty'&&pixel.colourMatch!==false&&pixel.foregroundMatch!==false)return {title:'The graphics shifter is empty',text:`Fine scrolling leaves this position before the next source byte arrives. Empty output selects ${pixel.selected.label.toLowerCase()}, colour index ${colourIndex}.`,tick};
  if(pixel.colourMatch===false||pixel.foregroundMatch===false)return {
    title:'The recorded source does not fully explain this pixel',
    text:'The output-stage source and the final picture disagree. A later rendering effect needs additional evidence. The Monitor keeps this unresolved rather than guessing.',address,tick,value,
  };
  const bits=pixel.bitCount===2?`Bits ${pixel.shift+1}–${pixel.shift} are ${pixel.code.toString(2).padStart(2,'0')}`:`Bit ${pixel.shift} is ${pixel.code}`;
  return {title:`${pixel.mode} → bits → colour`,
    text:`${pixel.evidence==='idle'?'Idle graphics repeat a source byte with zero screen and colour data. ':''}Recorded renderer source sample, not an independently timed bus fetch. Source $${hex(address)} = $${hex(value,2)}. ${pixel.character===null?`Screen byte $${hex(matrix,2)} supplies cell colours.`:`Screen code $${hex(matrix,2)} selects character ${pixel.character}.`} ${bits}, selecting ${pixel.selected.label}. Colour index ${colourIndex}. The recorded output-stage controls apply to this pixel, including changes within the line. This code counts as ${pixel.foreground?'foreground':'background'} for sprite priority.`,
    address,tick,value,graphics:pixel};
}
