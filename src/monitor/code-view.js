// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { createEvidenceView } from './evidence-view.js';
import { createCodeStory } from './code-story.js';
import { hex } from './memory-sampler.js';
import { decodeInstruction, registerMeaning } from './disassembly.js';

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
  const story = createCodeStory(storyRoot, { ...options, openCode: (value, origin) => openAddress(value, origin) });
  const execution = createEvidenceView(executionRoot, 'code', options.openEvidenceFrame, options.openMemory, {inline:true,onPosition:tick=>story.seek(tick)});
  mode('story');
  const el = name => root.querySelector(`[data-code="${name}"]`);
  const data = new Uint8Array(48), registers = [], flags = [], lines = [];
  let address = 0, facade = null, state = null;
  for (const name of ['PC', 'A', 'X', 'Y', 'SP']) {
    const cell = document.createElement('div'); cell.innerHTML = `<small>${name}</small><b></b>`; el('registers').append(cell); registers.push(cell.lastElementChild);
  }
  for (const [name, bit] of [['N', 7], ['V', 6], ['D', 3], ['I', 2], ['Z', 1], ['C', 0]]) {
    const cell = document.createElement('span'); cell.textContent = name; el('flags').append(cell); flags.push({ cell, bit });
  }
  for (let i = 0; i < 10; i++) {
    const button = document.createElement('button'); button.type = 'button'; button.innerHTML = '<code></code><strong></strong><span></span>';
    const line = { button, address: button.children[0], instruction: button.children[1], effect: button.children[2], target: null };
    button.addEventListener('click', () => { if (line.target !== null) inspectAddress(line.target); });
    lines.push(line); el('lines').append(button);
  }
  el('address').addEventListener('change', () => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(el('address').value)) { el('address').setCustomValidity('Enter 1 to 4 hexadecimal digits'); el('address').reportValidity(); return; }
    el('address').setCustomValidity(''); address = parseInt(el('address').value, 16); el('follow').checked = false; el('context').textContent='Snapshot CPU-visible memory · shared inspection snapshot';
    if (state) update(facade, state);
  });
  el('follow').addEventListener('change', () => { el('context').textContent='Snapshot CPU-visible memory · shared inspection snapshot'; if (state) update(facade, state); });
  function update(current, sample) {
    facade = current; state = sample;
    if(assembly.hidden)return;
    if (el('follow').checked) address = sample.pc;
    if (document.activeElement !== el('address')) el('address').value = hex(address);
    el('state').textContent = sample.halted ? 'Halted' : sample.instructionBoundary ? 'Instruction boundary' : 'Mid-instruction PC';
    const values = [sample.pc, sample.a, sample.x, sample.y, sample.sp];
    for (let i = 0; i < 5; i++) registers[i].textContent = '$' + hex(values[i], i ? 2 : 4);
    for (const { cell, bit } of flags) { cell.classList.toggle('is-set', !!(sample.p & (1 << bit))); cell.setAttribute('aria-label', `${cell.textContent}: ${(sample.p >>> bit) & 1}`); }
    facade.copyCpuMemory(address, data);
    let offset = 0;
    for (const line of lines) {
      const entry = decodeInstruction(data, offset, (address + offset) & 65535); offset += entry.size;
      line.address.textContent = '$' + hex(entry.address);
      line.instruction.textContent = entry.name + ' ' + entry.operand;
      line.target = entry.target; line.button.dataset.kind = entry.kind;
      const source = entry.target === null ? facade.cpuMemorySource(entry.address) : facade.cpuMemorySource(entry.target);
      line.effect.textContent = entry.target !== null && source === 'I/O' && entry.kind !== 'flow' ? `${entry.kind === 'write' ? '→' : entry.kind === 'modify' ? '↔' : '←'} ${registerMeaning(entry.target, sample.sid2Address)}` : source;
      line.button.disabled = entry.target === null;
    }
  }
  function openAddress(value, origin = null) { mode('assembly'); el('context').textContent=origin?`${origin} supplied the instruction address. Bytes below are from the shared inspection snapshot.`:'Snapshot CPU-visible memory · shared inspection snapshot'; address = value; el('follow').checked = false; el('address').value = hex(value); if (state) update(facade, state); }
  return { execution, update, poll: story.update, openAddress, accept: story.accept, activate(){active=true;execution.setActive(selectedMode==='execution');story.refresh();},deactivate(){active=false;execution.setActive(false);},clear(){facade=null;state=null;story.clear();execution.setFrame(null);},theme: story.theme };
}
