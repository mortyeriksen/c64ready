// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { phasePixel } from './pixel-phase.js';
import { hex } from './memory-sampler.js';

const GRAPHICS = [
  ['Small patterns build the picture','Character graphics reuse small patterns','Screen codes choose 8 × 8 patterns. Those patterns can be letters, scenery or artwork, so character mode does not necessarily mean text.'],
  ['Some colours use wider pixels','Multicolour characters trade detail for colour','A multicolour character can interpret two bits together, choosing from four colours. Individual cells can still use single-colour detail.'],
  ['The picture uses bitmap data','Bitmap bytes supply the shapes','Bitmap bytes describe the pattern directly. The screen byte supplies two colours for each 8 × 8 cell instead of choosing a character.'],
  ['Pairs of bits paint bitmap colours','A multicolour bitmap uses wider colour steps','Each pair of bits chooses one of four colour sources. Screen memory, colour RAM and a shared background supply those colours.'],
  ['Characters choose their own background','Character codes also select a background','The top two screen-code bits choose one of four background colours. The remaining six bits select one of 64 character patterns.'],
  ['Black can come from the graphics mode','An invalid mode forces graphics output to black','This combination of graphics controls produces black. The source byte can still contain data, and sprite layers remain separate.'],
  ['Black can come from the graphics mode','An invalid mode forces graphics output to black','This combination of graphics controls produces black. The source byte can still contain data, and sprite layers remain separate.'],
  ['Black can come from the graphics mode','An invalid mode forces graphics output to black','This combination of graphics controls produces black. The source byte can still contain data, and sprite layers remain separate.'],
];
const GRAPHICS_INTROS = [
  'A matching pixel sample comes from character graphics. Small reusable patterns supply the shapes, rather than a separate stored value for every screen pixel.',
  'The recorded graphics controls allow multicolour characters. This combines extra colour choices with cell-by-cell control over horizontal detail.',
  'A matching source sample comes from bitmap graphics. Shape data and cell colours have separate jobs in building the final pixel.',
  'This recording contains verified multicolour bitmap output. It combines locally chosen colours with a background shared across the picture.',
  'A matching character sample uses extended-background mode. Part of the screen code selects the background as well as the shape.',
  'A verified pixel uses a graphics-control combination that produces black. A black area therefore does not necessarily mean empty memory.',
];
const CONTROL_TOPICS = {
  'mode-switch':['graphics','The same bits can mean different things'],
  'fine-scroll':['position','Small offsets affect how the picture lines up'],
  window:['border','The border depends on the screen-window controls'],
  'display-enable':['timing','Display decisions depend on when settings change'],
  'screen-memory':['memory','Screen information can come from different places'],
  'shape-memory':['memory','A different address can mean a different shape'],
  priority:['layering','Visible layers depend on who is in front'],
  expansion:['sprite-timing','Sprite sizing is part of the timing'],
  'sprite-colours':['sprite-style','Sprite bits have more than one colour interpretation'],
  'sprite-enable':['layering','Sprite slots are switched during the frame'],
};

