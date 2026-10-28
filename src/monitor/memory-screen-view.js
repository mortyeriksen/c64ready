// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { screenPixels, graphicsLayout, invalidGraphicsMode } from './setup-model.js';
import { hex } from './memory-sampler.js';

export function createMemoryScreenView(root,{navigate,onMode,highlightPages}) {
  root.innerHTML=`<div class="monitor-memory-screen-modes"><button type="button" class="btn" data-screen-mode="bytes" aria-pressed="true">Screen bytes</button><button type="button" class="btn" data-screen-mode="current" aria-pressed="false">Static picture</button></div><p class="monitor-note" data-screen="meaning"></p><div class="monitor-memory-visual"><canvas data-screen="picture" tabindex="0" role="grid" aria-label="Screen bytes, 40 columns by 25 rows. Arrow keys select a cell."></canvas></div><p class="monitor-note" data-screen="caption"></p><div class="monitor-memory-facts" data-screen="facts"></div><div class="monitor-memory-links"><button class="monitor-help-trigger" type="button" data-screen="bytes">Inspect selected byte →</button><button class="monitor-help-trigger" type="button" data-screen="frame">See the captured picture in Video →</button></div>`;
  const el=name=>root.querySelector(`[data-screen="${name}"]`),canvas=el('picture'),ctx=canvas.getContext('2d');
  let mode='bytes',frame=null,state=null,snapshot=null,memory=null,selected=0,image;
  const pages=new Uint8Array(256);
  el('frame').addEventListener('click',()=>{if(frame)navigate('captured-video',0,null,frame);});
  el('bytes').addEventListener('click',()=>{
    const layout=graphicsLayout(state);
    navigate('vic',layout.bank+layout.screen+selected,layout.bank,'screen');
  });
  canvas.addEventListener('click',event=>{
    if(mode!=='bytes'||!memory)return;
    const rect=canvas.getBoundingClientRect();
    const scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
    if(!scale)return;
    const x=(event.clientX-rect.left-(rect.width-canvas.width*scale)/2)/scale;
    const y=(event.clientY-rect.top-(rect.height-canvas.height*scale)/2)/scale;
    if(x<0||y<0||x>=canvas.width||y>=canvas.height)return;
    selected=Math.floor(y/20)*40+Math.floor(x/20);
    paint();
  });
  canvas.addEventListener('keydown',event=>{
    const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-40,ArrowDown:40}[event.key];
    if(mode!=='bytes'||!memory||!step)return;
    event.preventDefault();selected=Math.min(999,Math.max(0,selected+step));paint();
  });
  for(const button of root.querySelectorAll('[data-screen-mode]'))button.addEventListener('click',()=>{
    mode=button.dataset.screenMode;onMode(mode);
  });
  function fact(label,value) {
    const row=document.createElement('div'),term=document.createElement('span'),data=document.createElement('b');
    term.textContent=label;data.textContent=value;row.append(term,data);el('facts').append(row);
  }
  function paint() {
    const layout=graphicsLayout(state),start=layout.bank+layout.screen,value=memory[layout.screen+selected];
    const bytes=mode==='bytes',width=bytes?800:320,height=bytes?500:200;
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;image=null;}
    for(const button of root.querySelectorAll('[data-screen-mode]'))button.setAttribute('aria-pressed',String(mode===button.dataset.screenMode));
    el('frame').hidden=!frame;
    canvas.setAttribute('role',bytes?'grid':'img');
    canvas.setAttribute('aria-label',bytes?`Screen bytes, 40 columns by 25 rows. Selected $${hex(start+selected)} = $${hex(value,2)}. Arrow keys select a cell.`:'Static screen reconstruction from sampled memory');
    if(bytes) {
      const style=getComputedStyle(root),background=style.getPropertyValue('--control-bg').trim()||'#111',ink=style.getPropertyValue('--text').trim()||'#ddd',accent=style.getPropertyValue('--accent').trim()||'#fff';
      ctx.fillStyle=background;ctx.fillRect(0,0,width,height);ctx.font='14px monospace';ctx.textAlign='center';ctx.textBaseline='middle';
      for(let i=0;i<1000;i++) {
        const x=i%40*20,y=Math.floor(i/40)*20;
        ctx.fillStyle=ink;ctx.globalAlpha=.1+.35*memory[layout.screen+i]/255;ctx.fillRect(x+1,y+1,18,18);
        ctx.globalAlpha=1;ctx.fillText(hex(memory[layout.screen+i],2),x+10,y+10);
      }
      ctx.strokeStyle=accent;ctx.lineWidth=2;ctx.strokeRect(selected%40*20+1,Math.floor(selected/40)*20+1,18,18);
      el('meaning').textContent=layout.bitmapOn?'Each screen byte supplies two bitmap colours: one in each half of the byte.':'Each screen byte selects a character shape. The grid follows the 40 × 25 screen-cell layout.';
      el('caption').textContent='Actual VIC-visible bytes at the sampled screen address. Brighter cells hold larger values. Select a cell for its address and meaning.';
    } else {
      if(!image)image=ctx.createImageData(width,height);
      screenPixels(image.data,memory,state);ctx.putImageData(image,0,0);
      el('meaning').textContent='One sampled configuration applied to memory, without sprites, borders or raster changes.';
      el('caption').textContent=invalidGraphicsMode(state)?'This graphics mode outputs black. Screen bytes still shows the stored data.':'Raster changes can make this reconstruction look scrambled. Video shows the captured picture.';
    }
    el('facts').replaceChildren();
    fact('Screen memory',`$${hex(start)}–$${hex(start+999)} · ${snapshot.vicMemorySource(layout.screen,layout.bank)}`);
    fact(`Cell ${selected%40+1}, ${Math.floor(selected/40)+1}`,`$${hex(start+selected)} = $${hex(value,2)} · ${value}`);
    if(layout.bitmapOn)fact('Colour nibbles',`High ${value>>>4} · low ${value&15}`);
    else fact('Character bytes',`$${hex(layout.bank+layout.characters+(layout.extended?value&63:value)*8)} · 8 bytes`);
    pages.fill(0);for(let p=start>>>8;p<=(start+999)>>>8;p++)pages[p]=1;highlightPages(pages);
  }
  return {
    show(value,current,data,captured){snapshot=value;state=current;memory=data;frame=captured;paint();},
    get mode(){return mode;},
    invalidate(){},
    clear(){frame=null;snapshot=null;state=null;memory=null;selected=0;},
  };
}
