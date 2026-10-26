// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Independent PAL 6569 reference equations. No emulator imports or memory reads.
export const POINTER_CYCLES = [58,60,62,1,3,5,7,9];
export function matrixAddress(d018,vc) { return ((d018&240)<<6)|(vc&1023); }
export function graphicsAddress(d011,d018,matrix,vc,rc,display=true) {
  let address=!display?0x3fff:d011&32?((d018&8)<<10)|((vc&1023)<<3)|(rc&7):((d018&14)<<10)|((matrix&255)<<3)|(rc&7);
  if(d011&64)address&=~0x600;
  return address;
}
export function spritePointerAddress(d018,slot) { return ((d018&240)<<6)|0x3f8|slot; }
export function spriteDataAddress(pointer,mc) { return ((pointer&255)<<6)|(mc&63); }
export function refreshAddress(raster,cycle) { return cycle<11||cycle>15?null:0x3f00|((255-raster*5-(cycle-11))&255); }
export function advanceGraphics({vc,vcBase,rc,vmli,display},cycle,badLine,gAccess=false) {
  if(cycle===14){vc=vcBase;vmli=0;if(badLine)rc=0;}
  if(badLine)display=true;
  if(gAccess&&display){vc=(vc+1)&1023;vmli=(vmli+1)&63;}
  if(cycle===58){if(rc===7){vcBase=vc;if(!badLine)display=false;}if(display)rc=(rc+1)&7;}
  return {vc,vcBase,rc,vmli,display};
}
export function spriteCrunch(base,mc) { return (42&(base&mc))|(21&(base|mc)); }
export function spritePixel(data,pixel,multi,expanded,colours) {
  const x=Math.floor(pixel/(expanded?2:1));
  if(x<0||x>=24)return null;
  const code=(data>>>(multi?22-(x&~1):23-x))&(multi?3:1);
  return code===0?null:multi?[null,colours.shared0,colours.own,colours.shared1][code]:colours.own;
}
export function spritePriority(mask,foreground,behindMask) {
  for(let slot=0;slot<8;slot++)if(mask&(1<<slot))return foreground&&(behindMask&(1<<slot))?-1:slot;
  return -1;
}
export function collisionBits(mask,foreground) { return { sprites:mask&&(mask&(mask-1))?mask:0, graphics:foreground?mask:0 }; }
export function irqOutput(latch,mask) { return !!(latch&mask&15); }
export function acknowledgeIrq(latch,write) { return latch&~write&15; }
export function lightpenLatch(previous,{fallingEdge,x,raster,newFrame=false}) {
  const state={...previous,triggered:newFrame?false:previous.triggered};
  if(fallingEdge&&!state.triggered){state.x=(x>>>1)&255;state.y=raster&255;state.triggered=true;}
  return state;
}
