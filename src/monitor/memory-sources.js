// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { screenPixels, screenBytePixels, characterPixels, bitmapPatternPixels, spritePixels, spriteLayout } from './setup-model.js';
import { drawSpritePreviews, spritePreviewPixel } from './sprite-preview.js';
import { hex } from './memory-sampler.js';

export function createMemorySources(root, navigate) {
  root.innerHTML=`<div class="monitor-memory-source-heading">Find graphics in memory <small>Choose a picture or sprite slot</small></div><div class="monitor-memory-source-choices"><button type="button" data-memory-source="screen"><canvas width="320" height="200" aria-hidden="true"></canvas><span class="monitor-memory-capture-wait" hidden>Waiting for a captured frame</span><b>Screen cells</b><small>Arrange shapes and colours</small></button><button type="button" data-memory-source="patterns"><canvas width="128" height="128" aria-hidden="true"></canvas><span class="monitor-memory-capture-wait" hidden>Waiting for a captured frame</span><b>Character shapes</b><small>The picture’s building blocks</small></button><div class="monitor-memory-sprite-sources"><div>${Array.from({length:8},(_,i)=>`<button type="button" data-memory-sprite="${i}" disabled><canvas width="24" height="21" aria-hidden="true"></canvas><span>${i}</span></button>`).join('')}</div><b>Sprite shapes</b><button type="button" data-memory-sprite-mode disabled>Current pointers</button></div></div>`;
  const screen=root.querySelector('[data-memory-source="screen"]'),patterns=root.querySelector('[data-memory-source="patterns"]');
  const sprites=[...root.querySelectorAll('[data-memory-sprite]')];
  const nodes=[screen,patterns,...sprites],contexts=nodes.map(node=>node.querySelector('canvas').getContext('2d'));
  const images=contexts.map(ctx=>ctx.createImageData(ctx.canvas.width,ctx.canvas.height));
  const modeButton=root.querySelector('[data-memory-sprite-mode]');
  const capturedCanvases=Array.from({length:8},()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=84;return canvas;});
  let state, regions=[],lastDraw=-Infinity,force=true,lastPaused=false,screenMode='bytes';
  let frame=null,drawnFrame=null,capturedBounds=null,capturedMode=false,chosenMode=null,lastSnapshot,lastMemory,lastRegions;
  let paintedFrame=null,paintedMode=null,detailFrame=null,detailSlot=-1;
  const detailCanvas=document.createElement('canvas'),detailContext=detailCanvas.getContext('2d');
  function prepareFrame() {
    if(frame===drawnFrame)return;
    drawnFrame=frame;
    capturedBounds=frame?drawSpritePreviews(frame,capturedCanvases):null;
  }
  modeButton.addEventListener('click',()=>{chosenMode=!capturedMode;if(lastSnapshot)view.update(lastSnapshot,lastMemory,lastRegions,lastPaused);navigate('sprite-mode',capturedMode);});
  function open(region) { if(region)navigate('vic',region.start,state.vicBank,region.kind==='sprite'?`sprite:${region.index}`:region.kind); }
  screen.addEventListener('click',()=>navigate('screen'));
  patterns.addEventListener('click',()=>open(regions.find(r=>r.kind==='characters'||r.kind==='bitmap')));
  sprites.forEach((node,i)=>node.addEventListener('click',event=>{
    if(!capturedMode){open(regions.find(r=>r.kind==='sprite'&&r.index===i));return;}
    const canvas=node.querySelector('canvas'),rect=canvas.getBoundingClientRect();
    const point=spritePreviewPixel(frame,i,capturedBounds[i],event.detail&&rect.width?(event.clientX-rect.left)/rect.width:.5,event.detail&&rect.height?(event.clientY-rect.top)/rect.height:.5,canvas.width,canvas.height);
    if(point)navigate('captured-sprite',i,point,frame);
  }));
  const view = {
    setScreenMode(mode) { screenMode=mode;force=true;if(lastSnapshot)view.update(lastSnapshot,lastMemory,lastRegions,lastPaused); },
    selectScreen() { for(const node of nodes)node.setAttribute('aria-pressed',String(node===screen)); },
    setFrame(value) { if(value!==frame)force=true;frame=value;if(!value){drawnFrame=null;paintedFrame=null;capturedBounds=null;capturedMode=false;chosenMode=null;detailFrame=null;detailSlot=-1;} },
    drawCapturedSprite(ctx,slot) {
      prepareFrame();
      const bounds=capturedBounds?.[slot];
      if(!bounds?.pixels)return null;
      const width=bounds.right-bounds.left+1,height=bounds.bottom-bounds.top+1;
      if(detailFrame!==frame||detailSlot!==slot){
        detailFrame=frame;detailSlot=slot;detailCanvas.width=width;detailCanvas.height=height;
        const image=detailContext.createImageData(width,height),visible=frame.provenance?.visibleSprites;
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const i=(y+bounds.top)*frame.width+x+bounds.left;
          if(frame.owners[i]!==slot||frame.border[i]||(visible&&!visible[i]))continue;
          const target=(y*width+x)*4;
          for(let c=0;c<4;c++)image.data[target+c]=frame.rgba[i*4+c];
        }
        detailContext.putImageData(image,0,0);
      }
      if(ctx.canvas.width!==width||ctx.canvas.height!==height){ctx.canvas.width=width;ctx.canvas.height=height;}
      ctx.clearRect(0,0,width,height);ctx.drawImage(detailCanvas,0,0);
      return {frame,bounds};
    },
    selectCaptured(slot) { for(let i=0;i<8;i++)sprites[i].setAttribute('aria-pressed',String(capturedMode&&i===slot)); },
    select(page,kind) {
      for(let i=0;i<nodes.length;i++) {
        const r=regions.find(r=>i===0?r.kind==='screen':i===1?r.kind==='characters'||r.kind==='bitmap':r.kind==='sprite'&&r.index===i-2);
        const selected=!(i>=2&&capturedMode)&&!!r&&r.start<(page+1)*256&&r.start+r.size>page*256&&!!kind&&(kind===r.kind||kind===`sprite:${r.index}`);
        nodes[i].setAttribute('aria-pressed',String(selected));
      }
    },
    refresh() { force=true; },
    update(snapshot,memory,currentRegions,paused=false) {
      state=snapshot.state;regions=currentRegions;
      lastSnapshot=snapshot;lastMemory=memory;lastRegions=currentRegions;
      prepareFrame();
      const available=!!frame;
      capturedMode=available&&(chosenMode??true);
      modeButton.disabled=!available;
      modeButton.textContent=capturedMode?'Captured frame ⇄':'Current pointers ⇄';
      modeButton.title=capturedMode?'Recorded appearance. Switch to current pointer bytes.':'Sampled pointer bytes. Switch to sprites visible in the captured frame.';
      modeButton.setAttribute('aria-label',modeButton.title);
      for(let i=0;i<8;i++) {
        if(capturedMode&&paintedMode===capturedMode&&paintedFrame===frame)continue;
        const region=regions.find(r=>r.kind==='sprite'&&r.index===i),ctx=contexts[i+2];
        const width=capturedMode?96:24,height=capturedMode?84:21;
        if(ctx.canvas.width!==width){ctx.canvas.width=width;ctx.canvas.height=height;}
        ctx.clearRect(0,0,width,height);
        if(capturedMode) {
          const b=capturedBounds[i];
          sprites[i].disabled=!b.pixels;sprites[i].classList.remove('is-inactive');sprites[i].setAttribute('aria-pressed','false');
          sprites[i].title=`Sprite ${i}: ${b.pixels?'visible in captured frame':'not visible in captured frame'}.${b.pixels?' Show its recorded shape and sprite information.':''}`;
          sprites[i].setAttribute('aria-label',sprites[i].title);
          ctx.imageSmoothingEnabled=false;ctx.drawImage(capturedCanvases[i],0,0);
          continue;
        }
        sprites[i].disabled=!region;
        sprites[i].classList.toggle('is-inactive',region?.enabled===false);
        sprites[i].title=region?`Sprite ${i}: $${hex(region.start)}. ${region.enabled?'Enabled':'Not enabled'}. Inspect its shape and pointer.`:`Sprite ${i}: not enabled`;
        sprites[i].setAttribute('aria-label',sprites[i].title);
        if(!region)continue;
        const sprite=spriteLayout(state,memory,i);
        spritePixels(images[i+2].data,memory.subarray(sprite.offset,sprite.offset+63),sprite,state);
        ctx.putImageData(images[i+2],0,0);
      }
      paintedFrame=frame;paintedMode=capturedMode;
      const pauseChanged=lastPaused!==paused;lastPaused=paused;
      if(!force&&!pauseChanged&&snapshot.capturedAt-lastDraw<200)return;
      force=false;lastDraw=snapshot.capturedAt;
      const pattern=regions.find(r=>r.kind==='characters'||r.kind==='bitmap'),bitmap=pattern.kind==='bitmap';
      contexts[0].canvas.hidden=false;
      screen.querySelector('.monitor-memory-capture-wait').hidden=true;
      if(contexts[0].canvas.width!==320||contexts[0].canvas.height!==200){contexts[0].canvas.width=320;contexts[0].canvas.height=200;}
      (screenMode==='current'?screenPixels:screenBytePixels)(images[0].data,memory,state);
      contexts[0].putImageData(images[0],0,0);
      patterns.querySelector('b').textContent=bitmap?'Bitmap pixels':'Character shapes';
      patterns.querySelector('small').textContent=bitmap?'Raw bits before colours':'The picture’s building blocks';
      screen.querySelector('small').textContent=screenMode==='current'?'Static reconstruction':'1,000 screen bytes';
      contexts[1].canvas.hidden=false;
      patterns.querySelector('.monitor-memory-capture-wait').hidden=true;
      const width=bitmap?320:128,height=bitmap?200:128;
      if(contexts[1].canvas.width!==width||contexts[1].canvas.height!==height||images[1].width!==width) {
        contexts[1].canvas.width=width;contexts[1].canvas.height=height;images[1]=contexts[1].createImageData(width,height);
      }
      if(bitmap)bitmapPatternPixels(images[1].data,memory,state);
      else characterPixels(images[1].data,memory,state);
      contexts[1].putImageData(images[1],0,0);
      for(const [node,region] of [[screen,regions.find(r=>r.kind==='screen')],[patterns,pattern]]) {
        const source=snapshot.vicMemorySource(region.start&16383,state.vicBank);
        node.title=`${region.title}: $${hex(region.start)}. Open the VIC-visible source (${source}). Preview uses current settings, not a captured frame.`;
      }
      screen.title='Sampled screen bytes. Inspect addresses, character codes or bitmap colour nibbles.';
    },
  };
  return view;
}
