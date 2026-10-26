// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { createVideoInspector } from './video-inspector.js';
import { createPixelLens } from './pixel-lens.js';
import { picturePoint } from './learn-model.js';
import { captureLabel } from './capture-context.js';
import { drawSpritePreviews } from './sprite-preview.js';
import { traceSpriteOutlines, drawSpriteOutlines } from './sprite-outline.js';
import { hex } from './memory-sampler.js';

export function createFrameView(root, openCode = () => {}, openMemory = () => {}, { onReplay = () => {} } = {}) {
  root.innerHTML = `<div class="monitor-section-head monitor-video-heading monitor-page-head"><p class="monitor-page-intro">Explore the picture. Follow it back to the machine.</p></div>
    <p class="monitor-tag" data-frame="status" role="status"></p>
    <div class="monitor-video-work"><div class="monitor-video-stage">
      <div class="monitor-video-stage-head"><span>Hover to magnify · click a pixel to explain it · arrow keys and Enter also work</span><div class="monitor-frame-layers" role="group" aria-label="Picture layers"><label><input type="checkbox" data-frame="border"> Border mask</label><label><input type="checkbox" data-frame="bad"> Bad lines</label><label><input type="checkbox" data-frame="sprites"> Sprite coverage</label><label><input type="checkbox" data-frame="events"> Events</label><label><input type="checkbox" data-frame="reveal"> Reveal scan</label></div></div>
      <div class="monitor-frame-visual"><canvas class="monitor-frame-picture" data-frame="picture" width="504" height="312" tabindex="0" role="img" aria-label="Captured picture. Click a pixel, or use arrow keys and Enter to explain a pixel."></canvas></div>
      <div class="monitor-frame-controls"><button class="btn" data-frame="play" disabled>Play replay</button><button class="btn" data-frame="back" aria-label="Previous raster line" disabled>‹</button><input class="monitor-frame-seek" data-frame="seek" type="range" min="0" max="19655" value="0" disabled aria-label="Replay cycle within captured frame"><button class="btn" data-frame="line" aria-label="Next raster line" disabled>›</button><details class="monitor-video-steps"><summary>Step & speed</summary><div><button class="btn" data-frame="cycle" disabled>+ Cycle</button><button class="btn" data-frame="event" disabled>Next event</button><select data-frame="speed" aria-label="Replay speed"><option value="500">Slow</option><option value="2000" selected>Normal</option><option value="8000">Fast</option></select></div></details></div>
      <div class="monitor-section-head monitor-video-position"><b data-frame="position">No frame captured</b><span class="monitor-tag" data-frame="gates"></span></div>
      <div class="monitor-video-timing"><div class="monitor-frame-key">${['H border','V border','Screen fetch','VIC owns bus','IRQ'].map(name=>`<button type="button" data-timing-topic="${name==='H border'||name==='V border'?'border':'timing'}">${name}</button>`).join('')}</div><canvas class="monitor-frame-timing" data-frame="timing" width="630" height="110" tabindex="0" role="img" aria-label="Selected raster line: H border, V border, Screen fetch, VIC owns bus and IRQ. Click a cycle or use arrow keys."></canvas></div>
    </div><aside class="monitor-video-inspector" data-frame="inspector" aria-label="Explanation of the selected picture or cycle"></aside></div>
    <div class="monitor-video-footer"><details class="monitor-help"><summary>How to use Video</summary><p><b>Pause</b> to keep the current recording. Complete frames refresh automatically while the C64 runs.</p><p><b>Click the picture</b> to explain a pixel beside it. Choose Sprites in the inspector to explore its eight slots.</p><p><b>Move along the timeline</b> or click a timing row to inspect that cycle. Replay never seeks the program or advances a paused machine.</p></details><details class="monitor-help"><summary>Evidence & limits</summary><p>Bright pink outlines mark recorded sprite coverage and can include pixels hidden behind foreground graphics. Pointers and banks are sampled at line end. Related writes are evidence, not proof of what caused a visible effect.</p><p>Reveal scan uncovers final pixels for orientation, not sub-cycle rendering. The timing canvas includes margins outside the visible picture. Renderer-source samples are distinct from timed bus fetches. Unsupported cases are reported explicitly.</p></details></div>`;
  const el = name => root.querySelector(`[data-frame="${name}"]`);
  const inspector = createVideoInspector(el('inspector'), { seek: position => seek(position), selectSprite: value => { selectedSprite=value; el('sprites').checked=value>=0; rebuild(); draw(); }, openMemory, openCode });
  const picture = el('picture').getContext('2d'), timing = el('timing').getContext('2d');
  const base = document.createElement('canvas'); base.width = 504; base.height = 312;
  const baseCtx = base.getContext('2d');
  const pixels = document.createElement('canvas'); pixels.width = 384; pixels.height = 272;
  const pixelCtx = pixels.getContext('2d');
  let selectedSprite = -1, spriteOutlines = [], paintPending = false;
  let keyboardPixel = {x:160,y:100};
  let facade = null, frame = null, playing = false, tick = 0, lastTime = 0, active = false;
  const lens = createPixelLens(el('picture'), pixels, () => frame);
  let ink, dim, bg, accent, green;
  const slots = [];
  for (let s = 0; s < 8; s++) {
    const slot = document.createElement('button'); slot.type = 'button'; slot.setAttribute('aria-pressed', 'false');
    slot.addEventListener('click', () => { selectedSprite = selectedSprite === s ? -1 : s; el('sprites').checked = selectedSprite >= 0; inspector.sprite(selectedSprite); rebuild(); draw(); }); slot.innerHTML = `<b>${s}</b><canvas width="96" height="84" aria-label="Recorded coverage for sprite ${s}"></canvas><code></code><i class="monitor-led"></i>`;
    slots.push(slot); el('slots').append(slot);
  }
  function theme() {
    if(root.hidden)return;
    const style = getComputedStyle(root);
    ink = style.getPropertyValue('--text').trim(); dim = style.getPropertyValue('--dim').trim();
    bg = style.getPropertyValue('--ui-bg').trim(); accent = style.getPropertyValue('--accent').trim(); green = style.getPropertyValue('--green').trim();
    rebuild(); draw();
  }
  function controls() {
    for (const name of ['play', 'back', 'line', 'cycle', 'event', 'seek']) el(name).disabled = !frame;
    el('play').textContent = playing ? 'Pause replay' : 'Play replay';
  }
  function rebuild() {
    baseCtx.fillStyle = bg || '#000'; baseCtx.fillRect(0, 0, 504, 312);
    if (!frame) return;
    baseCtx.drawImage(pixels, 80, frame.rasterOffset);
    if (el('border').checked) {
      baseCtx.globalAlpha = 0.5;
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const index = y * frame.width + x;
          if (frame.border[index]) {
            baseCtx.fillStyle = accent; baseCtx.fillRect(x + 80, y + frame.rasterOffset, 1, 1);
          }
        }
      }
      baseCtx.globalAlpha = 1;
    }
    for (let line = 0; line < frame.lines; line++) {
      let bad = false;
      for (let c = 0; c < 63; c++) if (frame.flags[line * 63 + c] & 4) bad = true;
      if (bad && el('bad').checked) {
        baseCtx.fillStyle = accent; baseCtx.fillRect(0, line, 72, 1);
        baseCtx.globalAlpha = 0.16; baseCtx.fillRect(80, line, 384, 1); baseCtx.globalAlpha = 1;
      }
    }
    if (el('events').checked) {
      for (let i = 0; i < frame.eventCount; i++) {
        const t = frame.eventTick[i];
        baseCtx.fillStyle = frame.eventKind[i] === 64 ? green : ink;
        baseCtx.fillRect((t % 63) * 8, Math.floor(t / 63), 3, 1);
      }
    }
    baseCtx.strokeStyle = dim; baseCtx.strokeRect(80.5, 15.5, 383, 271);
    if (el('sprites').checked) drawSpriteOutlines(baseCtx,spriteOutlines,selectedSprite,frame.width,frame.height,frame.rasterOffset);
  }
  function draw() {
    picture.drawImage(base, 0, 0);
    timing.fillStyle = bg || '#000'; timing.fillRect(0, 0, 630, 110);
    if (!frame) return;
    const cursor = Math.floor(tick), line = Math.floor(cursor / 63), cycle = cursor % 63;
    if (el('reveal').checked) {
      picture.fillStyle = bg; picture.globalAlpha = 0.88;
      picture.fillRect(0, line + 1, 504, 312 - line - 1);
      picture.fillRect((cycle + 1) * 8, line, 504 - (cycle + 1) * 8, 1); picture.globalAlpha = 1;
    }
    picture.strokeStyle = ink; picture.lineWidth = 0.6;
    picture.beginPath(); picture.moveTo(0, line + 0.5); picture.lineTo(504, line + 0.5); picture.stroke();
    picture.fillStyle = ink; picture.fillRect(cycle * 8, Math.max(0, line - 2), 8, 5);
    const flags = frame.flags[cursor];
    el('position').textContent = `Raster ${line} / 311 · cycle ${cycle + 1} / 63`;
    inspector.position(cursor);
    el('gates').textContent = `H ${flags & 1 ? 'closed' : 'open'} · V ${flags & 2 ? 'closed' : 'open'}${flags & 4 ? ' · Bad line' : ''}`;
    el('seek').value = cursor;
    el('seek').setAttribute('aria-valuetext', `Raster ${line}, cycle ${cycle + 1}`);
    for (let row = 0; row < 5; row++) {
      const bit = [1, 2, 8, 32, 64][row];
      for (let c = 0; c < 63; c++) {
        timing.fillStyle = frame.flags[line * 63 + c] & bit ? (row === 4 ? green : accent) : dim;
        timing.globalAlpha = frame.flags[line * 63 + c] & bit ? 1 : 0.12;
        timing.fillRect(c * 10, row * 22, 9, 18);
      }
    }
    timing.globalAlpha = 1; timing.strokeStyle = ink; timing.strokeRect(cycle * 10 + 0.5, 0.5, 9, 108);
    for (let s = 0; s < 8; s++) {
      const offset = line * 8 + s, address = frame.spriteBanks[offset] + frame.pointers[offset] * 64;
      slots[s].setAttribute('aria-pressed', String(selectedSprite === s));
      slots[s].setAttribute('aria-label', `Highlight captured sprite ${s}`);
      slots[s].classList.toggle('is-enabled', !!(frame.spriteDma[line] & (1 << s)));
      slots[s].querySelector('code').textContent = `$${hex(frame.pointers[offset], 2)}`;
      slots[s].title = `Sprite ${s}: pointer $${hex(frame.pointers[offset], 2)} → $${hex(address)}, DMA ${frame.spriteDma[line] & (1 << s) ? 'on' : 'off'} at line end`;
    }
  }
  function seek(position) {
    playing=false; tick=Math.max(0,Math.min(19655,Math.floor(position))); controls(); draw();
  }
  function inspectPixel(point) {
    if(!frame)return;
    keyboardPixel=point;
    seek((point.y+frame.rasterOffset)*63+Math.floor((point.x+80)/8));
    inspector.pixel(point.x,point.y);
  }
  el('picture').addEventListener('click',event=>{
    if(!frame)return;
    const b=el('picture').getBoundingClientRect(),p=picturePoint(event.clientX-b.left,event.clientY-b.top,b.width,b.height,504,312);
    if(p&&p.x>=80&&p.x<464&&p.y>=frame.rasterOffset&&p.y<frame.rasterOffset+frame.height)inspectPixel({x:p.x-80,y:p.y-frame.rasterOffset});
  });
  el('picture').addEventListener('keydown',event=>{
    if(!frame)return;
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(delta){event.preventDefault();inspectPixel({x:Math.max(0,Math.min(383,keyboardPixel.x+delta[0])),y:Math.max(0,Math.min(271,keyboardPixel.y+delta[1]))});}
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();inspectPixel(keyboardPixel);}
  });
  el('timing').addEventListener('click',event=>{
    if(!frame)return;const b=el('timing').getBoundingClientRect();const cycle=Math.max(0,Math.min(62,Math.floor((event.clientX-b.left)/b.width*63)));
    seek(Math.floor(tick/63)*63+cycle);inspector.topic('timing');
  });
  el('timing').addEventListener('keydown',event=>{if(frame&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();seek(tick+(event.key==='ArrowLeft'?-1:1));inspector.topic('timing');}});
  for(const button of root.querySelectorAll('[data-timing-topic]'))button.addEventListener('click',()=>{inspector.topic(button.dataset.timingTopic);});
  el('play').addEventListener('click', () => { if (!playing) onReplay(); if (tick >= 19655) tick = 0; playing = !playing; lastTime = performance.now(); controls(); draw(); });
  for (const [name, delta] of [['back', -63], ['line', 63], ['cycle', 1]]) el(name).addEventListener('click', () => {
    seek(tick+delta);
  });
  el('event').addEventListener('click', () => {
    if (!frame?.eventCount) return;
    playing = false;
    let next = 0;
    for (let i = 0; i < frame.eventCount; i++) if (frame.eventTick[i] > tick) { next = i; break; }
    tick = frame.eventTick[next]; controls(); draw();
  });
  el('seek').addEventListener('input', () => seek(Number(el('seek').value)));
  for (const name of ['border', 'bad', 'sprites', 'events', 'reveal']) el(name).addEventListener('change', () => { rebuild(); draw(); });
  function update(current, paused) {
    if (!active || facade !== current) {
      if (facade !== current) { frame = null; spriteOutlines = []; tick = 0; }
      facade = current; active = true;
      if(!paintPending) { theme(); controls(); inspector.refresh(); }
    }
    paintFrame();
    const status = facade.vicFrameCaptureStatus();
    el('status').textContent = frame
      ? `${captureLabel(frame)} · ${frame.eventCount} events${frame.overflow ? ' · event buffer full' : ''} · ${paused?'paused · recording held':'refreshes every second · Pause to inspect'}`
      : paused ? 'No complete frame was recorded before Pause. Resume to record one.'
      : status === 'waiting' || status === 'recording' ? 'Recording a complete frame…' : 'Waiting for the shared recording…';
    if (playing && frame) {
      const now = performance.now(); tick = Math.min(19655, tick + Math.min(now - lastTime, 250) * Number(el('speed').value) / 1000); lastTime = now;
      if (tick >= 19655) { playing = false; controls(); } draw();
    }
  }
  function accept(current, captured, position) {
    const reset = facade !== current || !frame;
    if (reset) selectedSprite = -1;
    if (facade !== current) facade?.cancelVicFrameCapture();
    lens.hide();
    facade = current; frame = captured; tick = Math.max(0,Math.min(19655,Math.floor(position ?? (reset ? 0 : tick)))); playing = false;
    inspector.setFrame(frame, { reset, position: tick });
    spriteOutlines = [];
    paintPending = true;
    paintFrame();
  }
  function paintFrame() {
    if(!paintPending||root.hidden||!frame)return;
    paintPending=false;
    spriteOutlines = Array.from({length:8}, () => new Path2D());
    traceSpriteOutlines(frame,spriteOutlines);
    const image = pixelCtx.createImageData(frame.width, frame.height);
    image.data.set(frame.rgba); pixelCtx.putImageData(image, 0, 0);
    drawSpritePreviews(frame, slots.map(slot => slot.querySelector('canvas')));
    controls(); theme();
  }
  function deactivate(clear = false) {
    lens.hide();
    if (!clear) inspector.clearSprite();
    active = false; playing = false;
    if (clear) {
      paintPending=false; facade = null; frame = null; tick=0; selectedSprite = -1; spriteOutlines = []; inspector.setFrame(null);
      el('position').textContent='No frame captured';el('gates').textContent='';el('seek').value=0;
    }
    controls();
  }
  return { update, deactivate, theme, accept, inspect(current,captured,position) { onReplay(); accept(current,captured,position); }, get frame() { return frame; } };
}
