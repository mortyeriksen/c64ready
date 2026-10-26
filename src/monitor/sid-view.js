// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { hex } from './memory-sampler.js';

import { voiceDescription, filterDescription, envelopePoints } from './sound-model.js';
export { sidVoice } from './sound-model.js';

export function createSidView(root) {
  root.innerHTML = `<div class="monitor-section-head monitor-page-head"><p class="monitor-page-intro">Follow each voice from pitch to filter.</p></div><div class="monitor-sid-tabs"><button class="btn" data-sid-chip="0" aria-pressed="true">SID 1</button><button class="btn" data-sid-chip="1" aria-pressed="false">SID 2</button></div><div class="monitor-sid-panels"></div><details class="monitor-help"><summary>Reading the SID</summary><p>Each chip has three voices. Frequency and pulse width come from the oscillator registers. Waveform labels indicate selected waveforms, which can be combined. Gate starts or releases the envelope. Sync and ring modulation use the previous oscillator, with voice 1 using voice 3. Envelope drawings illustrate settings, not measured levels or timing. Gate on does not prove a voice is audible, and release can continue after gate off.</p><p>Filter routing chooses which voices enter the filter. Low-pass, band-pass and high-pass can be combined. Cutoff is the 11-bit register setting, not a calibrated frequency. OSC3 and ENV3 are side-effect-free shadow-chip readbacks, not an audio waveform. Voice 3 off suppresses its unfiltered output. The chips retain independent models, addresses and controls.</p></details>`;
  const panels = root.querySelector('.monitor-sid-panels'), chips = [];
  const registerHelp = document.createElement('details'); registerHelp.className = 'monitor-help';
  registerHelp.innerHTML = '<summary>Register bytes</summary>';
  panels.after(registerHelp);
  let selected = 0;
  for (let index = 0; index < 2; index++) {
    const panel = document.createElement('section'); panel.className = 'monitor-sid-chip'; panel.dataset.chip = index;
    panel.innerHTML = `<div class="monitor-section-head"><h3>SID ${index + 1}</h3><span class="monitor-tag" data-sid="identity"></span></div><div class="monitor-sid-voices"></div><div class="monitor-sid-filter"><b>Filter → output</b><p data-sid="filter-meaning"></p><div data-sid="routing" class="monitor-sid-bits"></div><label>Cutoff <meter min="0" max="2047" data-sid="cutoff"></meter><code data-sid="cutoff-value"></code></label><label>Resonance <meter min="0" max="15" data-sid="resonance"></meter><code data-sid="resonance-value"></code></label><label>Volume <meter min="0" max="15" data-sid="volume"></meter><code data-sid="volume-value"></code></label><div data-sid="modes" class="monitor-sid-bits"></div><details class="monitor-help"><summary>Inputs & voice 3 readbacks</summary><p>POTX/POTY are input readings. OSC3/ENV3 are shadow-chip voice 3 readings, not measurements of the audio output.</p><div class="monitor-sid-readback"><span>POTX <b data-sid="potx"></b></span><span>POTY <b data-sid="poty"></b></span><span>OSC3 <b data-sid="osc"></b></span><span>ENV3 <b data-sid="env"></b></span></div></details></div>`;
    const registers = document.createElement('section');
    registers.innerHTML = `<h3>SID ${index + 1}</h3><pre></pre>`; registerHelp.append(registers);
    const el = name => panel.querySelector(`[data-sid="${name}"]`);
    const voices = [];
    for (let v = 0; v < 3; v++) {
      const card = document.createElement('div'); card.className = 'monitor-sid-voice';
      card.innerHTML = `<b>Voice ${v + 1}</b><div class="monitor-sid-wave"></div><label>Frequency <strong></strong><meter min="0" max="65535"></meter></label><label>Pulse width <code></code><meter min="0" max="4095"></meter></label><div class="monitor-sid-switches"></div><div class="monitor-sid-envelope-shape"><svg viewBox="0 0 100 44" role="img" aria-label="Envelope settings illustration"><polyline fill="none" stroke="currentColor" stroke-width="2"/></svg><span>Attack · Decay · Sustain · Release</span></div><div class="monitor-sid-route"></div><p class="monitor-sid-voice-meaning"></p><code class="monitor-sid-voice-evidence"></code>`;
      const wave = [], switches = [];
      for (const [name, bit] of [['△', 16], ['╱', 32], ['⊓', 64], ['Noise', 128]]) { const tag = document.createElement('span'); tag.textContent = name; tag.title = {16:'Triangle',32:'Sawtooth',64:'Pulse',128:'Noise'}[bit]; card.querySelector('.monitor-sid-wave').append(tag); wave.push([tag, bit]); }
      for (const [name, bit] of [['Gate',1],['Sync',2],['Ring',4],['Test',8]]) { const tag = document.createElement('span'); tag.textContent = name; card.querySelector('.monitor-sid-switches').append(tag); switches.push([tag,bit]); }
      voices.push({ card, wave, switches, frequency: card.querySelector('strong'), pulse: card.querySelector('label code'), meters: card.querySelectorAll('meter') }); panel.querySelector('.monitor-sid-voices').append(card);
    }
    function bits(target, labels) { return labels.map(name => { const tag = document.createElement('span'); tag.textContent = name; el(target).append(tag); return tag; }); }
    chips.push({ panel, el, voices, registers, inactive: null, routing: bits('routing',['Voice 1','Voice 2','Voice 3','Ext in']), modes: bits('modes',['Low-pass','Band-pass','High-pass','Voice 3 off']) }); panels.append(panel);
  }
  function select(value) { selected = value; root.dataset.selectedSid = selected; for (const button of root.querySelectorAll('[data-sid-chip]')) button.setAttribute('aria-pressed', String(Number(button.dataset.sidChip) === selected)); }
  root.addEventListener('click', event => { const button = event.target.closest('[data-sid-chip]'); if (button) select(Number(button.dataset.sidChip)); });
  select(0);
  function update(state) {
    root.dataset.sidCount = state.sidCount;
    for (let index = 0; index < 2; index++) {
      const chip = chips[index], inactive = index >= state.sidCount;
      if (chip.inactive !== inactive) {
        chip.inactive = inactive;
        chip.panel.classList.toggle('is-inactive', inactive);
        chip.registers.hidden = inactive;
        for (const part of chip.panel.querySelectorAll('.monitor-sid-voices, .monitor-sid-filter')) {
          part.inert = inactive;
          if (inactive) part.setAttribute('aria-hidden', 'true');
          else part.removeAttribute('aria-hidden');
        }
        if (inactive) {
          chip.el('identity').textContent = 'Not enabled · Enable in Options → Sound';
          for (const item of chip.voices) {
            item.frequency.textContent = '—'; item.frequency.title = '';
            item.pulse.textContent = '—';
            for (const meter of item.meters) meter.value = 0;
            for (const [tag] of [...item.wave, ...item.switches]) { tag.classList.remove('is-set'); tag.removeAttribute('aria-label'); }
            item.card.querySelector('polyline').setAttribute('points', '0,42 20,8 40,24 70,24 100,42');
            item.card.querySelector('.monitor-sid-route').textContent = 'Envelope → Filter → output';
            item.card.querySelector('.monitor-sid-voice-meaning').textContent = '';
            item.card.querySelector('.monitor-sid-voice-evidence').textContent = '';
          }
          chip.el('filter-meaning').textContent = 'Three more voices, with their own filter and output.';
          for (const name of ['cutoff', 'resonance', 'volume']) { chip.el(name).value = 0; chip.el(name + '-value').textContent = '—'; }
          for (const tag of [...chip.routing, ...chip.modes]) tag.classList.remove('is-set');
          chip.registers.querySelector('pre').textContent = '';
        }
      }
      if (inactive) continue;
      const offset = index * 32, r = state.sid, address = index ? state.sid2Address : 0xD400;
      chip.el('identity').textContent = `${state.sidModels[index] ? '8580' : '6581'} · $${hex(address)}${state.sidCount > 1 ? ' · ' + state.sidMix : ''}`;
      for (let v = 0; v < 3; v++) {
        const voice = voiceDescription(r,index,v), item = chip.voices[v];
        item.frequency.textContent = `${voice.hz.toFixed(1)} Hz${voice.note ? " ≈ " + voice.note : ""}`; item.frequency.title = `$${hex(voice.frequency)}`;
        item.pulse.textContent = `${voice.pulsePercent.toFixed(1)}%`; item.meters[0].value = voice.frequency; item.meters[1].value = voice.pulse;
        for (const [tag, bit] of [...item.wave, ...item.switches]) { tag.classList.toggle('is-set', !!(voice.control & bit)); tag.setAttribute('aria-label', `${tag.title || tag.textContent}: ${voice.control & bit ? 'on' : 'off'}`); }
        item.card.querySelector('polyline').setAttribute('points',envelopePoints(voice.adsr));
        item.card.querySelector('.monitor-sid-route').textContent=`Envelope → ${voice.route} → output`;
        item.card.querySelector('.monitor-sid-voice-meaning').textContent=voice.gate?'Gate on: attack or sustain.':'Gate off: release may still sound.';
        item.card.querySelector('.monitor-sid-voice-evidence').textContent=`ADSR ${voice.adsr.join('/')} · $${hex(address+v*7)}–$${hex(address+v*7+6)}: ${Array.from(r.slice(offset+v*7,offset+v*7+7),n=>hex(n,2)).join(' ')}`;

      }
      chip.el('filter-meaning').textContent=filterDescription(r,index);
      const route = r[offset + 23], modes = r[offset + 24];
      for (const [name, value] of [['cutoff', (r[offset + 21] & 7) | (r[offset + 22] << 3)], ['resonance', route >>> 4], ['volume', modes & 15]]) { chip.el(name).value = value; chip.el(name + '-value').textContent = value; }
      for (let bit = 0; bit < 4; bit++) { chip.routing[bit].classList.toggle('is-set', !!(route & (1 << bit))); chip.modes[bit].classList.toggle('is-set', !!(modes & (16 << bit))); }
      for (const [part, name] of ['potx', 'poty', 'osc', 'env'].entries()) chip.el(name).textContent = state.sidReadback[index * 4 + part];
      let text = '';
      for (let reg = 0; reg < 25; reg++) text += `$${hex(address + reg)}  $${hex(r[offset + reg],2)}${reg % 4 === 3 ? '\n' : '   '}`;
      chip.registers.querySelector('pre').textContent = text;
    }
  }
  return { update, selectChip: select };
}
