import assert from 'node:assert/strict';
import { readAsset } from './external-assets.js';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('**/monitor-fixture*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/src/styles/styles.css"></head><body><button id="anchor">Pause</button><canvas id="screen" tabindex="0" width="384" height="272"></canvas><script type="module">
    import { createMonitor } from '/src/monitor/monitor.js';
    import { MachineFacade } from '/src/machine-facade.js';
    const ram = new Uint8Array(65536);
    let paused = false, powered = true;
    window.fixture = { ram, samples: 0, inspections: 0, storageSamples: 0, frames: 0, pauses: 0, released: 0, keys: 0, pastes: 0 };
    const facade = Object.freeze({ setStorageMonitoring: active => { fixture.storageMonitoring = active; }, createStorageInspection: MachineFacade.prototype.createStorageInspection, inspectStorageInto: out => { fixture.storageSamples++; return out; }, createInspectionState: MachineFacade.prototype.createInspectionState, inspectInto: out => { fixture.inspections++; Object.assign(out,fixture.cpu || {}); return out; }, copyCpuMemory: (address, out) => { for (let i=0;i<out.length;i++) out[i]=ram[(address+i)&65535]; }, copyVicMemory: (address,out,bank=0) => { for(let i=0;i<out.length;i++) out[i]=ram[bank+((address+i)&16383)]; }, cpuMemorySource: () => 'RAM', vicMemorySource: () => 'RAM', requestVicFrameCapture: () => { fixture.captures = (fixture.captures || 0) + 1; }, vicFrameCaptureStatus: () => fixture.captureStatus || 'idle', takeVicFrameCapture: () => { const frame=fixture.frame; fixture.frame=null; fixture.captureStatus='idle'; return frame; }, cancelVicFrameCapture: () => {}, ready: true, charRom: () => null, ram: () => { fixture.samples++; return ram; }, drive: () => null, tape: Object.freeze({ hasMedia: false }) });
    fixture.monitor = createMonitor({ getFacade: () => facade, isPowered: () => powered, isPaused: () => paused, setPaused: value => { paused = value; fixture.pauses++; }, releaseInput: () => fixture.released++, screen: document.querySelector('#screen'), anchor: document.querySelector('#anchor') });
    fixture.powerOff = () => { powered = false; document.querySelector('#anchor').disabled = true; };
    document.addEventListener('keydown', () => fixture.keys++);
    document.addEventListener('paste', () => fixture.pastes++);
    setInterval(() => { if (!paused && powered) { fixture.frames++; ram[0x400] = fixture.frames & 255; } }, 20);
  </script></body></html>` }));
  await page.goto(`${base}/monitor-fixture`);
  assert.equal(await page.evaluate(() => fixture.samples),0,'normal emulator use starts without Monitor sampling');
  await page.click('#btn-monitor');
  await page.waitForFunction(() => fixture.samples >= 2);
  assert.equal(await page.evaluate(()=>fixture.storageMonitoring),true,'visible Monitor enables transfer counters');
  const sampling=page.locator('[data-monitor="sampling-rate"]');
  assert.match(await sampling.textContent(),/10 samples\/s/,'Monitor starts at ten live samples per second');
  for(const rate of [25,50,1,10]){
    await sampling.click();
    assert.match(await sampling.textContent(),new RegExp(`${rate} samples/s`),'Rate button cycles in the requested order');
    assert.match(await sampling.getAttribute('aria-label'),new RegExp(`Sampling rate: ${rate} samples per second`),'Rate button announces its value');
  }

  await sampling.click();await sampling.click();
  const fastStart=await page.evaluate(()=>({samples:fixture.samples,captures:fixture.captures}));
  await page.waitForTimeout(400);
  const fastEnd=await page.evaluate(()=>({samples:fixture.samples,captures:fixture.captures}));
  assert.ok(fastEnd.samples-fastStart.samples>=6,'50/s updates observations faster than the default cadence');
  assert.ok(fastEnd.captures-fastStart.captures<=1,'Fast live sampling does not multiply detailed frame requests');
  await sampling.click();
  const slowStart=await page.evaluate(()=>fixture.samples);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>fixture.samples),slowStart,'1/s reuses its snapshot between one-second deadlines');
  await sampling.click();
  assert.equal(await page.locator('[data-live="cpu-status"]').textContent(),'Instruction unavailable','Live does not invent a missing instruction');
  await page.evaluate(()=>{fixture.cpu={pc:0x201,instructionAddress:0x200,instructionOpcode:0x8d,p:0,irq:true};});
  await page.waitForFunction(()=>document.querySelector('[data-live="cpu-status"]').textContent==='Storing a value');
  assert.match(await page.locator('[data-live="cpu-detail"]').textContent(),/STA.*\$0200/,'Live shows dispatched instruction evidence rather than operand PC');
  assert.equal(await page.locator('[data-live="cpu-irq"]').getAttribute('aria-label'),'IRQ request: yes','IRQ line indicator has a readable sampled state');
  assert.equal(await page.locator('[data-live="cpu-mask"]').getAttribute('aria-label'),'IRQ allowed by CPU flag: yes','IRQ mask indicator stays separate from request');
  assert.equal(await page.locator('[data-live="cpu-source"]').textContent(),'RAM','trail names the current CPU-visible memory source');
  await page.evaluate(()=>{
    const r=new Uint8Array(64);r[0x11]=0x1b;r[0x16]=0x0d;r[0x15]=0x81;r[0x20]=6;r[0x21]=2;
    fixture.cpu.vic=r;fixture.cpu.raster=106;
  });
  await page.waitForFunction(()=>document.querySelector('[data-video-live="scroll"]').textContent==='X 5 · Y 3');
  assert.equal(await page.locator('.monitor-live-video-slots .is-enabled').count(),2,'live sprite slots follow the enable mask');
  assert.equal(await page.locator('[data-video-slot="7"]').getAttribute('aria-label'),'Sprite 7: enabled','slot state is available without relying on colour');
  assert.equal(await page.locator('[data-video-live="scroll"]').textContent(),'X 5 · Y 3','fine scroll reads the shared VIC snapshot');
  assert.equal(await page.locator('[data-video-live="raster-line"], [data-video-live="marker"], [data-video-live="rail"]').count(),0,'Live shows configuration without a raster indicator');
  await page.evaluate(()=>{fixture.cpu.vic[0x11]=0x30;});
  await page.waitForFunction(()=>document.querySelector('[data-video-live="texture"]').getAttribute('fill').endsWith('-bitmap)'));
  await page.evaluate(()=>{fixture.cpu.vic.fill(0);fixture.cpu.raster=0;});
  await page.waitForFunction(()=>document.querySelector('[data-video-live="caption"]').textContent==='Display enable off');


  assert.equal(await page.locator('#monitor-title .monitor-beta').textContent(),'Beta','Monitor identifies its beta status beside the logo label');
  const box = await page.locator('#machine-monitor').boundingBox();
  assert.equal(box.width, 1440, 'Monitor fills browser width');
  assert.equal(box.height, 1000, 'Monitor fills browser height');
  assert.equal(await page.locator('.monitor-footer').count(),0,'all sections return the snapshot footer space to their content');
  const pageHeadings=await page.evaluate(()=>{
    const titles=selector=>[...document.querySelector(selector).querySelectorAll('h2')].filter(h=>!h.closest('.monitor-help-dialog,.monitor-component-guide')).map(h=>h.textContent);
    return {live:titles('[data-monitor=setup]'),other:['code','atlas','frame','sid','controls','storage'].flatMap(view=>titles(`[data-monitor="${view}"]`)),intros:[...document.querySelectorAll('.monitor-page-head .monitor-page-intro')].map(p=>p.textContent)};
  });
  assert.ok(pageHeadings.live.includes('The living machine'),'Live retains its page title');
  assert.deepEqual(pageHeadings.other,[],'other Monitor pages have no redundant page titles');
  assert.ok(pageHeadings.intros.length===4&&pageHeadings.intros.every(text=>text.length>0&&text.length<80),'pages without top-level controls use a short introduction');
  for (const [width, height] of [[800, 100], [700, 2], [384, 272]]) {
    const size = await page.locator('#screen').evaluate((screen, [width, height]) => {
      screen.width = width; screen.height = height;
      const rect = screen.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }, [width, height]);
    assert.ok(Math.abs(size.height - size.width * 272 / 384) < 0.1, 'display keeps framebuffer aspect regardless of renderer backing-store dimensions');
  }
  assert.equal(await page.locator('#monitor-screen-title').count(), 0, 'display has no repeated caption');
  assert.equal(await page.locator('[data-monitor="status"]').isVisible(), false, 'Live status is not repeated beside the display');
  await page.click('[data-view="atlas"]');
  await page.click('[data-monitor="map"] [data-page="32"]');
  assert.equal(await page.locator('[data-monitor="preview"]').inputValue(), 'context', 'Memory defaults to an explanation rather than a forced graphics interpretation');
  assert.equal(await page.locator('[data-memory="title"]').textContent(), 'Working memory: purpose unknown', 'unidentified RAM is honestly labelled');
  assert.equal(await page.locator('[data-monitor="tiles"]').isVisible(), false, 'raw tile noise is hidden by default');
  await page.selectOption('[data-monitor="preview"]','sprites');
  assert.equal(await page.locator('[data-monitor="tiles"]').isVisible(), true, 'manual raw interpretation remains available');
  await page.selectOption('[data-monitor="preview"]','context');
  await page.click('[data-monitor="map"] [data-page="4"]');
  await page.click('[data-view="setup"]');

  assert.equal(await page.locator('.monitor-header [data-view]').count(), 7, 'Live and six machine sections live in the header');
  assert.equal(await page.locator('.monitor-header [data-view] svg[aria-hidden="true"]').count(),7,'each section has a decorative icon while its text remains the accessible name');
  assert.deepEqual(await page.locator('.monitor-header [data-view]').allTextContents(),['Live','Code','Memory','Video','Sound','Controls','Storage'],'header follows Live card reading order');
  assert.equal(await page.locator('[data-card=cpu] h3').textContent(),'Code','Live uses the same Code name as the header');
  await page.click('[data-view="code"]');
  await page.locator('.monitor-code-modes').click({position:{x:2,y:2}});
  assert.equal(await page.locator('.monitor-code-story').isVisible(),true,'toolbar clicks do not interpret the page appearance as a Code mode');
  await page.click('[data-mode=execution]');
  assert.equal(await page.locator('.monitor-code-execution').isVisible(),true,'execution evidence has a full-page Code mode');
  assert.equal(await page.locator('.monitor-code-execution dialog').count(),0,'execution evidence does not open a help dialog');
  await page.click('[data-view="setup"]');

  assert.equal(await page.locator('button[data-view="setup"]').textContent(), 'Live', 'machine overview is named Live in the menu');
  for (const view of ['setup','code','atlas','frame','sid','controls','storage']) {
    await page.click(`[data-view="${view}"]`);
    const live = await page.locator('#screen').boundingBox();
    assert.ok(live && live.width > 0 && live.x > 1000 && live.y < 100, `${view} keeps the original live display at the top right`);
    assert.equal(await page.locator('.monitor-header #screen').count(), 1, `${view} uses the original keyboard-capable display`);
  }
  await page.click('[data-view="setup"]');

  for (const [width, height] of [[1920, 1080], [1440, 1000], [1440, 900], [1280, 720], [390, 844], [375, 667], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const fit = await page.locator('.monitor-workspace').evaluate(el => ({ scroll: el.scrollHeight, height: el.clientHeight, width: el.scrollWidth, clientWidth: el.clientWidth }));
    assert.ok(fit.scroll <= fit.height + 1 && fit.width <= fit.clientWidth + 1, `Setup fits ${width} × ${height} without scrolling`);
    assert.ok(await page.locator('.monitor-header [data-view]').evaluateAll(buttons=>buttons.every(button=>{
      const b=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect(),label=button.querySelector('span').getBoundingClientRect();
      return icon.left>=b.left&&icon.right<=label.left&&label.right<=b.right&&icon.top>=b.top&&icon.bottom<=b.bottom;
    })),`menu icons and labels fit without overlap at ${width} × ${height}`);
    const screenFits = await page.locator('.monitor-screen-card').evaluate(card => {
      const bounds=card.getBoundingClientRect(), display=card.querySelector('.monitor-display').getBoundingClientRect();
      return display.top>=bounds.top&&display.bottom<=bounds.bottom+1&&display.left>=bounds.left&&display.right<=bounds.right+1&&Math.abs(display.height-display.width*272/384)<1;
    });
    assert.equal(screenFits,true,`full live picture fits its dock at ${width} × ${height}`);
    const pauseBeforeLive=await page.locator('.monitor-nav').evaluate(nav=>{
      const pause=nav.querySelector('[data-monitor="pause"]').getBoundingClientRect(),live=nav.querySelector('[data-view="setup"]').getBoundingClientRect();
      return pause.right<=live.left&&live.left-pause.right<=10&&Math.abs(pause.top-live.top)<1;
    });
    assert.ok(pauseBeforeLive,`pause sits immediately before Live at ${width} × ${height}`);

    const setupFits = await page.locator('[data-monitor="machine"]').evaluate(el => [...el.children].filter(child => getComputedStyle(child).display !== 'none').every(child => child.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1));
    if (width > 1000) assert.equal(setupFits, true, `Setup content is visible within ${width} × ${height}`);
    const wiresFit = await page.locator('.monitor-machine-board').evaluate(board => {
      const bounds = board.getBoundingClientRect(), wires = board.querySelector('.monitor-machine-wires').getBoundingClientRect();
      return Math.abs(bounds.top-wires.top)<1 && Math.abs(bounds.height-wires.height)<1 && Math.abs(bounds.width-wires.width)<1;
    });
    if (width > 1000) assert.equal(wiresFit,true,`connection canvas covers the board at ${width} × ${height}`);
    assert.equal(await page.locator('.monitor-card-snapshot').count(),6,'each machine card has a visual snapshot');
    assert.doesNotMatch((await page.locator('.monitor-live-card').allTextContents()).join(' '),/samples?\/s|10\/s|100 ms/,'Live cards do not repeat the global sampling rate');
    if(width>1100 && height>650) {
      const filled=await page.locator('.monitor-card-snapshot').evaluateAll(panels=>panels.every(panel=>{
        const card=panel.parentElement.getBoundingClientRect(), visual=panel.querySelector('[data-live$="-visual"]').getBoundingClientRect();
        return Math.abs(visual.top-card.top)<=2 && Math.abs(visual.bottom-card.bottom)<=2 && Math.abs(visual.width-card.width/3)<=2 && Math.abs(visual.right-card.right)<=2;
      }));
      if (!filled) console.log(await page.locator('.monitor-card-snapshot').evaluateAll(panels=>panels.map(panel=>({card:panel.parentElement.getBoundingClientRect().toJSON(),visual:panel.querySelector('[data-live$="-visual"]').getBoundingClientRect().toJSON()}))));
      assert.ok(filled,'desktop card visualizations fill the full height and right third');
      const videoFit=await page.locator('.monitor-live-video').evaluate(el=>{
        const b=el.getBoundingClientRect(), image=el.querySelector('svg').getBoundingClientRect();
        const inside=[...el.querySelectorAll('.monitor-live-video-stack > div,.monitor-live-video-rail')].every(child=>{const r=child.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom+1&&r.right<=b.right;});
        const stack=el.querySelector('.monitor-live-video-stack');
        return inside&&stack.scrollHeight<=stack.clientHeight+1&&el.scrollHeight<=el.clientHeight+1&&Math.abs(image.width/image.height-384/272)<.01;
      });
      assert.ok(videoFit,`full-height Video diagram fits without stretching its screen at ${width} × ${height}`);

      const contentFits=await page.locator('.monitor-live-copy').evaluateAll(items=>items.every(item=>{const b=item.getBoundingClientRect();return [...item.children].filter(child=>getComputedStyle(child).display!=='none').every(child=>{const c=child.getBoundingClientRect();return c.top>=b.top-1&&c.bottom<=b.bottom+1&&c.right<=b.right+1;});}));
      assert.ok(contentFits,`all Live readings and actions fit their cards at ${width} × ${height}`);
      const anchored=await page.locator('.monitor-live-copy').evaluateAll(items=>items.every(item=>{
        const box=item.getBoundingClientRect(), style=getComputedStyle(item);
        const chip=item.querySelector('.monitor-live-chip').getBoundingClientRect(), actions=item.querySelector('.monitor-live-actions').getBoundingClientRect();
        return Math.abs(chip.top-box.top-parseFloat(style.paddingTop))<1 && Math.abs(box.bottom-actions.bottom-parseFloat(style.paddingBottom))<1;
      }));
      if(!anchored)console.log(await page.locator('.monitor-live-copy').evaluateAll(items=>items.map(item=>{
        const box=item.getBoundingClientRect(), style=getComputedStyle(item), chip=item.querySelector('.monitor-live-chip').getBoundingClientRect(), actions=item.querySelector('.monitor-live-actions').getBoundingClientRect();
        return {card:item.parentElement.dataset.card,top:chip.top-box.top-parseFloat(style.paddingTop),bottom:box.bottom-actions.bottom-parseFloat(style.paddingBottom),height:box.height};
      })));
      assert.ok(anchored,`all Live cards anchor component labels at top and actions at bottom at ${width} × ${height}`);

    }

  }
  for (const view of ['atlas', 'code', 'frame', 'sid', 'controls', 'storage']) {
    await page.click(`[data-view="${view}"]`);
    for (const [width, height] of (view === 'frame' ? [[1440,1000],[1280,720]] : [[1440, 1000], [1280, 720], [390, 844], [375, 667], [844, 390]])) {
      await page.setViewportSize({ width, height });
      const fit = await page.locator('.monitor-workspace').evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
      assert.equal(fit, true, `${view} fits ${width} × ${height} without workspace scrolling`);
      const contentFit = await page.locator(`[data-monitor="${view}"]`).evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
      if (!contentFit) console.log(await page.locator(`[data-monitor="${view}"]`).evaluate(el => ({ outer: [el.clientWidth,el.scrollWidth,el.clientHeight,el.scrollHeight], children: [...el.querySelectorAll('*')].filter(child => getComputedStyle(child).display !== 'none').map(child => ({ name: child.className || child.tagName, h: child.getBoundingClientRect().height, y: child.getBoundingClientRect().y, w: child.getBoundingClientRect().width })).filter(child => child.h > 20) })));
      assert.equal(contentFit, true, `${view} content fits ${width} × ${height}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.click('[data-view="setup"]');
  for(const [chip,view] of [['cpu','code'],['ram','atlas'],['vic','frame'],['sid','sid'],['controls','controls'],['storage-link','storage']]) {
    await page.click(`[data-card="${chip}"] h3`);
    assert.equal(await page.locator(`button[data-view="${view}"]`).getAttribute('aria-pressed'),'true',`${chip} card body opens inspection`);
    await page.click('[data-view="setup"]');
  }
  for (const [chip, view] of [['cpu','code'], ['ram','atlas'], ['sid','sid'], ['storage-link','storage']]) {
    await page.click(`[data-machine="${chip}"]`);
    assert.equal(await page.locator(`button[data-view="${view}"]`).getAttribute('aria-pressed'), 'true', `${chip} opens its detail view`);
    await page.click('[data-view="setup"]');
  }
  await page.click('[data-about="cpu"]');
  await page.waitForFunction(() => document.querySelector('.monitor-component-guide article h2'));
  const beforeGuide = await page.evaluate(() => ({captures:fixture.captures||0, frames:fixture.frames, pauses:fixture.pauses}));
  for (const key of ['cpu','memory','vic','sid','cia','drive','tape','crt','reu']) {
    await page.click(`[data-guide="${key}"]`);
    await page.waitForFunction(() => document.querySelector('.monitor-component-guide article h2')?.textContent === 'The story');
    assert.match(await page.locator('.monitor-component-guide article').innerText(),/Try it in Monitor/,'each guide includes a practical next step');
    const bounded=await page.locator('.monitor-component-guide').evaluate(el=>{const b=el.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight&&b.width<innerWidth;});
    assert.equal(bounded,true,'component guides remain bounded to the viewport');
    const spacing=await page.locator('.monitor-component-guide > article').evaluate(el=>{
      const style=getComputedStyle(el), p=el.querySelector('p + p');
      return {padding:parseFloat(style.paddingLeft), gap:p ? p.getBoundingClientRect().top-p.previousElementSibling.getBoundingClientRect().bottom : null, fits:el.scrollWidth<=el.clientWidth+1};
    });
    assert.ok(spacing.padding>=20 && spacing.fits,'About text has readable insets without horizontal scrolling');
    if(spacing.gap!==null)assert.ok(spacing.gap>=14,'About paragraphs retain visible vertical separation');
    const links=await page.locator('.monitor-component-guide article a').evaluateAll(links=>links.map(a=>a.getAttribute('href')));
    assert.ok(links.some(link=>link.includes('-architecture.html')),'each component links to emulator documentation');
  }
  assert.equal(await page.evaluate(()=>fixture.captures||0),beforeGuide.captures,'reading component guides does not request frame captures');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.monitor-component-guide').evaluate(el=>el.open),false,'Escape closes the component guide');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.about),'cpu','guide closing restores its original About button');
  assert.equal(await page.evaluate(()=>fixture.pauses),beforeGuide.pauses,'reading component guides does not pause playback');
  await page.locator('[data-section-about="machine"]').click();
  await page.waitForFunction(()=>document.querySelector('.monitor-component-guide article h2'));
  assert.equal(await page.locator('#monitor-component-guide-title').textContent(),'Inside the C64','Live About opens the component overview');
  await page.locator('.monitor-component-guide .monitor-help-close').click();
  await page.click('[data-view=storage]');
  assert.equal(await page.locator('[data-monitor=storage] > .monitor-section-head > h2').count(),0,'Storage uses its device row instead of a separate heading');
  const storageToolbar=await page.evaluate(()=>{
    const row=document.querySelector('.monitor-storage-tabs'), device=row.querySelector('.btn'), about=row.querySelector('.monitor-section-about');
    const storage=getComputedStyle(device),code=getComputedStyle(document.querySelector('.monitor-code-modes .btn'));
    return {sameSizing:['paddingTop','paddingRight','paddingBottom','paddingLeft','fontSize','letterSpacing'].every(key=>storage[key]===code[key]),aboutInside:about.parentElement===row};
  });
  assert.ok(storageToolbar.sameSizing&&storageToolbar.aboutInside,'Storage shares Code button sizing with About in the same top row');
  await page.click('[data-storage-device="4"]');
  await page.locator('[data-section-about="storage"]').click();
  await page.waitForFunction(()=>document.querySelector('#monitor-component-guide-title').textContent==='RAM expansion');
  await page.locator('.monitor-component-guide .monitor-help-close').click();
  await page.click('[data-view=setup]');
  assert.ok(await page.evaluate(()=>fixture.frames)>beforeGuide.frames,'playback progresses while a component guide is open');
  await page.click('[data-machine="controls"]');
  await page.waitForFunction(()=>!document.querySelector('[data-monitor=controls]').hidden);
  assert.match(await page.locator('[data-controls="summary"]').innerText(),/unavailable/,'unsupported control inspection is explicit');
  await page.click('[data-view=setup]');

  const sharedCounts=await page.evaluate(()=>({ram:fixture.samples,chips:fixture.inspections,storage:fixture.storageSamples}));
  assert.equal(sharedCounts.ram,sharedCounts.chips,'RAM and chip inspection share one sample count across view changes');
  assert.equal(sharedCounts.ram,sharedCounts.storage,'storage inspection shares the same capture cadence');
  const cadenceStart=await page.evaluate(()=>({count:fixture.samples,time:performance.now()}));
  await page.waitForTimeout(1100);
  const cadence=await page.evaluate(start=>({count:fixture.samples-start.count,elapsed:performance.now()-start.time}),cadenceStart);
  assert.ok(cadence.count>=8&&cadence.count<=Math.ceil(cadence.elapsed/100)+1,'open Monitor targets ten shared observations per second without catch-up bursts');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const hiddenSamples=await page.evaluate(()=>fixture.samples);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>fixture.samples),hiddenSamples,'hidden Monitor does not sample');
  assert.equal(await page.evaluate(()=>fixture.storageMonitoring),false,'hidden Monitor detaches transfer counters');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.locator('#screen').focus();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.evaluate(() => fixture.pauses), 0, 'opening does not pause playback');
  assert.equal(await page.evaluate(() => fixture.released), 1, 'opening releases held machine input');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'screen', 'opening gives the C64 keyboard focus');
  const before = await page.evaluate(() => fixture.frames);
  await page.waitForFunction(before => fixture.frames > before + 5, before);
  assert.match(await page.locator('[data-monitor="bytes"]').textContent(), /\$0400/, 'default inspection selects screen RAM');
  await page.click('[data-view="atlas"]');
  await page.locator('[data-monitor="map"] [data-page="4"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-monitor="selection"]').textContent(), '$0500–$05FF', 'keyboard selects adjacent memory page');
  await page.keyboard.press('a');
  await page.keyboard.press('Control+Shift+V');
  await page.locator('#machine-monitor').dispatchEvent('paste');
  assert.equal(await page.evaluate(() => fixture.keys), 0, 'Monitor keys do not reach app keyboard handlers');
  assert.equal(await page.evaluate(() => fixture.pastes), 0, 'Monitor paste does not reach C64');
  await page.click('[data-monitor="pause"]');
  assert.equal(await page.locator('[data-monitor="pause"]').getAttribute('aria-label'), 'Resume', 'paused header icon has an accessible Resume label');
  assert.equal(await page.locator('.monitor-resume-icon').isVisible(), true, 'paused header shows the play icon');

  await page.click('[data-view=setup]');
  await sampling.click();await sampling.click();
  const frozen = await page.evaluate(() => fixture.frames);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => fixture.frames), frozen, 'explicit Pause freezes execution');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#machine-monitor').evaluate(el => el.open), false, 'Escape closes Monitor');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-monitor', 'close restores focus');
  assert.equal(await page.locator('#screen').evaluate(el => el.parentElement.tagName), 'BODY', 'close restores original display position');
  const samples = await page.evaluate(() => fixture.samples);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => fixture.samples), samples, 'closed Monitor does no sampling');
  assert.equal(await page.evaluate(()=>fixture.storageMonitoring),false,'closed Monitor detaches transfer counters');
  await page.click('#btn-monitor');
  assert.equal(await page.locator('[data-monitor="status"]').textContent(), 'Paused', 'reopening preserves pause');
  assert.match(await sampling.textContent(),/50 samples\/s/,'Reopening keeps the selected rate for this session');
  await sampling.click();await sampling.click();
  await page.click('[data-monitor="pause"]');
  await page.waitForFunction(frozen => fixture.frames > frozen, frozen);
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => { document.documentElement.dataset.mode = mode; window.dispatchEvent(new Event('c64-appearance')); }, mode);
    const colours = await page.locator('#machine-monitor').evaluate(el => ({ actual: getComputedStyle(el).backgroundColor, expected: getComputedStyle(el).getPropertyValue('--crt-bg').trim() }));
    assert.ok(colours.expected, 'Monitor inherits theme tokens');
    const expected = await page.evaluate(colour => { const el = document.createElement('div'); el.style.backgroundColor = colour; document.body.append(el); const value = getComputedStyle(el).backgroundColor; el.remove(); return value; }, colours.expected);
    assert.equal(colours.actual, expected, `${mode} Monitor background uses selected theme`);
  }
  await page.click('[data-view=setup]');
  await page.click('[data-monitor=pause]');
  await page.evaluate(async()=>{
    const {VicFrameCapture}=await import('/src/vic2-frame-capture.js');
    const frame=new VicFrameCapture({analysis:true}).frame;
    frame.analysis.model='6569';
    frame.owners.fill(255);frame.eventCount=1;frame.eventKind[0]=0x21;frame.eventTick[0]=63;
    const analysis=frame.analysis,registers=analysis.sequencer.registers;
    fixture.analysisReads=0;fixture.ruleReads=0;
    Object.defineProperty(frame,'analysis',{get(){fixture.analysisReads++;return analysis;}});
    Object.defineProperty(analysis.sequencer,'registers',{get(){fixture.ruleReads++;return registers;}});
    fixture.frame=frame;fixture.captureStatus='ready';
  });
  await page.waitForFunction(()=>fixture.captureStatus==='idle');
  assert.equal(await page.evaluate(()=>fixture.analysisReads),0,'Live frame delivery does not compute hidden analysis or budget charts');
  await page.click('[data-view=code]');
  await page.click('[data-mode=story]');
  assert.ok(await page.evaluate(()=>fixture.analysisReads)>0,'Code computes its budget when opened');
  await page.click('[data-group=Colours]');
  await page.locator('[data-story=seek]').evaluate(el=>{el.value=126;el.dispatchEvent(new Event('input'));});
  await page.evaluate(async()=>{
    const {VicFrameCapture}=await import('/src/vic2-frame-capture.js');
    const frame=new VicFrameCapture({analysis:true}).frame;
    frame.analysis.model='6569';
    frame.owners.fill(255);frame.eventCount=1;frame.eventKind[0]=0x21;frame.eventTick[0]=64;
    const registers=frame.analysis.sequencer.registers;
    Object.defineProperty(frame.analysis.sequencer,'registers',{get(){fixture.ruleReads++;return registers;}});
    fixture.frame=frame;fixture.captureStatus='ready';
  });
  await page.waitForFunction(()=>fixture.captureStatus==='idle');
  assert.equal(await page.locator('[data-group=Colours]').getAttribute('aria-pressed'),'true','Code refresh retains its selected category');
  assert.equal(await page.locator('[data-story=seek]').inputValue(),'126','Code refresh retains its inspected cycle');
  await page.click('[data-view=frame]');
  assert.equal(await page.evaluate(()=>fixture.ruleReads),0,'Video overview does not run the Bauer rule analyzer');
  await page.locator('[data-video=topic]').selectOption('timing');
  assert.ok(await page.evaluate(()=>fixture.ruleReads)>0,'Timing and rules analyzes the shared evidence when opened');
  await page.click('[data-monitor=close]');
  assert.equal(await page.locator('.monitor-code-story').getAttribute('data-capture-label'),null,'closing clears Code capture identity');
  assert.equal(await page.locator('[data-story=timeline]').evaluate(el=>el.getContext('2d').getImageData(0,0,el.width,el.height).data.some(Boolean)),false,'closing clears the hidden Code timeline pixels');
  await page.click('#btn-monitor');
  await page.click('[data-view=code]');
  assert.equal(await page.locator('[data-story=video]').isDisabled(),true,'paused reopening cannot navigate to a released Code frame');
  await page.click('[data-view=frame]');
  assert.equal(await page.locator('[data-frame=play]').isDisabled(),true,'paused reopening has no stale Video replay');
  await page.click('[data-monitor=pause]');
  const cancelledRequests=await page.evaluate(()=>{fixture.captureStatus='cancelled';return fixture.captures;});
  await page.waitForFunction(count=>fixture.captures>count,cancelledRequests);
  assert.ok(await page.evaluate(()=>fixture.captures)>cancelledRequests,'capture scheduling recovers from reset or restore cancellation');
  await page.evaluate(()=>{fixture.captureStatus='idle';});
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#machine-monitor').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'phone layout has no horizontal overflow');
  await page.evaluate(() => fixture.powerOff());
  await page.waitForFunction(() => !document.querySelector('#machine-monitor').open);
  assert.equal(await page.locator('#btn-monitor').isDisabled(), true, 'powered-off Monitor is unavailable');
  const spritePreview = await page.evaluate(async () => {
    const {drawSpritePreviews} = await import('/src/monitor/sprite-preview.js');
    const canvases = Array.from({length:8},()=>{const c=document.createElement('canvas');c.width=96;c.height=84;return c;});
    const frame = {width:4,height:2,owners:Uint8Array.of(0,255,255,255,0,255,255,255),border:new Uint8Array(8),rgba:new Uint8ClampedArray(32)};
    for (const i of [0,4]) frame.rgba.set([255,0,0,255],i*4);
    drawSpritePreviews(frame,canvases);
    return canvases.map(canvas=>canvas.getContext('2d').getImageData(0,0,96,84).data.some((value,i)=>i%4===3 && value));
  });
  assert.deepEqual(spritePreview,[true,false,false,false,false,false,false,false],'Video thumbnails show captured coverage only for the recorded slot');

  const storageChecks=await page.evaluate(async()=>{
    const {createStorageView}=await import('/src/monitor/storage-view.js');
    const {MachineFacade}=await import('/src/machine-facade.js');
    const root=document.createElement('section');root.className='monitor-storage';document.body.append(root);
    let tapeReads=0,openedCode=null,openedFrame=null,openedMemory=null;
    const stream=Uint8Array.of(48,67,85,48,67,85),tape={get tapData(){tapeReads++;return stream;},pos:6,tapVersion:1,hasMedia:true};
    const state=MachineFacade.prototype.createStorageInspection();state.tape.hasMedia=true;state.tape.key='PLAY';state.tape.motor=true;
    const snapshot={storage:state,facade:{tape},capturedAt:0,cpuMemorySource:address=>address>=0x8000&&address<0xa000?'Cartridge':'RAM'};
    const view=createStorageView(root,()=>{},address=>openedCode=address,{openFrame:(frame,tick)=>openedFrame=tick,openCapturedMemory:(frame,tick,address)=>openedMemory=address});
    view.update(snapshot,false);view.select(2);view.update(snapshot,false);view.theme();const hiddenReads=tapeReads;
    view.update(snapshot,true);const pulses=root.querySelector('[data-plot=reading]').textContent;
    const canvas=root.querySelector('[data-plot=canvas]');canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    const selected=root.querySelector('[data-plot=reading]').textContent,focusable=canvas.tabIndex;
    view.update(snapshot,true);const held=root.querySelector('[data-plot=reading]').textContent;
    view.select(3);state.cartridge.inserted=true;view.update(snapshot,true);
    canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const mapped=root.querySelector('[data-plot=reading]').textContent;
    view.select(4);state.reu.attached=true;state.reu.bytes=262144;
    const frame={lines:312,cyclesPerLine:63,provenance:{count:1,kind:[6],tick:[120],address:[0x2345],value:[99],aux:[0x034567]}};
    view.setFrame(frame);view.update(snapshot,true);
    root.querySelector('[data-plot=video]').click();root.querySelector('[data-plot=memory]').click();
    const reu=root.querySelector('[data-plot=reading]').textContent;
    const readsBeforeHidden=tapeReads;view.update(snapshot,false);view.theme();const readsAfterHidden=tapeReads;
    view.reset();root.remove();return {hiddenReads,pulses,selected,focusable,held,mapped,openedCode,openedFrame,openedMemory,reu,readsBeforeHidden,readsAfterHidden};
  });
  assert.equal(storageChecks.hiddenReads,0,'Tape data is not decoded by hidden Storage updates, selection or theme changes');
  assert.match(storageChecks.pulses,/384–680 cycles/,'Tape displays the timing range decoded from real TAP entries');
  assert.equal(storageChecks.selected,storageChecks.pulses,'Tape scope has no keyboard pulse selection');
  assert.equal(storageChecks.focusable,-1,'Display-only Tape scope does not take keyboard focus');
  assert.equal(storageChecks.held,storageChecks.selected,'Shared updates retain pulse timing while its source is unchanged');
  assert.match(storageChecks.mapped,/\$8000–\$9FFF/,'CRT displays the actual CPU-visible window');
  assert.equal(storageChecks.openedCode,0x8000,'Mapped cartridge memory opens CPU-visible Code');
  assert.equal(storageChecks.openedFrame,120,'REU navigation uses the recorded access cycle');
  assert.equal(storageChecks.openedMemory,0x2345,'REU navigation uses the recorded C64 address');
  assert.match(storageChecks.reu,/1 access/,'REU reports recorded accesses rather than inferred completed transfers');
  assert.equal(storageChecks.readsAfterHidden,storageChecks.readsBeforeHidden,'Leaving Tape stops its source decoding');

  const storyChecks=await page.evaluate(async()=>{
    const {createCodeStory}=await import('/src/monitor/code-story.js');
    const root=document.createElement('div'); document.body.append(root);
    let video=null,code=null;
    const story=createCodeStory(root,{openFrame:(_facade,frame,tick)=>video={frame,tick},openCode:(pc,origin)=>code={pc,origin},onCapture:()=>{}});
    const frame={lines:312,cyclesPerLine:63,eventCount:2,eventKind:[0x21,0x12],eventValue:[6,99],eventTick:[63,100],eventCPU:[1,0],eventPC:[0x3000,0],eventOpcode:[0x8d,0],palette:new Uint32Array(16),analysis:{bus:new Uint8Array(19656).fill(1)}};
    frame.palette[6]=0x2e2c9b; story.accept({},frame);
    const title=root.querySelector('[data-story="title"]').textContent;
    const swatch=root.querySelector('[data-story="swatch"]').style.backgroundColor;
    const budget=root.querySelector('[data-story="budget"]').textContent;
    root.querySelector('[data-story="assembly"]').click(); root.querySelector('[data-story="video"]').click();const initialVideoTick=video.tick;
    root.querySelector('[data-group="Interrupts"]').click();
    root.querySelector('[data-story="next"]').click();
    const missingOrigin=root.querySelector('[data-story="assembly"]').disabled;
    const sliderCount=root.querySelectorAll('input[type="range"]').length;
    const slider=root.querySelector('[data-story="seek"]');slider.value=126;slider.dispatchEvent(new Event('input'));
    const emptyCycle=root.querySelector('[data-story="title"]').textContent;
    const preservedFilter=root.querySelector('[data-group="Interrupts"]').getAttribute('aria-pressed');
    const matchingBudget=root.querySelector('[data-story="line-budget"] small').textContent;
    root.querySelector('[data-story="video"]').click();const emptyVideoTick=video.tick;

    story.accept({}, {...frame,eventCount:0,analysis:null});
    const empty=root.querySelector('[data-story="title"]').textContent;
    const unavailable=root.querySelector('[data-story="budget"]').textContent;
    root.remove(); return {title,swatch,budget,pc:code.pc,origin:code.origin,videoTick:initialVideoTick,sliderCount,emptyCycle,preservedFilter,matchingBudget,emptyVideoTick,sameFrame:video.frame===frame,missingOrigin,empty,unavailable};
  });
  assert.match(storyChecks.title,/background to blue/,'Code leads with the recorded action');
  assert.equal(storyChecks.swatch,'rgb(46, 44, 155)','Code swatch uses the captured RGB palette');
  assert.match(storyChecks.budget,/19,656 \/ 19,656/,'Code shows CPU-available cycles against the frame total');
  assert.equal(storyChecks.pc,0x3000,'assembly link selects the captured instruction address');
  assert.match(storyChecks.origin,/raster 1, cycle 1/,'assembly link preserves capture identity and cycle');
  assert.ok(storyChecks.sameFrame && storyChecks.videoTick===63,'Video link preserves the same frame and tick');
  assert.equal(storyChecks.sliderCount,1,'Code exposes one frame-time slider');
  assert.match(storyChecks.emptyCycle,/No matching video write/,'scrubbing to an empty cycle clears the previous action');
  assert.equal(storyChecks.preservedFilter,'true','scrubbing preserves the action category');
  assert.match(storyChecks.matchingBudget,/Line 2:/,'budget follows the shared time cursor');
  assert.equal(storyChecks.emptyVideoTick,126,'Video opens the same time even when no action is selected');
  assert.equal(storyChecks.missingOrigin,true,'Code does not invent an instruction origin');
  assert.match(storyChecks.empty,/No video writes/,'empty capture does not imply an idle program');
  assert.match(storyChecks.unavailable,/unavailable/,'ordinary frame does not invent a CPU budget');

  console.log('ok  - full-window live Monitor, pause preservation, focus, keyboard isolation, themes, phone layout and lifecycle');

  const outlineChecks=await page.evaluate(async()=>{
    const {createFrameView}=await import('/src/monitor/frame-view.js');
    const {VicFrameCapture}=await import('/src/vic2-frame-capture.js');
    const root=document.createElement('section');document.body.append(root);
    const view=createFrameView(root), frame=new VicFrameCapture().frame;
    frame.owners.fill(255);
    for(let i=0;i<frame.owners.length;i++)frame.rgba.set([70,80,90,255],i*4);
    for(const [slot,left,top,masked] of [[0,20,40,false],[0,20,100,false],[1,80,40,false],[2,140,40,true]]) {
      for(let y=top;y<top+21;y++)for(let x=left;x<left+24;x++){
        const i=y*frame.width+x;frame.owners[i]=slot;frame.border[i]=masked?1:0;frame.rgba.set([120,130,140,255],i*4);
      }
    }
    const source=frame.rgba.slice(), owners=frame.owners.slice();
    view.inspect({cancelVicFrameCapture(){}},frame,0);
    const ctx=root.querySelector('[data-frame=picture]').getContext('2d');
    const pixel=(x,y)=>Array.from(ctx.getImageData(x+80,y+15,1,1).data);
    const coverage=root.querySelector('[data-frame=sprites]');coverage.checked=true;coverage.dispatchEvent(new Event('change'));
    const all=[pixel(30,61),pixel(90,61),pixel(150,61)], interior=pixel(30,50), outside=pixel(30,62);
    const topic=root.querySelector('[data-video=topic]');topic.value='sprite';topic.dispatchEvent(new Event('change'));
    root.querySelector('[data-frame=slots] button').click();
    const selected=[pixel(30,61),pixel(30,121),pixel(90,61)];
    topic.value='overview';topic.dispatchEvent(new Event('change'));
    const cleared=pixel(30,61), unchanged=source.every((v,i)=>v===frame.rgba[i])&&owners.every((v,i)=>v===frame.owners[i]);
    view.deactivate(true);root.remove();
    return {all,interior,outside,selected,cleared,unchanged};
  });
  assert.deepEqual(outlineChecks.all,[[255,20,147,255],[255,20,147,255],[70,80,90,255]],'Sprite coverage outlines unmasked sprites in inspection pink on the picture');
  assert.deepEqual(outlineChecks.selected,[[255,20,147,255],[255,20,147,255],[70,80,90,255]],'selecting a slot outlines its separate appearances without highlighting another slot');
  assert.deepEqual(outlineChecks.outside,[70,80,90,255],'one-pixel outline leaves the next pixel unchanged with no dark edge');
  assert.deepEqual(outlineChecks.interior,[120,130,140,255],'sprite artwork keeps its recorded colours inside the outline');
  assert.deepEqual(outlineChecks.cleared,[70,80,90,255],'leaving sprite details removes the selected sprite outline');
  assert.equal(outlineChecks.unchanged,true,'outlines leave captured pixel and ownership evidence untouched');

  const inspectorRefresh=await page.evaluate(async()=>{
    const {createFrameView}=await import('/src/monitor/frame-view.js');
    const {VicFrameCapture}=await import('/src/vic2-frame-capture.js');
    const root=document.createElement('section');document.body.append(root);
    const view=createFrameView(root),facade={cancelVicFrameCapture(){}},frame=new VicFrameCapture().frame;
    frame.owners.fill(255);view.accept(facade,frame);
    const topic=root.querySelector('[data-video=topic]'),seek=root.querySelector('[data-frame=seek]');
    topic.value='sprite';topic.dispatchEvent(new Event('change'));
    view.accept(facade,structuredClone(frame));const unselectedTopic=topic.value;
    root.querySelector('[data-frame=slots] button').click();
    seek.value=126;seek.dispatchEvent(new Event('input'));
    const details=root.querySelector('[data-video=report] details');details.open=true;
    await new Promise(resolve=>setTimeout(resolve,0));
    const next=structuredClone(frame);next.pointers[16]=0x81;
    view.accept(facade,next);
    const selected={topic:topic.value,slot:root.querySelector('[data-frame=slots] button').getAttribute('aria-pressed'),tick:seek.value,open:root.querySelector('[data-video=report] details').open,text:root.querySelector('[data-video=report]').textContent};
    const topics=[], clearedSelections=[];
    for(const name of ['overview','border','timing','events','techniques']){
      topic.value='sprite';topic.dispatchEvent(new Event('change'));
      const sprite=root.querySelector('[data-frame=slots] button');if(sprite.getAttribute('aria-pressed')!=='true')sprite.click();
      topic.value=name;topic.dispatchEvent(new Event('change'));view.accept(facade,structuredClone(next));topics.push(topic.value);
      clearedSelections.push(sprite.getAttribute('aria-pressed')==='false'&&!root.querySelector('[data-frame=sprites]').checked);
    }
    topic.value='sprite';topic.dispatchEvent(new Event('change'));root.querySelector('[data-frame=slots] button').click();
    root.querySelector('[data-frame=picture]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
    const pixelCleared=root.querySelector('[data-frame=slots] button').getAttribute('aria-pressed')==='false';
    const pixelFrame=structuredClone(next);pixelFrame.border[100*frame.width+160]=1;
    view.accept(facade,pixelFrame);
    const pixel={topic:topic.value,title:root.querySelector('[data-video=report] h3').textContent};
    topic.value='sprite';topic.dispatchEvent(new Event('change'));root.querySelector('[data-frame=slots] button').click();
    view.deactivate();view.accept(facade,next);
    const sectionCleared=root.querySelector('[data-frame=slots] button').getAttribute('aria-pressed')==='false'&&!root.querySelector('[data-frame=sprites]').checked;
    view.accept({cancelVicFrameCapture(){}},frame);
    const reset={topic:topic.value,tick:seek.value,slot:root.querySelector('[data-frame=slots] button').getAttribute('aria-pressed')};
    view.deactivate(true);root.remove();return {unselectedTopic,selected,topics,pixel,reset,clearedSelections,pixelCleared,sectionCleared};
  });
  assert.equal(inspectorRefresh.unselectedTopic,'sprite','a new capture preserves Sprites even before a slot is selected');
  assert.equal(inspectorRefresh.selected.slot,'true','a new capture preserves the selected sprite slot');
  assert.equal(inspectorRefresh.selected.tick,'126','a new capture preserves the inspected cycle');
  assert.equal(inspectorRefresh.selected.open,true,'a new capture preserves expanded sprite evidence');
  assert.match(inspectorRefresh.selected.text,/Pointer \$81/,'preserved selection reads source evidence from the new capture');
  assert.ok(inspectorRefresh.clearedSelections.every(Boolean),'leaving sprite details clears selection and its outline for every inspector topic');
  assert.ok(inspectorRefresh.pixelCleared,'clicking a pixel clears the previous sprite selection');
  assert.ok(inspectorRefresh.sectionCleared,'leaving Video clears selection before returning to the section');
  assert.deepEqual(inspectorRefresh.topics,['overview','border','timing','events','techniques'],'a selected sprite does not force other inspector topics back to Sprites');
  assert.deepEqual(inspectorRefresh.pixel,{topic:'pixel',title:'The border covers this pixel'},'pixel inspection keeps its coordinates and refreshes their evidence');
  assert.deepEqual(inspectorRefresh.reset,{topic:'overview',tick:'0',slot:'false'},'changing machines clears the old inspection context');

  const rateKey='c64emu.monitorSamplingRate';
  for(const rate of [1,10,25,50]) {
    await page.evaluate(({rateKey,rate})=>localStorage.setItem(rateKey,String(rate)),{rateKey,rate});
    await page.goto(`${base}/monitor-fixture`);
    await page.waitForFunction(()=>window.fixture);
    assert.equal(await page.evaluate(()=>fixture.samples),0,'restoring a saved rate does not sample a closed Monitor');
    await page.click('#btn-monitor');
    assert.match(await page.locator('[data-monitor=sampling-rate]').textContent(),new RegExp(`${rate} samples/s`),'each supported saved rate is restored');
    const next={1:10,10:25,25:50,50:1}[rate];
    await page.click('[data-monitor=sampling-rate]');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),rateKey),String(next),'cycling immediately saves the selected rate');
    await page.reload();await page.waitForFunction(()=>window.fixture);
    assert.equal(await page.evaluate(()=>fixture.samples),0,'reloading after a rate change leaves sampling inactive');
    await page.click('#btn-monitor');
    assert.match(await page.locator('[data-monitor=sampling-rate]').textContent(),new RegExp(`${next} samples/s`),'a changed rate survives a browser reload');
  }
  for(const value of ['invalid','25junk','0']) {
    await page.evaluate(({rateKey,value})=>localStorage.setItem(rateKey,value),{rateKey,value});
    await page.goto(`${base}/monitor-fixture`);await page.waitForFunction(()=>window.fixture);
    await page.click('#btn-monitor');
    assert.match(await page.locator('[data-monitor=sampling-rate]').textContent(),/10 samples\/s/,'invalid stored rates fall back to ten samples per second');
  }
  await page.addInitScript(()=>{
    if(location.pathname==='/monitor-fixture'&&location.search==='?storage-blocked')Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage disabled','SecurityError');}});
  });
  await page.goto(`${base}/monitor-fixture?storage-blocked`);await page.waitForFunction(()=>window.fixture);
  assert.equal(await page.evaluate(()=>fixture.samples),0,'unavailable storage does not trigger sampling');
  await page.click('#btn-monitor');
  assert.match(await page.locator('[data-monitor=sampling-rate]').textContent(),/10 samples\/s/,'blocked storage uses the default rate');
  await page.click('[data-monitor=sampling-rate]');
  assert.match(await page.locator('[data-monitor=sampling-rate]').textContent(),/25 samples\/s/,'rate selection remains usable when saving is blocked');
  await page.click('[data-monitor=close]');
  await page.goto(`${base}/monitor-fixture`);await page.waitForFunction(()=>window.fixture);
  await page.evaluate(key=>localStorage.removeItem(key),rateKey);
  console.log('ok  - browser sampling preference, reloads, validation and unavailable storage');

  const roms = {};
  for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
    const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
  }
  if (Object.keys(roms).length !== 3) console.log('ok  - app Monitor integration # SKIP local C64 ROMs missing');
  else {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(roms => {
      for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
      for (const key of ['splashSeen', 'themePickerShown', 'installDismissed']) localStorage.setItem('c64emu.' + key, '1');
      localStorage.setItem('c64emu.attract', '0');
    }, roms);
    await page.goto(base);
    await page.locator('#btn-power').click();
    await page.waitForFunction(() => !document.querySelector('#btn-monitor').disabled);
    assert.ok(await page.locator('#btn-power').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft) >= 8 && parseFloat(getComputedStyle(el).paddingRight) >= 8), 'text buttons keep horizontal breathing room');
    await page.click('#btn-monitor');
    await page.waitForFunction(() => document.querySelector('[data-live="cpu-status"]').textContent.length > 0);
    await page.waitForFunction(()=>document.querySelector('.monitor-code-story').dataset.captureLabel?.startsWith('Captured frame'));
    await page.click('[data-monitor="pause"]');
    assert.equal(await page.locator('[data-story="status"]').count(),0,'Code has no redundant capture-count status line');
    const sharedPausedFrame=(await page.locator('.monitor-code-story').getAttribute('data-capture-label')).split(' · ')[0];
    const pausedCycles=await page.evaluate(()=>window.machine.vic2.totalCycles);
    for(const view of ['code','frame','sid','storage','atlas','code','frame']) {
      await page.click(`[data-view="${view}"]`);
      if(view==='code') assert.ok((await page.locator('.monitor-code-story').getAttribute('data-capture-label')).startsWith(sharedPausedFrame),'paused Code reuses the frame recorded on Live');
      if(view==='frame') assert.ok((await page.locator('[data-frame="status"]').textContent()).startsWith(sharedPausedFrame),'paused Video reuses the frame recorded on Live');
    }
    assert.equal(await page.evaluate(()=>window.machine.vic2.totalCycles),pausedCycles,'paused section changes and capture never clock the C64');
    assert.equal(await page.evaluate(()=>window.machine.vic2._frameCapture),null,'paused navigation never queues a replacement recording');
    await page.click('[data-monitor="pause"]');
    await page.click('[data-view="atlas"]');
    await page.getByRole('button',{name:/Character patterns \$/}).click();
    assert.match(await page.locator('[data-memory="meaning"]').textContent(), /Character ROM/, 'configured character ROM is distinguished from underlying RAM');
    await page.getByRole('button',{name:'View the source actually read by the VIC →',exact:true}).click();
    assert.match(await page.locator('[data-monitor="source"]').textContent(), /VIC-visible Character ROM/, 'explicit VIC source navigation labels ROM bytes');
    assert.equal(await page.locator('[data-memory="visual"]').evaluate(el=>el.width), 128, 'VIC ROM source displays the real configured character set');
    await page.click('[data-page="1"]');
    assert.match(await page.locator('[data-memory="facts"]').textContent(), /Next stack push/, 'stack explains the current push address');
    await page.click('[data-view="setup"]');
    await page.locator('#screen').focus();

    await page.locator('.monitor-brand .logo-text').evaluate(async el => { await document.fonts.ready; await Promise.allSettled(el.getAnimations().map(animation => animation.finished)); });
    for (const width of [1440, 900, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(350);
      const screenSize = await page.locator('#screen').boundingBox();
      assert.ok(Math.abs(screenSize.height - screenSize.width * 272 / 384) < 0.1, `live display preserves 384:272 aspect at viewport ${width}`);
      const aligned = await page.locator('.monitor-brand').evaluate(el => Math.abs(el.querySelector('#monitor-title').getBoundingClientRect().left - el.querySelector('.lt-c64').getBoundingClientRect().left) < 1);
      assert.ok(aligned, `Monitor title shares the lettering column at viewport ${width}`);
      assert.ok(await page.locator('#monitor-title').evaluate(el=>{
        const range=document.createRange();range.selectNodeContents(el.firstChild);
        const word=range.getBoundingClientRect(), badge=el.querySelector('.monitor-beta').getBoundingClientRect();
        return badge.width>0&&badge.left>=word.right&&badge.top>=word.top-2&&badge.bottom<=word.bottom+2;
      }),`Beta follows Monitor on the same line at viewport ${width}`);

    }
    await page.setViewportSize({width:1280,height:720});

    await page.click('[data-about="vic"]');
    await page.waitForFunction(()=>document.querySelector('.monitor-component-guide article h2'));

    await page.locator('.monitor-component-guide .monitor-help-close').click();
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#screen').focus();
    assert.equal(await page.locator('#machine-monitor .logo-text').count(), 1, 'Monitor retains the app header sign');
    const themeBefore = await page.evaluate(() => localStorage.getItem('c64emu.theme'));
    await page.keyboard.press('Control+Shift+Y');
    assert.notEqual(await page.evaluate(() => localStorage.getItem('c64emu.theme')), themeBefore, 'theme cycling remains available while the display has focus');
    const inherited = await page.locator('#machine-monitor').evaluate(el => getComputedStyle(el).getPropertyValue('--text').trim());
    assert.equal(inherited, await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text').trim()), 'Monitor inherits the newly selected theme');
    await page.keyboard.down('a');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).c64.isKeyDown(1, 2)), true, 'keyboard reaches the C64 from the embedded display');
    await page.waitForFunction(()=>/key.*held/.test(document.querySelector('[data-live="controls-status"]').textContent));
    assert.match(await page.locator('[data-live="controls-detail"]').innerText(),/\d \/ 4 timers started/,'Live shows sampled CIA timer state');
    await page.click('[data-machine="controls"]');
    await page.waitForFunction(()=>!document.querySelector('[data-monitor=controls]').hidden);
    assert.ok(await page.locator('.monitor-keyboard-matrix .is-active').count()>0,'control inspection shows the held key from the shared snapshot');
    for(const [width,height] of [[1280,720],[1440,1000]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.locator('.monitor-controls-content').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'desktop Controls exposes keyboard, ports and all timer readings without scrolling');
    }
    assert.match(await page.locator('[data-controls="interrupts"]').innerText(),/CIA1 pending \$[0-9A-F]+/,'control inspection shows formatted interrupt values');
    await page.click('[data-view=setup]');

    await page.click('[data-view="atlas"]');
  await page.locator('[data-monitor="map"] [data-page="4"]').focus();
    await page.keyboard.up('a');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).c64.isKeyDown(1, 2)), false, 'key release reaches C64 after focus changes to inspection');
    await page.locator('#screen').focus();
    await page.keyboard.down('ArrowUp');
    assert.equal(await page.evaluate(() => window.machine.joyPort2 & 1), 0, 'keyboard joystick reaches control port two');
    await page.keyboard.up('ArrowUp');
    assert.equal(await page.evaluate(() => window.machine.joyPort2 & 1), 1, 'keyboard joystick releases control port two');
    await page.evaluate(async () => {
      const { c64 } = await import('/src/state.js');
      const { createBlankD64 } = await import('/src/media/d64.js');
      c64.setD64(createBlankD64('STORAGE TEST','01'));
      c64.newBlankTape(); c64.attachReu('1764');
      window.machine.mem.setCartridge({mode:'8k',romLo:new Uint8Array(8192)});
    });
    await page.click('[data-view="storage"]');
    for (const [index,name] of ['Drive 8','Drive 9','Tape','CRT','REU'].entries()) {
      await page.click(`[data-storage-device="${index}"]`);
      for (const [width,height] of [[1920,1080],[1440,900],[1280,720]]) {
        await page.setViewportSize({width,height});
        const fit = await page.locator('[data-monitor="storage"]').evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
        assert.equal(fit,true,`${name} storage details fit ${width} × ${height}`);
        const clear = await page.locator('[data-monitor="storage"]').evaluate(el => {
          const historyTop = el.querySelector('[data-storage="history"]').getBoundingClientRect().top;
          const factsBottom = el.querySelector('[data-storage="limit"]').getBoundingClientRect().bottom;
          const statusBottom = el.querySelector('[data-storage="status"]').getBoundingClientRect().bottom;
          return Math.max(factsBottom, statusBottom) <= historyTop;
        });
        assert.equal(clear,true,`${name} facts and illustration do not overlap activity at ${width} × ${height}`);
      }
    }
    await page.waitForFunction(()=>document.querySelector('[data-storage="status"]').textContent.includes('256 KB'));
    assert.match(await page.locator('[data-storage="status"]').textContent(), /256 KB/, 'REU shows its actual fitted RAM capacity');
    await page.click('[data-storage-device="3"]');
    assert.match(await page.locator('[data-storage="status"]').textContent(), /8k mapping/, 'CRT reports current cartridge mapping');
    await page.click('[data-storage="inspect"]');
    assert.equal(await page.locator('[data-code="address"]').inputValue(),'8000','cartridge opens CPU-visible code rather than underlying RAM');
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(async () => {
      window.machine.mem.setCartridge(null);
      const { c64 } = await import('/src/state.js');
      c64.detachReu(); c64.ejectTape(); c64.setD64(null);
    });
    await page.click('[data-view="sid"]');
    await page.waitForFunction(()=>document.querySelector('[data-monitor="sid"]').dataset.sidCount==='1');
    const sid2Preview=page.locator('[data-chip="1"]');
    assert.equal(await sid2Preview.isVisible(),true,'disabled SID 2 remains visible as a desktop preview');
    assert.match(await sid2Preview.locator('[data-sid="identity"]').textContent(),/Not enabled.*Options/,'preview explains how to enable the extra chip');
    assert.equal(await sid2Preview.locator('.monitor-sid-voice').count(),3,'preview shows all three optional voices');
    assert.deepEqual(await sid2Preview.locator('.monitor-sid-voice strong').allTextContents(),['—','—','—'],'preview does not invent frequency readings');
    assert.equal(await sid2Preview.locator('.monitor-sid-filter').evaluate(el=>el.inert),true,'preview cannot open readback controls for an absent chip');
    const singleSidBox=await page.locator('[data-chip="0"]').boundingBox();
    await page.evaluate(() => {
      window.machine.configureSecondSid({enabled: true, address: 0xDE00, is8580: false});
      window.machine.mem.sid2.write(0, 0x34); window.machine.mem.sid2.write(1, 0x12);
      window.machine.mem.sid2.write(4, 0x41); window.machine.mem.sid2.write(0x18, 15);
    });
    await page.click('[data-view="sid"]');
    await page.waitForFunction(() => document.querySelector('[data-monitor="sid"]').dataset.sidCount === '2');
    const dualSidBox=await page.locator('[data-chip="0"]').boundingBox();
    assert.ok(Math.abs(singleSidBox.width-dualSidBox.width)<1&&Math.abs(singleSidBox.height-dualSidBox.height)<1,'SID 1 keeps the same desktop size when a second SID is enabled');
    assert.match(await page.locator('[data-chip="1"] [data-sid="identity"]').textContent(), /6581.*DE00/, 'dual SID shows its independent model and address');
    assert.equal(await page.locator('[data-chip="1"] [data-sid="volume"]').getAttribute('max'), '15', 'SID volume spans the four-bit setting');
    assert.equal(await page.locator('[data-chip="1"] [data-sid="volume"]').evaluate(el => el.value), 15, 'second SID volume is independent');
    assert.equal(await sid2Preview.evaluate(el=>el.classList.contains('is-inactive')),false,'enabling SID 2 removes preview fading');
    assert.equal(await sid2Preview.locator('.monitor-sid-filter').evaluate(el=>el.inert),false,'enabled SID 2 restores readback controls');
    assert.equal(await page.locator('[data-sid-voice]').count(),0,'voice information is available without selection controls');
    for(const [width,height] of [[1440,1000],[1280,720]]) {
      await page.setViewportSize({width,height});
      const voiceFit=await page.locator('.monitor-sid-voice').evaluateAll(cards=>cards.every(card=>{const b=card.getBoundingClientRect();return [...card.children].every(child=>{const c=child.getBoundingClientRect();return c.top>=b.top&&c.bottom<=b.bottom&&c.left>=b.left&&c.right<=b.right;});}));
      assert.ok(voiceFit,`all six envelopes, settings and explanations fit inside their voice boxes at ${width} × ${height}`);
      assert.ok(await page.locator('.monitor-sid-chip').evaluateAll(chips=>chips.every(el=>el.scrollHeight<=el.clientHeight+1)),`both SID filters and voice details are visible at ${width} × ${height}`);
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>window.machine.configureSecondSid({enabled:false}));
    await page.waitForFunction(()=>document.querySelector('[data-monitor="sid"]').dataset.sidCount==='1');
    assert.deepEqual(await sid2Preview.locator('.monitor-sid-voice strong').allTextContents(),['—','—','—'],'disabling SID 2 clears previous live readings');
    assert.equal(await sid2Preview.locator('.is-set').count(),0,'disabled preview clears active waveform and routing indicators');
    await page.evaluate(()=>window.machine.configureSecondSid({enabled:true,address:0xDE00,is8580:false}));
    await page.waitForFunction(()=>document.querySelector('[data-monitor="sid"]').dataset.sidCount==='2');

    const links=page.locator('[data-monitor=sid] > .monitor-section-links');
    assert.deepEqual(await links.locator('button').allTextContents(),['Register bytes','Reading the SID','Captured voice changes'],'Sound has one compact row of secondary links');
    assert.ok(await links.locator('button').evaluateAll(nodes=>nodes.every(n=>Math.abs(n.getBoundingClientRect().top-nodes[0].getBoundingClientRect().top)<1)),'Sound links share one horizontal row on desktop');
    await links.getByText('Register bytes',{exact:true}).click();
    assert.equal(await page.locator('.monitor-help-dialog[open] pre').count(),2,'register bytes retain both SID chips');
    await page.locator('.monitor-help-dialog[open] .monitor-help-close').click();
    await page.setViewportSize({width:375,height:667});
    await page.click('[data-sid-chip="1"]');
    assert.equal(await page.locator('[data-chip="1"]').isVisible(), true, 'phone can select the second SID');
    assert.equal(await page.locator('[data-chip="0"]').isVisible(), false, 'phone focuses one chip without scrolling');
    assert.equal(await page.locator('[data-monitor="sid"]').evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'dual SID detail fits phone viewport');
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(async () => {
      const { c64 } = await import('/src/state.js');
      const request = c64.requestVicFrameCapture.bind(c64);
      window.videoCaptureRequests = 0;
      c64.requestVicFrameCapture = options => { window.videoCaptureRequests++; return request(options); };
    });
    for(const view of ['code','atlas','sid','controls','storage','frame']) {
      await page.click(`[data-view="${view}"]`);
      const previous=await page.locator('.monitor-code-story').getAttribute('data-capture-label');
      await page.waitForFunction(previous=>document.querySelector('.monitor-code-story').dataset.captureLabel!==previous,previous);
      assert.equal(await page.locator(`[data-monitor="${view}"] .monitor-section-about`).isVisible(),true,`${view} exposes About in its header`);
    }
    await page.locator('[data-video="topic"]').selectOption('sprite');
    const beforeSpriteRefresh=await page.locator('.monitor-code-story').getAttribute('data-capture-label');
    await page.waitForFunction(previous=>document.querySelector('.monitor-code-story').dataset.captureLabel!==previous,beforeSpriteRefresh);
    assert.equal(await page.locator('[data-video="topic"]').inputValue(),'sprite','Sprites stays selected when the next automatic shared capture arrives');
    await page.click('[data-monitor="pause"]');
    await page.waitForFunction(() => document.querySelector('[data-frame="status"]').textContent.includes('paused'));
    await page.locator('[data-section-about="vic"]').click();
    await page.waitForFunction(()=>document.querySelector('#monitor-component-guide-title').textContent==='The VIC-II');
    await page.locator('.monitor-component-guide .monitor-help-close').click();
    assert.equal(await page.locator('[data-frame="capture"], [data-story="capture"], [data-frame="auto"]').count(),0,'shared automatic recording needs no section capture controls');
    await page.locator('[data-video="topic"]').selectOption('techniques');
    const ghost=page.getByRole('heading',{name:/Ghost bytes/}).locator('..');
    assert.match(await ghost.innerText(),/idle graphics accesses/,'Video techniques explain recorded ghost-byte reads');
    assert.equal(await ghost.getByRole('link',{name:'Bauer §3.7.3.9'}).count(),1,'ghost-byte technique links to its rule');
    assert.equal(await ghost.getByRole('button',{name:'Inspect captured source in Memory →'}).count(),1,'ghost-byte technique links its recorded source to Memory');
    await page.locator('[data-video="topic"]').selectOption('overview');
    const requests=await page.evaluate(()=>window.videoCaptureRequests);
    const pictureBox=await page.locator('[data-frame=picture]').boundingBox();
    const scale=Math.min(pictureBox.width/504,pictureBox.height/312);
    const imageLeft=pictureBox.x+(pictureBox.width-504*scale)/2;
    const imageTop=pictureBox.y+(pictureBox.height-312*scale)/2;
    await page.mouse.move(imageLeft+(80+160.5)*scale,imageTop+(15+100.5)*scale);
    assert.equal(await page.locator('.monitor-pixel-lens').isVisible(),true,'hover magnifies the captured picture');
    assert.ok((await page.locator('.monitor-pixel-lens').boundingBox()).width<=110,'pixel lens remains compact');
    assert.equal(await page.locator('.monitor-pixel-lens').getAttribute('data-pixel'),'160,100','lens uses the same letterboxed source coordinates as pixel selection');
    assert.equal(await page.locator('.monitor-pixel-lens').evaluate(el=>getComputedStyle(el).pointerEvents),'none','lens never intercepts a pixel click');
    assert.equal(await page.locator('[data-frame=picture]').evaluate(el=>getComputedStyle(el).cursor),'none','native cursor is hidden while the lens supplies the only crosshair');
    assert.equal(await page.locator('.monitor-pixel-lens').evaluate(el=>el.children.length),1,'the magnifier has no extra coordinate badge or selector element');
    const pixelMatches=await page.evaluate(()=>{
      const lens=document.querySelector('.monitor-pixel-lens canvas').getContext('2d').getImageData(52,52,1,1).data;
      const picture=document.querySelector('[data-frame=picture]').getContext('2d').getImageData(240,115,1,1).data;
      return lens.every((value,i)=>value===picture[i]);
    });
    assert.ok(pixelMatches,'the unobscured lens centre shows the exact pixel selected by a click');
    assert.ok(await page.locator('.monitor-pixel-lens canvas').evaluate(el=>{const css=getComputedStyle(el);return el.getBoundingClientRect().width-parseFloat(css.borderLeftWidth)-parseFloat(css.borderRightWidth)===el.width;}),'lens pixels render at native canvas size, preserving exact eightfold magnification');
    assert.equal(await page.locator('.monitor-video-stage-head input[type=checkbox]:visible').count(),5,'all five layer checkboxes are visible above the picture');
    assert.ok(await page.locator('.monitor-frame-layers').evaluate(el=>{const row=el.getBoundingClientRect(),head=el.parentElement.getBoundingClientRect(),picture=el.closest('.monitor-video-stage').querySelector('[data-frame=picture]').getBoundingClientRect();return Math.abs(row.right-head.right)<1&&row.bottom<=picture.top;}),'layer controls sit above the picture and align right');
    await page.mouse.click(imageLeft+(80+160.5)*scale,imageTop+(15+100.5)*scale);
    assert.equal(await page.locator('[data-video=topic]').inputValue(),'pixel','click through the lens opens the pixel explanation');
    for(const [x,y] of [[0,0],[383,0],[0,271],[383,271]]){
      await page.mouse.move(imageLeft+(80+x+.5)*scale,imageTop+(15+y+.5)*scale);
      assert.equal(await page.locator('.monitor-pixel-lens').getAttribute('data-pixel'),`${x},${y}`,'edge pixels retain exact coordinates');
      const lens=await page.locator('.monitor-pixel-lens canvas').boundingBox();
      assert.ok(Math.abs(lens.x+lens.width/2-(imageLeft+(80+x+.5)*scale))<1&&Math.abs(lens.y+lens.height/2-(imageTop+(15+y+.5)*scale))<1,'selected pixel stays at the lens centre, including picture edges');
    }
    await page.mouse.move(imageLeft+10*scale,imageTop+100*scale);
    assert.equal(await page.locator('.monitor-pixel-lens').isVisible(),false,'timing margins are not mistaken for picture pixels');
    await page.mouse.move(5,5);
    assert.equal(await page.locator('.monitor-pixel-lens').isVisible(),false,'lens disappears outside the captured picture');
    assert.equal(await page.evaluate(()=>window.videoCaptureRequests),requests,'magnification and selection reuse the capture');

    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>window.videoCaptureRequests),requests,'held frame does not silently refresh');
    assert.equal(await page.locator('[data-frame="explain"]').count(),0,'Video uses one workspace instead of a second Explain page');
    for(const [width,height] of [[1440,1000],[1280,720]]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.locator('[data-monitor="frame"]').evaluate(el=>el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth+1),true,`Video workspace fits ${width} × ${height}`);
      const bounds=await page.locator('.monitor-video-timing').evaluate(el=>{const b=el.getBoundingClientRect(),c=el.querySelector('canvas').getBoundingClientRect();return {bottom:b.bottom,canvasBottom:c.bottom};});
      assert.ok(bounds.canvasBottom<=bounds.bottom+1,'all five timing rows fit beside their labels');
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-frame="picture"]').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-video="topic"]').inputValue(),'pixel','picture keyboard activation opens pixel explanation in place');
    assert.equal(await page.locator('.monitor-video-inspector .monitor-pixel-bits span').count(),8,'pixel inspector shows the eight recorded bits');
    assert.equal(await page.locator('.monitor-help-dialog[open]').count(),0,'pixel inspection never opens a modal');
    const held=(await page.locator('[data-frame="status"]').textContent()).split(' · ')[0];
    const position=await page.locator('[data-frame="seek"]').inputValue();
    await page.locator('[data-video="topic"]').selectOption('timing');
    assert.equal(await page.locator('.monitor-video-rules > details').count(),await page.evaluate(async()=>(await import('/src/monitor/bauer-rules.js')).BAUER_RULES.length),'Rules at this cycle exposes the complete indexed catalogue');
    assert.equal(await page.locator('[data-frame="seek"]').inputValue(),position,'changing topic preserves the shared cycle');
    const rule=page.locator('.monitor-video-rules > details').first();
    await rule.locator('summary').click();
    await page.locator('.monitor-video-steps > summary').click();
    await page.click('[data-frame="cycle"]');
    await page.waitForTimeout(100);
    assert.equal(await rule.evaluate(el=>el.open),true,'stepping the shared timeline preserves the expanded rule');
    await page.locator('.monitor-video-steps > summary').click();
    assert.ok((await page.locator('[data-frame="status"]').textContent()).startsWith(held),'rules and picture retain the same recording');
    assert.equal(await page.evaluate(()=>window.videoCaptureRequests),requests,'topic and rule navigation never recapture');
    await page.getByRole('button',{name:'How to use Video',exact:true}).click();
    const help=page.locator('.monitor-help-dialog[open]');
    const helpBox=await help.boundingBox();
    assert.ok(helpBox.width<700&&helpBox.height<500,'short help uses a content-sized dialog');
    assert.ok(helpBox.x>100&&helpBox.y>100,'help dialog is centered in the browser');
    await page.keyboard.press('Escape');
    assert.equal(await help.count(),0,'Escape closes help');
    assert.equal(await page.locator('#machine-monitor').evaluate(el=>el.open),true,'Escape on help leaves Monitor open');
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'How to use Video','help returns focus to its trigger');
    const beforeResume=await page.evaluate(()=>window.videoCaptureRequests);
    await page.click('[data-monitor="pause"]');
    await page.waitForFunction(n=>window.videoCaptureRequests>n,beforeResume);
    await page.click('[data-frame="play"]');
    await page.waitForFunction(()=>document.querySelector('[data-monitor="pause"]').getAttribute('aria-pressed')==='true');
    const replayRequests=await page.evaluate(()=>window.videoCaptureRequests);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>window.videoCaptureRequests),replayRequests,'replay pauses shared capture before playing the recording');
    await page.click('[data-frame="play"]');
    assert.equal(await page.locator('#screen').isVisible(),true,'live machine stays visible while inspecting Video');
    const machineCycles=await page.evaluate(()=>window.machine.vic2.totalCycles);
    await page.click('[data-frame="play"]');await page.waitForTimeout(150);await page.click('[data-frame="play"]');
    assert.equal(await page.evaluate(()=>window.machine.vic2.totalCycles),machineCycles,'replay does not clock the paused C64');
    assert.ok((await page.locator('[data-frame="status"]').textContent()).startsWith('Captured frame'),'paused capture keeps the shared recording available');
    assert.equal(await page.evaluate(()=>window.machine.vic2._frameCapture),null,'paused capture does not queue work behind a stopped machine');
    await page.click('[data-view="setup"]');
    assert.equal(await page.evaluate(()=>window.machine.vic2._frameCapture),null,'leaving Video cancels a pending capture');
    await page.evaluate(()=>{const m=window.machine;m.vic2.currentVicBank=0;m.vic2.regs[0x18]=0x14;m.vic2.regs[0x15]=1;m.mem.ram[0x7f8]=0x80;m.mem.ram[0x2000]=0x80;});
    await page.click('#screen');
    assert.equal(await page.getByRole('button',{name:'Live source inspector',exact:true}).count(),0,'Video has no separate live-source inspector');
    await page.click('[data-view="atlas"]');
    await page.getByRole('button',{name:'Sprite sources $2000',exact:true}).click();
    assert.equal(await page.locator('[data-monitor="selection"]').textContent(),'$2000–$20FF','Memory follows the configured sprite pointer');
    assert.match(await page.locator('[data-memory="meaning"]').textContent(), /Sprite 0 points here/, 'Memory explains the live sprite source');
    await page.click('[data-view="frame"]');
    const oldRecording=(await page.locator('[data-frame="status"]').textContent()).split(' · ')[0];
    await page.click('[data-monitor="pause"]');
    await page.waitForFunction(old=>!document.querySelector('[data-frame="status"]').textContent.startsWith(old),oldRecording);
    await page.click('[data-monitor="pause"]');
    await page.locator('[data-frame="picture"]').focus();await page.keyboard.press('Enter');
    const captureIdentity=(await page.locator('[data-frame="status"]').textContent()).split(' · ')[0];
    await page.getByRole('button',{name:'Inspect captured source in Memory →',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.monitor-help-dialog[open]'));
    assert.match(await page.locator('.monitor-help-dialog[open] .monitor-evidence-head b').textContent(),new RegExp(captureIdentity),'source memory keeps the captured frame identity');
    await page.locator('.monitor-help-dialog[open] > header button').click();
    await page.click('[data-view="setup"]');
    assert.equal(await page.locator('[data-monitor="status"]').textContent(), 'Paused', 'Monitor controls actual host pause');
    await page.click('[data-monitor="close"]');
    assert.match(await page.locator('#btn-pause').textContent(), /RESUME/, 'host stays paused after Monitor closes');
    await page.click('#btn-monitor');
    await page.click('[data-monitor="pause"]');
    assert.match(await page.locator('#btn-pause').textContent(), /PAUSE/, 'host resumes through Monitor');
    await page.click('[data-monitor="close"]');
    assert.equal(await page.locator('.crt-bezel > #screen').count(), 1, 'original display returns to its bezel');
    assert.equal(await page.locator('body > header .logo-text').count(), 1, 'header sign returns to normal layout');
    await page.selectOption('#cp-device-p1', 'paddle');
    await page.click('#btn-monitor');
    await page.locator('#screen').dispatchEvent('mousedown', { button: 0 });
    assert.equal(await page.evaluate(() => window.machine.joyPort1 & 4), 0, 'paddle A button uses the active-low LEFT line (bit 2)');
    await page.locator('#screen').dispatchEvent('mouseup', { button: 0 });
    assert.equal(await page.evaluate(() => window.machine.joyPort1 & 4), 4, 'paddle A button releases the LEFT line inside Monitor');
    await page.keyboard.press('Escape');
    console.log('ok  - actual machine facade, keyboard, control port, shared display and host pause integration');

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    phone.on('pageerror', error => errors.push(error.message));
    await phone.addInitScript(roms => {
      for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
      for (const key of ['splashSeen', 'themePickerShown', 'installDismissed']) localStorage.setItem('c64emu.' + key, '1');
      localStorage.setItem('c64emu.controlPorts', JSON.stringify({ 1: 'none', 2: 'touchJoystick' }));
    }, roms);
    await phone.goto(base);
    await phone.click('#btn-power');
    await phone.waitForFunction(() => !document.querySelector('#btn-monitor').disabled);
    await phone.click('#btn-monitor');
    assert.equal(await phone.locator('#machine-monitor #touch-controls').isVisible(), true, 'touch joystick moves into the full-window Monitor');
    assert.equal(await phone.locator('#machine-monitor #mobile-kbd').count(), 1, 'native keyboard input stays within modal focus containment');
    await phone.locator('#touch-button-a').dispatchEvent('pointerdown', { pointerId: 55, pointerType: 'touch', button: 0 });
    assert.equal(await phone.evaluate(() => window.machine.joyPort2 & 16), 0, 'touch fire reaches the control port');
    await phone.locator('#touch-button-a').dispatchEvent('pointerup', { pointerId: 55, pointerType: 'touch', button: 0 });
    assert.equal(await phone.evaluate(() => window.machine.joyPort2 & 16), 16, 'touch fire releases in Monitor');
    for (const [width,height] of [[320,568],[375,667],[390,844],[768,1024],[844,390]]) {
      await phone.setViewportSize({width,height});
      for (const view of ['setup','code','atlas','frame','sid','controls','storage']) {
        await phone.locator(`button[data-view="${view}"]`).tap();
        assert.ok(await phone.locator('#machine-monitor').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`${view} stays within touch viewport ${width} × ${height}`);
      }
      assert.ok(await phone.locator('.monitor-header [data-view]').evaluateAll(nodes=>nodes.every(el=>el.getBoundingClientRect().height>=44)),`main navigation has 44px touch targets at ${width} × ${height}`);
      await phone.locator('button[data-view="frame"]').tap();
      await phone.waitForFunction(()=>!document.querySelector('[data-frame="play"]').disabled);
      const layersFit=await phone.locator('.monitor-frame-layers').evaluate(el=>{
        const bounds=el.closest('.monitor-video-stage').getBoundingClientRect();
        return [...el.querySelectorAll('label')].every(label=>{const b=label.getBoundingClientRect();return b.left>=bounds.left-1&&b.right<=bounds.right+1;});
      });
      assert.ok(layersFit,`Video layer labels wrap inside the picture column at ${width} × ${height}`);
      const picture=phone.locator('[data-frame="picture"]');
      await picture.scrollIntoViewIfNeeded();
      const pictureBox=await picture.boundingBox();
      assert.ok(pictureBox.width>200&&pictureBox.height>=150,`captured picture retains useful size at ${width} × ${height}`);
      await phone.locator('[data-frame="sprites"]').check();
      assert.ok(await phone.locator('[data-frame="sprites"]').isChecked(),'sprite coverage remains reachable by touch');
      await phone.locator('button[data-view="sid"]').tap();
      await phone.locator('[data-sid-chip="1"]').tap();
      assert.ok(await phone.locator('[data-chip="1"]').isVisible(),`SID 2 preview is reachable at ${width} × ${height}`);
      assert.equal(await phone.locator('[data-chip="0"]').isVisible(),false,'compact Sound shows one readable chip at a time');
      await phone.locator('[data-sid-chip="0"]').tap();
      const lastVoice=phone.locator('[data-chip="0"] .monitor-sid-voice').last();
      await lastVoice.locator('strong').scrollIntoViewIfNeeded();
      assert.ok(await lastVoice.locator('strong').evaluate(el=>{
        const b=el.getBoundingClientRect(),chip=el.closest('.monitor-sid-chip').getBoundingClientRect();
        return b.top>=chip.top&&b.bottom<=chip.bottom;
      }),'the third voice reading can scroll fully into view');
      await phone.getByRole('button',{name:'Reading the SID',exact:true}).tap();
      const help=phone.locator('.monitor-help-dialog[open]');
      const helpBox=await help.boundingBox();
      assert.ok(helpBox.x>=0&&helpBox.y>=0&&helpBox.x+helpBox.width<=width+1&&helpBox.y+helpBox.height<=height+1,'Sound help stays inside the touch viewport');
      await help.getByRole('button',{name:'Close dialog',exact:true}).tap();
    }
    await phone.locator('[data-monitor="close"]').click();
    assert.equal(await phone.locator('#monitor > #touch-controls').count(), 1, 'touch controls return to their original position');
    await phone.close();
    console.log('ok  - phone touch joystick and native keyboard remain attached');
  }
  assert.deepEqual(errors, [], 'no browser errors');
} finally { await browser.close(); await vite.close(); }
