// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { capturedCodeActions } from './code-actions.js';

// One captured-time cursor. Filters change which events can be selected,
// never the meaning of the time axis or the identity of the frame.
export class CodeTimeline {
  constructor() { this.frame=null; this.setFrame(null); }
  setFrame(frame, { reset = false } = {}) {
    const retain=!!this.frame&&!!frame&&!reset,group=retain?this.group:'All',tick=this.tick;
    this.frame=frame; this.actions=capturedCodeActions(frame); this.group=group; this.refreshIndices();
    this.tick=this.actions[0]?.tick??0; this.selected=this.actions.length?0:-1;
    if(retain)this.seek(tick);
  }
  get total() { return this.frame?this.frame.lines*this.frame.cyclesPerLine:0; }
  get line() { return this.frame?Math.floor(this.tick/this.frame.cyclesPerLine):0; }
  get indices() { return this.filtered; }
  refreshIndices(){this.filtered=[];for(let i=0;i<this.actions.length;i++)if(this.group==='All'||this.actions[i].group===this.group)this.filtered.push(i);}
  get lineIndices() { return this.indices.filter(i=>Math.floor(this.actions[i].tick/this.frame.cyclesPerLine)===this.line); }
  get action() { return this.actions[this.selected]??null; }
  seek(tick) {
    this.tick=Math.max(0,Math.min(Math.max(0,this.total-1),Math.floor(tick)));
    this.selected=this.indices.find(i=>this.actions[i].tick===this.tick)??-1;
  }
  filter(group) { this.group=group; this.refreshIndices(); this.seek(this.tick); }
  select(index) { if(this.indices.includes(index)){this.selected=index;this.tick=this.actions[index].tick;} }
  neighbour(direction) {
    const indices=this.indices;
    if(this.selected>=0){const at=indices.indexOf(this.selected);return indices[at+direction]??-1;}
    return (direction>0?indices.find(i=>this.actions[i].tick>this.tick):indices.findLast(i=>this.actions[i].tick<this.tick))??-1;
  }
  step(direction) { const index=this.neighbour(direction);if(index>=0)this.select(index); }
}
