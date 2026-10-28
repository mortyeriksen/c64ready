// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Regions surround the normal 320 × 200 screen in the captured 384 × 272 image.
// Corner pixels belong to both adjacent edges, so the counts are not additive.
export function borderRegions(frame) {
  const visible=frame.provenance?.visibleSprites, sources=frame.provenance?.pixels?.source;
  const regions=['Top','Bottom','Left','Right'].map(label=>({label,uncovered:0,spritePixels:visible?0:null,graphicsSamples:sources&&visible?0:null,slots:0,point:null,score:-1}));
  function record(region,index,x,y){
    region.uncovered++;
    const sprite=!!visible?.[index],graphics=sources?.[index]&&!sprite;
    if(sprite){region.spritePixels++;if(frame.owners[index]<8)region.slots|=1<<frame.owners[index];}
    if(graphics&&region.graphicsSamples!==null)region.graphicsSamples++;
    const coloured=!!(frame.rgba[index*4]||frame.rgba[index*4+1]||frame.rgba[index*4+2]);
    const score=(sprite?2:graphics?1:0)+(coloured?3:0);
    if(score>region.score){region.point={x,y};region.score=score;}
  }
  for(let y=0;y<frame.height;y++)for(let x=0;x<frame.width;x++){
    const index=y*frame.width+x;if(frame.border[index])continue;
    if(y<36)record(regions[0],index,x,y);
    if(y>=236)record(regions[1],index,x,y);
    if(x<32)record(regions[2],index,x,y);
    if(x>=352)record(regions[3],index,x,y);
  }
  return regions;
}
