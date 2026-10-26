// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const CYCLE_CATEGORIES = ['unknown','available','vic','reu','halted'];
export function cycleCategory(flags) {
  return !(flags & 1) ? 0 : flags & 8 ? 3 : flags & 16 ? 4 : flags & 4 ? 2 : 1;
}
export function lineBudgets(frame) {
  if (!frame) return [];
  return Array.from({length:frame.lines},(_,line)=>{
    const counts=new Uint16Array(5);
    for(let c=0;c<frame.cyclesPerLine;c++) counts[cycleCategory(frame.analysis?.bus[line*frame.cyclesPerLine+c]??0)]++;
    return counts;
  });
}
export function createCycleBudget(root, onSelect = ()=>{}, { slider = true } = {}) {
  root.innerHTML='<label>CPU time by raster line <input type="range" min="0" max="311" value="0" aria-label="Select budget raster line"></label><canvas width="624" height="48" aria-label="Each column shows CPU availability on one raster line"></canvas><small></small><canvas width="630" height="12" aria-label="CPU opportunities on selected line"></canvas>';
  if(!slider)root.querySelector('input').remove();
  root.classList.add('monitor-cycle-budget');
  const input=root.querySelector('input'), [map,detail]=root.querySelectorAll('canvas'), label=root.querySelector('small');
  let frame=null, rows=null, line=0;
  function draw(){
    const style=getComputedStyle(root), colours=['--dim','--accent','--amber','--accent2','--text'].map(name=>style.getPropertyValue(name).trim()||'#888');
    const ctx=map.getContext('2d'), dc=detail.getContext('2d'); ctx.clearRect(0,0,624,48); dc.clearRect(0,0,630,12);
    if(!frame) {label.textContent='Capture a frame with bus evidence.';return;}
    rows ??= lineBudgets(frame);
    for(let l=0;l<rows.length;l++) {let y=48; for(let k=0;k<5;k++){const height=48*rows[l][k]/frame.cyclesPerLine;ctx.globalAlpha=[.15,.95,.18,.6,.4][k];ctx.fillStyle=colours[k];ctx.fillRect(l*624/rows.length,y-height,624/rows.length,height);y-=height;}}
    ctx.globalAlpha=1;ctx.strokeStyle=colours[4];ctx.strokeRect(line*624/rows.length,0,Math.max(2,624/rows.length),48);
    for(let c=0;c<frame.cyclesPerLine;c++){const category=cycleCategory(frame.analysis?.bus[line*frame.cyclesPerLine+c]??0);dc.globalAlpha=[.15,.95,.18,.6,.4][category];dc.fillStyle=colours[category];dc.fillRect(c*630/frame.cyclesPerLine,0,630/frame.cyclesPerLine-1,12);}
    const r=rows[line]; label.textContent=`Line ${line}: CPU ${r[1]}/${frame.cyclesPerLine} · VIC stalls ${r[2]} · REU ${r[3]} · halted ${r[4]} · unknown ${r[0]}`;
    if(input)input.value=line;
  }
  function select(value){if(!frame)return;line=Math.max(0,Math.min(frame.lines-1,value));draw();onSelect(line*frame.cyclesPerLine);}
  input?.addEventListener('input',()=>select(Number(input.value)));
  map.addEventListener('click',event=>{const bounds=map.getBoundingClientRect();select(Math.floor((event.clientX-bounds.left)/bounds.width*(frame?.lines??0)));});
  return {setFrame(value,{render=true}={}){frame=value;rows=null;line=0;if(render){if(input){input.max=Math.max(0,(frame?.lines??1)-1);input.disabled=!frame;}draw();}},seek(tick){if(frame){line=Math.floor(Math.max(0,Math.min(frame.lines*frame.cyclesPerLine-1,tick))/frame.cyclesPerLine);}if(input){input.max=Math.max(0,(frame?.lines??1)-1);input.disabled=!frame;}draw();},theme:draw};
}
