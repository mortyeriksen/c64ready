// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Magnifies captured pixels. Pointer movement never reads machine state.
export function createPixelLens(canvas, source, getFrame) {
  const host=canvas.parentElement, lens=document.createElement('div');
  lens.className='monitor-pixel-lens'; lens.hidden=true; lens.setAttribute('aria-hidden','true');
  lens.innerHTML='<canvas width="104" height="104"></canvas>';
  host.append(lens);
  const ctx=lens.querySelector('canvas').getContext('2d');
  let left=0,top=0,scale=1,hostLeft=0,hostTop=0,ready=false;
  const hide=()=>{lens.hidden=true;ready=false;};
  function enter(event) {
    if(event.pointerType==='touch'||!getFrame())return;
    const rect=canvas.getBoundingClientRect(), bounds=host.getBoundingClientRect();
    scale=Math.min(rect.width/504,rect.height/312);
    left=rect.left+(rect.width-504*scale)/2;top=rect.top+(rect.height-312*scale)/2;
    hostLeft=bounds.left;hostTop=bounds.top;ready=true;
    move(event);
  }
  function move(event) {
    if(!ready){enter(event);return;}
    const frame=getFrame(); if(!frame)return;
    const x=Math.floor((event.clientX-left)/scale)-80,y=Math.floor((event.clientY-top)/scale)-frame.rasterOffset;
    if(x<0||x>=frame.width||y<0||y>=frame.height){lens.hidden=true;return;}
    ctx.imageSmoothingEnabled=false;ctx.fillStyle='#000';ctx.fillRect(0,0,104,104);
    ctx.drawImage(source,(6-x)*8,(6-y)*8,source.width*8,source.height*8);
    ctx.beginPath();
    ctx.moveTo(34,52);ctx.lineTo(47,52);ctx.moveTo(57,52);ctx.lineTo(70,52);
    ctx.moveTo(52,34);ctx.lineTo(52,47);ctx.moveTo(52,57);ctx.lineTo(52,70);
    ctx.lineWidth=4;ctx.strokeStyle='#000';ctx.stroke();
    ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();
    lens.dataset.pixel=`${x},${y}`;
    const pointerX=event.clientX-hostLeft,pointerY=event.clientY-hostTop;
    lens.style.transform=`translate(${pointerX-52}px,${pointerY-52}px)`;
    lens.hidden=false;
  }
  canvas.addEventListener('pointerenter',enter);
  canvas.addEventListener('pointermove',move);
  canvas.addEventListener('pointerleave',hide);
  canvas.addEventListener('blur',hide);
  canvas.addEventListener('keydown',hide);
  new ResizeObserver(hide).observe(canvas);
  return {hide};
}
