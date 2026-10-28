// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { logicalDisplayTrace } from './bauer-phases.js';
import { EXTENDED_RULES, prepareExtended, checkExtended } from './bauer-extended.js';

// Independent predicates, without imports from the emulator's VIC implementation.
export const BAUER_SOURCE = 'https://www.cebix.net/VIC-Article.txt';
export const BAUER_REVISION = '2024-09-29';
export const RESULT = Object.freeze({ irrelevant: 0, match: 1, mismatch: 2, unknown: 3 });
export const BAUER_RULES = Object.freeze([
  { id:'badline.condition', section:'3.5', title:'Bad-line condition', requires:'phi1 $D011, DEN latch, raster, recorded condition', explanation:'A bad line is eligible when the raster is in $30–$F7, its low three bits match YSCROLL, and the DEN latch is set.' },
  { id:'bus.read-stall', section:'2.2 / 2.3', title:'Read waits for the bus', requires:'BA, AEC, next CPU access, recorded bus permission', explanation:'BA connects to RDY. A low BA stops a read, including an opcode or dummy read.' },
  { id:'bus.write-window', section:'2.2 / 2.3', title:'Write can still proceed', requires:'BA, AEC, next CPU access, recorded bus permission', explanation:'RDY does not stop writes. While BA is low and AEC still permits CPU access, a write can proceed.' },
  { id:'bus.vic-ownership', section:'2.3', title:'VIC owns the bus', requires:'AEC, recorded bus permission', explanation:'Low AEC disconnects the CPU address drivers. The CPU cannot perform a bus access in this phase.' },
  { id:'bus.available', section:'2.2 / 2.3', title:'CPU bus available', requires:'BA, AEC, recorded bus permission', explanation:'With BA and AEC high, these VIC signals do not block the next CPU bus access.' },
  ...EXTENDED_RULES,
].map(rule => Object.freeze({...rule, source:BAUER_SOURCE, revision:BAUER_REVISION})));
export const BAUER_UNCHECKED = 'Checks cover recorded digital evidence, not the whole physical chip. Renderer-source bytes are not timed bus fetches. Grouped sprite reads do not expose individual half-cycle timing. Exact sprite X-comparator phases, display entry before the captured rendering-stage window, analog output and unstable VMLI effects remain insufficient evidence. REU holds and halted CPUs are outside VIC bus checks.';

export function badLineCondition(raster, d011, denLatch) {
  return raster >= 0x30 && raster <= 0xF7 && (raster & 7) === (d011 & 7) && !!denLatch;
}
export function hasBauerCapture(frame) {
  const a = frame?.analysis, n = 312*63;
  return !!(a?.version === 1 && a.scope === 'pal-bus-v1' && ['6569','8565'].includes(a.model)
    && frame.lines === 312 && frame.cyclesPerLine === 63 && frame.flags?.length === n
    && ['d011','denLatch','vicValid','bus','pc'].every(key => a[key]?.length === n));
}
export function checkBauerRule(frame, tick, ruleIndex) {
  if (!hasBauerCapture(frame) || !Number.isInteger(tick) || tick < 0 || tick >= 19656 || !Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= BAUER_RULES.length) return RESULT.unknown;
  return checkRecordedRule(frame,tick,ruleIndex,ruleIndex>=5?prepareExtended(frame):null);
}
function checkRecordedRule(frame,tick,ruleIndex,extended) {
  if(ruleIndex>=5)return checkExtended(frame,tick,BAUER_RULES[ruleIndex].id,extended);
  const a = frame.analysis, bus = a.bus[tick];
  if (ruleIndex === 0) {
    if (!a.vicValid[tick]) return RESULT.unknown;
    const expected = badLineCondition(Math.floor(tick/63),a.d011[tick],a.denLatch[tick]);
    return expected === !!(frame.flags[tick]&4) ? RESULT.match : RESULT.mismatch;
  }
  if (!(bus&1) || (bus&24)) return RESULT.unknown;
  const write=!!(bus&2), blocked=!!(bus&4), ba=!!(bus&32), aec=!!(bus&64);
  let applies=false, expected=false;
  if (ruleIndex===1) { applies=ba && !aec && !write; expected=true; }
  if (ruleIndex===2) applies=ba && !aec && write;
  if (ruleIndex===3) { applies=aec; expected=true; }
  if (ruleIndex===4) applies=!ba && !aec;
  return !applies ? RESULT.irrelevant : expected===blocked ? RESULT.match : RESULT.mismatch;
}
export function busCategory(frame,tick) {
  const b=frame.analysis?.bus[tick] ?? 0;
  return !(b&1) ? 'unknown' : b&8 ? 'external' : b&16 ? 'halted' : b&64 ? 'vic' : b&32 ? b&2 ? 'write' : 'read' : 'available';
}
export function analyzeBauerFrame(frame) {
  if (!hasBauerCapture(frame)) return null;
  const extended=prepareExtended(frame);
  const results = BAUER_RULES.map(()=>new Uint8Array(19656));
  const summary = BAUER_RULES.map(rule=>({id:rule.id,match:0,mismatch:0,unknown:0}));
  const events=[0]; let previous=-1;
  for (let tick=0;tick<19656;tick++) {
    let mismatch=false;
    for (let rule=0;rule<BAUER_RULES.length;rule++) {
      const result=checkRecordedRule(frame,tick,rule,extended); results[rule][tick]=result;
      if (result===1) summary[rule].match++; else if (result===2) { summary[rule].mismatch++; mismatch=true; } else if (result===3) summary[rule].unknown++;
    }
    const b=frame.analysis.bus[tick];
    const category=!(b&1)?0:b&8?1:b&16?2:b&64?3:b&32?(b&2?4:5):6;
    const key=category*8+(frame.flags[tick]&4)+(mismatch?1:0);
    if (tick && key!==previous) events.push(tick);
    previous=key;
  }
  return {results,summary,events,logicalDisplay:logicalDisplayTrace(frame)};
}
export function explainBauerCycle(frame,report,tick,selectedRule = -1) {
  if (selectedRule >= 0 && selectedRule < BAUER_RULES.length) {
    const rule = BAUER_RULES[selectedRule];
    return { title: rule.title, rule, result: report.results[selectedRule][tick], text: rule.explanation };
  }
  const category=busCategory(frame,tick), titles={unknown:'CPU bus evidence is missing',external:'An REU holds the bus',halted:'The CPU is halted',vic:'The VIC owns the bus',write:'A write can still proceed',read:'The CPU read must wait',available:'The CPU can use the bus'};
  const index=report.results[0][tick]===RESULT.mismatch?0:category==='vic'?3:category==='write'?2:category==='read'?1:category==='available'?4:0;
  const rule=BAUER_RULES[index], result=report.results[index][tick];
  const unsupported=['unknown','external','halted'].includes(category);
  return {title:index===0 && !unsupported?'Bad-line condition differs from the rule':titles[category],rule:unsupported?null:rule, result:unsupported?RESULT.unknown:result,
    text:unsupported?'This cycle is outside the supported CPU bus checks. The analyzer does not attribute this pause to a VIC rule.':rule.explanation};
}
