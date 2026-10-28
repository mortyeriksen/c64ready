// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const cache=new WeakMap();

// Matrix fetches establish screen-memory use. D018 settings and sprite-pointer
// reads alone do not prove that a screen cell was read or reached the picture.
export function capturedScreenUsage(frame) {
  if(!frame)return null;
  if(cache.has(frame))return cache.get(frame);
  const p=frame.provenance,regions=[],byBase=new Map(),pages=new Uint8Array(256);
  const available=!!(p?.kind&&p.address&&p.tick&&p.value&&Number.isInteger(p.count));
  const rasters=new Uint32Array(frame.lines??312);
  let reads=0,cells=0;
  if(available)for(let i=0;i<p.count;i++) {
    if(p.kind[i]!==11)continue;
    const address=p.address[i],base=address&0xfc00,tick=p.tick[i],line=Math.floor(tick/(frame.cyclesPerLine??63));
    let region=byBase.get(base);
    if(!region){
      region={base,reads:0,cells:0,start:address,end:address,firstTick:tick,lastTick:tick,firstAddress:address,firstValue:p.value[i],pages:new Uint8Array(256),rasters:new Uint32Array(rasters.length),seen:new Uint8Array(1024)};
      byBase.set(base,region);regions.push(region);
    }
    reads++;region.reads++;
    if(!region.seen[address&1023]){region.seen[address&1023]=1;region.cells++;cells++;}
    region.start=Math.min(region.start,address);region.end=Math.max(region.end,address);
    region.lastTick=tick;region.pages[address>>>8]=1;pages[address>>>8]=1;
    if(line<rasters.length){region.rasters[line]++;rasters[line]++;}
  }
  for(const region of regions)delete region.seen;
  const result={regions,pages,rasters,reads,cells,status:!available?'unavailable':p.overflow||frame.overflow?'partial':'complete'};
  cache.set(frame,result);return result;
}
