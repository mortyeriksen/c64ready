import assert from 'node:assert/strict';import {chromium} from 'playwright';import {createGuideContext} from '../tools/guide-context.mjs';
import {assetPath} from './external-assets.js';
for(const key of ['kernal','basic','chargen']) {
 if(!assetPath(key)) { console.log(`# SKIP missing ${key} ROM`); process.exit(0); }
}
let browser;
try { browser=await chromium.launch({headless:true}); }
catch { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS='0';
const {createServer}=await import('vite');
const server=await createServer({logLevel:'silent',server:{host:'127.0.0.1',port:0}});
await server.listen();
try{
 const context=await createGuideContext(browser,{viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('c64emu.splashSeen','1'));
 const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);await page.click('#btn-power');await page.waitForTimeout(1600);await page.click('#btn-pause');
 await page.click('#btn-monitor');
 await page.click('[data-monitor=pause]');
 await page.evaluate(async()=>{const {c64}=await import('/src/state.js');window.entryFrames=0;const run=c64.runFrame.bind(c64);c64.runFrame=()=>{entryFrames++;return run()};});
 await page.evaluate(()=>{entryFrames=0;document.querySelector('[data-view=code]').click();});
 assert.equal(await page.locator('[data-monitor=pause]').getAttribute('aria-label'),'Resume','Component entry pauses');
 assert.equal(await page.evaluate(()=>entryFrames),2,'Component entry obtains one bounded shared recording');
 await page.click('[data-view=sid]');await page.click('[data-view=atlas]');
 assert.equal(await page.evaluate(()=>entryFrames),2,'Component navigation preserves the recording without clocking');
 assert.equal(await page.locator('[data-monitor=pause] [data-monitor=status]').textContent(),'Paused','Header announces held state');
 await page.click('[data-view=setup]');
 assert.equal(await page.locator('[data-monitor=pause]').getAttribute('aria-label'),'Pause','Live resumes a navigation-owned pause');
 assert.match(await page.locator('[data-view=code]').getAttribute('data-tip'),/Pause and inspect Code/,'Navigation tooltip announces pausing');
 await page.click('[data-monitor=pause]');await page.click('[data-view=code]');await page.click('[data-view=setup]');
 assert.equal(await page.locator('[data-monitor=pause]').getAttribute('aria-label'),'Resume','Live respects a manual pause');
 await page.click('[data-view=sid]');await page.click('[data-monitor=pause]');
 assert.equal(await page.locator('[data-monitor=status]').textContent(),'Running','Explicit Resume permits component activity');
 await page.click('[data-monitor=close]');
 await page.click('#btn-monitor');
 assert.equal(await page.locator('button[data-view=setup]').getAttribute('aria-pressed'),'true','Reopening from a running component selects Live');
 assert.equal(await page.locator('[data-monitor=status]').textContent(),'Running','Reopening Live preserves running playback');
 const runningStyle=await page.locator('[data-monitor=pause]').evaluate(button=>{
  const style=getComputedStyle(button),tab=getComputedStyle(document.querySelector('button[data-view=setup]'));
  return {radius:parseFloat(style.borderRadius),tabRadius:parseFloat(tab.borderRadius),background:style.backgroundColor,tabBackground:tab.backgroundColor};
 });
 assert.ok(runningStyle.radius>runningStyle.tabRadius,'Playback uses a rounded transport shape distinct from section buttons');
 assert.notEqual(runningStyle.background,runningStyle.tabBackground,'Running control does not resemble the selected section');

 await page.click('[data-view=code]');
 await page.click('[data-monitor=close]');
 await page.click('#btn-monitor');
 assert.equal(await page.locator('button[data-view=setup]').getAttribute('aria-pressed'),'true','Reopening from a paused component selects Live');
 assert.equal(await page.locator('[data-monitor=status]').textContent(),'Running','Closing paused inspection resumes playback');
 await page.click('[data-monitor=pause]');
 const pausedStyle=await page.locator('[data-monitor=pause]').evaluate(button=>{
  const style=getComputedStyle(button),tab=getComputedStyle(document.querySelector('button[data-view=setup]'));
  return {background:style.backgroundColor,tabBackground:tab.backgroundColor};
 });
 assert.notEqual(pausedStyle.background,runningStyle.background,'Paused and running use different surface treatments');
 assert.notEqual(pausedStyle.background,pausedStyle.tabBackground,'Paused control remains distinct from selected navigation');

 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.locator('[data-monitor=pause]').evaluate(button=>{
   const outer=button.getBoundingClientRect(),label=button.querySelector('[data-monitor=status]').getBoundingClientRect();
   return label.left>=outer.left&&label.right<=outer.right&&label.top>=outer.top&&label.bottom<=outer.bottom;
  }),'State label fits inside the playback button');
 }
 await page.keyboard.press('Escape');
 assert.match(await page.locator('#btn-pause').textContent(),/PAUSE/,'Escape resumes the host machine');
 const hooks=await page.evaluate(()=>({frame:window.machine.vic2._frameCapture,activity:window.machine._monitorActivity,cpu:window.machine.cpu._captureObserver,memory:window.machine.mem._captureObserver,vic:window.machine.vic2._captureObserver}));
 assert.deepEqual(hooks,{frame:null,activity:null,cpu:null,memory:null,vic:null},'Exit detaches core capture observers before playback resumes');
 console.log('ok - component capture, shared held navigation, automatic return, manual pause and header state');
}finally{await browser.close();await server.close();}
