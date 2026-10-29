// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';

const guides={machine:['Inside the C64','OVERVIEW'],cpu:['The 6510 CPU','CPU'],memory:['Memory and banking','MEMORY'],vic:['The VIC-II','VIC'],sid:['The SID','SID'],cia:['CIA and control interfaces','CIA'],drive:['The 1541 disk drive','DRIVE'],tape:['The Datasette','TAPE'],crt:['Cartridges','CRT'],reu:['RAM expansion','REU']};
const destinations={machine:'setup',cpu:'code',memory:'atlas',vic:'frame',sid:'sid',cia:'controls',drive:'storage',tape:'storage',crt:'storage',reu:'storage'};

export function createComponentGuide(root,inspect) {
  const dialog=document.createElement('dialog'); dialog.className='monitor-component-guide';
  dialog.setAttribute('aria-labelledby','monitor-component-guide-title');
  dialog.innerHTML='<header><h2 id="monitor-component-guide-title"></h2><button class="monitor-help-close" aria-label="Close component guide">×</button></header><nav aria-label="Component guides"></nav><article></article><footer><button class="btn" data-guide-inspect>Inspect in Monitor</button><a target="_blank" rel="noopener" data-guide-document>Open full document ↗</a></footer>';
  root.append(dialog);
  const title=dialog.querySelector('h2'), body=dialog.querySelector('article'), doc=dialog.querySelector('[data-guide-document]');
  let key='cpu', opener=null, request=0;
  const layer={isOpen:()=>dialog.open,close:()=>close()};
  function close(restoreFocus=true) {
    if(!dialog.open) return;
    request++; dialog.close(); popEscapeLayer(layer);
    const target=opener; opener=null;
    if(restoreFocus&&root.open&&target?.isConnected) target.focus();
  }
  for(const [id,[name]] of Object.entries(guides)) {
    const button=document.createElement('button'); button.type='button'; button.textContent=name; button.dataset.guide=id;
    button.addEventListener('click',()=>open(id)); dialog.querySelector('nav').append(button);
  }
  async function open(id) {
    if(!guides[id]) return; key=id; const token=++request;
    if(!dialog.open) { opener=document.activeElement; dialog.showModal(); pushEscapeLayer(layer); dialog.querySelector('.monitor-help-close').focus(); }
    title.textContent=guides[id][0]; doc.href=id==='machine'?'/docs/inside-the-c64.html':`/docs/component-guide-${guides[id][1].toLowerCase()}.html`;
    dialog.querySelectorAll('[data-guide]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.guide===id)));
    body.textContent='Loading component guide…';
    try {
      const url=doc.href;
      const response=await fetch(url);
      if(!response.ok)throw new Error('Guide unavailable');
      const html=await response.text();
      if(token!==request||!dialog.open)return;
      const article=new DOMParser().parseFromString(html,'text/html').querySelector('article.doc-content');
      if(!article)throw new Error('Guide content missing');
      // The dialog supplies its own title and chapter navigation.
      article.querySelectorAll(':scope > h1, :scope > .crumbs, :scope > .guide-pager, .anchor').forEach(el=>el.remove());
      for(const link of article.querySelectorAll('a')) {
        const href=link.getAttribute('href');
        if(href && !href.startsWith('#')) { link.href=new URL(href,url).href; link.target='_blank';link.rel='noopener'; }
      }
      body.replaceChildren(...article.childNodes);
      body.scrollTop=0;
    } catch { if(token===request)body.textContent='The guide could not be loaded. Open the full document using the link below.'; }
  }
  dialog.querySelector('.monitor-help-close').addEventListener('click',layer.close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();layer.close();});
  dialog.addEventListener('close',()=>{if(!dialog.open)popEscapeLayer(layer);});
  dialog.querySelector('[data-guide-inspect]').addEventListener('click',()=>{const target=destinations[key];close(false);inspect(target,key);});
  return {open,close};
}
