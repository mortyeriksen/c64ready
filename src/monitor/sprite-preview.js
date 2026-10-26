// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { spriteBounds } from './learn-model.js';

export function drawSpritePreviews(frame, canvases) {
  const bounds = spriteBounds(frame), cutout = document.createElement('canvas');
  cutout.width = frame.width; cutout.height = frame.height;
  const ctx = cutout.getContext('2d'), image = ctx.createImageData(frame.width,frame.height);
  for (let slot = 0; slot < 8; slot++) {
    const canvas = canvases[slot], target = canvas.getContext('2d'), b = bounds[slot];
    target.clearRect(0,0,canvas.width,canvas.height);
    if (!b.pixels) continue;
    image.data.fill(0);
    for (let y=b.top;y<=b.bottom;y++) for (let x=b.left;x<=b.right;x++) {
      const i=y*frame.width+x;
      if (frame.owners[i] !== slot || frame.border[i]) continue;
      for (let c=0;c<4;c++) image.data[i*4+c]=frame.rgba[i*4+c];
    }
    ctx.putImageData(image,0,0);
    const width=b.right-b.left+1, height=b.bottom-b.top+1, scale=Math.min(canvas.width/width,canvas.height/height);
    target.imageSmoothingEnabled=false;
    target.drawImage(cutout,b.left,b.top,width,height,(canvas.width-width*scale)/2,(canvas.height-height*scale)/2,width*scale,height*scale);
  }
  return bounds;
}
