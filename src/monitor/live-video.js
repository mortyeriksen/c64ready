// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { borderComparators } from './border-rules.js';

export const LIVE_VIDEO_FRAME = Object.freeze({ width: 384, height: 272, firstRaster: 15, lines: 312 });

// Enable writes can turn sprites off again before the next UI sample.
export function capturedSpriteEnables(frame) {
  const registers = frame?.analysis?.initial?.registers;
  if (!registers) return null;
  let mask = registers[0x15];
  for (let i = 0; i < frame.eventCount; i++) {
    if (frame.eventKind[i] === 0x15) mask |= frame.eventValue[i];
  }
  return mask & 255;
}

// Static register configuration, not the current border flip-flops or pixels.
export function liveVideoSetup(state) {
  const r = state.vic, compare = borderComparators(r[0x11], r[0x16]);
  const bitmap = !!(r[0x11] & 32), multicolour = !!(r[0x16] & 16);
  const invalid = !!(r[0x11] & 64) && (bitmap || multicolour);
  return {
    x: compare.left + 8, y: compare.top - LIVE_VIDEO_FRAME.firstRaster,
    width: compare.right - compare.left, height: compare.bottom - compare.top,
    top: compare.top, enabled: compare.den, bitmap, multicolour, invalid,
    texture: !compare.den || invalid ? 'none' : bitmap ? 'bitmap' : 'characters',
    scrollX: r[0x16] & 7, scrollY: r[0x11] & 7,
    sprites: r[0x15], border: r[0x20] & 15, background: r[0x21] & 15,
  };
}

let nextId = 0;

export function createLiveVideoView(root) {
  const id = `monitor-live-video-${++nextId}`;
  root.classList.add('monitor-live-video');
  root.innerHTML = `<div class="monitor-live-video-stack">
    <div class="monitor-live-video-screen"><svg viewBox="0 0 384 272" role="img" data-video-live="screen">
      <defs><pattern id="${id}-characters" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0H8V8" fill="none" stroke="currentColor" stroke-width="1" opacity=".2"/></pattern>
      <pattern id="${id}-bitmap" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M0 0h8v8H0zM8 8h8v8H8z" fill="currentColor" opacity=".16"/></pattern></defs>
      <rect width="384" height="272" data-video-live="border"/>
      <g data-video-live="display"><rect data-video-live="window"/><rect data-video-live="texture"/>
      <rect data-video-live="scroll-guide" class="monitor-live-video-scroll-guide"/></g>
    </svg><span class="monitor-live-video-label" data-video-live="caption">Configured window</span></div>
    <div><span class="monitor-live-video-label">SPRITE SLOTS</span><div class="monitor-live-video-slots">${Array.from({length:8},(_,i)=>`<span role="img" data-video-slot="${i}">${i}</span>`).join('')}</div></div>
    <div><span class="monitor-live-video-label">FINE SCROLL</span><div class="monitor-live-video-scroll"><span class="monitor-live-video-arrows" aria-hidden="true">↔<span>↕</span></span><span data-video-live="scroll"></span></div>
    <div class="monitor-live-video-colours"><i role="img" data-video-live="border-colour"></i><i role="img" data-video-live="background-colour"></i></div>
    </div>
  </div>`;
  const elements = Object.fromEntries([...root.querySelectorAll('[data-video-live]')].map(el => [el.dataset.videoLive,el]));
  const slots = [...root.querySelectorAll('[data-video-slot]')];
  const attr = (name, key, value) => elements[name].setAttribute(key, value);
  const rect = (name, x, y, width, height) => { attr(name,'x',x); attr(name,'y',y); attr(name,'width',width); attr(name,'height',height); };
  elements['scroll-guide'].setAttribute('aria-hidden','true');
  return {
    update(state, capturedSprites = null) {
      const view = liveVideoSetup(state);
      const colour = index => `#${state.palette[index].toString(16).padStart(6,'0')}`;
      attr('border','fill',colour(view.border)); attr('window','fill',colour(view.background));
      for (const name of ['window','texture']) rect(name,view.x,view.y,view.width,view.height);
      rect('scroll-guide',view.x+view.scrollX,view.y+view.scrollY,view.width-8,view.height-8);
      attr('texture','fill',view.texture === 'none' ? 'none' : `url(#${id}-${view.texture})`);
      elements.display.style.display = view.enabled ? '' : 'none';
      elements.caption.textContent = !view.enabled ? 'Display enable off' : view.invalid ? 'Invalid mode · setup' : 'Configured window';
      attr('screen','aria-label',`Schematic video setup: ${view.enabled?'display enabled':'display enable off'}, ${view.width} by ${view.height} configured pixels. Texture is illustrative, not program artwork.`);
      elements['scroll-guide'].style.display = view.invalid ? 'none' : '';
      for (let i=0;i<8;i++) {
        const enabled = !!((capturedSprites ?? view.sprites) & (1<<i));
        const scope = capturedSprites === null ? 'at this sample' : 'during the captured frame';
        slots[i].classList.toggle('is-enabled',enabled);
        slots[i].setAttribute('aria-label',`Sprite ${i}: ${enabled?'enabled':'not enabled'} ${scope}`);
        slots[i].title = `Sprite ${i} ${enabled?'enabled':'not enabled'} ${scope}. Enable bits do not prove visible pixels.`;
      }
      elements.scroll.textContent = `X ${view.scrollX} · Y ${view.scrollY}`;
      elements.scroll.title = 'Fine-scroll settings. The inset guide illustrates offsets, not measured screen movement.';
      for (const name of ['border','background']) {
        elements[`${name}-colour`].style.backgroundColor = colour(view[name]);
        elements[`${name}-colour`].setAttribute('aria-label',`${name === 'border'?'Border':'Background'} colour ${view[name]}`);
        elements[`${name}-colour`].title = `${name === 'border'?'Border':'Background'} colour ${view[name]}`;
      }

    },
  };
}
