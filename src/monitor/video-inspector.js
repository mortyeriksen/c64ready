// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { describeBauerPhases } from './bauer-phases.js';
import { observedRuleEvidence } from './bauer-observation-rules.js';
import { explainPixel, frameTechniques, staticBorderCheck } from './provenance-model.js';
import { borderEvidence, relatedWrites, spriteCoverage, spriteSourceAtLine } from './learn-model.js';
import { BAUER_RULES, BAUER_SOURCE, BAUER_UNCHECKED, analyzeBauerFrame, explainBauerCycle } from './bauer-rules.js';
import { frameStory } from './frame-story.js';
import { appendFrameStory, appendStoryMoment, appendSpriteIntervals, appendPicturePatch } from './frame-story-view.js';
import { appendPixelBits } from './pixel-detail.js';
import { recordedOrigin } from './capture-context.js';
import { hex } from './memory-sampler.js';
import { registerMeaning } from './disassembly.js';

const RULE_ENTRIES=BAUER_RULES.map((rule,i)=>({rule,i}));

export function createVideoInspector(root, { seek, selectSprite, openMemory, openCode, chooseStory }) {
  let frame = null, tick = 0, topic = 'overview', point = null, slot = -1, report = null, coverage = null, techniques = [], border = null, selectedStory = null;
  const opened = new Set();
  let preferredRules=[], ruleOrder=RULE_ENTRIES, ruleQuery='', ruleFilter='all';
  function preferRules(sections=[]){
    preferredRules=RULE_ENTRIES.filter(({rule})=>sections.some(section=>rule.section===section||rule.section.startsWith(section+'.')));
    const preferred=new Set(preferredRules);ruleOrder=preferredRules.length?[...preferredRules,...RULE_ENTRIES.filter(entry=>!preferred.has(entry))]:RULE_ENTRIES;
  }
  root.addEventListener('toggle', event => { const d=event.target; if(!d.isConnected||!d.dataset.evidenceKey)return; if(d.open)opened.add(d.dataset.evidenceKey);else opened.delete(d.dataset.evidenceKey); }, true);
  function restoreDisclosure(d,key){d.dataset.evidenceKey=topic+':'+key;d.open=opened.has(d.dataset.evidenceKey);}
  const views = ['overview', 'change', 'pixel', 'sprite', 'border', 'timing', 'events', 'techniques'];
  root.innerHTML = `<div class="monitor-video-inspector-head"><label>Inspect<span class="monitor-video-select"><span data-video="topic-label" aria-hidden="true">This frame</span><select aria-label="Video inspector topic" data-video="topic"><option value="overview">This frame</option><option value="change">Selected change</option><option value="pixel">Why this pixel?</option><option value="sprite">Sprite appearances</option><option value="border">Border</option><option value="timing">Timing & rules</option><option value="events">Events on this line</option><option value="techniques">Observed techniques</option></select></span></label><small data-video="position"></small></div><div class="monitor-rule-filters" data-video="rule-filters" hidden><input type="search" aria-label="Search Bauer rules" placeholder="Find a rule or section"><select aria-label="Filter Bauer rules"><option value="all">All rules</option><option value="checked">Checked in this frame</option><option value="mismatch">Mismatches</option><option value="unknown">Missing evidence</option></select></div><div data-video="report"></div><div data-frame="slots" class="monitor-frame-sprites" hidden aria-label="Recorded sprite slots"></div>`;
  const filters=root.querySelector('[data-video="rule-filters"]');
  filters.querySelector('input').addEventListener('input',event=>{ruleQuery=event.target.value.trim().toLowerCase();render();});
  filters.querySelector('select').addEventListener('change',event=>{ruleFilter=event.target.value;render();});
  const body = root.querySelector('[data-video="report"]'), selector = root.querySelector('select'), slots = root.querySelector('[data-frame="slots"]');
  function clearSpriteSelection() {
    if (slot < 0) return;
    slot=-1; selectSprite(-1);
  }
  function changeTopic(value) {
    topic=value;
    if (topic !== 'sprite') clearSpriteSelection();
  }
  selector.addEventListener('change', () => { preferRules(); changeTopic(selector.value); seek(tick); render(); root.scrollTop=0; });
  function section(title, text, parent = body) {
    const el = document.createElement('section'), h = document.createElement('h3'), p = document.createElement('p'); h.textContent = title; p.textContent = text; el.append(h,p); parent.append(el); return el;
  }
  function button(parent, text, action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'monitor-context-link'; b.textContent = text; b.addEventListener('click', action); parent.append(b); return b; }
  function evidence(parent, text) { const d = document.createElement('details'), s = document.createElement('summary'), p = document.createElement('p'); d.className = 'monitor-inline-evidence'; s.textContent = 'Technical evidence'; p.textContent = text; d.append(s,p); parent.append(d); restoreDisclosure(d,'technical'); return d; }
  function reference(parent, label = 'Bauer’s VIC-II reference') { const a = document.createElement('a'); a.href = BAUER_SOURCE; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label; parent.append(a); }
  function jump(position, kind = topic) { changeTopic(kind); seek(position); render(); }
  function writes(indices, parent = body) {
    const d = document.createElement('details'), s = document.createElement('summary'); d.className = 'monitor-inline-evidence'; s.textContent = `Related register writes (${indices.length})`; d.append(s); parent.append(d); restoreDisclosure(d,'writes');
    for (const i of indices.slice(0,64)) {
      const row = section(`Line ${Math.floor(frame.eventTick[i]/63)}, cycle ${frame.eventTick[i]%63+1}`, frame.eventKind[i] === 64 ? 'Raster IRQ asserted' : `$${hex(0xD000+frame.eventKind[i])} ← $${hex(frame.eventValue[i],2)} · ${registerMeaning(0xD000+frame.eventKind[i])}`, d);
      button(row, 'Inspect this cycle', () => jump(frame.eventTick[i]));
      if (frame.eventCPU[i]) button(row, `Open recorded origin $${hex(frame.eventPC[i])} in Code →`, () => openCode(frame.eventPC[i], recordedOrigin(frame,i),frame,frame.eventTick[i]));
    }
    if (indices.length>64) section('First 64 shown', 'Use the timeline to inspect later lines.', d);
  }
  function render() {
    if(root.closest('[hidden]'))return;
    filters.hidden=topic!=='timing';
    selector.value = topic; root.querySelector('[data-video="topic-label"]').textContent=selector.selectedOptions[0].textContent; body.replaceChildren(); slots.hidden = topic !== 'sprite';
    root.querySelector('[data-video="position"]').textContent = frame ? `Line ${Math.floor(tick/63)} · cycle ${tick%63+1}` : 'No captured frame';
    if (!frame) { section('Waiting for the shared frame', 'The C64 keeps running. Complete frames are recorded automatically. Pause to explore the picture or timeline.'); return; }
    if (topic === 'overview') {
      appendFrameStory(body,frameStory(frame),chooseStory);
    } else if (topic === 'change') {
      const story=frameStory(frame),moment=story.stops.find(m=>m.id===selectedStory);
      appendStoryMoment(body,frame,moment,tick,{seek:position=>{seek(position);render();},pixel:(x,y)=>{point={x,y};seek((y+frame.rasterOffset)*frame.cyclesPerLine+Math.floor((x+80)/8));changeTopic('pixel');render();root.scrollTop=0;},openCode,openMemory,rules:()=>{preferRules(moment.rule.split(' / '));jump(tick,'timing');}});
      button(body,'Back to frame story',()=>{changeTopic('overview');render();});
    } else if (topic === 'pixel') {
      if (!point) { section('Click a pixel in the picture', 'The explanation appears here. You can also focus the picture and use the arrow keys, then Enter.'); return; }
      const p = explainPixel(frame,point.x,point.y);
      const s=section(p.graphics?.evidence==='idle'?'Idle graphics → bits → colour':p.title,p.graphics?`${p.graphics.evidence==='idle'?'Idle graphics repeat one byte':p.graphics.mode}: ${p.graphics.bitCount===2?'a pair of bits selects':'one bit selects'} ${p.graphics.selected.label.toLowerCase()}.${p.graphics.colourIndex===null?' Its exact colour is unresolved because the register changes.':` Colour index ${p.graphics.colourIndex}.`}`:p.text);
      appendPicturePatch(s,frame,point.x,point.y);
      if(p.graphics) section('Source → bits → colour',`${p.graphics.evidence==='idle'?'The idle sequencer supplies zero screen and colour data, without reading a normal screen cell.':p.graphics.character===null?'Screen data supplies cell colours.':`Screen code selects character ${p.graphics.character}.`} Source row $${hex(p.address)} supplies $${hex(p.value,2)}. The highlighted ${p.graphics.bitCount===2?'pair':'bit'} chooses ${p.graphics.selected.label.toLowerCase()}.`,s);
      appendPixelBits(s,p);
      if(p.graphics) { evidence(s,p.text); reference(s,`Bauer §${p.graphics.rule}`); if(p.graphics.evidence==='idle')reference(s,'Bauer §3.7.3.9 · idle graphics'); }
      if(p.address!==undefined) { section('Recorded source',`$${hex(p.address)}${p.value!==undefined?` supplied byte $${hex(p.value,2)}`:''}.`); button(body,'Inspect captured source in Memory →',()=>openMemory(frame,p.tick??tick,p.address)); }
      const owner=frame.owners[point.y*frame.width+point.x]; if(owner<8)button(body,`Inspect sprite slot ${owner} →`,()=>{slot=owner;changeTopic('sprite');selectSprite(owner);render();});
      if(!frame.provenance) section('Detailed evidence needed','Resume to record a complete frame with source bytes.');
    } else if (topic === 'sprite') {
      coverage ??= spriteCoverage(frame);
      section(slot<0?'Which shapes are sprites?':`Sprite slot ${slot}`,slot<0?'Select one of the eight slots below. Highlighted coverage belongs to that slot in this recording.':'The video chip draws this independent image over graphics. A slot can be reused, so line-end settings do not describe every pixel.');
      if(slot>=0) { const source=spriteSourceAtLine(frame,slot,Math.floor(tick/63)); section('Source at this line’s end',`Pointer $${hex(source.pointer,2)} · bank $${hex(source.bank)} → $${hex(source.address)}. ${coverage[slot].toLocaleString()} pixels of recorded coverage, including possible foreground-hidden pixels.`); button(body,'Inspect captured source in Memory →',()=>openMemory(frame,(Math.floor(tick/63)+1)*63-1,source.address)); appendSpriteIntervals(body,frame,slot,position=>jump(position,'sprite'),openMemory); writes(relatedWrites(frame,'sprites',slot)); }
    } else if (topic === 'border') {
      border ??= staticBorderCheck(frame);
      const e=borderEvidence(frame,tick);
      section('Where the border lets pixels through',`${e?.uncovered??0} positions outside the normal screen are uncovered on this line. Related register writes are evidence, not proof of what caused the opening.`);
      if(frameStory(frame).moments.some(m=>m.id==='border'))button(body,'Explore all four border regions →',()=>chooseStory('border'));
      section('Independent stable-border check',border.supported?`${border.checked.toLocaleString()} positions checked · ${border.mismatches} mismatches.`:border.reason);
      evidence(body,`Recorded gates at this cycle: horizontal ${frame.flags[tick]&1?'closed':'open'}, vertical ${frame.flags[tick]&2?'closed':'open'}. Timing includes the six comparator rules and cycle-17/56 border cancellation checks.`);
      writes(relatedWrites(frame,'border'));
    } else if(topic === 'timing') {
      report ??= analyzeBauerFrame(frame);
      if(!report){section('Detailed timing needed','Resume to record a complete frame with detailed timing evidence.');return;}
      const preferred=preferredRules.find(({i})=>report.results[i][tick]===1||report.results[i][tick]===2)?.i??-1;
      const explanation=explainBauerCycle(frame,report,tick,preferred); section('Rules at this cycle',`${explanation.title}. ${explanation.text}`);
      const phase=describeBauerPhases(frame,tick,report.logicalDisplay);
      if(phase) {
        const d=document.createElement('details'),s=document.createElement('summary');d.className='monitor-inline-evidence';
        s.textContent=`Expected half-cycles · ${phase.beam}`;d.append(s);body.append(d);
        section('Bauer reference schedule',phase.phases.join(' · '),d);
        section('Display and X comparison',[phase.display,...phase.matches].join('. '),d);
        evidence(d,'Prediction from captured controls, not a recorded half-cycle trace. An X match alone does not prove shifter start or fresh sprite data. Grouped reads remain separate evidence.');
        reference(d,'Bauer §3.6.1–3.8.1');restoreDisclosure(d,'phase-reference');
      }
      const rules=document.createElement('div');rules.className='monitor-video-rules';body.append(rules);
      const entries=ruleOrder.filter(({rule,i})=>{
        const totals=report.summary[i];
        return (!ruleQuery||`${rule.id} ${rule.title} ${rule.section} ${rule.explanation}`.toLowerCase().includes(ruleQuery))&&(ruleFilter==='all'||ruleFilter==='checked'&&(totals.match||totals.mismatch)||ruleFilter==='mismatch'&&totals.mismatch||ruleFilter==='unknown'&&totals.unknown);
      });
      const counts=report.summary;
      section('Frame coverage',`${counts.filter(r=>r.match||r.mismatch).length} of ${BAUER_RULES.length} rules have checked evidence in this frame. ${counts.filter(r=>r.mismatch).length} have mismatches. A rule without an occurrence is not a failed check. ${entries.length} rules shown.`);
      entries.forEach(({rule,i})=>{
        const d=document.createElement('details'),s=document.createElement('summary'); d.className='monitor-inline-evidence'; d.name='monitor-video-rule'; const label=document.createElement('span'),status=document.createElement('small');label.textContent=rule.title;status.textContent=rule.coverage==='reference'?'Reference model only':['Not applicable','Matches inputs','Mismatch','Insufficient evidence'][report.results[i][tick]];s.append(label,status);d.append(s);section(rule.id,rule.explanation,d);
        section('Evidence required',rule.requires,d);
        const totals=report.summary[i]; section('In this frame',`${totals.match} checked matches · ${totals.mismatch} mismatches · ${totals.unknown} insufficient`,d);
        if(totals.match||totals.mismatch)button(d,'Show next checked cycle →',()=>{const values=report.results[i];let next=-1;for(let step=1;step<=values.length;step++){const candidate=(tick+step)%values.length;if(values[candidate]===1||values[candidate]===2){next=candidate;break;}}if(next>=0)jump(next,'timing');});
        if(totals.mismatch)button(d,'Show next mismatch →',()=>{const values=report.results[i];for(let step=1;step<=values.length;step++){const next=(tick+step)%values.length;if(values[next]===2){jump(next,'timing');break;}}});
        if(i===0) { const a=frame.analysis,line=Math.floor(tick/63); for(const [label,yes] of [['Display raster range',line>=48&&line<=247],['Raster matches YSCROLL',(line&7)===(a.d011[tick]&7)],['DEN latch set',!!a.denLatch[tick]]])section(label,yes?'Present':'Absent',d); }
        let shownInputs=false;
        function showInputs(){if(!d.isConnected||!d.open||shownInputs)return;shownInputs=true;const inputs=observedRuleEvidence(frame,rule.id,tick);if(inputs.length){const pre=document.createElement('pre');pre.className='monitor-rule-inputs';pre.textContent=inputs.join('\n');section('Recorded inputs and outputs','At the selected cycle.',d).append(pre);}}
        d.addEventListener('toggle',showInputs);
        reference(d,`Bauer §${rule.section}`);rules.append(d);restoreDisclosure(d,rule.id);showInputs();
      });
      evidence(body,`${BAUER_UNCHECKED} Current $D011: $${hex(frame.analysis.d011[tick],2)}. Checks compare independent reference equations with recorded inputs and outputs. Missing phases remain insufficient evidence.`);
    } else if(topic==='events') {
      const indices=[];for(let i=0;i<frame.eventCount;i++)if(Math.floor(frame.eventTick[i]/63)===Math.floor(tick/63))indices.push(i);
      section('Events on this line',`${indices.length} recorded VIC writes or raster IRQ assertions. CPU writes normally become visible to the VIC on the following cycle.`);writes(indices);const d=body.querySelector('details');if(d)d.open=true;
    } else {
      section('What the recording shows','Observed changes and candidate techniques are separate. They do not identify the program or prove the author’s intent.');
      techniques ??= frameTechniques(frame);
      for(const f of techniques){
        const s=section(`${f.status}: ${f.title}`,f.text);
        if(f.evidence)evidence(s,f.evidence);
        if(f.rule)reference(s,`Bauer §${f.rule}`);
        if(f.tick!==undefined)button(s,'Inspect this moment',()=>jump(f.tick,f.topic??'events'));
        if(f.address!==undefined)button(s,'Inspect captured source in Memory →',()=>openMemory(frame,f.tick,f.address));
      }
      if(!techniques.length)section('No supported finding','This is not proof that no technique is present. The recording or analysis may not cover it.');
    }
  }
  return {
    setFrame(value, { reset = false, position = tick } = {}) {
      if (reset || !value) { opened.clear(); preferRules(); point=null; slot=-1; topic='overview'; selectedStory=null; }
      frame=value; tick=frame?Math.max(0,Math.min(frame.lines*frame.cyclesPerLine-1,Math.floor(position))):0;
      report=null; coverage=null; techniques=null; border=null;
      body.replaceChildren(); render();
    },
    remember(){const saved={topic,point,slot,selectedStory,opened:[...opened],ruleQuery,ruleFilter};return()=>{topic=saved.topic;point=saved.point;slot=saved.slot;selectedStory=saved.selectedStory;opened.clear();for(const key of saved.opened)opened.add(key);ruleQuery=saved.ruleQuery;ruleFilter=saved.ruleFilter;filters.querySelector('input').value=ruleQuery;filters.querySelector('select').value=ruleFilter;selectSprite(slot);render();};},
    refresh:render,
    position(value){if(value===tick)return;const previousLine=Math.floor(tick/63);tick=value;if(['timing','border'].includes(topic)||(['sprite','events'].includes(topic)&&Math.floor(tick/63)!==previousLine))render();else root.querySelector('[data-video="position"]').textContent=`Line ${Math.floor(tick/63)} · cycle ${tick%63+1}`;},
    story(id){selectedStory=id;changeTopic('change');render();root.scrollTop=0;},
    followStory(id,position){selectedStory=id;if(topic==='change'){tick=position;render();root.scrollTop=0;}},
    pixel(x,y){point={x,y};changeTopic('pixel');render();root.scrollTop=0;},
    sprite(value){slot=value;changeTopic('sprite');render();},
    topic(value){if(views.includes(value)){changeTopic(value);render();}},
    clearSprite(){clearSpriteSelection();render();},
  };
}
