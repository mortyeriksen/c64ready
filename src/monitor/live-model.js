// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const LIVE_COMPONENTS = [
  { key: 'cpu', title: 'Code', chip: '6510 CPU', purpose: 'Executes instructions and controls the chips.', view: 'code', action: 'Code', guide: 'cpu' },
  { key: 'ram', title: 'Memory', chip: '64 KB RAM · BANKING', purpose: 'Holds instructions, graphics and working data.', view: 'atlas', action: 'Memory', guide: 'memory' },
  { key: 'vic', title: 'Video', chip: 'VIC-II', purpose: 'Turns memory into the picture you see.', view: 'frame', action: 'Video', guide: 'vic' },
  { key: 'sid', title: 'Sound', chip: 'SID', purpose: 'Turns oscillator and filter settings into sound.', view: 'sid', action: 'Sound', guide: 'sid' },
  { key: 'controls', title: 'Controls & timing', chip: 'CIA · KEYBOARD · PORTS', purpose: 'Connects input, timers and interrupts.', view: 'controls', action: 'Controls', guide: 'cia' },
  { key: 'storage-link', title: 'Storage', chip: 'DISK · TAPE · CRT · REU', purpose: 'Brings programs and data into the machine.', view: 'storage', action: 'Storage', guide: 'drive' },
];

export function videoMode(state) {
  const r=state.vic;
  if(!(r[0x11]&16)) return 'Display disabled';
  if((r[0x11]&64) && ((r[0x11]&32)||(r[0x16]&16))) return 'Invalid graphics mode';
  return `${r[0x11]&32?'Bitmap':'Characters'}${r[0x11]&64?' · extended colour':r[0x16]&16?' · multicolour':''}`;
}
export function enabledSpriteCount(register) {
  let count=0; for(let i=0;i<8;i++) if(register&(1<<i)) count++; return count;
}
export function soundSummary(state) {
  const waves=new Map(), models=[]; let filters=0;
  for(let chip=0;chip<state.sidCount;chip++) {
    const base=chip*32; models.push(state.sidModels[chip]?'8580':'6581');
    if((state.sid[base+0x17]&7)&&(state.sid[base+0x18]&0x70)) filters++;
    for(let voice=0;voice<3;voice++) for(const [mask,name] of [[16,'triangle'],[32,'saw'],[64,'pulse'],[128,'noise']]) if(state.sid[base+voice*7+4]&mask) waves.set(name,(waves.get(name)||0)+1);
  }
  return { title:`${state.sidCount*3} voices · ${models.join(' + ')}`, waves:waves.size?[...waves].map(([name,count])=>`${count} ${name} voice${count===1?'':'s'}`).join(' · '):'No waveform selected', filter:filters?`Voice filter routed on ${filters===2?'both SIDs':'1 SID'}`:'Voice filter routing off' };
}
export function controlSummary(state) {
  if(!state) return { title:'Input readings unavailable', detail:'Explore the hardware with About', timers:0, keys:0 };
  let keys=0, timers=0;
  for(const column of state.keyboard) for(let bit=0;bit<8;bit++) if(!(column&(1<<bit))) keys++;
  for(const control of state.timerControl) if(control&1) timers++;
  const ports=[]; for(let i=0;i<2;i++) if((state.ports[i]&31)!==31) ports.push(i+1);
  return { title:keys?`${keys} key${keys===1?'':'s'} held`:ports.length?`Port ${ports.join(' + ')} input active`:'Inputs at rest', detail:`${timers} / 4 timers started`, timers, keys };
}
