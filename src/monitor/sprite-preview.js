// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { spriteBounds } from './learn-model.js';

// Coordinates use the same centred, aspect-preserving crop as the thumbnail.
// Transparent space selects the nearest visible pixel belonging to this slot.
export function spritePreviewPixel(frame, slot, bounds, u=.5, v=.5, width=96, height=84) {
  if(!bounds?.pixels)return null;
  const w=bounds.right-bounds.left+1,h=bounds.bottom-bounds.top+1,scale=Math.min(width/w,height/h);
  const px=bounds.left+(u*width-(width-w*scale)/2)/scale-.5;
  const py=bounds.top+(v*height-(height-h*scale)/2)/scale-.5;
  let best=Infinity,point=null;
  for(let y=bounds.top;y<=bounds.bottom;y++)for(let x=bounds.left;x<=bounds.right;x++) {
    const i=y*frame.width+x;
    if(frame.owners[i]!==slot||frame.border[i]||(frame.provenance?.visibleSprites&&!frame.provenance.visibleSprites[i]))continue;
    const distance=(x-px)**2+(y-py)**2;
    if(distance<best){best=distance;point={x,y};}
  }
  return point;
}

export function drawSpritePreviews(frame, canvases) {
  const bounds = spriteBounds(frame,true), cutout = document.createElement('canvas');
  cutout.width = frame.width; cutout.height = frame.height;
  const ctx = cutout.getContext('2d'), image = ctx.createImageData(frame.width,frame.height);
  for (let slot = 0; slot < 8; slot++) {
    const canvas = canvases[slot], target = canvas.getContext('2d'), b = bounds[slot];
    target.clearRect(0,0,canvas.width,canvas.height);
    if (!b.pixels) continue;
    image.data.fill(0);
    for (let y=b.top;y<=b.bottom;y++) for (let x=b.left;x<=b.right;x++) {
      const i=y*frame.width+x;
      if (frame.owners[i] !== slot || frame.border[i] || (frame.provenance?.visibleSprites && !frame.provenance.visibleSprites[i])) continue;
      for (let c=0;c<4;c++) image.data[i*4+c]=frame.rgba[i*4+c];
    }
    ctx.putImageData(image,0,0);
    const width=b.right-b.left+1, height=b.bottom-b.top+1, scale=Math.min(canvas.width/width,canvas.height/height);
    target.imageSmoothingEnabled=false;
    target.drawImage(cutout,b.left,b.top,width,height,(canvas.width-width*scale)/2,(canvas.height-height*scale)/2,width*scale,height*scale);
  }
  return bounds;
}
