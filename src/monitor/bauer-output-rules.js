// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { OBSERVATION_RULES, prepareObservationRules } from './bauer-observation-rules.js';
import { BORDER_RULES, borderComparators } from './border-rules.js';

const rule=(id,section,title,requires,explanation)=>({id,section,title,requires,explanation});
export const OUTPUT_RULES=[
  ...OBSERVATION_RULES,
  ...BORDER_RULES.map(r=>rule(r.id,r.section,r.title,'border comparator inputs and before/after gate samples',[
    'The right comparator closes the main border. Its initial pulse is checked separately from a later timed cancellation.',
    'At line end, reaching the bottom comparator sets the vertical latch for the following line.',
    'At line end, reaching the top comparator with DEN set clears the vertical latch.',
    'At the left comparator, reaching the bottom line closes the vertical gate.',
    'At the left comparator, reaching the top line with DEN set opens the vertical gate.',
    'The left comparator opens the main border only when the vertical gate permits it.',
  ][r.number-1])),
  rule('border.right-cancel','3.14.1','Keep the right border open','complete CSEL writes and final gate history','A wide-to-narrow CSEL change in cycle 56 can cancel the right-border close. The main gate keeps its state from before that close.'),
  rule('border.left-cancel','3.14.1','Prevent the left border opening','complete CSEL writes and final gate history','A narrow-to-wide CSEL change in cycle 17 can prevent the left-border opening.'),
  ...['Standard text','Multicolour text','Standard bitmap','Multicolour bitmap','Extended-background text','Invalid text','Invalid bitmap 1','Invalid bitmap 2'].map((name,i)=>rule(`graphics.mode.${i}`,`3.7.3.${i+1}`,`${name} pixels`,'output-phase source byte, mode, colour data and final pixels','Decode the recorded byte with the controls that reached this pixel. Colour selection and foreground classification are checked independently of the renderer. A renderer source sample does not prove a timed bus fetch.')),
  rule('graphics.idle-output','3.7.3.9','Show the idle byte','idle output-phase source and zero matrix data','Idle graphics repeat the idle source byte with screen and colour data forced to zero. The selected graphics mode still controls its colour and priority.'),
  rule('graphics.fine-scroll','3.7.3','Delay graphics by fine scroll','output-stage scroll and source bit position','XSCROLL delays the source-byte reload by zero to seven pixels. Each pixel then selects the corresponding bit or pair from that recorded byte.'),
  rule('fetch.idle-address','3.7.3.9','Read the idle graphics address','timed idle graphics read, bank and ECM bit','Idle graphics read the last byte of the VIC bank, $3FFF. ECM forces address bits 9 and 10 low, selecting $39FF.'),
  rule('graphics.display-start','3.7.1 / 3.7.2 rule 3','Start display on a bad line','recorded bad-line condition and display state','A bad-line condition switches the graphics sequencer into display state. The capture exposes a rendering-stage flag, so entry before its cycle-14 window remains insufficient evidence.'),
  rule('sprite.shift','3.8.1 rule 6','Shift and expand sprite pixels','sprite shift-register state before and after a span','Each monochrome pixel shifts one bit. Multicolour consumes pairs, and horizontal expansion repeats each output twice. A consumed sprite stops after its 24 source bits.'),
  rule('sprite.pixel','3.8.1','Choose a sprite colour','raw sprite shift bits, validity, mode and palette inputs','Zero is transparent. Monochrome one selects the sprite colour. Multicolour 01 selects shared colour 0, 10 its own colour and 11 shared colour 1.'),
  rule('sprite.priority','3.8.2','Resolve sprite priority','opaque sprite candidates, priority bits and visible owner','The lowest numbered opaque sprite wins. If it is behind foreground graphics, that foreground also hides lower-priority sprites.'),
  rule('collision.sprites','3.8.2','Detect overlapping sprites','opaque sprite mask and collision pipeline before/after','Two different nontransparent sprite outputs set both sprite bits. A repeated output from the same sprite does not collide with itself.'),
  rule('collision.graphics','3.8.2','Detect sprite and graphics overlap','foreground output, opaque sprite bit and collision pipeline','An opaque sprite collides with foreground graphics even if display priority hides it. Background pixels do not set a graphics-collision bit.'),
  rule('collision.latch','3.8.2','Keep collision bits until read','collision bits presented to a latch and its before/after value','A collision sets all involved sprite bits without clearing earlier collisions.'),
  rule('collision.read-clear','3.8.2','Clear collision bits on read','collision-register read and post-read latch','Reading a collision register returns its latched bits and clears the register. Later pipeline arrivals are separate events.'),
  rule('irq.acknowledge','3.12','Acknowledge interrupt sources','IRQ latch before and after a register write','Writing one clears the corresponding pending interrupt source. Writing zero leaves that source unchanged.'),
  rule('lightpen.edge','3.11','Latch the first lightpen edge','input levels, beam position and before/after latches','The first falling lightpen edge in a frame stores X divided by two and the low eight raster bits, then requests the lightpen interrupt. Later edges leave the coordinates unchanged. The PAL last-line exception follows the VICE addendum.'),
];
const OBSERVATION_IDS=new Set(OBSERVATION_RULES.map(r=>r.id));
const NA=0,MATCH=1,MISMATCH=2,UNKNOWN=3;
const MODE_RULE_IDS=Array.from({length:8},(_,i)=>`graphics.mode.${i}`);
const verdict=(expected,actual)=>expected===actual?MATCH:MISMATCH;
function merge(rows,id,t,result) {
  const row=rows.get(id);if(!row||t<0||t>=row.length)return;
  // Any disagreement wins. Missing evidence cannot be hidden by a match.
  row[t]=row[t]===MISMATCH||result===MISMATCH?MISMATCH:row[t]===UNKNOWN||result===UNKNOWN?UNKNOWN:result;
}

