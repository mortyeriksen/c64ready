// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { StorageHistory } from './storage-model.js';

const CAPACITY=401, WINDOW_MS=8000;

// Bounded display-rate samples, not an instruction, audio or transfer trace.
export class LiveCardHistory {
  constructor() {
    this.pc = new Uint16Array(CAPACITY);
    this.times = new Float64Array(CAPACITY);
    this.source = new Uint8Array(CAPACITY);
    this.frequency = Array.from({length:6},()=>new Uint16Array(CAPACITY));
    this.gates = new Uint8Array(CAPACITY);
    this.voices = new Uint8Array(CAPACITY);
    this.storage = new StorageHistory();
    this.reset();
  }
  reset() { this.count=0; this.cursor=0; this.lastTime=-Infinity; this.storage.reset(); }
  sample(state, storage, source, time, paused, interval = 100) {
    if (paused) { this.lastTime=-Infinity; return; }
    if (time-this.lastTime<interval*.9) return;
    if (time-this.lastTime>Math.max(500,interval*2.5)) this.reset();
    this.lastTime=time;
    const index=this.cursor;
    this.pc[index]=state.pc;
    this.times[index]=time;
    this.source[index]=source==='RAM'?0:source.includes('ROM')?1:2;
    this.gates[index]=0; this.voices[index]=state.sidCount*3;
    for(let v=0;v<6;v++) {
      const base=Math.floor(v/3)*32+(v%3)*7, active=v<this.voices[index];
      this.frequency[v][index]=active?(state.sid[base]|state.sid[base+1]<<8):0;
      if(active && state.sid[base+4]&1) this.gates[index]|=1<<v;
    }
    this.storage.sample(storage,time,interval);
    this.cursor=(index+1)%CAPACITY; this.count=Math.min(CAPACITY,this.count+1);
    while(this.count>1&&time-this.times[this.index(0)]>WINDOW_MS)this.count--;
  }
  get seconds() { return this.count < 2 ? 0 : (this.times[this.index(this.count-1)]-this.times[this.index(0)])/1000; }
  index(offset) { return (this.cursor-this.count+offset+CAPACITY)%CAPACITY; }
}