// Candidates describe recorded pixels or changed bits, never a program's intent.
export function summaryFindings(frame, story, strip, patch) {
  const cards=[],moments=new Map(story.moments.map(m=>[m.id,m]));
  const stopFor=(kind,tick)=>{
    let match=null;
    for(const stop of story.stops)if(stop.kind===kind&&stop.tick<=tick)match=stop;
    return match?.id??moments.get(kind)?.id;
  };
  const changes=(kind,registers)=> (moments.get(kind)?.changes??[]).filter(c=>c.before!==null&&registers.some(([reg,mask])=>c.register===reg&&((c.before^c.after)&mask)));
  const addWrites=(id,kind,registers,score,title,text,intro)=>{
    const writes=changes(kind,registers);if(!writes.length)return;
    const first=writes.find(c=>c.tick>=frame.rasterOffset*frame.cyclesPerLine&&c.tick<(frame.rasterOffset+frame.height)*frame.cyclesPerLine)??writes[0];
    const line=Math.floor(first.tick/frame.cyclesPerLine);
    const [category,headline]=CONTROL_TOPICS[id];
    cards.push({id,category,score,title,text,headline,intro,
      crops:[strip(line)],storyId:stopFor(kind,first.tick),
      evidence:`${writes.length} recorded changes affect these controls. At raster ${line}, cycle ${first.tick%frame.cyclesPerLine+1}, $D0${hex(first.register,2)} changes from $${hex(first.before,2)} to $${hex(first.after,2)}. The strip shows the final picture near that time, not a before/after comparison. The write alone does not prove a visible effect.`});
  };
  addWrites('mode-switch','mode',[[0x11,0x60],[0x16,0x10]],88,'Graphics rules change during drawing','The video chip can interpret later bytes differently when character, bitmap or multicolour controls change.','The program changes how the video chip interprets graphics during this frame. The timing of each change matters as much as the bytes in memory.');
  addWrites('fine-scroll','mode',[[0x11,7],[0x16,7]],78,'Fine-scroll controls change','Small offsets position graphics between character-cell boundaries. Vertical scroll also participates in deciding when the row buffer is fetched.','Fine-scroll settings change within this frame. These offsets can reposition graphics, but one recording cannot establish movement over time.');
  addWrites('window','mode',[[0x11,8],[0x16,8]],76,'The screen-window controls change','The 24/25-row and 38/40-column settings affect border comparisons. A carefully timed change can alter which part of the picture is covered.','The program changes the normal screen-window settings while drawing. Border-mask evidence shows whether any extra picture actually becomes uncovered.');
  addWrites('display-enable','mode',[[0x11,0x10]],70,'The display-enable setting changes','This control participates in display and bad-line decisions at specific times. Clearing it is not an instant command to erase the entire picture.','Display-enable changes are recorded during this frame. Their effect depends on the video chip’s latch and raster timing.');
  addWrites('screen-memory','memory',[[0x18,0xf0]],86,'Screen information moves to another address','The screen selector chooses a different 1 KB area in the VIC bank. The eight sprite pointers live at the end of that area too.','The program changes where the video chip finds screen information. One selector can redirect both screen data and the sprite-pointer table.');
  addWrites('shape-memory','memory',[[0x18,0x0e]],82,'The graphics source selector changes','The graphics offset chooses character patterns or bitmap data, depending on the current mode. Stored screen codes can therefore refer to different shapes.','The recorded graphics-memory selector changes during drawing. Its meaning depends on whether the chip is producing character or bitmap graphics.');
  addWrites('priority','sprite-controls',[[0x1b,255]],84,'Sprites change their place behind graphics','Priority bits choose whether a sprite sits behind foreground graphics. Transparent graphics and sprite-to-sprite priority obey separate rules.','The program changes how sprite layers overlap the graphics layer. A sprite can be present in memory and coverage while its pixels are hidden.');
  addWrites('expansion','sprite-controls',[[0x17,255],[0x1d,255]],80,'Sprite expansion controls change','Expansion can repeat pixels horizontally or rows vertically. Vertical expansion also interacts with the sprite row counters.','Sprite size controls change during the recording. The settings and row-counter evidence need to be read together before explaining a stretched shape.');
  addWrites('sprite-colours','sprite-controls',[[0x1c,255]],74,'Sprites change how bits become colours','A multicolour sprite reads bits in pairs, choosing transparent output, its own colour or either shared sprite colour.','Sprite colour-mode controls change during this frame. They alter how the sprite’s image bits are interpreted without requiring a different image block.');
  addWrites('sprite-enable','sprite-controls',[[0x15,255]],68,'The set of enabled sprites changes','Enable bits participate in starting sprite DMA at the matching Y position. They are not a direct count of objects currently visible.','The program changes which sprite slots are enabled. Recorded output, rather than the enable bits alone, shows which slots reach the picture.');

  const pixels=frame.provenance?.pixels,visible=frame.provenance?.visibleSprites;
  const examples=new Map(),attempts=new Uint8Array(16);
  if(pixels?.version===1&&pixels.phase==='renderer-output'&&visible)for(let i=0;i<frame.width*frame.height;i++){
    if(frame.border[i]||visible[i]||pixels.source[i]!==1&&pixels.source[i]!==2)continue;
    const mode=(pixels.sample[i]>>>20)&7;
    const single=mode===1&&!(pixels.sample[i]&0x80000),key=mode+(single?8:0);
    const value=pixels.sample[i]&255;
    const quality=(value!==0&&value!==255?2:0)+(frame.rgba[i*4]||frame.rgba[i*4+1]||frame.rgba[i*4+2]?1:0)+(frame.provenance.foreground?.[i]?1:0);
    if((examples.get(key)?.quality??-1)>=quality||attempts[key]>=32)continue;
    attempts[key]++;
    const decoded=phasePixel(frame,i);
    if(decoded?.colourMatch!==true||decoded.foregroundMatch!==true)continue;
    const point={x:i%frame.width,y:Math.floor(i/frame.width)};
    examples.set(key,{mode,point,decoded,quality});
  }
  for(const [key,{mode,point,decoded}] of examples){
    const single=key===9;
    const [headline,title,text]=GRAPHICS[mode];
    cards.push({id:`graphics-${key}`,category:'graphics',score:mode>=5?89:mode===0?57:64,
      headline:single?'Multicolour controls can preserve sharp characters':headline,intro:GRAPHICS_INTROS[Math.min(mode,5)],title:single?'A multicolour screen can keep fine detail':title,
      text:single?'This cell keeps one-bit pixels because its colour-RAM flag selects single-colour output. Neighbouring cells can use multicolour pairs.':text,
      crops:[patch(point)],point,storyId:stopFor('mode',decoded.tick)??moments.get('fetch')?.id,
      evidence:`At picture (${point.x}, ${point.y}), ${decoded.mode.toLowerCase()} decodes source $${hex(decoded.address)} = $${hex(decoded.value,2)} to colour ${decoded.colourIndex}. The final colour and foreground classification agree. This is a recorded renderer-source sample, not an independently timed bus fetch or proof of the whole screen’s mode.`});
  }
  const distinct=[...new Map([...examples.values()].map(example=>[Math.min(example.mode,5),example])).values()];
  if(distinct.length>1){
    const pair=distinct.slice(0,2);
    cards.push({id:'mixed-graphics',category:'graphics',score:94,title:'One picture uses different graphics modes',
      headline:'Different parts of the picture use different graphics rules',intro:'Matching source samples show more than one graphics mode in this recording. A single memory preview cannot represent every part of the picture.',
      text:'Compare these two recorded patches. Their source bits are interpreted under different mode settings.',
      crops:pair.map(example=>patch(example.point)),point:pair[0].point,storyId:moments.get('mode')?.id??moments.get('fetch')?.id,
      evidence:pair.map(({point,decoded})=>`Picture (${point.x}, ${point.y}): ${decoded.mode.toLowerCase()}, source $${hex(decoded.address)}.`).join(' ')+' Both decoded colours and foreground classifications match the final pixels. The crops provide context, not an exact boundary between modes.'});
  }
  const dma=moments.get('dma');
  if(dma)cards.push({id:'bus-sharing',category:'timing',score:62,title:'Drawing borrows time from the CPU',
    headline:'Video and code share the same memory bus',intro:'The video chip takes memory time to fetch picture data. The recording shows when that makes the CPU wait, which is part of the cost of drawing this frame.',
    text:'The CPU sometimes waits while the video chip uses memory. This is a hardware cost, not a measure of how useful the program’s work is.',
    crops:[strip(dma.line)],storyId:'dma',evidence:`${story.budget.vic.toLocaleString()} of ${story.budget.total.toLocaleString()} cycles are recorded as VIC stalls. ${story.budget.unknown?`${story.budget.unknown.toLocaleString()} cycles have unknown bus ownership. `:''}${dma.mechanism}`});
  let invalidSeen=false;
  return cards.filter(card=>{
    if(!/^graphics-[567]$/.test(card.id))return true;
    if(invalidSeen)return false;invalidSeen=true;return true;
  });
}
