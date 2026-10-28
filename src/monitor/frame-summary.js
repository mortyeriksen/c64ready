// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { frameStory } from './frame-story.js';
import { spriteBounds } from './learn-model.js';
import { summaryFindings } from './frame-summary-findings.js';

const summaries = new WeakMap();

// Every claim uses this detached recording. Names and current memory are not inputs.
export function buildFrameSummary(frame) {
  if (!frame) return null;
  const story = frameStory(frame), moments = new Map(story.moments.map(m => [m.id, m]));
  const summary = { title:'The picture, with limited source evidence', paragraphs:[], facts:[], cards:[], incomplete:story.incomplete };
  if (story.incomplete) {
    summary.title = 'A partial view of this frame';
    summary.paragraphs.push('Some recording history is missing. The picture is available, but this capture cannot support a complete explanation of how its layers were assembled. Use the frame story to inspect the retained evidence.');
    return summary;
  }
  const bounds = spriteBounds(frame), active = bounds.filter(b => b.pixels);
  const visible = frame.provenance?.visibleSprites;
  let visibleMask = 0, blackLeft = 0, blackRight = 0;
  if (visible) for (let i = 0; i < visible.length; i++) {
    if (!visible[i] || frame.border[i]) continue;
    if (frame.owners[i] < 8) visibleMask |= 1 << frame.owners[i];
    if (frame.rgba[i*4] || frame.rgba[i*4+1] || frame.rgba[i*4+2]) continue;
    const x = i % frame.width;
    if (x < 32) blackLeft++;
    if (x >= 352) blackRight++;
  }
  let visibleCount = 0;
  for (let slot = 0; slot < 8; slot++) if (visibleMask & (1 << slot)) visibleCount++;
  const regions = moments.get('border')?.regions;
  const upper = visibleMask === 255 && active.length === 8 && active.every(b => b.bottom < 36);
  const allEdges = regions?.every(r => r.spritePixels > 0);
  const ghost = visible ? moments.get('ghost')?.point : null;
  const sources = moments.get('sources')?.points ?? [];
  const extended = moments.get('extended-sprites')?.intervals ?? [];
  const colours = moments.get('colour')?.changes ?? [];
  const area = (x,y,w,h) => ({ x:Math.max(0,Math.min(frame.width-w,x)), y:Math.max(0,Math.min(frame.height-h,y)), w, h });
  const patch = p => area(p.x-32,p.y-16,64,32);
  const strip = line => area(0,line-frame.rasterOffset-4,frame.width,9);
  const union = active.length ? area(Math.min(...active.map(b=>b.left)),Math.min(...active.map(b=>b.top)),Math.max(...active.map(b=>b.right))-Math.min(...active.map(b=>b.left))+1,Math.max(...active.map(b=>b.bottom))-Math.min(...active.map(b=>b.top))+1) : null;
  if (visible) summary.facts.push(`${visibleCount} visible sprite slots`);
  if (sources.length) summary.facts.push(`${sources.length} sprite source changes`);
  if (colours.length) summary.facts.push(`${colours.length} colour changes`);
  if (upper) {
    summary.title = 'Eight sprite slots share the top border';
    summary.paragraphs.push('The sprite picture is packed into a narrow strip above the normal screen. All eight hardware sprite slots contribute there, and the uncovered top border lets them show.');
    summary.cards.push({ title:'The action is above the normal screen', text:'This strip sits above the usual picture window. All eight sprite slots contribute visible output here.', crops:[area(union.x-8,0,Math.min(frame.width,union.w+16),36)], storyId:'border:top',
      evidence:`Recorded slot coverage stays within rasters ${union.y+frame.rasterOffset}–${union.y+union.h-1+frame.rasterOffset}. The visible-output mask identifies all eight slots. Slots are hardware layers, not a count of pictured objects.` });
  } else if (allEdges) {
    summary.title = 'The picture spills into all four borders';
    summary.paragraphs.push('The normal screen is only part of this picture. Recorded sprite pixels appear above, below and on both sides of it. The border cover is open at those positions, letting the picture extend beyond its usual window.');
    summary.cards.push({title:'Above and below the usual window',text:'Both strips come from outside the normal 320 × 200 screen. These are pixels in the recorded output.',crops:[area(0,0,frame.width,36),area(0,236,frame.width,36)],stacked:true,storyId:'border',
      evidence:regions.map(r=>`${r.label}: ${r.spritePixels.toLocaleString()} visible sprite pixels at uncovered positions.`).join(' ')});
    if(blackLeft && blackRight)summary.cards.push({title:'Black pixels can hide the border trick',text:'Black is a sprite colour too. The source masks distinguish these side areas from the hardware border.',crops:[area(0,regions[2].point.y-12,64,32),area(320,regions[3].point.y-12,64,32)],storyId:'border:left',
      evidence:`The output and border masks identify ${regions[2].spritePixels} visible sprite pixels on the left and ${regions[3].spritePixels} on the right, including ${blackLeft} and ${blackRight} black pixels respectively. Corners belong to both adjacent edge regions.`});
  } else if (visibleCount) {
    summary.title = 'Separate sprite layers join the picture';
    summary.paragraphs.push(`${visibleCount} hardware sprite slot${visibleCount===1?' contributes':'s contribute'} visible pixels to this frame. These are independent picture layers. Their overlap with graphics and the border determines which pixels reach the screen.`);
    summary.cards.push({title:'Look for the sprite layers',text:'The capture identifies sprite output in this part of the picture. One slot can contribute in several places.',crops:[union],storyId:'sprites',evidence:`${visibleCount} slots have visible pixels. The crop encloses recorded coverage, which can also contain hidden or transparent parts. It is picture context, not isolated sprite artwork.`});
  } else if (moments.has('fetch')) {
    summary.title = 'Screen data feeds the graphics pipeline';
    summary.paragraphs.push('The video chip fetches screen information into its row buffer. Graphics bytes then supply pixel patterns, and colour settings help turn those patterns into the picture.');
    const fetch = moments.get('fetch');
    summary.cards.push({title:'Bytes feed the picture',text:'The selected raster contains a recorded screen-fetch window. Follow it to see how memory feeds the graphics pipeline.',crops:[strip(fetch.line)],storyId:'fetch',evidence:fetch.evidence});
  } else {
    summary.paragraphs.push(visible?'This capture does not establish a dominant visible technique. The picture and recorded changes are available for closer inspection.':'The captured picture is available, but visible sprite-source evidence is missing. Current memory is not used to fill that gap.');
  }
  if (allEdges && blackLeft && blackRight) summary.paragraphs[0]+=' Even black side areas can be sprite output, rather than the hardware border.';
  if (ghost) summary.cards.push({title:'A graphics pattern contributes too',text:'The idle graphics pipeline repeats a source byte. This pixel shows how a pattern can appear without a normal screen-cell fetch.',crops:[patch(ghost)],point:ghost,storyId:'ghost',
    evidence:`Renderer-source byte $${ghost.address.toString(16).toUpperCase()} supplies $${ghost.value.toString(16).toUpperCase().padStart(2,'0')}. Its decoded colour agrees with the final pixel and its foreground classification does not conflict. This establishes a pixel source, not an entire object or an independently timed bus fetch.`});
  if (extended.length) summary.cards.push({title:'Fetching continues beyond a normal sprite',text:'Some slots keep fetching longer than the normal expanded height. Fetching data and displaying a tall object are different things.',crops:[upper?area(union.x-8,0,Math.min(frame.width,union.w+16),36):strip(moments.get('extended-sprites').line)],storyId:'extended-sprites',
    evidence:extended.map(r=>`Slot ${r.slot}: ${r.end-r.start+1} active line-end samples, rasters ${r.start}–${r.end}.`).join(' ')+' These runs exceed 42 samples. They do not establish the exact sprite-crunch trigger.'});
  if (sources.length) {
    const first = sources[0], same = sources.filter(p=>p.slot===first.slot), later = same[Math.floor(same.length/2)];
    const b = bounds[first.slot];
    const crop = p => b.pixels ? area(b.left-8,p.line-frame.rasterOffset,Math.min(frame.width,b.right-b.left+17),32) : strip(p.line);
    summary.cards.push({title:'A slot can change its image source',text:'The same hardware slot reads different image blocks as the frame progresses. A slot is a reusable layer, not a permanent character.',crops:first===later?[crop(first)]:[crop(first),crop(later)],storyId:'sources',
      evidence:`${sources.length} pointer or bank changes between consecutive active line-end samples. These crops show picture context around rasters ${first.line} and ${later.line}, not isolated sprite artwork. Line-end samples do not prove the exact visible seam.`});
  }
  if (colours.length) summary.cards.push({title:'Colour settings change during the frame',text:'The program writes colour settings while the picture is being drawn. Inspect a write before attributing a particular colour band to it.',crops:[strip(Math.floor(colours[0].tick/frame.cyclesPerLine))],storyId:'colour',evidence:`${colours.length} changed colour settings. A register write alone does not establish a visible pixel change.`});
  if(!upper&&!allEdges&&regions?.some(r=>r.uncovered)&&visible){
    const open=regions.filter(r=>r.uncovered),region=open[0];
    summary.cards.push({title:'The border cover leaves extra space',text:'Uncovered positions extend beyond the usual window. Removing the border cover does not itself create extra graphics.',
      crops:[patch(region.point)],point:region.point,storyId:`border:${region.label.toLowerCase()}`,
      evidence:open.map(r=>`${r.label}: ${r.uncovered.toLocaleString()} uncovered positions.`).join(' ')+' These are border-mask observations. Inspect a pixel to distinguish graphics, sprites and background.'});
  }
  const priorities={border:96,'border:top':96,'border:left':72,sprites:38,fetch:35,ghost:93,'extended-sprites':87,sources:83,colour:58};
  for(const card of summary.cards){
    card.id=card.storyId;card.score=priorities[card.id]??75;
    if(card.id==='ghost'&&(ghost.value===0||ghost.value===255))card.score=45;
    card.category=card.id.startsWith('border')?'border':card.id==='ghost'?'graphics':card.id==='extended-sprites'?'sprite-timing':card.id;
  }
  const extra=summaryFindings(frame,story,strip,patch);
  const lead=extra.reduce((best,card)=>!best||card.score>best.score?card:best,null);
  if(lead&&lead.score>(upper||allEdges?100:visibleCount?40:moments.has('fetch')?20:0)){
    summary.title=lead.headline;summary.paragraphs=[lead.intro];
  }
  const candidates=[...summary.cards,...extra].sort((a,b)=>b.score-a.score);
  summary.cards=[];
  // Each page introduces different mechanisms before revisiting a subject.
  while(candidates.length){
    const categories=new Set();
    for(let count=0;count<3&&candidates.length;count++){
      let index=candidates.findIndex(card=>!categories.has(card.category));if(index<0)index=0;
      const [card]=candidates.splice(index,1);categories.add(card.category);summary.cards.push(card);
    }
  }
  return summary;
}

export function frameSummary(frame) {
  if (!frame) return null;
  let summary = summaries.get(frame);
  if (!summary) { summary = buildFrameSummary(frame); summaries.set(frame,summary); }
  return summary;
}
