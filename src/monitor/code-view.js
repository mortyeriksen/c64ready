// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { createEvidenceView } from './evidence-view.js';
import { createCodeStory } from './code-story.js';
import { capturedInstructions } from './provenance-model.js';
import { hex } from './memory-sampler.js';
import { decodeInstruction, registerMeaning, OPCODES } from './disassembly.js';

export function createCodeView(root, inspectAddress, options = {}) {
  root.innerHTML = `<div class="monitor-section-head"><p class="monitor-view-intro" data-code="context">Current CPU instructions and registers.</p><span class="monitor-tag" data-code="state"></span></div><div class="monitor-cpu-registers" data-code="registers"></div><div class="monitor-flags" data-code="flags"></div><div class="monitor-code-controls"><label><input type="checkbox" checked data-code="follow"> Follow PC</label><label>Address $<input type="text" data-code="address" value="0000" maxlength="4" pattern="[0-9a-fA-F]{1,4}" aria-label="Code address in hexadecimal"></label></div><div class="monitor-disassembly" data-code="lines"></div><details class="monitor-help"><summary>How instructions affect the machine</summary><p>Decoded from CPU-visible memory, including ROM and cartridge mapping. Labels identify the register addressed by an instruction, not proof that the instruction executed. Follow PC samples the program counter, which can point to an operand in the middle of an instruction. It is not a trace or a disassembler for the entire program. Indexed and indirect targets are not inferred from future register values.</p><p>Click a direct target to inspect its address in the memory view. That view is underlying RAM, which may differ from CPU-visible ROM or I/O.</p></details>`;
  const assembly = document.createElement('div'); assembly.className = 'monitor-code-assembly';
  assembly.append(...root.childNodes); root.append(assembly);
  const storyRoot = document.createElement('div'); storyRoot.className = 'monitor-code-story'; root.prepend(storyRoot);
  const executionRoot = document.createElement('div'); executionRoot.className = 'monitor-code-execution'; root.append(executionRoot);
  const modes = document.createElement('div'); modes.className = 'monitor-code-modes monitor-section-modes';
  modes.innerHTML = '<button class="btn" data-mode="story" aria-pressed="true">Explain actions</button><button class="btn" data-mode="execution" aria-pressed="false">Execution & interrupts</button><button class="btn" data-mode="assembly" aria-pressed="false">Assembly & registers</button>';
  root.prepend(modes);
  let selectedMode='story',active=false;
  function mode(value) { selectedMode=value; executionRoot.hidden = value !== 'execution'; execution.setActive(active && value === 'execution'); if(value === 'execution') execution.seek(story.tick); assembly.hidden = value !== 'assembly'; storyRoot.hidden = value !== 'story'; for (const button of modes.children) button.setAttribute('aria-pressed', String(button.dataset.mode === value)); }
  modes.addEventListener('click', event => { const value=event.target.closest('button[data-mode]')?.dataset.mode; if(value) { mode(value); story.refresh(); if(state)update(facade,state); } });
  const story = createCodeStory(storyRoot, { ...options, openCode: (value, origin, captured, tick) => openAddress(value, origin, captured, tick) });
  const execution = createEvidenceView(executionRoot, 'code', options.openEvidenceFrame, options.openMemory, {inline:true,onPosition:tick=>story.seek(tick)});
  mode('story');
  const el = name => root.querySelector(`[data-code="${name}"]`);
  const data = new Uint8Array(48), registers = [], flags = [], lines = [];
  let address = 0, facade = null, state = null, recorded = null;
  for (const name of ['PC', 'A', 'X', 'Y', 'SP']) {
    const cell = document.createElement('div'); cell.innerHTML = `<small>${name}</small><b></b>`; el('registers').append(cell); registers.push(cell.lastElementChild);
  }
  for (const [name, bit] of [['N', 7], ['V', 6], ['D', 3], ['I', 2], ['Z', 1], ['C', 0]]) {
    const cell = document.createElement('span'); cell.textContent = name; el('flags').append(cell); flags.push({ cell, bit });
  }
  for (let i = 0; i < 10; i++) {
    const button = document.createElement('button'); button.type = 'button'; button.innerHTML = '<code></code><strong></strong><span></span>';
    const line = { button, address: button.children[0], instruction: button.children[1], effect: button.children[2], target: null };
    button.addEventListener('click', () => { if (line.target !== null) { if(recorded&&options.openMemory)options.openMemory(recorded.frame,line.tick,line.target);else inspectAddress(line.target); } });
    lines.push(line); el('lines').append(button);
  }
  el('address').addEventListener('change', () => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(el('address').value)) { el('address').setCustomValidity('Enter 1 to 4 hexadecimal digits'); el('address').reportValidity(); return; }
    recorded = null; el('address').setCustomValidity(''); address = parseInt(el('address').value, 16); el('follow').checked = false; el('context').textContent='Snapshot CPU-visible memory · shared inspection snapshot';
    if (state) update(facade, state);
  });
  el('follow').addEventListener('change', () => { recorded = null; el('context').textContent='Snapshot CPU-visible memory · shared inspection snapshot'; if (state) update(facade, state); });
  function update(current, sample) {
    facade = current; state = sample;
    if(assembly.hidden)return;
    el('registers').hidden=!!recorded; el('flags').hidden=!!recorded;
    if(recorded){if(!recorded.rendered)renderRecorded();return;}
    if (el('follow').checked) address = sample.pc;
    if (document.activeElement !== el('address')) el('address').value = hex(address);
    el('state').textContent = sample.halted ? 'Halted' : sample.instructionBoundary ? 'Instruction boundary' : 'Mid-instruction PC';
    const values = [sample.pc, sample.a, sample.x, sample.y, sample.sp];
    for (let i = 0; i < 5; i++) registers[i].textContent = '$' + hex(values[i], i ? 2 : 4);
    for (const { cell, bit } of flags) { cell.classList.toggle('is-set', !!(sample.p & (1 << bit))); cell.setAttribute('aria-label', `${cell.textContent}: ${(sample.p >>> bit) & 1}`); }
    facade.copyCpuMemory(address, data);
    let offset = 0;
    for (const line of lines) {
      line.button.hidden=false;
      const entry = decodeInstruction(data, offset, (address + offset) & 65535); offset += entry.size;
      line.address.textContent = '$' + hex(entry.address);
      line.instruction.textContent = entry.name + ' ' + entry.operand;
      line.target = entry.target; line.button.dataset.kind = entry.kind;
      const source = entry.target === null ? facade.cpuMemorySource(entry.address) : facade.cpuMemorySource(entry.target);
      line.effect.textContent = entry.target !== null && source === 'I/O' && entry.kind !== 'flow' ? `${entry.kind === 'write' ? '→' : entry.kind === 'modify' ? '↔' : '←'} ${registerMeaning(entry.target, sample.sid2Address)}` : source;
      line.button.disabled = entry.target === null;
    }
  }
  function renderRecorded() {
    recorded.rendered=true;el('registers').hidden=true;el('flags').hidden=true;
    const rows=recorded.rows, selected=recorded.selected;
    el('state').textContent='Captured instruction reads';
    el('context').textContent=recorded.origin || 'Recorded instruction and operand bytes';
    el('address').value=hex(address);
    for(let i=0;i<lines.length;i++) {
      const line=lines[i],row=rows[selected+i];
      line.button.hidden=!row;
      if(!row)continue;
      const complete=row.bytes.slice(0,row.size).every(value=>value!==null);
      const entry=complete?decodeInstruction(row.bytes,0,row.address):null;
      line.address.textContent='$'+hex(row.address);
      line.instruction.textContent=entry?`${entry.name} ${entry.operand}`:`${OPCODES[row.opcode].name} · operand not recorded`;
      line.effect.textContent=`${row.bytes.slice(0,row.size).map(value=>value===null?'??':hex(value,2)).join(' ')} · raster ${Math.floor(row.tick/recorded.frame.cyclesPerLine)}, cycle ${row.tick%recorded.frame.cyclesPerLine+1}`;
      line.tick=row.tick;line.target=entry?.target??null;line.button.disabled=line.target===null;
      line.button.dataset.kind=entry?.kind??'cpu';
    }
    if(selected<0){el('context').textContent+=' · Instruction dispatch is outside the captured evidence. Current memory is not substituted.';}
  }
  function openAddress(value, origin = null, captured = null, tick = 0) {
    recorded=null;
    if(captured){
      const rows=capturedInstructions(captured);
      const selected=rows.findLastIndex(row=>row.address===value&&row.tick<=tick);
      recorded={frame:captured,rows:selected<0?[]:rows,selected,origin};
    }
    mode('assembly'); el('context').textContent=origin||'Snapshot CPU-visible memory';
    address=value;el('follow').checked=false;el('address').value=hex(value);
    if(recorded)renderRecorded();else if(state)update(facade,state);
  }

  return { remember(){const saved={selectedMode,recorded,address},restoreStory=story.remember(),restoreExecution=execution.remember();return()=>{recorded=saved.recorded;address=saved.address;mode(saved.selectedMode);restoreStory();restoreExecution();if(recorded){recorded.rendered=false;renderRecorded();}else if(state)update(facade,state);};}, execution, update, poll: story.update, openAddress, accept: story.accept, activate(){active=true;execution.setActive(selectedMode==='execution');story.refresh();},deactivate(){active=false;execution.setActive(false);},clear(){facade=null;state=null;recorded=null;story.clear();execution.setFrame(null);},theme: story.theme };
}
