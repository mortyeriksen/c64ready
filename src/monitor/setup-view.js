// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { hex } from './memory-sampler.js';
import { graphicsLayout, spriteLayout, spritePixels, characterPixels, screenPixels } from './setup-model.js';

export function createSetupView(root, inspectAddress, showCode, showSid) {
  root.innerHTML = `
    <div class="monitor-section-head"><h2>Machine setup</h2><span class="monitor-tag" data-setup="sample">Current sample</span></div>
    <div class="monitor-chip-flow"><button type="button" class="monitor-chip" data-setup="cpu"><b>6510</b><span data-setup="pc"></span></button><span aria-hidden="true">↔</span><div class="monitor-chip"><b>VIC-II</b><span data-setup="bank"></span></div><span aria-hidden="true">→</span><div class="monitor-chip"><b>Display</b><span data-setup="mode"></span></div></div>
    <div class="monitor-graphics-grid">
      <button type="button" class="monitor-graphic" data-setup="screen-link"><span>Screen memory <b data-setup="screen-address"></b></span><canvas width="320" height="200" data-setup="screen" aria-label="Screen memory reconstructed with current graphics settings"></canvas></button>
      <button type="button" class="monitor-graphic" data-setup="chars-link"><span>Character set <b data-setup="chars-address"></b></span><canvas width="128" height="128" data-setup="characters" aria-label="Configured character patterns"></canvas></button>
    </div>
    <div class="monitor-graphics-settings"><span><i data-setup="border-colour"></i>Border</span><span><i data-setup="background-colour"></i>Background</span><span data-setup="scroll" title="Horizontal and vertical fine scroll"></span><button type="button" class="btn" data-setup="bitmap-link" hidden></button></div>
    <div class="monitor-section-head"><h3>Sprites <span data-setup="sprite-count"></span></h3><select data-setup="pointer-mode" aria-label="Sprite pointer source"><option value="configured">Configured pointers</option><option value="latched">Last fetched pointers</option></select></div>
    <div class="monitor-sprite-grid" data-setup="sprites"></div>
    <details class="monitor-help"><summary>Sprite positions</summary><canvas class="monitor-position-map" data-setup="positions" width="512" height="312" aria-label="Enabled sprite bounds in VIC coordinates, not frame history"></canvas></details>
    <div class="monitor-section-head"><button type="button" class="btn" data-setup="sid-link">SID voices ↗</button><span class="monitor-tag">Register settings</span></div><div class="monitor-voices" data-setup="voices"></div>
    <details class="monitor-help"><summary>Reading this setup</summary><p>Screen and character previews use the VIC memory map, including character ROM and cartridge windows. The screen preview reconstructs the current setup without sprites, scrolling or mid-frame changes. It is not a replay of the displayed frame.</p><p>Configured sprite pointers come from the selected screen's final eight bytes. Last fetched pointers use the VIC's latched bank and offset. Both previews read the source memory as it is now. Enabled is a register setting, not proof that a sprite was visible throughout the frame.</p><p>SID bars show frequency and ADSR settings, not measured audio levels. CPU location is sampled, not an execution trace.</p></details>`;
  const el = name => root.querySelector(`[data-setup="${name}"]`);
  let facade = null, state = null, layout = null;
  const bankBytes = new Uint8Array(16384), spriteData = new Uint8Array(63);
  const screenCtx = el('screen').getContext('2d'), charCtx = el('characters').getContext('2d');
  const screenImage = screenCtx.createImageData(320, 200), charImage = charCtx.createImageData(128, 128);
  const positionCtx = el('positions').getContext('2d');
  const sprites = [], voices = [];
  let themeInk = '', themeBg = '', themeGrid = '';
  function theme() {
    const style = getComputedStyle(root);
    themeInk = style.getPropertyValue('--text').trim(); themeBg = style.getPropertyValue('--ui-bg').trim(); themeGrid = style.getPropertyValue('--border').trim();
  }
  for (let index = 0; index < 8; index++) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'monitor-sprite';
    button.innerHTML = `<span class="monitor-sprite-head"><b>${index}</b><i class="monitor-led"></i></span><canvas width="24" height="21"></canvas><code></code><small></small>`;
    const ctx = button.querySelector('canvas').getContext('2d');
    const item = { button, ctx, image: ctx.createImageData(24, 21), address: button.querySelector('code'), flags: button.querySelector('small'), info: null };
    button.addEventListener('click', () => { if (item.info) inspectAddress(item.info.address, 'sprites', item.info.bank, item.info.offset); });
    sprites.push(item); el('sprites').append(button);
  }
  for (let index = 0; index < 6; index++) {
    const card = document.createElement('div'); card.className = 'monitor-voice';
    card.innerHTML = `<div class="monitor-section-head"><b>Voice ${index % 3 + 1}${index >= 3 ? ' / SID 2' : ''}</b><i class="monitor-led"></i></div><meter min="0" max="65535" value="0" aria-label="Frequency register"></meter><span class="monitor-wave-label"></span><div class="monitor-adsr"></div>`;
    const bars = [];
    for (const name of ['A', 'D', 'S', 'R']) {
      const bar = document.createElement('span'); bar.innerHTML = `<i></i><small>${name}</small>`; card.querySelector('.monitor-adsr').append(bar); bars.push(bar);
    }
    voices.push({ card, frequency: card.querySelector('meter'), wave: card.querySelector('.monitor-wave-label'), bars }); el('voices').append(card);
  }
  el('bitmap-link').addEventListener('click', () => { if (layout) inspectAddress(layout.bank + layout.bitmap, 'tiles', layout.bank); });
  el('sid-link').addEventListener('click', showSid);
  el('cpu').addEventListener('click', showCode);
  el('screen-link').addEventListener('click', () => { if (layout) inspectAddress(layout.bank + layout.screen, 'upper', layout.bank, layout.screen); });
  el('chars-link').addEventListener('click', () => { if (layout) inspectAddress(layout.bank + layout.characters, 'tiles', layout.bank, layout.characters); });
  el('pointer-mode').addEventListener('change', () => { if (facade) update(facade); });

  function update(current, render = true) {
    if (current !== facade) { facade = current; state = facade.createInspectionState(); theme(); }
    facade.inspectInto(state);
    if (!render) return state;
    facade.copyVicMemory(0, bankBytes, state.vicBank);
    layout = graphicsLayout(state);
    el('sample').textContent = `Raster ${state.raster} · cycle ${state.cycle}`;
    for (const [name, register] of [['border', 0x20], ['background', 0x21]]) {
      const colour = state.vic[register] & 15;
      el(name + '-colour').style.backgroundColor = '#' + state.palette[colour].toString(16).padStart(6, '0');
      el(name + '-colour').title = `Colour ${colour}`;
    }
    el('scroll').textContent = `↔ ${state.vic[0x16] & 7}  ↕ ${state.vic[0x11] & 7}`;
    el('bitmap-link').hidden = !layout.bitmapOn;
    el('bitmap-link').textContent = `Bitmap $${hex(layout.bank + layout.bitmap)}`;
    el('pc').textContent = `PC $${hex(state.pc)}`;
    el('bank').textContent = `Bank $${hex(layout.bank)}`;
    el('mode').textContent = `${layout.bitmapOn ? 'Bitmap' : 'Text'}${layout.multicolour ? ' · multicolour' : ''}${layout.extended ? ' · ECM' : ''}`;
    el('screen-address').textContent = `$${hex(layout.bank + layout.screen)}`;
    el('chars-address').textContent = `$${hex(layout.bank + layout.characters)}`;
    el('chars-link').title = facade.vicMemorySource(layout.characters, layout.bank);
    characterPixels(charImage.data, bankBytes, state); charCtx.putImageData(charImage, 0, 0);
    screenPixels(screenImage.data, bankBytes, state); screenCtx.putImageData(screenImage, 0, 0);
    const latched = el('pointer-mode').value === 'latched';
    let enabled = 0;
    positionCtx.fillStyle = themeBg; positionCtx.fillRect(0, 0, 512, 312);
    positionCtx.strokeStyle = themeGrid; positionCtx.lineWidth = 1;
    for (let x = 0; x <= 512; x += 64) { positionCtx.beginPath(); positionCtx.moveTo(x, 0); positionCtx.lineTo(x, 312); positionCtx.stroke(); }
    for (let y = 0; y <= 312; y += 39) { positionCtx.beginPath(); positionCtx.moveTo(0, y); positionCtx.lineTo(512, y); positionCtx.stroke(); }
    positionCtx.font = '12px monospace';
    for (let index = 0; index < 8; index++) {
      const item = sprites[index], sprite = spriteLayout(state, bankBytes, index, latched); item.info = sprite;
      facade.copyVicMemory(sprite.offset, spriteData, sprite.bank);
      spritePixels(item.image.data, spriteData, sprite, state); item.ctx.putImageData(item.image, 0, 0);
      item.button.classList.toggle('is-enabled', sprite.enabled);
      item.address.textContent = `$${hex(sprite.pointer, 2)} → $${hex(sprite.address)}`;
      item.flags.textContent = `${sprite.multicolour ? 'MC' : 'HI'} · ${sprite.width}×${sprite.height}`;
      const source = facade.vicMemorySource(sprite.offset, sprite.bank);
      item.button.setAttribute('aria-label', `Sprite ${index}, ${sprite.enabled ? 'enabled' : 'disabled'}, pointer $${hex(sprite.pointer, 2)}, ${source} $${hex(sprite.address)}, X ${sprite.x}, Y ${sprite.y}`);
      item.button.title = `${latched ? 'Latched' : `$${hex(sprite.pointerAddress)}`} → $${hex(sprite.pointer, 2)} × 64 → ${source} $${hex(sprite.address)} · X ${sprite.x}, Y ${sprite.y}${sprite.dma ? ' · DMA' : ''}${sprite.behind ? ' · behind graphics' : ''}`;
      if (sprite.enabled) {
        enabled++;
        positionCtx.strokeStyle = themeInk; positionCtx.strokeRect(sprite.x, sprite.y, sprite.width, sprite.height);
        positionCtx.fillStyle = themeInk; positionCtx.fillText(String(index), sprite.x + 3, sprite.y + 13);
      }
    }
    el('sprite-count').textContent = `${enabled} / 8 enabled`;
    for (let index = 0; index < 6; index++) {
      const item = voices[index], base = ((index / 3) | 0) * 32 + (index % 3) * 7;
      item.card.hidden = index >= state.sidCount * 3;
      const control = state.sid[base + 4], frequency = state.sid[base] | (state.sid[base + 1] << 8);
      item.card.classList.toggle('is-enabled', !!(control & 1)); item.frequency.value = frequency;
      item.frequency.title = `${(frequency * 985248 / 16777216).toFixed(1)} Hz oscillator setting`;
      item.wave.textContent = `${control & 16 ? '△ ' : ''}${control & 32 ? '╱ ' : ''}${control & 64 ? '⊓ ' : ''}${control & 128 ? 'Noise ' : ''}` || 'No waveform';
      const ad = state.sid[base + 5], sr = state.sid[base + 6];
      for (let part = 0; part < 4; part++) {
        const value = part === 0 ? ad >>> 4 : part === 1 ? ad & 15 : part === 2 ? sr >>> 4 : sr & 15;
        item.bars[part].firstElementChild.style.height = `${value / 15 * 100}%`; item.bars[part].title = `${'ADSR'[part]}: ${value}`;
      }
    }
    return state;
  }
  return { update, theme, get state() { return state; } };
}
