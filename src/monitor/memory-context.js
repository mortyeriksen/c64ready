// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { hex, regionHint } from './memory-sampler.js';
import { memoryRegions, rolesForPage, byteSummary } from './memory-model.js';
import { screenPixels, characterPixels, spritePixels, spriteLayout } from './setup-model.js';

export function createMemoryContext(root, shortcuts, cells, navigate) {
  root.innerHTML = `<div class="monitor-memory-story"><h3 data-memory="title"></h3><p data-memory="meaning"></p></div><div class="monitor-memory-visual"><canvas data-memory="visual" width="256" height="256"></canvas></div><p class="monitor-note" data-memory="caption"></p><div class="monitor-memory-facts" data-memory="facts"></div><div class="monitor-memory-links" data-memory="links"></div>`;
  const el = name => root.querySelector(`[data-memory="${name}"]`);
  const canvas = el('visual'), ctx = canvas.getContext('2d');
  const vicMemory = new Uint8Array(16384), pageBytes = new Uint8Array(256);
  let facade, state, sampler, regions = [], page = 4, bank = null, last = -Infinity;
  let image, graphicsSource;
  const button = (label, action) => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'monitor-help-trigger'; node.textContent = label; node.addEventListener('click', action); return node;
  };
  const videoLink=button('Explore the captured picture in Video →',()=>navigate('video'));
  const codeLink=button('Explain the program in Code →',()=>navigate('code',state.pc));
  const vicLink=button('View the source actually read by the VIC →',()=>navigate('vic',graphicsSource.start,state.vicBank));
  el('links').append(videoLink,codeLink,vicLink);
  const jumpButtons=new Map();
  const fact = (label, value) => { const row = document.createElement('div'), term = document.createElement('span'), data = document.createElement('b'); term.textContent = label; data.textContent = value; row.append(term,data); el('facts').append(row); };
  function pixels(width, height) {
    if (canvas.width !== width || canvas.height !== height || !image) { canvas.width = width; canvas.height = height; image = ctx.createImageData(width,height); }
    return image.data;
  }
  function render() {
    if (!facade || !state) return;
    const start = page << 8, roles = rolesForPage(regions,page);
    if (bank === null) pageBytes.set(sampler.bytes.subarray(start,start+256));
    else facade.copyVicMemory(start & 0x3fff,pageBytes,bank);
    const summary = byteSummary(pageBytes), cpu = facade.cpuMemorySource(start), source = facade.vicMemorySource(start & 0x3fff,bank ?? state.vicBank);
    const graphics = roles.find(r => ['screen','bitmap','characters','sprite'].includes(r.kind));
    graphicsSource=graphics;
    const showGraphics = graphics && (bank === null || bank === state.vicBank) && (source === 'RAM' || bank !== null);
    el('title').textContent = roles.length ? roles.map(r=>r.title).join(' · ') : 'Working memory: purpose unknown';
    el('meaning').textContent = roles.length ? regionHint(page) : 'No current video setting identifies this page. These bytes could be code, data or workspace.';
    el('facts').replaceChildren(); videoLink.hidden=true; codeLink.hidden=true; vicLink.hidden=true;
    if (showGraphics) {
      if (graphics.kind === 'characters') {
        characterPixels(pixels(128,128),vicMemory,state);
        el('meaning').textContent = 'The VIC-II selects character shapes from this configured set. Each shape uses eight bytes, one byte per row.';
        el('caption').textContent = 'Full configured set, shown as monochrome patterns. Outlines mark this page’s characters.';
      } else if (graphics.kind === 'sprite') {
        const sprite = spriteLayout(state,vicMemory,graphics.index);
        spritePixels(pixels(24,21),vicMemory.subarray(sprite.offset,sprite.offset+63),sprite,state);
        el('meaning').textContent = `Sprite ${graphics.index} points here through $${hex(sprite.pointerAddress)}. Its 63 image bytes describe a 24 × 21 pixel shape.`;
        el('caption').textContent = 'Snapshot pointer and colours. Expansion, priority and mid-frame changes are not applied.';
        fact('Pointer',`$${hex(sprite.pointer,2)} × 64 + bank $${hex(state.vicBank)}`);
      } else {
        screenPixels(pixels(320,200),vicMemory,state);
        el('meaning').textContent = graphics.kind === 'screen' ? 'These cells tell the VIC-II which characters or bitmap colours to use. They are not themselves a picture.' : 'These bytes supply the pixel patterns for the configured bitmap.';
        el('caption').textContent = 'Reconstructed from snapshot settings, not a recorded frame. Outlines mark cells supplied by this page.';
      }
      ctx.putImageData(image,0,0);
      const style=getComputedStyle(root); ctx.strokeStyle=style.getPropertyValue('--accent').trim(); ctx.lineWidth=1;
      if (graphics.kind !== 'sprite') {
        const stride=graphics.kind==='screen'?1:8, columns=graphics.kind==='characters'?16:40;
        const first=Math.max(0,Math.floor((start-graphics.start)/stride)), end=Math.min(graphics.size/stride,Math.ceil((start+256-graphics.start)/stride));
        for(let i=first;i<end;) {
          const count=Math.min(columns-i%columns,end-i);
          ctx.strokeRect((i%columns)*8+.5,Math.floor(i/columns)*8+.5,count*8-1,7);
          i+=count;
        }
      }
      videoLink.hidden=false;
    } else {
      pixels(256,256);
      const style=getComputedStyle(root), ink=style.getPropertyValue('--accent').trim(), quiet=style.getPropertyValue('--control-bg').trim();
      ctx.fillStyle=quiet; ctx.fillRect(0,0,256,256); ctx.fillStyle=ink;
      for(let i=0;i<256;i++) { ctx.globalAlpha=.08+pageBytes[i]/255*.92; ctx.fillRect((i%16)*16+1,Math.floor(i/16)*16+1,14,14); }
      ctx.globalAlpha=1;
      el('caption').textContent = '256 byte values, read left to right. Dark = $00, bright = $FF. This is a byte map, not decoded graphics.';
      if (graphics && source !== 'RAM') { el('meaning').textContent = `The VIC-II selects ${source} here. This map shows the underlying RAM instead. Open the VIC source to see the configured graphics.`; vicLink.hidden=false; }
      if (roles.some(r=>r.kind==='stack')) {
        el('meaning').textContent = 'The CPU uses this page for temporary values and return addresses. The stack grows toward lower addresses.';
        fact('Next stack push',`$${hex(0x100+state.sp)}`);
      }
    }
    if (roles.some(r=>r.kind==='code')) {
      if(!graphics) el('meaning').textContent = facade.cpuMemorySource(state.pc)==='RAM' ? 'The sampled program counter points into this page. This does not prove every byte is code.' : `The CPU reads ${facade.cpuMemorySource(state.pc)} at its current location. The underlying RAM shown here is separate data.`;
      fact('CPU location',`$${hex(state.pc)} · ${facade.cpuMemorySource(state.pc)}`);
      codeLink.hidden=false;
    }
    fact(bank===null?'CPU reads at page start':'VIC reads selected bank',bank===null?cpu:source);
    fact('Different byte values',`${summary.distinct} / 256`);
    fact('Changed in latest RAM sample',`${sampler.pages[page]} / 256 bytes`);
    if (graphics) fact('Configured range',`$${hex(graphics.start)}–$${hex(graphics.start+graphics.size-1)}`);
    canvas.setAttribute('aria-label',el('caption').textContent);
  }
  return {
    select(value,selectedBank) { if (page===value && bank===selectedBank) return; page=value; bank=selectedBank; render(); },
    update(current,currentState,currentSampler) {
      const changed=facade!==current; facade=current; state=currentState; sampler=currentSampler;
      if (!changed && last===current.revision) return; last=current.revision;
      facade.copyVicMemory(0,vicMemory,state.vicBank); regions=memoryRegions(state,vicMemory);
      for(const node of jumpButtons.values()) node.hidden=true;
      for (const kind of ['screen',state.vic[0x11]&32?'bitmap':'characters','code','sprite']) {
        const r=regions.find(item=>item.kind===kind);
        if(!r) continue;
        let node=jumpButtons.get(kind);
        if(!node) { node=button('',()=>navigate('address',Number(node.dataset.address))); jumpButtons.set(kind,node); shortcuts.append(node); }
        node.hidden=false; node.dataset.address=r.start;
        node.textContent=`${kind==='code'?'CPU location':kind==='sprite'?'Sprite sources':r.title} $${hex(r.start)}`;
      }
      for(let i=0;i<256;i++) {
        const roles=rolesForPage(regions,i);
        cells[i].dataset.role=roles.find(r=>['screen','characters','bitmap','sprite'].includes(r.kind))?.kind??'';
        cells[i].title=`$${hex(i<<8)}–$${hex((i<<8)+255)}${roles.length?' · '+roles.map(r=>r.title).join(', '):''}`;
      }
      render();
    },
  };
}
