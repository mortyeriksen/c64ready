// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { frameSummary } from './frame-summary.js';
import { SPRITE_OUTLINE_COLOUR } from './sprite-outline.js';

function node(tag,text,className) {
  const el=document.createElement(tag);if(text!==undefined)el.textContent=text;
  if(className)el.className=className;return el;
}
function button(text,action) {
  const el=node('button',text,'monitor-context-link');el.type='button';el.addEventListener('click',action);return el;
}

export function createFrameSummaryView(root,{chooseStory,inspectPixel}) {
  root.innerHTML='<div class="monitor-summary-main"><figure><canvas data-summary="picture" width="384" height="272" aria-label="Recorded C64 picture"></canvas></figure><article data-summary="prose" tabindex="-1" aria-label="Frame explanation"></article></div><section class="monitor-summary-findings" aria-label="Illustrated findings"><nav class="monitor-summary-navigation" data-summary="navigation" aria-label="Findings pages" hidden></nav><div class="monitor-summary-grabs" data-summary="grabs"></div></section>';
  const el=name=>root.querySelector(`[data-summary="${name}"]`);
  const source=document.createElement('canvas');source.width=384;source.height=272;
  const context=source.getContext('2d'),picture=el('picture').getContext('2d');
  let frame=null,summary=null,selected=null,selectedAction=null,page=0;
  const evidenceButtons=new Map();
  function drawPicture() {
    picture.clearRect(0,0,384,272);
    if(!frame)return;
    picture.drawImage(source,0,0);
    if(selected){picture.strokeStyle=SPRITE_OUTLINE_COLOUR;picture.lineWidth=1;for(const crop of selected.crops)picture.strokeRect(crop.x+.5,crop.y+.5,crop.w-1,crop.h-1);}
  }
  function abstract(restoreFocus=false) {
    const previousAction=selectedAction;selected=null;selectedAction=null;
    for(const actions of evidenceButtons.values())for(const action of actions)action.setAttribute('aria-expanded','false');const prose=el('prose');prose.replaceChildren();
    prose.append(node('h3',summary?.title??'Waiting for a complete frame'));
    for(const p of summary?.paragraphs??['A complete recording is needed for the illustrated summary. Resume the machine to record one.'])prose.append(node('p',p));
    if(summary?.facts.length){const facts=node('div',undefined,'monitor-summary-facts');for(const fact of summary.facts)facts.append(node('span',fact));prose.append(facts);}
    prose.scrollTop=0;drawPicture();
    if(restoreFocus)previousAction?.focus({preventScroll:true});
  }
  function evidence(card,action) {
    selected=card;selectedAction=action;const prose=el('prose');prose.replaceChildren();
    prose.append(button('← Back to TL;DR',()=>abstract(true)),node('h3',card.title),node('p',card.evidence));
    const links=node('div',undefined,'monitor-summary-links');
    if(card.storyId)links.append(button('Follow in the frame story →',()=>chooseStory(card.storyId)));
    if(card.point)links.append(button('Why this pixel? →',()=>inspectPixel(card.point)));
    prose.append(links);prose.scrollTop=0;drawPicture();
    for(const [item,actions] of evidenceButtons)for(const action of actions)action.setAttribute('aria-expanded',String(item===card));
    prose.focus({preventScroll:true});prose.scrollIntoView({block:'nearest'});
  }
  function drawCrop(canvas,card) {
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=false;
    card.crops.forEach((r,i)=>{
      const cw=card.stacked?canvas.width:canvas.width/card.crops.length,ch=card.stacked?canvas.height/card.crops.length:canvas.height;
      const scale=Math.min((cw-12)/r.w,(ch-8)/r.h),x=(card.stacked?0:i*cw)+(cw-r.w*scale)/2,y=(card.stacked?i*ch:0)+(ch-r.h*scale)/2;
      ctx.drawImage(source,r.x,r.y,r.w,r.h,x,y,r.w*scale,r.h*scale);
      if(card.point){ctx.strokeStyle=SPRITE_OUTLINE_COLOUR;ctx.lineWidth=1;ctx.strokeRect(x+(card.point.x-r.x)*scale-2,y+(card.point.y-r.y)*scale-2,scale+4,scale+4);}
    });
  }
  function theme() {if(!root.hidden)drawPicture();}
  function render(value) {
    if(frame===value&&summary)return;
    frame=value;summary=frameSummary(frame);selected=null;page=0;
    if(frame){const data=context.createImageData(frame.width,frame.height);data.data.set(frame.rgba);context.putImageData(data,0,0);}
    else context.clearRect(0,0,384,272);
    renderCards();abstract();theme();
  }
  function renderCards() {
    const navigation=el('navigation'),pages=Math.ceil((summary?.cards.length??0)/3);
    navigation.hidden=pages<=1;
    if(pages>1){
      let more=el('more');
      if(!more){
        more=button('',()=>{page=(page+1)%Math.ceil(summary.cards.length/3);renderCards();abstract();});
        more.classList.add('monitor-summary-more');more.dataset.summary='more';navigation.append(more);
      }
      more.textContent=`More findings · ${page+1} / ${pages} →`;
    }else navigation.replaceChildren();
    el('grabs').replaceChildren();evidenceButtons.clear();
    for(const [index,card] of (summary?.cards??[]).slice(page*3,page*3+3).entries()){
      const grab=node('article',undefined,'monitor-summary-grab');grab.dataset.summaryCard=card.id;
      const canvas=node('canvas');canvas.width=420;canvas.height=176;canvas.setAttribute('aria-label',`Picture context: ${card.title}`);
      const cutout=button(undefined,event=>evidence(card,event.currentTarget));cutout.className='monitor-summary-cutout';
      cutout.setAttribute('aria-label',`Inspect picture: ${card.title}`);cutout.setAttribute('aria-expanded','false');cutout.append(canvas);
      const action=button('See the evidence →',event=>evidence(card,event.currentTarget));action.classList.add('monitor-summary-evidence');
      action.setAttribute('aria-label',`See the evidence: ${card.title}`);action.setAttribute('aria-expanded','false');evidenceButtons.set(card,[cutout,action]);
      grab.append(cutout,node('strong',`${page*3+index+1}. ${card.title}`),node('span',card.text),action);
      el('grabs').append(grab);drawCrop(canvas,card);
    }
  }
  render(null);
  return {render,theme,overview(){page=0;renderCards();abstract();},clear(){frame=null;summary=null;render(null);}};
}
