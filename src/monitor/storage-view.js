// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { STORAGE_DEVICES, StorageHistory, reuSettings, activeStorageDevice } from './storage-model.js';
import { formatStorageRate } from './storage-rates.js';
import { hex } from './memory-sampler.js';
import { createStorageAnalysis } from './storage-analysis.js';
import { drawStorageMedia } from './storage-media.js';

const clock = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2,'0')}`;

export function createStorageView(root, openMemory, openCode, navigation = {}) {
  root.innerHTML = `<div class="monitor-storage-tabs monitor-section-modes" role="group" aria-label="Storage device">${STORAGE_DEVICES.map((name,i) => `<button type="button" class="btn" data-storage-device="${i}" aria-pressed="${i === 0}">${name}</button>`).join('')}</div>
    <div class="monitor-storage-body"><div class="monitor-storage-visual"><canvas width="480" height="300" data-storage="picture" aria-label="Selected storage medium illustration"></canvas><strong data-storage="status"></strong><div class="monitor-storage-throughput"><strong data-storage="rate"></strong><span data-storage="rate-scope"></span><small data-storage="rate-directions"></small></div><div class="monitor-storage-chain" data-storage="chain" aria-label="How this device connects"></div></div>
    <div class="monitor-storage-explanation"><h3 data-storage="title"></h3><p data-storage="meaning"></p><div class="monitor-storage-plot"></div><dl data-storage="facts"></dl><button class="btn" type="button" data-storage="inspect" hidden></button><p class="monitor-tag" data-storage="limit"></p></div></div>
    <div class="monitor-section-head"><b>Observed activity</b><span class="monitor-tag" data-storage="window"></span></div><canvas class="monitor-storage-history" data-storage="history" width="800" height="34" aria-label="Recent sampled device state"></canvas><span class="monitor-tag" data-storage="legend"></span>
    <details class="monitor-help"><summary>Exact values and what the observations mean</summary><pre data-storage="details"></pre><p>The device illustration explains its role. History records sampled motor, indicator or mapping states. REU marks also detect changes in its transfer counter. Brief transitions can occur between samples. Track and activity indicators do not identify a file, sector or RAM destination. Accelerated loading bypasses the normal KERNAL disk-load path. A cartridge maps into the address space, while an REU transfers data to and from separate expansion RAM.</p></details>`;
  const el = name => root.querySelector(`[data-storage="${name}"]`);
  const ctx = el('picture').getContext('2d'), trace = el('history').getContext('2d');
  const buttons = [...root.querySelectorAll('[data-storage-device]')];
  const history = new StorageHistory();
  const analysis = createStorageAnalysis(root.querySelector('.monitor-storage-plot'), { openCode, openMemory, ...navigation });
  let facade = null, state = null, selected = 0, visible = false;
  let ink, accent, dim, bg;
  function theme() { const style = getComputedStyle(root); ink = style.getPropertyValue('--text').trim(); accent = style.getPropertyValue('--accent').trim(); dim = style.getPropertyValue('--dim').trim(); bg = style.getPropertyValue('--ui-bg').trim(); analysis.theme(); if (state && visible && !root.hidden) draw(); }
  function select(index) { selected = index; root.dataset.device = String(index); if (state && visible && !root.hidden) draw(); }
  for (const button of buttons) button.addEventListener('click',() => select(Number(button.dataset.storageDevice)));
  function facts(values) {
    el('facts').replaceChildren();
    for (const [key,value] of values) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = value; el('facts').append(dt,dd); }
  }
  function chain(values) {
    el('chain').replaceChildren();
    values.forEach((value,i) => { if (i) { const arrow = document.createElement('span'); arrow.textContent = '→'; arrow.setAttribute('aria-hidden','true'); el('chain').append(arrow); } const part = document.createElement('b'); part.textContent = value; el('chain').append(part); });
  }
  function picture() { drawStorageMedia(ctx, selected, state, { ink, accent, dim, bg }); }
  function draw() {
    const reuHelp = root.querySelector('.monitor-evidence');
    if (reuHelp) reuHelp.hidden = selected !== 4;
    const d = selected < 2 ? state.drives[selected] : null, t = state.tape, c = state.cartridge, r = state.reu;
    const summaries = state.drives.map(drive => drive.hasMedia ? `${drive.format} inserted` : drive.available ? 'Empty' : 'Not attached');
    summaries.push(t.hasMedia ? t.key : 'Empty',c.inserted ? 'Inserted' : 'Empty',r.attached ? `${r.bytes/1024} KB` : 'Not attached');
    buttons.forEach((button,i) => { button.setAttribute('aria-pressed',String(i === selected)); button.title = `${STORAGE_DEVICES[i]} · ${summaries[i]}`; });
    const rate = state.rates?.[selected];
    el('rate').textContent = !rate?.available ? '— kB/s' : rate.ready ? formatStorageRate(rate.total, true) : 'Measuring…';
    el('rate-scope').textContent = rate?.scope || 'No media or device';
    el('rate-directions').textContent = rate?.ready ? `Read ${formatStorageRate(rate.read,true)} · write ${formatStorageRate(rate.write,true)} · 1 kB = 1,000 bytes` : 'Rates use up to one second of wall time';
    el('inspect').hidden = true;
    if (d) {
      el('title').textContent = d.mode === 'accelerated' ? 'Follow the bytes being delivered.' : 'Watch the head find its next track.';
      el('status').textContent = !d.available ? 'Drive not connected' : !d.hasMedia ? 'No disk inserted' : d.motor ? 'Disk motor running' : 'Disk inserted · motor stopped';
      el('meaning').textContent = d.mode === 'accelerated' ? 'KERNAL disk loads use an accelerated path. A simulated drive, when attached, can still respond to other serial operations.' : 'The drive’s own CPU runs its loader while the head reads the disk. The trail shows sampled head positions.';
      chain(d.mode === 'accelerated' ? ['Disk image','Accelerated LOAD','C64 RAM'] : ['Disk','1541','Serial','C64']);
      facts([['Media',d.hasMedia ? `${d.format}${d.label ? ' · '+d.label : ''}` : 'No disk'],['Loading mode',d.mode === 'true-drive' ? 'True drive' : d.mode === 'accelerated' ? 'Accelerated' : 'Disconnected'],['Disk changes',!d.hasMedia ? 'No media' : `${d.writeProtected ? 'Protected' : 'Writable'} · ${d.dirty ? 'modified' : 'unchanged'}`]]);
      el('limit').textContent = 'Motor and LED state do not prove that bytes reached RAM.';
      el('details').textContent = `Device ${d.device}\nDrive CPU PC: ${d.hardware ? '$'+hex(d.pc) : 'unavailable'}\nHead half-track: ${d.hardware ? d.halfTrack : 'unavailable'}\nDisk label comes from media metadata, not a browser filename.\nNo decoded file, sector or transfer destination is recorded.`;
      el('legend').textContent = 'Dim: motor on · bright: activity LED on · blank: neither observed';
    } else if (selected === 2) {
      el('title').textContent = 'The gaps carry the information.'; el('status').textContent = t.hasMedia ? `${t.recording ? 'Recording' : t.key} · motor ${t.motor ? 'on' : 'off'}` : 'No tape inserted';
      el('meaning').textContent = 'The loader measures pulse timing to recover data. Watch the lengths change as the tape moves, measured in cycles and microseconds.';
      chain(['Tape pulses','Datasette','C64 program','RAM']);
      facts([['Position',`${clock(t.elapsed)} / ${clock(t.duration)}`],['Transport',`${t.key} · motor ${t.motor ? 'on' : 'off'}`],['Tape',`${t.writeProtected ? 'Protected' : 'Writable'} · ${t.dirty ? 'modified' : 'unchanged'}`]]);
      el('limit').textContent = 'Tape position is not the percentage of a program loaded.';
      el('details').textContent = `Position: ${((t.fraction || 0)*100).toFixed(2)}%\nMotor: ${t.motor ? 'on' : 'off'}\nRecording: ${t.recording ? 'yes' : 'no'}\nThe scope reads pulse lengths through the facade from TAP entries near the head or the recording tail. Full-wave pulse shape is reconstructed, not a measurement of pin duty cycle. Bit decoding and target addresses depend on the loader. Pause holds the tape window. Long tapes are decoded in bounded steps from valid entry boundaries.`;
      el('legend').textContent = 'Dim: motor on · bright: recording · blank: neither observed';
    } else if (selected === 3) {
      el('title').textContent = 'A different bank, the same address.';
      el('status').textContent = c.inserted ? `${c.label} · ${c.mode === 'none' ? 'ROM mapping off' : c.mode+' mapping'}` : 'No cartridge inserted';
      el('meaning').textContent = 'Bank switching chooses which cartridge memory appears in a window. The map shows what the CPU can see now.';
      chain(['Cartridge','Expansion port','CPU address space']);
      facts([['Mapping',c.mode],['Selected bank',c.inserted ? String(c.bank) : 'None'],['CPU sees $8000',facade.cpuMemorySource(0x8000)]]);
      el('inspect').hidden = !c.inserted; el('inspect').textContent = 'Inspect CPU-visible code at $8000 ↗';
      el('limit').textContent = 'Inserted and mapped are different states. The CPU port can hide cartridge memory.';
      el('details').textContent = `CPU-visible sources:\n$8000: ${facade.cpuMemorySource(0x8000)}\n$A000: ${facade.cpuMemorySource(0xA000)}\n$E000: ${facade.cpuMemorySource(0xE000)}\nFreeze button supported: ${c.freeze ? 'yes' : 'no'}\nReset button supported: ${c.reset ? 'yes' : 'no'}\nMapping activity does not measure cartridge reads.`;
      el('legend').textContent = 'Dim: cartridge mapping selected · blank: mapping off or no cartridge';
    } else {
      const settings = reuSettings(r.registers,r.bankMask);
      el('title').textContent = 'Move data without a CPU copy loop.';
      el('status').textContent = r.attached ? `${r.model} · ${r.bytes/1024} KB` : 'No REU attached';
      el('meaning').textContent = 'The REU copies, swaps or compares blocks of memory. Current settings and recorded accesses tell different parts of the story.';
      chain(['C64 RAM','REU controller','Expansion RAM']);
      facts([['Controller',r.active ? 'Transfer active' : 'Idle'],['Operation',r.attached ? settings.operation : 'Unavailable'],['Length register',r.attached ? `${settings.length.toLocaleString()} bytes` : 'Unavailable']]);
      el('inspect').hidden = !r.attached; el('inspect').textContent = 'Inspect current C64 RAM address ↗';
      el('limit').textContent = 'Addresses and length are current register settings, not a saved transfer record.';
      el('details').textContent = r.attached ? `${settings.complete ? 'End-of-block flag set' : 'End-of-block flag clear'}\n${settings.fault ? 'Compare mismatch flag set' : 'Compare mismatch flag clear'}\nIRQ pending: ${settings.irq ? 'yes' : 'no'}\nRead-only register bytes:\n${Array.from(r.registers,(value,i)=>'$'+hex(0xDF00+i)+'  $'+hex(value,2)).join('\n')}` : 'Attach an REU to inspect its controller registers.';
      el('legend').textContent = 'Bright: active transfer or changed transfer counter · blank: no new activity observed';
    }
    el('details').textContent += '\n\nRates count the named stream, not bytes delivered to a running program. GCR includes disk framing and repeated reads. TAP counts encoded pulse bytes. CRT counts CPU ROM reads, not inspection or VIC reads. REU counts C64 DMA bus reads and writes, including both sides of a swap and verify reads. Accelerated loads count payload bytes, channel reads include their data bytes. Rates stop being collected when the Monitor is closed or hidden.';
    el('details').textContent = `${el('meaning').textContent}\n\n${el('limit').textContent}\n\n${el('details').textContent}`;
    analysis.update(facade, selected, history);
    picture(); trace.fillStyle = bg; trace.fillRect(0,0,800,34);
    for (let i=0;i<history.count;i++) { const value = history.rows[selected][(history.cursor-history.count+i+401)%401]; trace.fillStyle = value === 2 ? accent : dim; trace.globalAlpha = value ? 1 : .12; trace.fillRect(800*(history.times[(history.cursor-history.count+i+401)%401]-history.lastTime+8000)/8000,3,Math.max(2,800/Math.max(1,history.count)),28); }
    trace.globalAlpha = 1; el('window').textContent = `${history.seconds.toFixed(1)} seconds`;
  }
  function update(current, render = true) {
    visible = render;
    if (facade !== current) { facade = current; history.reset(); analysis.reset(); }
    state = current.storage;
    history.sample(state, current.capturedAt, current.intervalMs);
    if (!ink) theme();
    else if (render) draw();
    return state;
  }
  el('inspect').addEventListener('click',() => { if (selected === 3) openCode(0x8000); else if (selected === 4) openMemory(reuSettings(state.reu.registers,state.reu.bankMask).c64); });
  return { update, theme, setFrame: value => analysis.setFrame(value), selectActive() { if (state) select(activeStorageDevice(state,selected,history.reuChanged)); }, reset() { facade = null; state = null; visible = false; history.reset(); analysis.reset(); }, select, get state() { return state; }, get selected() { return selected; } };
}
