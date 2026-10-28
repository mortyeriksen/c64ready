// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { borderRegions } from './border-regions.js';
import { phasePixel } from './pixel-phase.js';
import { frameFindings } from './learn-model.js';
import { ghostByteFinding } from './ghost-bytes.js';
import { capturedCycleBudget } from './code-actions.js';

// Analysis consumes one detached recording. No live machine state is consulted.
export function spriteIntervals(frame, slot) {
  const intervals = [];
  let current = null;
  for (let line = 0; line < frame.lines; line++) {
    if (!(frame.spriteDma[line] & (1 << slot))) { current = null; continue; }
    const i = line * 8 + slot, pointer = frame.pointers[i], bank = frame.spriteBanks[i];
    if (!current || current.pointer !== pointer || current.bank !== bank) {
      current = { start: line, end: line, pointer, bank, address: bank + pointer * 64, slot };
      intervals.push(current);
    } else current.end = line;
  }
  return intervals;
}

const WRITE_GROUPS = [
  { id:'colour', title:'Colour settings change along the raster', registers:[0x20,0x21,0x22,0x23,0x24], rule:'3.7', mechanism:'Colour registers choose the border and graphics colours. Changing them while the beam moves can colour different parts of one line.' },
  { id:'mode', title:'Graphics controls change', registers:[0x11,0x16], rule:'3.7 / 3.9', mechanism:'Display mode, fine scrolling and border comparisons share these controls. Their timing matters: one setting can change how later source bits are interpreted.' },
  { id:'memory', title:'Graphics memory settings change', registers:[0x18], rule:'3.6 / 3.8', mechanism:'The memory selector chooses the screen and shape areas. Moving the screen area also moves the eight sprite pointers at its end, so a single write can redirect several sprite sources.' },
  { id:'sprite-controls', title:'Sprite controls change', registers:[0x15,0x17,0x1b,0x1c,0x1d], rule:'3.8', mechanism:'Sprites have separate enable, expansion, priority and colour-mode controls. A changed control is not by itself proof of a new visible object or sprite crunch.' },
];
const maskFor = reg => reg >= 0x20 && reg <= 0x24 ? 15 : reg === 0x11 ? 127 : reg === 0x16 ? 31 : reg === 0x18 ? 254 : 255;

