// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { graphicsMemoryGroups } from './memory-model.js';
import { hex } from './memory-sampler.js';

export function graphicsSourceLabel(snapshot, region, bank) {
  const first=snapshot.vicMemorySource(region.start&16383,bank);
  for(let address=(region.start&~4095)+4096;address<region.start+region.size;address+=4096)
    if(snapshot.vicMemorySource(address&16383,bank)!==first)return 'Mixed VIC sources';
  return first;
}

export function createLiveMemory(root, navigate) {
  root.innerHTML = `<div class="monitor-memory-map-heading"><strong>Memory</strong><span>Configured graphics sources</span><div class="monitor-memory-legend">${[0,1,2].map(i=>`<button type="button" data-graphics-source="${i}" style="--source-colour:var(${['--accent2','--info','--text'][i]})"><i aria-hidden="true"></i><span></span></button>`).join('')}</div></div><button type="button" class="monitor-memory-activity" data-memory-activity><span>RAM changes</span><canvas width="768" height="12" aria-label="Changed RAM pages across 64 KB"></canvas></button><div class="monitor-memory-source-lanes">${[0,1,2].map(i=>`<button type="button" data-graphics-lane="${i}"><span></span><canvas width="768" height="8"></canvas></button>`).join('')}</div><div class="monitor-machine-addresses"><small>$0000</small><small>$FFFF</small></div>`;
  const buttons = [...root.querySelectorAll('[data-graphics-source]')];
  const lanes = [...root.querySelectorAll('[data-graphics-lane]')];
  const contexts = lanes.map(node=>node.querySelector('canvas').getContext('2d'));
  const activity = root.querySelector('[data-memory-activity] canvas').getContext('2d');
  let groups = [], bank = 0, changedPage = 4;
  let colours = [], quiet, accent, dim, dirty = true;
  const configuration = new Int32Array(12).fill(-1);
  function open(index, page = null) {
    const group = groups[index];
    const region = group?.regions.find(r => page === null || (r.start < (page+1)*256 && r.start+r.size > page*256));
    if (region) navigate('atlas', {address: page === null ? region.start : Math.max(region.start,page*256), bank, kind: group.kind});
  }
  buttons.forEach((button,i)=>button.addEventListener('click',()=>open(i)));
  lanes.forEach((button,i)=>button.addEventListener('click',event=>{
    const canvas = button.querySelector('canvas');
    if (event.detail && event.target === canvas) {
      const rect = canvas.getBoundingClientRect();
      open(i, Math.min(255,Math.max(0,Math.floor((event.clientX-rect.left)*256/rect.width))));
    } else open(i);
  }));
  root.querySelector('[data-memory-activity]').addEventListener('click',()=>navigate('atlas',changedPage<<8));
  function theme() {
    const style = getComputedStyle(root);
    dirty = true;
    colours = ['--accent2','--info','--text'].map(key=>style.getPropertyValue(key).trim());
    quiet = style.getPropertyValue('--border').trim();
    accent = style.getPropertyValue('--accent').trim();
    dim = style.getPropertyValue('--dim').trim();
  }
  return {
    theme,
    update(snapshot,state,pages,ages,page,ram) {
      bank = state.vicBank; changedPage = page;
      const memory=snapshot.vicBanks[bank>>>14], screen=(state.vic[0x18]&240)<<6;
      for(let i=0;i<12;i++) {
        const value=i===0?bank:i===1?state.vic[0x11]&32:i===2?state.vic[0x18]:i===3?state.vic[0x15]:memory[screen+0x3f8+i-4];
        if(configuration[i]!==value){dirty=true;configuration[i]=value;}
      }
      if(dirty)groups=graphicsMemoryGroups(state,memory);
      for(const group of groups)for(const region of group.regions) {
        const source=graphicsSourceLabel(snapshot,region,bank);
        if(source!==region.source){dirty=true;region.source=source;}
      }
      activity.clearRect(0,0,768,12);
      for(let p=0;p<256;p++) { activity.fillStyle = pages[p]?accent:ages[p]?dim:quiet; activity.fillRect(p*3,0,2,12); }
      groups.forEach((group,i)=>{
        if(dirty) {
          const ranges = group.regions.map(r=>`$${hex(r.start)}–$${hex(r.start+r.size-1)} (${r.source})`);
          const title = ranges.length ? `${group.label}: ${ranges.join(', ')}. Open the decoded VIC source in Memory.` : 'No sprite slots enabled in this snapshot.';
          buttons[i].querySelector('span').textContent = group.label;
          buttons[i].disabled = !ranges.length; buttons[i].title = title;
          lanes[i].querySelector('span').textContent = group.label;
          lanes[i].disabled = !ranges.length; lanes[i].title = title;
          lanes[i].querySelector('canvas').setAttribute('aria-label',title);
          const ctx = contexts[i]; ctx.clearRect(0,0,768,8);ctx.fillStyle=quiet;ctx.fillRect(0,3,768,1);ctx.fillStyle=colours[i];
          for(const region of group.regions) ctx.fillRect(region.start/65536*768,0,Math.max(1,region.size/65536*768),8);
        }
        ram.fillStyle=colours[i];
        for(const region of group.regions) {
          for(let p=region.start>>>8;p<=(region.start+region.size-1)>>>8;p++) ram.fillRect(p%16*16+1+i*4,Math.floor(p/16)*12+8,4,3);
        }
      });
      dirty=false;
    },
  };
}
