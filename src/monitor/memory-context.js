// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { createMemoryScreenView } from './memory-screen-view.js';
import { spritePreviewPixel } from './sprite-preview.js';
import { hex, regionHint } from './memory-sampler.js';
import { createMemorySources } from './memory-sources.js';
import { menuIcon } from './menu-icons.js';
import { memoryRegions, rolesForPage } from './memory-model.js';
import { screenBytePixels, bitmapPatternPixels, characterPixels, spritePixels, spriteLayout } from './setup-model.js';

export function createMemoryContext(root, shortcuts, cells, navigate, sourcesRoot) {
  root.innerHTML = `<div class="monitor-memory-story"><h3 data-memory="title"></h3><p data-memory="meaning"></p></div><div class="monitor-memory-visual"><canvas data-memory="visual" width="256" height="256"></canvas><div class="monitor-memory-unidentified" data-memory="unidentified">${menuIcon('atlas')}<strong>No graphics source identified here</strong><span>Choose a picture above the map to find its memory.</span></div></div><p class="monitor-note" data-memory="caption"></p><div class="monitor-memory-facts" data-memory="facts"></div><div class="monitor-memory-links" data-memory="links"></div>`;
  const el = name => root.querySelector(`[data-memory="${name}"]`);
  const canvas = el('visual'), ctx = canvas.getContext('2d');
  const vicMemory = new Uint8Array(16384);
  let facade, state, sampler, regions = [], page = 4, bank = null, preferredKind = null, last = -Infinity;
  let image, graphicsSource, capturedSprite=null,screenSelected=false,sharedFrame=null;
  const button = (label, action) => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'monitor-help-trigger'; node.textContent = label; node.addEventListener('click', action); return node;
  };
  const videoLink=button('Explore the captured picture in Video →',()=>navigate('video'));
  const codeLink=button('Explain the program in Code →',()=>navigate('code',state.pc));
  const vicLink=button('View the source actually read by the VIC →',()=>navigate('vic',graphicsSource.start,state.vicBank,preferredKind??graphicsSource.kind));
  const capturedLink=button('Inspect this pixel in the captured frame →',()=>{
    if(capturedSprite?.point)navigate('captured-pixel',capturedSprite.point.x,capturedSprite.point.y,capturedSprite.frame);
  });
  const currentSpriteLink=button('Inspect current pointer bytes →',()=>{
    const slot=capturedSprite.slot,region=regions.find(r=>r.kind==='sprite'&&r.index===slot);
    if(region){capturedSprite=null;navigate('vic',region.start,state.vicBank,`sprite:${slot}`);}
  });
  capturedLink.hidden=true;currentSpriteLink.hidden=true;
  el('links').append(videoLink,codeLink,vicLink,capturedLink,currentSpriteLink);
  canvas.addEventListener('click',()=>{if(capturedSprite)capturedLink.click();});
  canvas.addEventListener('keydown',event=>{if(capturedSprite&&(event.key==='Enter'||event.key===' ')){event.preventDefault();capturedLink.click();}});
  const jumpButtons=new Map();
  const sources=createMemorySources(sourcesRoot,(target,address,point,frame)=>{
    screenSelected=false;
    if(target==='screen'){screenSelected=true;capturedSprite=null;screenView.invalidate();navigate('context');render();}
    else if(target==='captured-sprite'){capturedSprite={slot:address,point,frame};navigate('context');render();}
    else {capturedSprite=null;if(target==='sprite-mode'){navigate('context');render();}else navigate(target,address,point,frame);}
  });
  const screenRoot=document.createElement('div');screenRoot.className='monitor-memory-screen-view';screenRoot.hidden=true;root.append(screenRoot);
  const screenView=createMemoryScreenView(screenRoot,{
    navigate:(...args)=>{if(args[0]==='vic')screenSelected=false;navigate(...args);},
    onMode:mode=>{sources.setScreenMode(mode);navigate('context');render();},
    highlightPages:pages=>{for(let i=0;i<cells.length;i++){cells[i].classList.toggle('is-source-range',!!pages[i]);cells[i].classList.toggle('is-captured-source',screenView.mode==='captured'&&!!pages[i]);}},
  });
  const fact = (label, value) => { const row = document.createElement('div'), term = document.createElement('span'), data = document.createElement('b'); term.textContent = label; data.textContent = value; row.append(term,data); el('facts').append(row); };
  function pixels(width, height) {
    if (canvas.width !== width || canvas.height !== height || !image) { canvas.width = width; canvas.height = height; image = ctx.createImageData(width,height); }
    return image.data;
  }
  function renderCapturedSprite() {
    root.dataset.capturedSprite='';
    const {slot}=capturedSprite,recorded=sources.drawCapturedSprite(ctx,slot);
    canvas.dataset.memoryKind='sprite';canvas.hidden=!recorded;el('unidentified').hidden=!!recorded;
    el('title').textContent=`Sprite ${slot} · captured appearance`;
    el('meaning').textContent='Sprites are independent images drawn over the background. A program can reuse a slot for different shapes within one frame.';
    el('caption').textContent='Recorded appearance, including expansion and reuse. This is not a decoding of the current pointer bytes.';
    el('facts').replaceChildren();
    videoLink.hidden=true;codeLink.hidden=true;vicLink.hidden=true;
    currentSpriteLink.hidden=false;capturedLink.hidden=!recorded;
    sources.select(page,null);sources.selectCaptured(slot);
    for(const cell of cells)cell.classList.remove('is-source-range');
    if(!recorded){
      el('unidentified').querySelector('strong').textContent='No visible pixels in this captured frame';
      el('unidentified').querySelector('span').textContent='The slot remains selected. Resume to follow its next appearance.';
      capturedSprite.point=null;return;
    }
    const {frame,bounds}=recorded;
    if(capturedSprite.frame!==frame||!capturedSprite.point)capturedSprite.point=spritePreviewPixel(frame,slot,bounds);
    capturedSprite.frame=frame;
    const raster=capturedSprite.point.y+frame.rasterOffset,index=raster*8+slot;
    fact('Visible pixels',bounds.pixels.toLocaleString());
    fact('Recorded rasters',`${bounds.top+frame.rasterOffset}–${bounds.bottom+frame.rasterOffset}`);
    if(frame.pointers&&frame.spriteBanks){
      const pointer=frame.pointers[index],bank=frame.spriteBanks[index];
      fact(`Pointer at raster ${raster} end`,`$${hex(pointer,2)} × 64 + $${hex(bank)} → $${hex(bank+pointer*64)}`);
    }
    const regs=frame.provenance?.lineRegs?.subarray(raster*64,raster*64+64);
    if(regs?.length===64){
      fact('Line-end mode',regs[0x1c]&(1<<slot)?'Multicolour':'Single colour');
      fact('Line-end expansion',`X ${regs[0x1d]&(1<<slot)?'2×':'1×'} · Y ${regs[0x17]&(1<<slot)?'2×':'1×'}`);
    }
    canvas.setAttribute('role','button');canvas.tabIndex=0;
    canvas.setAttribute('aria-label',`Inspect a visible pixel of sprite ${slot} in the captured frame`);
  }
  function render() {
    if (!facade || !state) return;
    canvas.removeAttribute('role');canvas.removeAttribute('tabindex');
    screenRoot.hidden=!screenSelected;root.toggleAttribute('data-screen-selected',screenSelected);
    if(screenSelected){sources.selectScreen();screenView.show(facade,state,vicMemory,sharedFrame);return;}
    for(const cell of cells)cell.classList.remove('is-captured-source');
    if(capturedSprite){renderCapturedSprite();return;}
    delete root.dataset.capturedSprite;
    capturedLink.hidden=true;currentSpriteLink.hidden=true;
    const start = page << 8, roles = rolesForPage(regions,page).filter(r=>r.enabled!==false||preferredKind===`sprite:${r.index}`);
    const cpu = facade.cpuMemorySource(start), source = facade.vicMemorySource(start & 0x3fff,bank ?? state.vicBank);
    const graphics = roles.find(r => r.kind === preferredKind || (r.kind==='sprite' && preferredKind===`sprite:${r.index}`)) ?? roles.find(r => ['screen','bitmap','characters','sprite'].includes(r.kind));
    graphicsSource=graphics;
    const showGraphics = graphics && (bank === null || bank === state.vicBank) && (source === 'RAM' || bank !== null);
    el('title').textContent = graphics?.title ?? roles.find(r=>r.kind==='stack'||r.kind==='zero')?.title ?? roles[0]?.title ?? 'Working memory: purpose unknown';
    el('meaning').textContent = roles.length ? regionHint(page) : 'No current video setting identifies this page. These bytes could be code, data or workspace.';
    el('facts').replaceChildren(); videoLink.hidden=true; codeLink.hidden=true; vicLink.hidden=true;
    canvas.dataset.memoryKind=graphics?.kind??'';
    canvas.hidden=!showGraphics;el('unidentified').hidden=!!showGraphics;
    el('unidentified').querySelector('strong').textContent=graphics&&source!=='RAM'?`${source} supplies these graphics`:'No graphics source identified here';
    el('unidentified').querySelector('span').textContent='Choose a picture above the map to find its memory.';
    sources.select(page,preferredKind??graphics?.kind);
    for(const cell of cells)cell.classList.toggle('is-source-range',!!graphics&&Number(cell.dataset.page)*256<graphics.start+graphics.size&&(Number(cell.dataset.page)+1)*256>graphics.start);
    if (showGraphics) {
      if (graphics.kind === 'characters') {
        characterPixels(pixels(128,128),vicMemory,state);
        el('meaning').textContent = 'The VIC-II selects character shapes from this configured set. Eight bytes make one 8 × 8 shape.';
        el('caption').textContent = `${source==='RAM'?'Shapes stored in RAM':`Shapes supplied by ${source}`}. Outlines mark the shapes whose bytes are in this page.`;
      } else if (graphics.kind === 'sprite') {
        const sprite = spriteLayout(state,vicMemory,graphics.index);
        spritePixels(pixels(24,21),vicMemory.subarray(sprite.offset,sprite.offset+63),sprite,state);
        el('meaning').textContent = `Sprite ${graphics.index} points here through $${hex(sprite.pointerAddress)}. Its 63 image bytes describe a 24 × 21 pixel shape.`;
        el('caption').textContent = `${sprite.enabled?'Slot enabled':'Slot not enabled'} in this sample. Shape uses the current pointer and colours, before expansion or compositing.`;
        fact('Pointer',`$${hex(sprite.pointer,2)} × 64 + bank $${hex(state.vicBank)}`);
      } else {
        (graphics.kind==='screen'?screenBytePixels:bitmapPatternPixels)(pixels(320,200),vicMemory,state);
        el('meaning').textContent = graphics.kind === 'screen' ? 'These cells tell the VIC-II which characters or bitmap colours to use. They are not themselves a picture.' : 'These bytes supply the pixel patterns for the configured bitmap.';
        el('caption').textContent = 'Decoded from sampled memory. Outlines mark the data supplied by this page.';
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
      el('caption').textContent = 'Use View for a manual interpretation, or Hexadecimal bytes for the raw values.';
      if (graphics && source !== 'RAM') { el('meaning').textContent = `The VIC-II selects ${source} here. The selected bytes are underlying RAM. Choose the graphics source above the map to see what the VIC reads.`; vicLink.hidden=false; }
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
    fact('Changed in latest RAM sample',`${sampler.pages[page]} / 256 bytes`);
    if (graphics) fact('Configured range',`$${hex(graphics.start)}–$${hex(graphics.start+graphics.size-1)}`);
    canvas.setAttribute('aria-label',el('caption').textContent);
  }
  function observe(current,currentState,currentSampler,paused=false) {
      const changed=facade!==current; facade=current; state=currentState; sampler=currentSampler;
      if (!changed && last===current.revision) return; last=current.revision;
      facade.copyVicMemory(0,vicMemory,state.vicBank); regions=memoryRegions(state,vicMemory,true);
      if(changed)sources.refresh();
      sources.update(current,vicMemory,regions,paused);
  }
  return {
    observe,
    setFrame(frame) { sharedFrame=frame;sources.setFrame(frame);last=-Infinity;if(!frame){capturedSprite=null;screenView.clear();} },
    clearCaptured() { capturedSprite=null;screenSelected=false; },
    get capturedSlot() { return capturedSprite?.slot??null; },
    get sourceTitle() { return screenSelected?'Screen cells':capturedSprite?`Sprite ${capturedSprite.slot}`:null; },
    get sourceCaption() { return screenSelected?(screenView.mode==='bytes'?'Screen bytes':'Static reconstruction'):'Captured appearance'; },
    select(value,selectedBank,kind = null) { if (page===value && bank===selectedBank && preferredKind===kind) return; capturedSprite=null;screenSelected=false;page=value; bank=selectedBank; preferredKind=kind; render(); },
    update(current,currentState,currentSampler,paused=false) {
      observe(current,currentState,currentSampler,paused);
      for(const node of jumpButtons.values()) node.hidden=true;
      for (const kind of ['code']) {
        const r=regions.find(item=>item.kind===kind);
        if(!r) continue;
        let node=jumpButtons.get(kind);
        if(!node) { node=button('',()=>navigate('address',Number(node.dataset.address))); jumpButtons.set(kind,node); shortcuts.append(node); }
        node.hidden=false; node.dataset.address=r.start;
        node.textContent=`${kind==='code'?'CPU location':kind==='sprite'?'Sprite sources':r.title} $${hex(r.start)}`;
      }
      for(let i=0;i<256;i++) {
        const roles=rolesForPage(regions,i).filter(r=>r.enabled!==false);
        const role=roles.find(r=>['screen','characters','bitmap','sprite'].includes(r.kind))?.kind??'';
        const title=`$${hex(i<<8)}–$${hex((i<<8)+255)}${roles.length?' · '+roles.map(r=>r.title).join(', '):''}`;
        const letter=({screen:'S',characters:'C',bitmap:'B',sprite:'●'})[role]??'';
        if(cells[i].dataset.role!==role)cells[i].dataset.role=role;
        if(cells[i].textContent!==letter)cells[i].textContent=letter;
        if(cells[i].getAttribute('aria-label')!==title){cells[i].title=title;cells[i].setAttribute('aria-label',title);}
      }
      render();
    },
  };
}
