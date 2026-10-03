import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sampleMedia} from '../fixtures/assembly64.js';
import {D64} from '../../src/media/d64.js';

export async function checkD71(page) {
  await page.evaluate(async()=>{
    const {openMedia}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/media.js').name);
    const {sampleMedia}=await import('/test/fixtures/assembly64.js');
    await openMedia({name:'setup.d71',mediaType:'d71',bytes:sampleMedia('d71'),targetDrive:9,autorun:false,saveToLibrary:false});
  });
  for(const drive of [8,9]){
    await page.evaluate(async drive=>{
      const dom=await import('/src/ui/dom.js');
      const toggle=drive===8?dom.tdeToggleBtn:dom.DRIVE9_UI.tdeBtn;
      if(!toggle.textContent.includes('ON'))toggle.click();
    },drive);
    await page.locator(drive===8?'#d64-input':'#d64-input-9').setInputFiles({name:`browser-${drive}.d71`,mimeType:'application/octet-stream',buffer:Buffer.from(sampleMedia('d71'))});
    await page.waitForFunction(drive=>document.querySelector(drive===8?'#d64-input':'#d64-input-9').value==='',drive);
    const mounted=await page.evaluate(async drive=>{
      const dom=await import('/src/ui/dom.js');
      const disk=drive===8?window.machine.currentD64:window.machine.currentD64Drive9;
      return {kind:disk.kind,protected:disk.writeProtected,tde:(drive===8?dom.tdeToggleBtn:dom.DRIVE9_UI.tdeBtn).textContent};
    },drive);
    assert.equal(mounted.kind,'d71','File picker mounts D71');
    assert.equal(mounted.protected,true,'Picked disk starts write-protected');
    assert.match(mounted.tde,/OFF/,'Mounting D71 switches TDE off');
    const suffix=drive===8?'':'-9';
    await page.locator(`#btn-d64-wp${suffix}`).click();
    await page.locator(`#btn-d64-format${suffix}`).click();
    await page.locator('#prompt-modal-input').fill('D71 CHECK');
    await page.locator('#btn-prompt-ok').click();
    await page.waitForFunction(drive=>(drive===8?window.machine.currentD64:window.machine.currentD64Drive9)?.diskName==='D71 CHECK',drive);
    const downloadEvent=page.waitForEvent('download');
    await page.locator(`#btn-d64-export${suffix}`).click();
    const download=await downloadEvent;
    assert.match(download.suggestedFilename(),/\.d71$/,'Export retains D71 extension');
    const disk=new D64(new Uint8Array(await readFile(await download.path())));
    assert.equal(disk.kind,'d71','Downloaded image retains D71 geometry');
    assert.equal(disk.freeBlocks,1328,'Browser format builds both sides of the BAM');
  }
  const stored=await page.evaluate(async()=>{
    const lib=await import('/src/media/library.js');
    const entry=(await lib.libList()).find(x=>x.type==='d71');
    return entry&&(await lib.libLoad(entry.id)).data.length;
  });
  assert.equal(stored,349696,'Library stores D71 image bytes');
  await page.evaluate(async()=>{
    const {stateSave}=await import('/src/statelibrary.js');
    const m=window.machine, state=m.serializeState();
    state.media={d64:m.currentD64.img.slice(),d64drive9:m.currentD64Drive9.img.slice(),drive9Enabled:true,vicVariant:'6569',sidIs8580:true};
    await stateSave('D71 RESTORE',state,null);
    const dom=await import('/src/ui/dom.js');
    dom.tdeToggleBtn.click();dom.DRIVE9_UI.tdeBtn.click();
  });
  await page.locator('#btn-load-state').click();
  await page.locator('#state-list .lib-row').filter({hasText:'D71 RESTORE'}).click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('State loaded: D71 RESTORE'));
  const restored=await page.evaluate(()=>({kind8:window.machine.currentD64.kind,kind9:window.machine.currentD64Drive9.kind,tde8:window.machine.truedriveEnabled,tde9:!!window.machine.drive1541b}));
  assert.deepEqual(restored,{kind8:'d71',kind9:'d71',tde8:false,tde9:false},'State restore selects virtual mode for both D71 images');
  console.log('PASS D71 state restore with TDE previously enabled');
  console.log('PASS D71 browser: drives 8/9, file pickers, TDE routing, write protection, format, export and Library');
}
