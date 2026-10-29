// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';
import { InspectionSnapshot, INSPECTION_RATES, DEFAULT_INSPECTION_RATE } from './inspection-snapshot.js';
import { MemorySampler, hex, regionHint } from './memory-sampler.js';
import { createMemoryContext } from './memory-context.js';
import { createHelpDialogs } from './help-dialogs.js';
import { createStorageView } from './storage-view.js';
import { createControlView } from './control-view.js';
import { createMachineView } from './machine-view.js';
import { createSidView } from './sid-view.js';
import { createFrameView } from './frame-view.js';
import { createEvidenceView, createSectionEvidence } from './evidence-view.js';
import { createCodeView } from './code-view.js';
import { PREVIEWS, previewMask } from './preview.js';
import { menuIcon } from './menu-icons.js';
import { appAccel } from '../app-accel.js';
import './monitor.css';

const OVERLAY_SHORTCUTS = new Set(['KeyF', 'KeyX', 'KeyZ']);
const SAMPLING_RATE_KEY = 'c64emu.monitorSamplingRate';

// Machine access is limited to the supplied facade. Pause and power belong to
// the host loop, so their controls are supplied separately.
export function createMonitor({ getFacade, isPowered, isPaused, setPaused, releaseInput, presentFrame = () => {}, screen, mobileKeyboard, touchControls, logo, anchor }) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'btn-monitor';
  trigger.className = 'btn';
  trigger.innerHTML = '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4M5 10h3l2-3 4 6 2-3h3"/></svg> MONITOR';
  trigger.title = 'Explore the live C64 display and memory';
  trigger.disabled = anchor.disabled;
  anchor.after(trigger);
  const powerObserver = new MutationObserver(() => { trigger.disabled = anchor.disabled; });
  powerObserver.observe(anchor, { attributes: true, attributeFilter: ['disabled'] });

  let dialog = null;
  let inspectionPause = false;
  let navigationState = -1;
  let timer = null;
  let samplingRate = DEFAULT_INSPECTION_RATE;
  try {
    const saved = Number(localStorage.getItem(SAMPLING_RATE_KEY));
    if (INSPECTION_RATES.includes(saved)) samplingRate = saved;
  } catch {}
  let samplingButton;
  let facade = null;
  let selected = 4;
  let previousFocus = null;
  let sampler;
  let cells;
  let tilesCtx;
  let previewMode = 'context';
  let memoryContext;
  let pixels;
  let mask;
  let previewNote, previewSelect, atlasPanel, setupPanel, codePanel;
  let framePanel, frameView, sidPanel, sidView, storagePanel, storageView;
  let helpDialogs, componentGuide, guideLoading, guideRequest = 0, controlView, controlPanel, controlState;
  let evidenceViews = [];
  const evidenceHistory=[];
  let evidenceBack=null,evidenceFrame=null;
  let machineView, inspection, codeView, currentView = 'setup';
  let inspectBank = null, inspectKind = null;
  let nextFrameCaptureAt = 0;
  let viewDirty = true;
  let snapshotDirty = true, lastPaused = null, lastPresentation = -Infinity, presentationPending = false, refreshQueued = false;
  const presentationPages = new Uint16Array(256);
  let presentationSampler;
  let sourceLabel;
  const inspectBytes = new Uint8Array(256);
  let backgroundBytes, foregroundBytes;
  const moved = [];
  let pause, status, changeCount, details, bytes, selection;
  let background, foreground;
  const layer = { close, isOpen: () => !!dialog?.open };

  function readColours() {
    if (!dialog?.open) return;
    const style = getComputedStyle(dialog);
    background = style.getPropertyValue('--ui-bg').trim();
    foreground = style.getPropertyValue('--text').trim();
    tilesCtx.fillStyle = background; tilesCtx.fillRect(0, 0, 1, 1);
    backgroundBytes = tilesCtx.getImageData(0, 0, 1, 1).data;
    tilesCtx.fillStyle = foreground; tilesCtx.fillRect(0, 0, 1, 1);
    foregroundBytes = tilesCtx.getImageData(0, 0, 1, 1).data;
    drawTiles();
    viewDirty = true;
    machineView?.theme();
    frameView?.theme();
    codeView?.theme();
    for(const view of evidenceViews) view.theme();
    storageView?.theme();
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.id = 'machine-monitor';
    dialog.className = 'machine-monitor';
    dialog.setAttribute('aria-labelledby', 'monitor-title');
    dialog.innerHTML = `
      <header class="monitor-header">
        <div class="monitor-brand"><div data-monitor="logo"><h1 id="monitor-title">MONITOR <span class="monitor-beta">Beta</span></h1></div></div>
      <nav class="monitor-nav" aria-label="Monitor views"><div class="monitor-machine-controls" data-monitor="machine-controls"><button class="btn" type="button" data-monitor="pause" aria-label="Pause" title="Pause"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path class="monitor-pause-icon" d="M6 4h4v16H6zm8 0h4v16h-4z"/><path class="monitor-resume-icon" d="M7 3v18l14-9z"/></svg><span data-monitor="status" role="status"></span></button></div>${[['setup','Live'],['code','Code'],['atlas','Memory'],['frame','Video'],['sid','Sound'],['controls','Controls'],['storage','Storage']].map(([view,label])=>`<button type="button" class="btn" data-view="${view}" aria-pressed="${view==='setup'}">${menuIcon(view)}<span>${label}</span></button>`).join('')}<div class="monitor-actions"><button class="btn" type="button" data-monitor="close">${menuIcon('back')}<span>Back to C64</span></button></div></nav>
      <section class="monitor-card monitor-screen-card" aria-label="C64 display">
          <div class="monitor-display" data-monitor="display" title="Click to pause and inspect the shared frame in Video"></div>

        </section>
      </header>

      <div class="monitor-workspace is-overview">
        <section class="monitor-card monitor-setup" data-monitor="setup" aria-label="Live machine overview"><div data-monitor="machine" class="monitor-machine"></div></section>
        <section class="monitor-card monitor-storage" data-monitor="storage" aria-label="Storage and memory expansion" hidden></section>
        <section class="monitor-card monitor-sid" data-monitor="sid" aria-label="SID sound inspection" hidden></section>
        <section class="monitor-card monitor-frame" data-monitor="frame" aria-label="Video replay" hidden></section>
        <section class="monitor-card monitor-controls-page" data-monitor="controls" aria-label="Controls and CIA timing" hidden><div class="monitor-section-head monitor-page-head"><p class="monitor-page-intro">Highlighted pins are active. Follow inputs and timers.</p></div><div class="monitor-controls-content"></div></section>
        <section class="monitor-card monitor-code" data-monitor="code" aria-label="CPU-visible code" hidden></section>
        <section class="monitor-card monitor-atlas" data-monitor="atlas" aria-label="Memory" hidden>
          <div class="monitor-section-head monitor-page-head"><p class="monitor-page-intro">Choose a picture to find its bytes in memory.</p></div>
          <div class="monitor-memory-sources" data-monitor="memory-sources"></div>
          <div class="monitor-map-labels"><span>$0000</span><span>$0FFF</span></div>
          <div class="monitor-memory-grid" role="group" aria-label="RAM pages, use arrow keys to select" data-monitor="map"></div>
          <div class="monitor-map-labels"><span>$F000</span><span>$FFFF</span></div>
          <div class="monitor-memory-activity-key"><div class="monitor-legend"><span><i></i>Quiet</span><span><i class="was-changing"></i>This visit</span><span><i class="is-changing"></i>Now</span></div>
          <p class="monitor-count" data-monitor="changes"></p></div>
          <div class="monitor-memory-tools">
          <div class="monitor-presets"><button type="button" class="btn" data-page="0">Zero page</button><button type="button" class="btn" data-page="1">Stack</button></div>
          <div class="monitor-memory-shortcuts" data-monitor="memory-shortcuts" aria-label="Current configured memory locations"></div><p class="monitor-note monitor-memory-map-key">S: screen cells · C: characters · B: bitmap · ●: sprites. Fill shows RAM changes.</p>
          <details class="monitor-help"><summary>About this map</summary><p>Underlying RAM from the shared snapshot at the selected sampling rate. Select a square or use arrow keys. ROM, I/O and colour RAM are separate. Changes between samples can be missed. Highlights show differences, not every write.</p></details></div>
        </section>
        <section class="monitor-card monitor-inspector" aria-labelledby="monitor-selection-title" hidden>
          <h2 id="monitor-selection-title" data-monitor="selection"></h2>
          <span class="monitor-tag" data-monitor="source">Underlying RAM</span>
          <label class="monitor-field">View<select data-monitor="preview"><option value="context">Explain this region</option><option value="tiles">8 × 8 monochrome tiles</option><option value="upper">ROM screen codes: uppercase / graphics</option><option value="lower">ROM screen codes: lowercase / uppercase</option><option value="sprites">24 × 21 monochrome sprites</option></select></label>
          <div class="monitor-memory-context" data-monitor="memory-context"></div>
          <canvas hidden data-monitor="tiles" width="64" height="32" aria-label="Selected RAM interpreted as 32 monochrome 8 by 8 tiles"></canvas>
          <details class="monitor-help"><summary>What am I looking at?</summary><p data-monitor="details"></p><p class="monitor-note" data-monitor="preview-note"></p></details>
          <details class="monitor-help"><summary>Hexadecimal bytes</summary><pre data-monitor="bytes" tabindex="0" aria-label="Selected RAM bytes"></pre></details>
        </section>
      </div>`;
    document.body.append(dialog);
    evidenceBack=document.createElement('button');evidenceBack.type='button';evidenceBack.className='btn monitor-evidence-back';evidenceBack.hidden=true;
    evidenceBack.addEventListener('click',()=>{const previous=evidenceHistory.pop();if(!previous)return;showView(previous.view);previous.restore?.();updateEvidenceBack();});

    const el = name => dialog.querySelector(`[data-monitor="${name}"]`);
    pause = el('pause'); status = el('status'); changeCount = el('changes');
    details = el('details'); bytes = el('bytes'); selection = el('selection');
    tilesCtx = el('tiles').getContext('2d');
    mask = new Uint8Array(128 * 128);
    previewNote = el('preview-note'); previewSelect = el('preview');
    atlasPanel = el('atlas'); setupPanel = el('setup'); codePanel = el('code'); sourceLabel = el('source');
    storagePanel = el('storage'); storageView = createStorageView(storagePanel, inspectAddress, address => { showView('code'); codeView.openAddress(address); }, {
      openFrame: openCapturedVideo,
      openCapturedMemory,
    });
    sidPanel = el('sid'); sidView = createSidView(sidPanel);
    framePanel = el('frame'); frameView = createFrameView(framePanel, openCapturedCode, openCapturedMemory, { onReplay: pauseForInspection });
    machineView = createMachineView(el('machine'), inspectComponent, openComponentGuide);
    samplingButton = el('sampling-rate');
    samplingButton.addEventListener('click', () => {
      samplingRate = INSPECTION_RATES[(INSPECTION_RATES.indexOf(samplingRate) + 1) % INSPECTION_RATES.length];
      try { localStorage.setItem(SAMPLING_RATE_KEY, String(samplingRate)); } catch {}
      inspection?.setRate(samplingRate);
      updateSamplingButton(); viewDirty=true; restartTimer(); sample();
    });
    updateSamplingButton();
    controlPanel=el('controls');
    controlView=createControlView(controlPanel.querySelector('.monitor-controls-content'));
    codeView = createCodeView(codePanel, address => inspectAddress(address), {
      isPaused,
      openFrame: (current,frame,position)=>openCapturedVideo(frame,position),
      openEvidenceFrame: openCapturedVideo,
      openMemory: openCapturedMemory,
    });
    evidenceViews = [codeView.execution, ...[[atlasPanel,'atlas'],[sidPanel,'sid'],[storagePanel,'storage']].map(([panel,kind])=>(kind==='storage'?createEvidenceView:createSectionEvidence)(panel,kind,openCapturedVideo,openCapturedMemory,{openCode:openCapturedCode,onPosition:pauseForInspection,recentPane:kind==='sid'?sidView.recentPane:null}))];
    for (const [panel,heading,key] of [
      [setupPanel,'.monitor-machine-heading','machine'],[codePanel,'.monitor-code-modes','cpu'],
      [atlasPanel,'.monitor-section-head','memory'],[framePanel,'.monitor-video-modes','vic'],
      [sidPanel,'.monitor-section-head','sid'],[controlPanel,'.monitor-section-head','cia'],
      [storagePanel,'.monitor-storage-tabs','storage'],
    ]) {
      const about=document.createElement('button'); about.type='button'; about.className='monitor-section-about';
      about.textContent='About'; about.dataset.sectionAbout=key;
      about.addEventListener('click',()=>openComponentGuide(key==='storage'?['drive','drive','tape','crt','reu'][storageView.selected]:key));
      (panel.querySelector('.monitor-evidence-modes')??panel.querySelector(heading)).append(about);
    }
    previewSelect.addEventListener('change', () => { previewMode = previewSelect.value; drawTiles(); });
    el('display').addEventListener('click', event => { if (event.target === screen) captureMoment(); });
    sampler = new MemorySampler();
    presentationSampler = { pages:presentationPages, observedPages:sampler.observedPages, changed:0 };
    cells = [];
    for (let page = 0; page < 256; page++) {
      const cell = document.createElement('button');
      cell.type = 'button'; cell.dataset.page = page;
      cell.setAttribute('aria-label', `$${hex(page << 8)} to $${hex((page << 8) + 255)}`);
      cell.title = `$${hex(page << 8)}–$${hex((page << 8) + 255)}`;
      cell.tabIndex = page === selected ? 0 : -1;
      cell.setAttribute('aria-pressed', String(page === selected));
      el('map').append(cell); cells.push(cell);
    }
    memoryContext = createMemoryContext(el('memory-context'), el('memory-shortcuts'), cells, (target,address,bank,kind) => {
      if (target === 'captured-pixel') followEvidence(kind,()=>{showView('frame');frameView.openPixel(getFacade(),kind,address,bank);});
      else if (target === 'captured-video') openCapturedVideo(kind,address);
      else if (target === 'captured-ram') openCapturedMemory(kind,bank,address);
      else if (target === 'context') {previewMode='context';previewSelect.value='context';drawSelection();}
      else if (target === 'vic') inspectAddress(address,'context',bank,kind);
      else if (target === 'address') inspectAddress(address);
      else if (target === 'code') { showView('code'); codeView.openAddress(address); }
      else showView('frame');
    },el('memory-sources'));
    dialog.addEventListener('click', event => {
      if(isPaused()){viewDirty=true;queueMicrotask(()=>sample());}
      const target = event.target.closest('[data-page]');
      if (target) selectPage(Number(target.dataset.page));
      const view = event.target.closest('button[data-view]');
      if (view) {
        clearEvidenceHistory();
        if(view.dataset.view==='frame')frameView.showSummary();
        showView(view.dataset.view);
      }
    });
    el('map').addEventListener('keydown', event => {
      let page = selected;
      if (event.key === 'ArrowRight') page++;
      else if (event.key === 'ArrowLeft') page--;
      else if (event.key === 'ArrowDown') page += 16;
      else if (event.key === 'ArrowUp') page -= 16;
      else if (event.key === 'Home') page = 0;
      else if (event.key === 'End') page = 255;
      else return;
      event.preventDefault();
      selectPage(Math.max(0, Math.min(255, page)));
      cells[selected].focus();
    });
    // The original display and soft keyboard keep their input handlers. Other
    // controls own their keys, while key releases always reach the host.
    for (const name of ['keydown', 'keypress', 'paste', 'drop', 'dragover']) {
      dialog.addEventListener(name, event => {
        // Overlays outside this modal cannot receive focus. Clipboard, theme
        // cycling and queued-disk shortcuts remain available from the display.
        if (name === 'keydown' && appAccel(event, false) && OVERLAY_SHORTCUTS.has(event.code)) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        if (event.target === screen || event.target === mobileKeyboard) {
          if (name !== 'drop' && name !== 'dragover') return;
        }
        event.stopPropagation();
        if (name === 'drop' || name === 'dragover') event.preventDefault();
      });
    }
    helpDialogs = createHelpDialogs(dialog);
    el('close').addEventListener('click', close);
    pause.addEventListener('click', () => {
      if (!isPowered()) { close(); return; }
      inspectionPause = false;
      setPaused(!isPaused());
      collectFrame();
      if (!isPaused()) nextFrameCaptureAt = 0;
      if (isPaused()) facade?.cancelVicFrameCapture();
      viewDirty = true; sample();
      screen.focus();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
    document.addEventListener('visibilitychange', () => {
      if (dialog.open && document.hidden) { facade?.setStorageMonitoring(false);facade?.setMonitorActivityMonitoring?.(false); codeView?.deactivate(); frameView?.deactivate(); facade?.cancelVicFrameCapture(); }
      else if(dialog.open) { if(currentView==='code')codeView.activate(); snapshotDirty=true;viewDirty=true; sample(); }
    });
    window.addEventListener('c64-monitor-refresh', queueRefresh);
    for(const type of ['keydown','keyup','pointerdown','pointerup','input','change','paste']) document.addEventListener(type,event=>{
      if(!dialog.open||!isPaused())return;
      const target=event.target;
      if(target===screen||mobileKeyboard?.contains(target)||touchControls?.contains(target)||!dialog.contains(target))queueRefresh();
    },true);
    window.addEventListener('c64-theme', readColours);
    window.addEventListener('c64-appearance', readColours);
    showView(currentView);
  }

  async function openComponentGuide(key) {
    const request = ++guideRequest;
    guideLoading ||= import('./component-guide.js');
    const { createComponentGuide } = await guideLoading;
    if (!dialog.open || request !== guideRequest) return;
    componentGuide ||= createComponentGuide(dialog, (view, id) => inspectComponent(view, {drive:0,tape:2,crt:3,reu:4}[id]));
    componentGuide.open(key);
  }

  function inspectComponent(view, value) {
    if (view === 'atlas' && value !== undefined) {
      if (typeof value === 'object') inspectAddress(value.address,'context',value.bank,value.kind);
      else inspectAddress(value);
      return;
    }
    if(view==='frame')frameView.showSummary();
    showView(view);
    if (view === 'sid' && value !== undefined) { evidenceViews[2].live();sidView.selectChip(value.chip); }
    if (view === 'storage' && value !== undefined) storageView.select(value);
  }

  function showView(view) {
    collectFrame();
    const captureForInspection = !!dialog.open && view !== 'setup' && !isPaused();
    if (captureForInspection) { setPaused(true); inspectionPause = true; snapshotDirty = true; }
    if (dialog.open && view === 'setup' && inspectionPause) {
      inspectionPause = false; setPaused(false); snapshotDirty = true; nextFrameCaptureAt = 0;
    }
    guideRequest++;
    componentGuide?.close();
    if (view === 'setup') machineView.activate(sampler);
    if (currentView === 'code' && view !== 'code') codeView.deactivate();
    if (currentView === 'frame' && view !== 'frame') frameView.deactivate();
    helpDialogs?.close();
    for (const detail of dialog.querySelectorAll('details[open]')) detail.open = false;
    currentView = view;
    dialog.querySelector('.monitor-workspace').scrollTop = 0;
    sidPanel.hidden = view !== 'sid';
    controlPanel.hidden = view !== 'controls';
    storagePanel.hidden = view !== 'storage';
    dialog.querySelector('.monitor-workspace').dataset.view = view;
    framePanel.hidden = view !== 'frame';
    dialog.querySelector('.monitor-inspector').hidden = view === 'frame' || view === 'setup' || view === 'sid' || view === 'code' || view === 'learn' || view === 'storage' || view === 'controls';
    dialog.querySelector('.monitor-workspace').classList.toggle('is-overview', view === 'setup');
    dialog.querySelector('.monitor-workspace').classList.toggle('is-frame', view === 'frame');
    atlasPanel.hidden = view !== 'atlas';
    setupPanel.hidden = view !== 'setup';
    codePanel.hidden = view !== 'code';
    if(view==='code')codeView.activate();
    evidenceViews[1]?.setActive(view==='atlas');evidenceViews[2]?.setActive(view==='sid');
    for (const button of dialog.querySelectorAll('button[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === (view === 'learn' ? 'frame' : view)));
    viewDirty = true;
    if (dialog.open) sample(captureForInspection);
    if (view === 'storage') storageView.selectActive();
    updateEvidenceBack();
  }

  function clearEvidenceHistory(){evidenceHistory.length=0;evidenceFrame=null;if(evidenceBack)evidenceBack.hidden=true;}
  function updateEvidenceBack(){
    if(!evidenceBack)return;
    const previous=evidenceHistory.at(-1);evidenceBack.hidden=!previous;
    if(!previous)return;
    evidenceBack.textContent=`← Back to ${{frame:'Video',code:'Code',atlas:'Memory',sid:'Sound',storage:'Storage'}[previous.view]??'evidence'}`;
    const panel=dialog.querySelector(`[data-monitor="${currentView}"]`),head=panel?.querySelector('.monitor-section-modes,.monitor-storage-tabs,.monitor-section-head');
    if(head)head.insertBefore(evidenceBack,head.querySelector('.monitor-section-about'));
  }
  function followEvidence(frame,open){
    if(frame!==evidenceFrame){clearEvidenceHistory();evidenceFrame=frame;}
    const source=currentView==='frame'?frameView:currentView==='code'?codeView:evidenceViews[{atlas:1,sid:2,storage:3}[currentView]];
    const restore=source?.remember?.();
    evidenceHistory.push({view:currentView,restore});if(evidenceHistory.length>8)evidenceHistory.shift();
    pauseForInspection();
    if(frameView.frame!==frame)shareFrame(frame);
    open();updateEvidenceBack();
  }
  function openCapturedMemory(frame,tick,address){followEvidence(frame,()=>{showView('atlas');evidenceViews[1].inspect(frame,tick,address);});}
  function openCapturedVideo(frame,tick){followEvidence(frame,()=>{showView('frame');frameView.inspect(getFacade(),frame,tick);});}
  function openCapturedCode(address,origin,frame,tick){
    if(!frame){showView('code');codeView.openAddress(address,origin);return;}
    followEvidence(frame,()=>{showView('code');codeView.openAddress(address,origin,frame,tick);});
  }

  function inspectAddress(address, mode = 'context', bank = null, kind = null) {
    evidenceViews[1]?.live();
    previewMode = mode; previewSelect.value = mode;
    selectPage((address & 65535) >>> 8);
    inspectBank = bank; inspectKind = kind;
    showView('atlas');
    drawSelection();
  }

  function pauseForInspection() {
    if (!isPaused()) { setPaused(true); snapshotDirty=true;queueMicrotask(()=>sample()); }
    facade?.cancelVicFrameCapture();
    viewDirty = true;
  }

  function captureMoment() {
    if (!isPowered() || !getFacade()?.ready) return;
    collectFrame(); pauseForInspection(); showView('frame');
  }

  function shareFrame(frame) {
    if(evidenceFrame&&frame!==evidenceFrame)clearEvidenceHistory();
    if (!frame || !facade) return;
    frameView.accept(facade, frame);
    codeView.accept(facade, frame);
    storageView.setFrame(frame);
    machineView.setFrame(frame);
    memoryContext?.setFrame(frame);
    viewDirty=true;
    for (const view of evidenceViews) view.setFrame(frame);
    nextFrameCaptureAt = performance.now() + 1000;
  }

  function collectFrame() {
    if (facade?.vicFrameCaptureStatus() === 'ready') shareFrame(facade.takeVicFrameCapture());
  }

  function selectPage(page) {
    memoryContext?.clearCaptured();
    inspectBank = null; inspectKind = null;
    cells[selected].setAttribute('aria-pressed', 'false');
    cells[selected].tabIndex = -1;
    selected = page;
    cells[selected].setAttribute('aria-pressed', 'true');
    cells[selected].tabIndex = 0;
    drawSelection();
  }

  function drawTiles() {
    if (!tilesCtx || !sampler.initialized) return;
    const contextual = previewMode === 'context';
    dialog.querySelector('[data-monitor="memory-context"]').hidden = !contextual;
    tilesCtx.canvas.hidden = contextual;
    if (contextual) { previewNote.textContent = 'Uses current register configuration. Memory may serve several purposes, and settings can change during a frame.'; return; }
    const spec = PREVIEWS[previewMode];
    if (!pixels || pixels.width !== spec.width || pixels.height !== spec.height) {
      tilesCtx.canvas.width = spec.width; tilesCtx.canvas.height = spec.height;
      pixels = tilesCtx.createImageData(spec.width, spec.height);
    }
    const rom = inspection?.charRom();
    previewNote.textContent = ((previewMode === 'upper' || previewMode === 'lower') && !rom) ? 'Character ROM is unavailable.' : spec.note;
    tilesCtx.canvas.setAttribute('aria-label', previewSelect.selectedOptions[0].textContent);
    previewMask(inspectBytes, 0, previewMode, rom, mask);
    for (let index = 0; index < spec.width * spec.height; index++) {
      const colour = mask[index] ? foregroundBytes : backgroundBytes;
      const offset = index * 4;
      pixels.data[offset] = colour[0]; pixels.data[offset + 1] = colour[1]; pixels.data[offset + 2] = colour[2]; pixels.data[offset + 3] = 255;
    }
    tilesCtx.putImageData(pixels, 0, 0);
  }

  function drawSelection() {
    memoryContext?.select(selected,inspectBank,inspectKind);
    const sourceTitle=memoryContext?.sourceTitle??null,captured=sourceTitle!==null;
    previewSelect.parentElement.hidden=captured;
    details.closest('details').hidden=captured;bytes.closest('details').hidden=captured;
    if(captured){selection.textContent=sourceTitle;sourceLabel.textContent=memoryContext.sourceCaption;drawTiles();return;}
    const start = selected << 8;
    selection.textContent = `$${hex(start)}–$${hex(start + 255)}`;
    if (inspectBank === null) {
      for (let i = 0; i < 256; i++) inspectBytes[i] = sampler.bytes[start + i];
      sourceLabel.textContent = `Underlying RAM · 256 bytes`;
    } else {
      inspection.copyVicMemory(start & 0x3FFF, inspectBytes, inspectBank);
      sourceLabel.textContent = `VIC-visible ${inspection.vicMemorySource(start & 0x3FFF, inspectBank)} · bank $${hex(inspectBank)}`;
    }
    details.textContent = regionHint(selected);
    let text = '';
    for (let row = 0; row < 32; row++) {
      const address = start + row * 8;
      text += `$${hex(address)}  `;
      for (let col = 0; col < 8; col++) text += hex(inspectBytes[row * 8 + col], 2) + ' ';
      text += '\n';
    }
    bytes.textContent = text;
    drawTiles();
  }

  function updateSamplingButton() {
    const next = INSPECTION_RATES[(INSPECTION_RATES.indexOf(samplingRate) + 1) % INSPECTION_RATES.length];
    samplingButton.textContent = `↻ ${samplingRate} samples/s`;
    samplingButton.setAttribute('aria-label', `Sampling rate: ${samplingRate} samples per second. Change to ${next}.`);
    samplingButton.title = 'Cycle sampling rate: 1 → 10 → 25 → 50 per second. Detailed frame recording keeps its own schedule.';
  }

  function queueRefresh() {
    if(!dialog?.open||refreshQueued)return;
    refreshQueued=true;
    queueMicrotask(()=>{refreshQueued=false;refresh();});
  }

  function refresh() {
    snapshotDirty=true;viewDirty=true;
    if(dialog?.open&&!document.hidden)sample();
  }

  function restartTimer() {
    clearInterval(timer); timer = null;
    // Keep frame polling and replay responsive even at one live sample/s.
    if (dialog?.open) timer = setInterval(sample, isPaused()?100:Math.min(100, 1000 / samplingRate));
  }

  function sample(capturePausedEntry = false) {
    if (!dialog.open || document.hidden) return;
    const current = getFacade();
    if (!isPowered() || !current?.ready) { close(); return; }
    if (current !== facade) {
      clearEvidenceHistory();
      facade?.cancelVicFrameCapture();
      facade?.setStorageMonitoring(false);facade?.setMonitorActivityMonitoring?.(false);
      codeView.clear();
      frameView.deactivate(true);
      for(const view of evidenceViews)view.setFrame(null);
      memoryContext?.setFrame(null);
      storageView.reset();
      facade = current; inspection = new InspectionSnapshot(facade, samplingRate);
      nextFrameCaptureAt = 0;
      sampler.reset(); machineView.reset(); viewDirty = true; snapshotDirty=true;lastPaused=null;lastPresentation=-Infinity;
    }
    if (capturePausedEntry && isPaused()) {
      try {
        facade.requestVicFrameCapture({ analysis: true, provenance: true });
        // Reach the next boundary, then record one whole frame. The host stays paused.
        for (let step = 0; step < 2 && facade.vicFrameCaptureStatus() !== 'ready'; step++) facade.runFrame();
        collectFrame();
        presentFrame();
      } finally {
        facade.cancelVicFrameCapture();
      }
    }
    collectFrame();
    const now = performance.now();
    if (!dialog.querySelector('.monitor-component-guide[open]') && !isPaused() && now >= nextFrameCaptureAt && (facade.vicFrameCaptureStatus() === 'idle' || facade.vicFrameCaptureStatus() === 'cancelled')) {
      facade.requestVicFrameCapture({ analysis: true, provenance: true });
      nextFrameCaptureAt = now + 1000;
    }
    facade.setStorageMonitoring(true);facade.setMonitorActivityMonitoring?.(true);
    const stoppedAtSample=isPaused(), transition=lastPaused!==stoppedAtSample;
    if(transition){snapshotDirty=true;viewDirty=true;lastPaused=stoppedAtSample;restartTimer();}
    const updated = (snapshotDirty||!stoppedAtSample) && inspection.capture(now,snapshotDirty);
    if(updated)snapshotDirty=false;
    const state = inspection.state;
    controlState = inspection.controls;
    if (updated) {
      sampler.sample(inspection.bytes);
      storageView.update(inspection,false);
      if(currentView==='setup')machineView.observe(inspection,state,sampler,inspection.storage,stoppedAtSample);
      if(currentView==='atlas'&&!atlasPanel.classList.contains('is-captured-evidence'))memoryContext.observe(inspection,state,sampler,stoppedAtSample);
      presentationPending=true;
    }
    if (viewDirty || (presentationPending && now-lastPresentation>=100)) {
      if(presentationPending)presentationSampler.changed=sampler.consumeInterval(presentationPages);
      changeCount.textContent=`${presentationSampler.changed.toLocaleString()} byte locations changed since the previous update`;
      const storage = storageView.update(inspection, currentView === 'storage');
      if (currentView === 'atlas'&&!atlasPanel.classList.contains('is-captured-evidence')) {
        for (let page = 0; page < 256; page++) {
          cells[page].classList.toggle('was-changing', sampler.observedPages[page] > 0);
          cells[page].classList.toggle('is-changing', !!presentationPages[page]);
        }
        drawSelection(); memoryContext.update(inspection,state,sampler,stoppedAtSample);
      }
      if (currentView === 'setup') machineView.update(inspection,state,presentationSampler,storage,stoppedAtSample,controlState);
      if (currentView === 'controls') controlView.update(controlState);
      if (currentView === 'sid') sidView.update(state,inspection.activity,stoppedAtSample,now);
      if (currentView === 'code') codeView.update(inspection, state);
      viewDirty=false;presentationPending=false;lastPresentation=now;
    }
    // The fast UI tick only services pending recordings and replay animation.
    if (currentView === 'frame') frameView.update(facade, isPaused());
    if (currentView === 'code') codeView.poll(facade);
    const stopped = isPaused();
    if(status.textContent!==(stopped?'Paused':'Running')) {
      status.textContent = stopped ? 'Paused' : 'Running';
      status.hidden = false;
      const pauseLabel = stopped ? 'Resume' : 'Pause';
      pause.setAttribute('aria-label', pauseLabel);
      pause.title = pauseLabel;
      pause.setAttribute('aria-pressed', String(stopped));
    }

    const nextNavigationState = (stopped ? 1 : 0) | (inspectionPause ? 2 : 0);
    if (navigationState !== nextNavigationState) {
      navigationState = nextNavigationState;
      for (const button of dialog.querySelectorAll('.monitor-nav button[data-view]')) {
        const live = button.dataset.view === 'setup';
        button.title = live ? (inspectionPause ? 'Return to live view and resume' : 'Show live overview') : `${stopped ? 'Inspect' : 'Pause and inspect'} ${button.querySelector('span').textContent}`;
      }
    }
  }

  function cleanup() {
    const resumeOnExit = moved.length > 0 && isPowered() && isPaused();
    inspectionPause = false;
    clearEvidenceHistory();
    clearInterval(timer); timer = null;
    facade?.setStorageMonitoring(false);facade?.setMonitorActivityMonitoring?.(false);
    facade?.cancelVicFrameCapture();
    codeView?.deactivate();
    codeView?.clear();
    for(const view of evidenceViews) view.setFrame(null);
    memoryContext?.setFrame(null);
    frameView?.deactivate(true);
    storageView?.reset();
    machineView?.reset();
    guideRequest++;
    componentGuide?.close();
    helpDialogs?.close();
    for (const detail of dialog.querySelectorAll('details[open]')) detail.open = false;
    popEscapeLayer(layer);
    facade = null; inspection = null; viewDirty = true;snapshotDirty=true;lastPaused=null;presentationPending=false;
    for (const { element, placeholder } of moved) placeholder.replaceWith(element);
    moved.length = 0;
    previousFocus?.focus();
    previousFocus = null;
    if (resumeOnExit) setPaused(false);
  }

  function close() {
    if (!dialog?.open) return;
    if (document.pointerLockElement === screen) document.exitPointerLock();
    dialog.close();
    cleanup();
  }

  function moveInto(element, target) {
    if (!element) return;
    const placeholder = document.createComment('Monitor return position');
    element.before(placeholder);
    moved.push({ element, placeholder });
    target.append(element);
  }

  function open() {
    if (!isPowered() || !getFacade()?.ready || dialog?.open) return;
    if (!dialog) build();
    previousFocus = document.activeElement;
    releaseInput();
    sampler.reset();
    showView('setup');
    const display = dialog.querySelector('[data-monitor="display"]');
    moveInto(screen, display);
    moveInto(mobileKeyboard, display);
    moveInto(touchControls, display);
    moveInto(logo, dialog.querySelector('[data-monitor="logo"]'));
    dialog.showModal();
    pushEscapeLayer(layer);
    readColours(); sample(true);
    restartTimer();
    screen.focus();
  }

  trigger.addEventListener('click', open);
  return { open, close, refresh };
}
