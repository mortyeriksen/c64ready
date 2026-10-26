// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { BAUER_RULES, BAUER_SOURCE, BAUER_REVISION, BAUER_UNCHECKED, analyzeBauerFrame, explainBauerCycle } from './bauer-rules.js';
import { hex } from './memory-sampler.js';

export function createBauerView(root, onPosition = () => {}) {
  root.innerHTML = `<div class="monitor-bauer-controls"><button class="btn" data-bauer="play">Play</button><button class="btn" data-bauer="cycle" aria-label="Advance one cycle">+ Cycle</button><button class="btn" data-bauer="line" aria-label="Advance one raster line">+ Line</button><button class="btn" data-bauer="next">Next event</button><span data-bauer="position"></span></div>
    <div class="monitor-bauer-overview" data-bauer="overview"></div><div class="monitor-bauer-body"><div class="monitor-bauer-visual"><canvas width="384" height="272" data-bauer="picture" aria-label="Recorded picture with selected raster line"></canvas><canvas width="630" height="100" data-bauer="bus" aria-label="Selected line: bad-line condition, BA low, AEC low, CPU write and CPU blocked"></canvas><span class="monitor-bauer-key">Bad line · BA low · AEC low · CPU write · Blocked</span><input data-bauer="seek" type="range" min="0" max="19655" value="0" aria-label="Analysis cycle"></div>
    <div class="monitor-bauer-explanation"><h3>Rules at this cycle</h3><div class="monitor-bauer-accordion">${BAUER_RULES.map((rule,i)=>`<div class="monitor-bauer-rule"><button type="button" class="monitor-bauer-rule-heading" data-rule-index="${i}" aria-expanded="${i===0}" aria-controls="monitor-bauer-rule-${i}"><span>${rule.title}</span><small data-rule-verdict="${i}"></small></button><div id="monitor-bauer-rule-${i}" class="monitor-bauer-rule-panel" ${i===0?'':'hidden'}></div></div>`).join('')}</div><div data-bauer="detail"><strong data-bauer="happened"></strong><b data-bauer="verdict"></b><p data-bauer="meaning"></p><div class="monitor-bauer-conditions" data-bauer="conditions" hidden></div><a href="${BAUER_SOURCE}" target="_blank" rel="noopener noreferrer" data-bauer="source">Bauer reference ↗</a></div></div></div>
    <details class="monitor-help"><summary>Rule coverage and evidence <span data-bauer="summary"></span></summary><p><code data-bauer="evidence"></code></p><p data-bauer="badline"></p><p>These checks are deterministic predicates and fixed explanations. No AI is used. A match confirms a rule against its recorded inputs, not the entire VIC implementation. Separate checks reconstruct DEN latching and bus windows from captured conditions. Missing phases remain insufficient evidence. Bus permission is not proof that an instruction executed.</p><div data-bauer="rules"></div><p>${BAUER_UNCHECKED}</p><p>The picture is the recorded final output with a moving cursor, not newly synthesized pixels. CPU writes occur after VIC phi1 sampling. Cycles are numbered 1–63. Reference: Bauer, ${BAUER_REVISION}. The capture identifies the PAL chip model. Output-phase sources are checked against recorded pixels. Unrecorded revision-specific effects remain insufficient evidence.</p></details>`;
  const el=name=>root.querySelector(`[data-bauer="${name}"]`);
  root.querySelector('#monitor-bauer-rule-0').append(el('detail'));
  const picture=el('picture').getContext('2d'), bus=el('bus').getContext('2d');
  const original=document.createElement('canvas'); original.width=384; original.height=272;
  const originalCtx=original.getContext('2d');
  let frame=null, report=null, tick=0, selectedRule=0, playing=false, lastTime=0, ink='#fff', accent='#fff', dim='#555', background='#000';
  function theme() {
    const style=getComputedStyle(root);
    ink=style.getPropertyValue('--text').trim() || ink; accent=style.getPropertyValue('--accent').trim() || accent;
    dim=style.getPropertyValue('--dim').trim() || dim; background=style.getPropertyValue('--ui-bg').trim() || background;
    render();
  }
  function setFrame(captured) {
    frame=captured; report=analyzeBauerFrame(frame); tick=0; playing=false;
    if (frame) { const image=originalCtx.createImageData(frame.width,frame.height); image.data.set(frame.rgba); originalCtx.putImageData(image,0,0); }
    const list=el('rules'); list.replaceChildren();
    if (report) for (let i=0;i<BAUER_RULES.length;i++) {
      const rule=BAUER_RULES[i], totals=report.summary[i], row=document.createElement('p');
      row.textContent=`${rule.id} · Bauer §${rule.section}: ${totals.match} matches, ${totals.mismatch} mismatches, ${totals.unknown} insufficient. Inputs: ${rule.requires}.`;
      list.append(row);
    }
    const mismatches=report?.summary.reduce((sum,row)=>sum+row.mismatch,0) ?? 0;
    el('summary').textContent=report?`· ${mismatches} mismatches`:'· analysis capture required';
    if (report) {
      let badLines=0, vicCycles=0, waiting=0;
      for (let line=0;line<frame.lines;line++) {
        let bad=false;
        for (let cycle=0;cycle<frame.cyclesPerLine;cycle++) {
          const t=line*frame.cyclesPerLine+cycle, b=frame.analysis.bus[t];
          bad ||= !!(frame.flags[t]&4);
          if ((b&65)===65) vicCycles++;
          if ((b&31)===5) waiting++;
        }
        if (bad) badLines++;
      }
      el('overview').textContent=`${badLines} lines with bad-line condition · ${vicCycles.toLocaleString()} VIC bus cycles · ${waiting.toLocaleString()} read waits`;
    } else el('overview').textContent='One captured frame · picture and recorded machine evidence';
    theme();
  }
  function render() {
    for (const name of ['play','cycle','line','next','seek']) el(name).disabled=!report;
    el('play').textContent=playing?'Pause':'Play';
    el('play').setAttribute('aria-label',playing?'Pause recorded analysis':'Play recorded analysis');
    picture.fillStyle=background; picture.fillRect(0,0,384,272);
    if (frame) picture.drawImage(original,0,0);
    bus.fillStyle=background; bus.fillRect(0,0,630,100);
    onPosition(Math.floor(tick));
    if (!report) {
      el('happened').textContent='Capture required'; el('position').textContent='No detailed analysis'; el('verdict').textContent='Insufficient evidence';
      for (const verdict of root.querySelectorAll('[data-rule-verdict]')) verdict.textContent='Capture required';
      el('meaning').textContent=BAUER_RULES[Math.max(0,selectedRule)].explanation+' Capture frame above to check this rule against recorded evidence.';
      el('conditions').hidden=true; el('evidence').textContent=''; el('badline').textContent=''; el('source').textContent='Bauer’s VIC-II reference ↗'; return;
    }
    const index=Math.floor(tick), line=Math.floor(index/63), cycle=index%63, a=frame.analysis;
    el('position').textContent=`Raster ${line} · cycle ${cycle+1}`;
    el('seek').value=index; el('seek').setAttribute('aria-valuetext',`Raster ${line}, cycle ${cycle+1}`);
    const y=line-frame.rasterOffset;
    if (y>=0 && y<frame.height) { picture.strokeStyle=ink; picture.beginPath(); picture.moveTo(0,y+.5); picture.lineTo(384,y+.5); picture.stroke(); }
    for (let c=0;c<63;c++) {
      const t=line*63+c, b=a.bus[t];
      const values=[frame.flags[t]&4,b&32,b&64,b&2,b&4];
      for (let row=0;row<5;row++) { bus.fillStyle=values[row]?accent:dim; bus.globalAlpha=values[row]?1:.18; bus.fillRect(c*10,row*20,9,16); }
    }
    bus.globalAlpha=1; bus.strokeStyle=ink; bus.strokeRect(cycle*10+.5,.5,9,98);
    const finding=explainBauerCycle(frame,report,index,selectedRule), names=['Not applicable','Matches recorded inputs','Mismatch','Insufficient evidence'];
    el('happened').textContent=selectedRule===0 ? (a.vicValid[index] ? `Bad-line condition ${frame.flags[index]&4?'present':'absent'}` : 'Bad-line evidence missing') : explainBauerCycle(frame,report,index).title;
    el('verdict').textContent=`Rule check: ${names[finding.result].toLowerCase()}`; el('verdict').dataset.result=finding.result;
    el('meaning').textContent=finding.text;
    for (const verdict of root.querySelectorAll('[data-rule-verdict]')) {
      const result=report.results[Number(verdict.dataset.ruleVerdict)][index];
      verdict.textContent=['Not active','Matches','Mismatch','No evidence'][result];
      verdict.dataset.result=result;
    }
    const conditions=el('conditions');
    conditions.hidden=finding.rule?.id!=='badline.condition';
    if (!conditions.hidden) {
      conditions.replaceChildren();
      const checks=[
        [line>=0x30 && line<=0xF7,`Raster ${line} is within 48–247`],
        [(line&7)===(a.d011[index]&7),`Raster low bits ${line&7} match scroll ${a.d011[index]&7}`],
        [!!a.denLatch[index],'Display-enable latch is set'],
      ];
      for (const [met,label] of checks) {
        const item=document.createElement('span');
        item.textContent=`${a.vicValid[index]?(met?'✓':'×'):'?'} ${label}`;
        conditions.append(item);
      }
    }
    const b=a.bus[index];
    el('evidence').textContent=(b&1)?`BA ${b&32?'low':'high'} · AEC ${b&64?'low':'high'}\nNext access: ${b&2?'write':'read'} · recorded ${b&4?'blocked':'allowed'}\nCPU PC $${hex(a.pc[index])}`:'CPU bus sample missing';
    const bad=report.results[0][index];
    el('badline').textContent=`Bad-line condition: ${frame.flags[index]&4?'present':'absent'} · ${names[bad]}. $D011=$${hex(a.d011[index],2)}, DEN latch ${a.denLatch[index]?'set':'clear'}.`;
    el('source').textContent=finding.rule?`${finding.rule.id} · Bauer §${finding.rule.section} ↗`:'Bauer reference · outside checked rules ↗';
    el('source').title=`${BAUER_SOURCE}, revision ${BAUER_REVISION}`;
  }
  for (const heading of root.querySelectorAll('[data-rule-index]')) heading.addEventListener('click',()=>{
    const index=Number(heading.dataset.ruleIndex);
    selectedRule=selectedRule===index?-1:index;
    for (const button of root.querySelectorAll('[data-rule-index]')) {
      const open=Number(button.dataset.ruleIndex)===selectedRule;
      button.setAttribute('aria-expanded',String(open));
      const panel=root.querySelector(`#${button.getAttribute('aria-controls')}`);
      panel.hidden=!open;
      if (open) panel.append(el('detail'));
    }
    render();
  });
  el('bus').addEventListener('click',event=>{
    if (!report) return;
    const rect=el('bus').getBoundingClientRect();
    const cycle=Math.max(0,Math.min(62,Math.floor((event.clientX-rect.left)/rect.width*63)));
    tick=Math.floor(tick/63)*63+cycle; playing=false; render();
  });
  el('play').addEventListener('click',()=>{if(!report)return;if(tick>=19655)tick=0;playing=!playing;lastTime=performance.now();render();});
  for (const [name,delta] of [['cycle',1],['line',63]]) el(name).addEventListener('click',()=>{playing=false;tick=Math.min(19655,Math.floor(tick)+delta);render();});
  el('next').addEventListener('click',()=>{if(!report)return;playing=false;tick=report.events.find(t=>t>tick)??19655;render();});
  el('seek').addEventListener('input',()=>{playing=false;tick=Number(el('seek').value);render();});
  function update() { if (!playing || !report) return; const now=performance.now();tick=Math.min(19655,tick+Math.min(250,now-lastTime)*2);lastTime=now;if(tick>=19655)playing=false;render(); }
  return {setFrame,theme,update,seek(position, rule) { tick=Math.max(0,Math.min(19655,position)); playing=false; if (rule !== undefined && selectedRule!==rule) root.querySelector(`[data-rule-index="${rule}"]`)?.click(); render(); },deactivate(){playing=false;render();}};
}