export function prepareOutputRules(frame) {
  const n=frame.lines*frame.cyclesPerLine,rows=new Map(OUTPUT_RULES.filter(r=>!OBSERVATION_IDS.has(r.id)).map(r=>[r.id,new Uint8Array(n)]));
  const a=frame.analysis,q=a?.sequencer,b=a?.border,p=frame.provenance;
  const comparator={left:0,right:0,top:0,bottom:0,den:false};
  const borderReady=b?.before?.length===n&&b.after?.length===n&&b.latch?.length===n&&q?.registers?.length===n*64;
  if(!borderReady||frame.overflow)for(const r of OUTPUT_RULES.filter(r=>r.id.startsWith('border.')))rows.get(r.id).fill(UNKNOWN);
  else for(let t=0;t<n;t++) {
    const line=Math.floor(t/63),cycle=t%63+1,r=t*64,cmp=borderComparators(q.registers[r+0x11],q.registers[r+0x16],comparator);
    const before=b.before[t],after=b.after[t],left=cycle===15,right=cycle===Math.floor(cmp.right/8)+12;
    if(!a.vicValid[t]){for(const id of rows.keys())if(id.startsWith('border.'))rows.get(id)[t]=UNKNOWN;continue;}
    if(right)rows.get('border.main.right')[t]=verdict(true,!!(after&1));
    if(cycle===63&&line===cmp.bottom)rows.get('border.vertical.bottom.line')[t]=verdict(1,b.latch[t]);
    if(cycle===63&&line===cmp.top&&cmp.den)rows.get('border.vertical.top.line')[t]=verdict(0,b.latch[t]);
    if(left) {
      if(line===cmp.bottom)rows.get('border.vertical.bottom.left')[t]=verdict(true,!!(after&2));
      if(line===cmp.top&&cmp.den)rows.get('border.vertical.top.left')[t]=verdict(false,!!(after&2));
      const vertical=line===cmp.bottom?true:line===cmp.top&&cmp.den?false:!!(before&2);
      rows.get('border.main.left')[t]=verdict(vertical?!!(before&1):false,!!(after&1));
    }
  }
  if(borderReady&&!frame.overflow)for(let i=0;i<frame.eventCount;i++) {
    if(frame.eventKind[i]!==0x16)continue;
    const t=frame.eventTick[i],c=t%63+1,r=Math.floor(t/63)*63;
    const before=q.registers[t*64+0x16]&8,after=frame.eventValue[i]&8;
    if(c===56&&before&&!after)merge(rows,'border.right-cancel',t,b.lineEndValid?.[r+54]?verdict(!!(b.before[r+54]&1),!!(b.lineEndGates[r+54]&1)):UNKNOWN);
    if(c===17&&!before&&after)merge(rows,'border.left-cancel',t,b.lineEndValid?.[r+14]?verdict(true,!!(b.lineEndGates[r+14]&1)):UNKNOWN);
  }
  if(q?.display?.length===n) {
    for(let t=0;t<n;t++)if(frame.flags[t]&4)rows.get('graphics.display-start')[t]=!a.vicValid[t]||(q.displayPhase==='render-window'&&t%63<13)?UNKNOWN:verdict(1,q.display[t]);
  } else rows.get('graphics.display-start').fill(UNKNOWN);
  const pix=p?.pixels;
  if(pix?.version===1 && !p.overflow && !frame.overflow) {
    for(let i=0;i<frame.width*frame.height;i++) {
      if(!pix.source[i])continue;
      const t=(Math.floor(i/frame.width)+frame.rasterOffset)*63+Math.floor(i%frame.width/8)+10;
      const s=pix.sample[i],m=(s>>>20)&7,colour=(s>>>16)&15,matrix=(s>>>8)&255,offset=(s>>>23)&7;
      const paired=!!(m&1)&&!!((m&2)||(colour&8));
      const code=(s>>>(paired?6-(offset&6):7-offset))&(paired?3:1),foreground=paired?code>=2:code===1;
      const bg=pix.backgrounds[i];let expected;
      if(m>=5)expected=0;
      else if(m===4)expected=code?colour:(bg>>>((matrix>>>6)*4))&15;
      else if(m===3)expected=code===0?bg&15:code===1?matrix>>>4:code===2?matrix&15:colour;
      else if(m===2)expected=code?matrix>>>4:matrix&15;
      else if(paired)expected=code===3?colour&7:(bg>>>(code*4))&15;
      else expected=code?colour:bg&15;
      if(s&0x40000000)expected=(s>>>26)&15;
      let result=p.foreground?verdict(foreground,!!p.foreground[i]):UNKNOWN;
      if(!frame.border[i]&&!p.visibleSprites[i]&&frame.palette&&frame.rgba) {
        const rgb=frame.palette[expected],j=i*4;
        if(frame.rgba[j]!==((rgb>>>16)&255)||frame.rgba[j+1]!==((rgb>>>8)&255)||frame.rgba[j+2]!== (rgb&255))result=MISMATCH;
      }
      merge(rows,MODE_RULE_IDS[m],t,result);
      if(pix.source[i]!==4)merge(rows,'graphics.fine-scroll',t,pix.scroll?verdict(((i%frame.width)-pix.scroll[i])&7,offset):UNKNOWN);
      if(pix.source[i]===3)merge(rows,'graphics.idle-output',t,matrix===0&&colour===0?result:MISMATCH);
    }
  } else for(const id of rows.keys())if(id.startsWith('graphics.mode.')||id==='graphics.idle-output'||id==='graphics.fine-scroll')rows.get(id).fill(UNKNOWN);
  if(p?.priorityMask&&!p.overflow&&!frame.overflow)for(let i=0;i<p.priorityMask.length;i++) {
    const mask=p.priorityMask[i];if(!mask||frame.border[i])continue;
    const t=(Math.floor(i/frame.width)+frame.rasterOffset)*63+Math.floor(i%frame.width/8)+10;
    let slot=0;while(!(mask&(1<<slot)))slot++;
    const visible=!(p.foreground[i]&&(p.priorityBehind[i]&(1<<slot)));
    merge(rows,'sprite.priority',t,p.priorityConflict[i]?UNKNOWN:verdict(true,frame.owners[i]===slot&&!!p.visibleSprites[i]===visible));
  } else rows.get('sprite.priority').fill(UNKNOWN);
  if(p&&!p.overflow&&!frame.overflow&&q?.registers&&q?.bank&&q?.display) {
    for(let i=0;i<p.count;i++) {
      const t=p.tick[i],c=t%63+1;
      if(p.kind[i]!==2||c<16||c>55||q.display[t])continue;
      const address=q.bank[t]+(q.registers[t*64+0x11]&64?0x39ff:0x3fff);
      merge(rows,'fetch.idle-address',t,verdict(address,p.address[i]));
    }
  } else rows.get('fetch.idle-address').fill(UNKNOWN);
  const e=p?.rules;
  if(!e||![1,2].includes(e.version)||e.overflow)for(const id of ['sprite.shift','sprite.pixel','collision.sprites','collision.graphics','collision.latch','collision.read-clear','irq.acknowledge','lightpen.edge'])rows.get(id).fill(UNKNOWN);
  else for(let i=0;i<e.count;i++) {
    const t=e.tick[i],kind=e.kind[i];
    if(kind===1) {
      const c=e.c[i],multi=!!(c&(1<<20)),expanded=!!(c&(1<<21)),unit=(multi?2:1)*(expanded?2:1);
      const phase=c&7,units=(c>>>3)&31,x=(c>>>8)&1023,start=e.g[i]&1023,end=e.g[i]>>>10;
      const count=Math.max(0,Math.min(end-x,units*unit-phase));
      const consumed=Math.floor((phase+count)/unit),bits=consumed*(multi?2:1);
      const expectedShift=bits>=24?0:(e.a[i]<<bits)&0xffffff,expectedMask=bits>=24?0:(e.b[i]<<bits)&0xffffff;
      const expectedX=Math.max(start,x+count),expectedPhase=(phase+count)%unit,expectedUnits=units-consumed;
      merge(rows,'sprite.shift',t,verdict(true,e.d[i]===expectedShift&&e.e[i]===expectedMask&&e.f[i]===(expectedPhase|(expectedUnits<<3)|(expectedX<<8))));
    } else if(kind===7) {
      const multi=!!(e.b[i]&1),valid=e.b[i]>>>1,bits=multi?(e.a[i]>>>22)&3:(e.a[i]>>>23)&1;
      const draw=multi?(valid&0xc00000)===0xc00000&&bits!==0:!!(valid&0x800000)&&bits!==0;
      const colour=multi?(bits===1?e.f[i]:bits===2?e.e[i]:e.g[i]):e.e[i];
      merge(rows,'sprite.pixel',t,verdict(true,!!e.c[i]===draw&&(!draw||e.d[i]===colour)));
    } else if(kind===2) {
      const raster=e.f[i]&511,cycle=e.f[i]>>>9,falling=!!(e.a[i]&1)&&e.c[i]===0,latched=!!(e.a[i]&2);
      const fire=falling&&!latched&&raster!==311;
      const coordinates=fire?((((0x194+cycle*8)%504)>>>1)&255)|((raster&255)<<8):e.b[i];
      merge(rows,'lightpen.edge',t,verdict(true,e.d[i]===coordinates&&!!e.e[i]===(latched||fire)&&(!fire||!!(e.g[i]&8))));
    } else if(kind===8) {
      const mask=e.a[i]|e.b[i],collision=(e.a[i]&~e.b[i])?mask:0;
      merge(rows,'collision.sprites',t,verdict(true,e.d[i]===mask&&e.e[i]===(e.c[i]|collision)));
    } else if(kind===9)merge(rows,'collision.graphics',t,verdict(e.c[i]|(e.a[i]?e.b[i]:0),e.d[i]));
    else if(kind===3)merge(rows,'irq.acknowledge',t,verdict(e.a[i]&~e.b[i]&15,e.c[i]&15));
    else if(kind===4)merge(rows,'collision.read-clear',t,verdict(0,e.c[i]));
    else if(kind===5)merge(rows,'collision.latch',t,verdict(e.b[i]|e.c[i],e.d[i]));
  }
  for(const [id,result] of prepareObservationRules(frame))rows.set(id,result);
  return rows;
}
