// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Bounded raw transition evidence. Expected values belong to the offline
// analyzer, never to this observer or to the emulation path.
export class VicRuleCapture {
  constructor() {
    const capacity=65536;
    this.data={version:1,capacity,count:0,overflow:false,tick:new Uint16Array(capacity),kind:new Uint8Array(capacity)};
    for(const key of ['a','b','c','d','e','f','g'])this.data[key]=new Uint32Array(capacity);
    this.spriteBefore=new Uint32Array(4);this.lpBefore=new Uint32Array(3);this.collisionBefore=new Uint32Array(4);
    this.capture=null;
  }
  add(kind,a=0,b=0,c=0,d=0,e=0,f=0,g=0) {
    const out=this.data,i=out.count;
    if(i===out.capacity){out.overflow=true;return;}
    out.kind[i]=kind;out.tick[i]=this.capture.tick();
    out.a[i]=a;out.b[i]=b;out.c[i]=c;out.d[i]=d;out.e[i]=e;out.f[i]=f;out.g[i]=g;out.count++;
  }
  finishIrq(value) {const d=this.data;if(!d.overflow&&d.count&&d.kind[d.count-1]===3)d.c[d.count-1]=value;}
  beginSprite(state,multi,expanded,start,end) {
    const b=this.spriteBefore;
    b[0]=state.shiftReg;b[1]=state.validMask;
    b[2]=state.pixelPhase|(state.unitsRemaining<<3)|(state.currentX<<8)|(multi?1<<20:0)|(expanded?1<<21:0);
    b[3]=start|(end<<10);
  }
  endSprite(state) {
    const b=this.spriteBefore;
    this.add(1,b[0],b[1],b[2],state.shiftReg,state.validMask,state.pixelPhase|(state.unitsRemaining<<3)|(state.currentX<<8),b[3]);
  }
  beginCollision(v,x) {
    const b=this.collisionBefore;
    b[0]=v.spriteCollisionBuffer[x];b[1]=v.graphicsCollisionBuffer[x];
    b[2]=v._deferCollisionCommit?v._collPipeE[1]:v.regs[0x1e];
    b[3]=v._deferCollisionCommit?v._collPipeF[1]:v.regs[0x1f];
  }
  endCollision(v,x,slot) {
    const b=this.collisionBefore,bit=1<<slot;
    this.add(8,b[0],bit,b[2],v.spriteCollisionBuffer[x],v._deferCollisionCommit?v._collPipeE[1]:v.regs[0x1e]);
    this.add(9,b[1],bit,b[3],v._deferCollisionCommit?v._collPipeF[1]:v.regs[0x1f]);
  }
  beginLightpen(v) {this.lpBefore[0]=v._lpInputLevel|(v._lpLatchedThisFrame?2:0);this.lpBefore[1]=v.regs[0x13]|(v.regs[0x14]<<8);this.lpBefore[2]=v.irqStatus;}
  endLightpen(v,level) {this.add(2,this.lpBefore[0],this.lpBefore[1],level,v.regs[0x13]|(v.regs[0x14]<<8),v._lpLatchedThisFrame?1:0,v.raster|(v.cycleInLine<<9),v.irqStatus);}
}