export function buildFrameStory(frame) {
  if (!frame) return null;
  const findings = frameFindings(frame), moments = [], cpl = frame.cyclesPerLine;
  const groups = Object.fromEntries(findings.map(group => [group.id, group.points]));
  const add = item => { item.line = Math.floor(item.tick / cpl); moments.push(item); };
  const initial = frame.analysis?.initial?.registers;
  const values = initial ? Array.from(initial) : Array(64).fill(null);
  const writes = WRITE_GROUPS.map(() => []);
  for (let i = 0; i < frame.eventCount; i++) {
    const reg = frame.eventKind[i];
    if (reg >= 64) continue;
    const mask = maskFor(reg), before = values[reg], after = frame.eventValue[i] & mask;
    values[reg] = after;
    if (before !== null && (before & mask) === after) continue;
    const group = WRITE_GROUPS.findIndex(g => g.registers.includes(reg));
    if (group >= 0) writes[group].push({ event:i, tick:frame.eventTick[i], register:reg, before:before === null ? null : before & mask, after });
  }
  WRITE_GROUPS.forEach((group, i) => {
    const changes = writes[i];
    if (!changes.length) return;
    // Prefer an example on the captured picture rather than blanking time.
    const first = changes.find(e => e.tick >= frame.rasterOffset*cpl && e.tick < (frame.rasterOffset+frame.height)*cpl) ?? changes[0];
    add({ ...group, tick:first.tick, precision:'cycle', changes, summary:`${changes.length} changed setting${changes.length===1?'':'s'} recorded. Follow one write and compare the picture at that row.`, evidence:'Register changes are observed. A visible effect must be checked against the captured output, not assumed from the write.' });
  });
  if (groups.border.length) {
    const regions=borderRegions(frame),focus=regions.filter(r=>r.point).sort((a,b)=>b.score-a.score)[0].point;
    add({ id:'border', title:regions.every(r=>r.spritePixels>0)?'Sprite output reaches all four borders':regions.every(r=>r.uncovered)?'All four borders leave picture area uncovered':'The border leaves extra picture area uncovered', tick:(focus.y+frame.rasterOffset)*cpl+Math.floor((focus.x+80)/8), precision:'line', rule:'3.9', points:groups.border,regions,point:focus,
    summary:`${groups.border.length} picture rows have uncovered positions outside the normal 320 × 200 screen.`,
    mechanism:'The border is a cover over graphics and sprites. Open gates allow those sources through. Removing the cover does not create extra graphics by itself.',
    evidence:'The recorded border mask establishes uncovered positions. Their final colours and sources must be inspected separately.' });
  }
  if (groups.pointers.length) add({ id:'sources', title:'Sprite slots draw from different sources', tick:(groups.pointers.find(p=>p.line>=frame.rasterOffset&&p.line<frame.rasterOffset+frame.height)??groups.pointers[0]).tick, precision:'line-end', rule:'3.8', points:groups.pointers,
    summary:`${groups.pointers.length} source changes between consecutive active line-end samples.`,
    mechanism:'Each slot reads a pointer to a 64-byte block. A different pointer or bank lets the same hardware slot draw from another block farther down the picture.',
    evidence:'Line-end samples locate source intervals. They do not prove an exact fetch time, a new character, multiplexing or sprite crunch.' });
  if (groups.sprites.length) add({ id:'sprites', title:'Separate sprite layers cover the picture', tick:groups.sprites[0].tick, precision:'line', rule:'3.8', points:groups.sprites,
    summary:`${groups.sprites.length} of the eight slots contribute recorded coverage outside the border mask.`,
    mechanism:'Sprites are independent image layers. Lower numbered slots have priority over higher ones. Graphics priority and transparent pixels determine which parts survive into the final picture.',
    evidence:'Coverage can include pixels hidden by foreground graphics. Select a pixel to test its recorded visible source.' });
  const ghost = ghostByteFinding(frame);
  let ghostPoint=null;
  const pixels=frame.provenance?.pixels;
  if(pixels?.version===1&&!frame.provenance.overflow&&!frame.overflow)for(let i=0;i<frame.width*frame.height;i++){
    if(pixels.source[i]!==3||frame.border[i]||frame.provenance.visibleSprites?.[i])continue;
    const value=pixels.sample[i]&255;
    if(ghostPoint&&(value===0||value===255||!(frame.rgba[i*4]||frame.rgba[i*4+1]||frame.rgba[i*4+2])))continue;
    const decoded=phasePixel(frame,i);
    if(decoded?.colourMatch===true&&decoded.foregroundMatch!==false){
      const patterned=decoded.value!==0&&decoded.value!==255&&decoded.colourIndex!==0;
      if(!ghostPoint||patterned)ghostPoint={x:i%frame.width,y:Math.floor(i/frame.width),address:decoded.address,value:decoded.value,tick:decoded.tick};
      if(patterned)break;
    }
  }
  if (ghost.tick !== undefined) add({ id:'ghost', title:'A repeated byte feeds idle graphics', tick:ghostPoint?(ghostPoint.y+frame.rasterOffset)*cpl+Math.floor((ghostPoint.x+80)/8):ghost.tick, precision:ghostPoint?'renderer-output':'cycle', rule:ghost.rule, ghost, point:ghostPoint,
    summary:ghostPoint?'An uncovered graphics pixel matches the recorded idle-source byte and colour.':'Idle-source reads were recorded, but no visible matching pixel was established.',
    mechanism:'With the sequencer idle, one byte can repeat across the graphics area. Mode changes can switch its address between the bank’s $3FFF and $39FF. Colour changes and sprite layers can transform the repeated pattern.',
    evidence:ghost.text });
  const fetch = frame.flags.findIndex((flags,t)=>!!(flags&8)&&t>=frame.rasterOffset*cpl&&t<(frame.rasterOffset+frame.height)*cpl);
  if (fetch >= 0) add({ id:'fetch', title:'Screen data feeds the graphics pipeline', tick:fetch, precision:'cycle', rule:'3.5 / 3.7',
    summary:`${groups.badlines.length} raster lines meet the recorded bad-line condition.`,
    mechanism:'The VIC fetches screen codes and colours into its row buffer. Shape data turns those codes into pixels on later rows. While the VIC needs the bus, the CPU may have to wait.',
    evidence:'The selected cycle records an active screen-fetch window. A bad-line condition alone is not a count of fetched bytes.' });
  let wait = -1, waits = 0;
  const bus = frame.analysis?.bus;
  if (bus) for (let t=0; t<bus.length; t++) if ((bus[t]&5)===5 && !(bus[t]&24)) { waits++; if(wait<0||(wait<frame.rasterOffset*cpl&&t>=frame.rasterOffset*cpl))wait=t; }
  if (wait >= 0) add({ id:'dma', title:'Video work leaves less time for code', tick:wait, precision:'cycle', rule:'2.2 / 2.3 / 3.8',
    summary:`${waits.toLocaleString()} CPU cycles were blocked by the VIC in this recording.`,
    mechanism:'Screen and sprite data share memory with the CPU. BA warns the CPU before AEC takes the bus. Reads can stop during the warning, while writes may still proceed. The exact cost depends on the recorded bus sequence.',
    evidence:'These are observed CPU stalls, not useful-work percentages. Sprite-enable bits alone cannot establish the cost or prove that a program deliberately stabilises timing.' });
  const q=frame.analysis?.sequencer;
  const extended=[];
  for(let slot=0;slot<8;slot++){
    let start=-1,wraps=0,previous=null,counterSamples=0;
    for(let line=0;line<=frame.lines;line++){
      if(line<frame.lines&&(frame.spriteDma[line]&(1<<slot))){
        if(start<0)start=line;
        const t=(line+1)*cpl-1;
        const counter=q?.mcBase&&frame.analysis.vicValid[t]?q.mcBase[t*8+slot]:null;
        if(counter!==null)counterSamples++;
        if(counter!==null&&previous!==null&&counter<previous)wraps++;
        previous=counter;
      }else if(start>=0){
        if(line-start>42)extended.push({slot,start,end:line-1,wraps,counterSamples});
        start=-1;wraps=0;previous=null;counterSamples=0;
      }
    }
  }
  if(extended.length){const first=extended.find(e=>e.end>=frame.rasterOffset)??extended[0];add({id:'extended-sprites',title:'Sprite DMA continues beyond normal height',tick:Math.max(first.start,frame.rasterOffset)*cpl,precision:'line-end',rule:'3.8',intervals:extended,
    summary:`${extended.length} active DMA runs exceed 42 line-end samples, the normal expanded sprite height.`,
    mechanism:'Normal sprites have 21 data rows, or 42 displayed rows with Y expansion. Altering row-counter progression can keep DMA active longer. Counter wrap and source changes describe how the recorded data sequence continues.',
    evidence:'Long DMA runs are observed, not proof of visible triple-height objects or the exact crunch trigger. Inspect the recorded counters and expansion rules before attributing the cause.'});}
  for(const moment of moments){
    if(moment.point||moment.id==='ghost')continue;
    const y=moment.line-frame.rasterOffset;if(y<0||y>=frame.height)continue;
    if(moment.id==='colour'&&pixels?.version===1&&!frame.provenance.overflow&&!frame.overflow){
      const change=moment.changes.find(e=>e.tick===moment.tick);
      for(let x=0;x<frame.width;x++){const i=y*frame.width+x;if(frame.border[i]||frame.provenance.visibleSprites?.[i])continue;const decoded=phasePixel(frame,i);if(decoded?.selected.register===change.register&&decoded.colourIndex===change.after&&decoded.colourMatch===true&&decoded.foregroundMatch!==false){moment.point={x,y};break;}}
      if(moment.point)continue;
    }
    const slot=moment.id==='sources'?moment.points.find(p=>p.line===moment.line)?.slot:moment.id==='extended-sprites'?moment.intervals[0].slot:-1;
    for(let x=0;x<frame.width;x++){
      const i=y*frame.width+x;
      if(!frame.border[i]&&(slot<0||frame.owners[i]===slot)){moment.point={x,y};break;}
    }
  }
  const stops = [];
  for (const moment of moments) {
    const occurrences = new Map();
    const addOccurrence = (tick, details = {}) => {
      const line = Math.floor(tick / cpl);
      if (!occurrences.has(line)) occurrences.set(line, { ...moment, ...details, tick, line, point: undefined, kind: moment.id });
    };
    if (moment.changes) {
      const rows = new Map();
      for (const change of moment.changes) {
        const line = Math.floor(change.tick / cpl);
        if (!rows.has(line)) rows.set(line, []);
        rows.get(line).push(change);
      }
      let previous = null;
      for (const [line, changes] of rows) {
        const repeats = previous && line === previous.endLine + 1 && changes.length === previous.rowChanges.length && changes.every((change,i) => {
          const before = previous.rowChanges[i];
          return change.register === before.register && change.before === before.before && change.after === before.after;
        });
        if (repeats) {
          previous.endLine = line;
          previous.writeCount += changes.length;
        } else {
          addOccurrence(changes[0].tick, { endLine:line, rowChanges:changes, writeCount:changes.length });
          previous = occurrences.get(line);
        }
      }
    } else if (moment.id === 'sources') {
      for (const sample of moment.points) addOccurrence(sample.tick);
    }
    // Keep the overview's anchor and its checked pixel evidence available.
    const anchor = occurrences.get(moment.line);
    if (anchor) anchor.point = moment.point;
    else occurrences.set(moment.line, { ...moment, kind: moment.id });
    for (const stop of occurrences.values()) {
      stop.id = stop.tick === moment.tick ? moment.id : `${moment.id}:${stop.tick}`;
      if (moment.changes) {
        stop.summary = stop.endLine > stop.line
          ? `The same setting sequence repeats across rasters ${stop.line}–${stop.endLine}, with ${stop.writeCount} recorded changes. Select an occurrence to inspect its exact timing.`
          : `Setting changes on this raster line: ${stop.writeCount ?? stop.changes.filter(change => Math.floor(change.tick / cpl) === stop.line).length}. ${moment.changes.length} across the recording. Compare the recorded writes with the picture.`;
        delete stop.rowChanges;
      } else if (moment.id === 'sources') {
        stop.points = moment.points.filter(sample => sample.line === stop.line);
        stop.summary = `${stop.points.length} sprite source change${stop.points.length === 1 ? '' : 's'} at this line-end sample. The same slots can read different image blocks farther down the picture.`;
      }
      stops.push(stop);
    }
    if (moment.regions) for (const region of moment.regions) {
      if (!region.point) continue;
      const tick = (region.point.y + frame.rasterOffset) * cpl + Math.floor((region.point.x + 80) / 8);
      stops.push({ ...moment, id: `border:${region.label.toLowerCase()}`, kind: 'border', tick, line: Math.floor(tick / cpl), point: region.point,
        title: `${region.label} border: picture beyond the normal screen`,
        summary: `${region.uncovered.toLocaleString()} uncovered positions in this edge region. ${region.spritePixels === null ? 'Visible sprite evidence is unavailable.' : `${region.spritePixels.toLocaleString()} recorded visible sprite pixels.`}` });
    }
  }
  stops.sort((a,b)=>a.tick-b.tick);
  moments.sort((a,b)=>a.tick-b.tick);
  return { moments, stops, budget:capturedCycleBudget(frame), incomplete:!!(frame.overflow||frame.provenance?.overflow),
    summary:moments.length ? `${groups.sprites.length} sprite slots with coverage · ${groups.badlines.length} bad-line conditions · ${groups.pointers.length} sprite source changes` : 'This recording has no supported story stops. Explore a pixel or the timing rules for its available evidence.' };
}

const stories = new WeakMap();
export function frameStory(frame) {
  if (!frame) return null;
  let story = stories.get(frame);
  if (!story) { story = buildFrameStory(frame); stories.set(frame, story); }
  return story;
}
