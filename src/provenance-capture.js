// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { VicRuleCapture } from './vic2-rule-capture.js';
import { VicPixelCapture } from './vic2-pixel-capture.js';

// Fixed observation points reference this object only during an explicit capture.
// Completion, cancellation, reset and state restore clear every observer.
export class ProvenanceCapture {
  constructor(cycles) {
    const capacity=cycles*8;
    this.pixels=new VicPixelCapture();
    this.rules=new VicRuleCapture();
    this.rules.capture=this;
    this.data={version:1,capacity,count:0,overflow:false,pixels:this.pixels.data,rules:this.rules.data,
      ram:new Uint8Array(65536),colour:new Uint8Array(1024),sid:new Uint8Array(64),sidCount:1,sid2Address:0,
      memoryComplete:true,cpuPort:0,cpuDDR:0,vicBank:0,cartMode:'',
      // Kind: CPU read/write, VIC bus, graphics, sprite, SID, REU read/write,
      // instruction dispatch, IRQ/NMI acceptance, screen matrix, RAM write.
      tick:new Uint16Array(capacity),kind:new Uint8Array(capacity),address:new Uint16Array(capacity),
      value:new Uint8Array(capacity),aux:new Uint32Array(capacity),pc:new Uint16Array(capacity),
      priorityMask:new Uint8Array(384*272),priorityBehind:new Uint8Array(384*272),priorityConflict:new Uint8Array(384*272),
      visibleSprites:new Uint8Array(384*272),foreground:new Uint8Array(384*272),lineRegs:new Uint8Array(312*64),
    };
    this.bytes=Object.values(this.data).reduce((n,v)=>n+(ArrayBuffer.isView(v)?v.byteLength:0),0)+this.pixels.bytes+Object.values(this.rules.data).reduce((n,v)=>n+(ArrayBuffer.isView(v)?v.byteLength:0),0);
    if(this.bytes>8*1024*1024) throw new RangeError('Provenance exceeds the 8 MiB capture ceiling');
    this.capture=null;this.machine=null;
  }
  tick(){const v=this.machine.vic2,c=v.cycleInLine||63;return (v.cycleInLine?v.raster:(v.raster+311)%312)*63+c-1;}
  add(kind,address,value,aux=0,tick=this.tick()){
    if(this.capture.status!=='recording')return;
    const d=this.data,i=d.count;if(i===d.capacity){d.overflow=true;return;}
    d.tick[i]=tick;d.kind[i]=kind;d.address[i]=address;d.value[i]=value;d.aux[i]=aux;
    d.pc[i]=this.machine.cpu.instructionAddress<0?65535:this.machine.cpu.instructionAddress;d.count++;
  }
  start(machine,capture){
    this.machine=machine;this.capture=capture;
    const m=machine,mem=m.mem,v=m.vic2,d=this.data;
    this.pixels.vic=v;
    d.ram.set(mem.ram);d.colour.set(mem.colorRam);d.sid.set(mem.sid.regs);if(m.sid2)d.sid.set(m.sid2.proxy.regs,32);
    d.sidCount=m.sid2?2:1;d.sid2Address=m.sid2?mem.sid2Address:0;d.cpuPort=mem.cpuPort;d.cpuDDR=mem.cpuDDR;d.vicBank=v.currentVicBank;d.cartMode=mem.cartMode;
    m.cpu._captureObserver=this;mem._captureObserver=this;v._captureObserver=this;
  }
  cpuWrite(address,value,before){this.add(1,address,value);const ram=this.machine.mem.ram;if(ram[address&65535]!==before)this.add(12,address,ram[address&65535]);}
  reuAccess(write,address,value){const r=this.machine.reu;this.add(write?7:6,address,value,((r?._reuAddr??0)&0xffffff)|((r?._command??0)&3)<<24);}
  line(vic){const y=vic._cycleRenderActiveCanvasY;if(y>=0&&y<272){this.data.foreground.set(vic.graphicsPriorityBuffer,y*384);this.data.visibleSprites.set(vic.spriteVisibleBuffer,y*384);}this.data.lineRegs.set(vic.regs,vic.raster*64);}
  spritePriority(x,y,slot,behind) {
    if(x<0||x>=384||y<0||y>=272)return;
    const i=y*384+x,bit=1<<slot,d=this.data;
    if((d.priorityMask[i]&bit)&&!!(d.priorityBehind[i]&bit)!==!!behind)d.priorityConflict[i]=1;
    d.priorityMask[i]|=bit;
    if(behind)d.priorityBehind[i]|=bit;else d.priorityBehind[i]&=~bit;
  }
  stop(){const m=this.machine;if(!m)return;for(const object of [m.cpu,m.mem,m.vic2])if(object._captureObserver===this)object._captureObserver=null;}
}
