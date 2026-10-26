// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const FIELDS = ['sample', 'address', 'tick', 'backgrounds', 'source', 'scroll'];
function buffers(size) {
  return { sample:new Uint32Array(size), address:new Uint16Array(size), tick:new Uint16Array(size),
    backgrounds:new Uint16Array(size), source:new Uint8Array(size), scroll:new Uint8Array(size) };
}
const backgrounds = r => (r[0x21]&15)|((r[0x22]&15)<<4)|((r[0x23]&15)<<8)|((r[0x24]&15)<<12);
const mode = (d011,d016) => ((d011>>4)&6)|((d016>>4)&1);

// Renderer observations retain the source and output controls of the winning
// paint, including split-column and line-end corrections. They are not bus reads.
export class VicPixelCapture {
  constructor() {
    this.data={version:1,phase:'renderer-output',...buffers(384*272)};
    this.span=buffers(320); this.saved=buffers(384); this.split=buffers(384);
    this.suspended=false; this.vic=null;
    this.idleAddress=new Uint16Array(64);this.idleLine=new Int16Array(64).fill(-1);
    this.bytes=this.idleAddress.byteLength+this.idleLine.byteLength;
    for(const group of [this.data,this.span,this.saved,this.split])for(const key of FIELDS)this.bytes+=group[key].byteLength;
  }
  clear(y,start,end) {
    if(!this.suspended && y>=0 && y<272) {
      this.data.source.fill(0,y*384+start,y*384+end);
      this.span.source.fill(0);
    }
  }
  source(seg,address,value,matrix,colour,offset,raster) {
    if(this.suspended)return;
    const r=seg.modeRegs||seg.nextRegs||seg.regs,bg=backgrounds(seg.bgRegs||seg.regs);
    for(let bit=0;bit<8;bit++) {
      const i=offset+bit;
      this.span.sample[i]=value|(matrix<<8)|(colour<<16)|(mode(r[0x11],r[0x16])<<20)|(bit<<23);
      this.span.address[i]=address; this.span.tick[i]=raster*63+seg.cycle-1;
      this.span.backgrounds[i]=bg; this.span.source[i]=1; this.span.scroll[i]=(seg.xscrollRegs||seg.regs)[0x16]&7;
    }
  }
  paint(seg,y,start,end,first,limit,origin,scroll,pixels,foreground,bg,firstBg) {
    if(this.suspended||y<0||y>=272)return;
    for(let x=start;x<end;x++) {
      const j=x-origin-scroll-first*8,i=y*384+x;
      if(j<0||j>=limit) {
        const nearest=j<0?0:limit-1;
        if(nearest<0||!this.span.source[nearest]){this.data.source[i]=0;continue;}
        for(const key of FIELDS)this.data[key][i]=this.span[key][nearest];
        const m=(this.data.sample[i]>>>20)&7;
        this.data.sample[i]&=m===2?0x0070ff00:0x00700000;
        this.data.source[i]=4;
        continue;
      }
      for(const key of FIELDS)this.data[key][i]=this.span[key][j];
      this.data.scroll[i]=(origin+scroll)&7;
      // The colour multiplexer can select a distinct first-pixel background.
      if(x===seg.cycleStart && firstBg!==bg && !foreground[j] && pixels[j]===bg) {
        const r=seg.bgRegs?seg.bgPrevRegs:seg.regs;
        const colour=this.vic._is8565?15:r[0x21]&15;
        this.data.sample[i]|=0x40000000|(colour<<26);
      }
    }
  }
  idleSource(cycle,address,raster) {this.idleAddress[cycle]=address;this.idleLine[cycle]=raster;}
  idle(seg,y,start,end) {
    if(this.suspended||y<0||y>=272)return;
    const r=seg.regs,m=seg.modeRegs||seg.nextRegs||r,b=seg.bgRegs||r;
    const scroll=r[0x16]&7, reload=seg.cycleStart+scroll;
    for(let x=start;x<end;x++) {
      const i=y*384+x, previous=x<reload, value=previous?seg.idleBytePrev:seg.idleByte;
      this.data.sample[i]=value|(mode(r[0x11],m[0x16])<<20)|(((x-scroll)&7)<<23);
      const cycle=Math.max(1,seg.cycle+(previous?0:1)+this.vic._regOffset);
      if(this.idleLine[cycle]!==this.vic.raster){this.data.source[i]=0;continue;}
      this.data.address[i]=this.idleAddress[cycle];
      this.data.tick[i]=this.vic.raster*63+cycle-1;
      this.data.backgrounds[i]=backgrounds(b); this.data.source[i]=3; this.data.scroll[i]=scroll;
      if(x===seg.cycleStart) {
        const previousRegs=seg.bgRegs?seg.bgPrevRegs:seg.prevRegs;
        if(previousRegs && previousRegs[0x21]!==b[0x21]) {
          const colour=this.vic._is8565?15:seg.bgRegs?previousRegs[0x21]&15:b[0x21]&15;
          this.data.backgrounds[i]=(this.data.backgrounds[i]&0xfff0)|colour;
        }
      }
    }
  }
  save(target,y,start,end) {
    if(this.suspended)return;
    for(let x=start;x<end;x++)for(const key of FIELDS)this[target][key][x]=this.data[key][y*384+x];
  }
  restore(target,y,start,end) {
    if(this.suspended)return;
    for(let x=start;x<end;x++)for(const key of FIELDS)this.data[key][y*384+x]=this[target][key][x];
  }
  merge(y,start,end,savedPixels) {
    const v=this.vic;
    this.suspended=false;
    for(let x=start;x<end;x++) {
      const i=y*384+x;
      if(!v._fixupSpriteHiddenBySpecFg(i,x)&&(v.spriteVisibleBuffer[x]||savedPixels[x]!==v.fb32[i]))
        for(const key of FIELDS)this.data[key][i]=this.saved[key][x];
    }
  }
}
