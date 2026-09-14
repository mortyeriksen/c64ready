import assert from 'node:assert/strict';
import { sampleMedia } from '../fixtures/assembly64.js';

export async function installTdeTestChoice(page) {
  await page.addInitScript(() => {
    window.autoDeclineTde = true;
    new MutationObserver(() => {
      const modal = document.getElementById('confirm-modal');
      if (window.autoDeclineTde && modal && !modal.hidden && document.getElementById('confirm-modal-title').textContent === 'Better disk compatibility?') document.getElementById('btn-confirm-cancel').click();
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

export async function checkTde(page) {
  await page.evaluate(() => { window.autoDeclineTde = false; });
  try {
    for (const [drive, choice] of [[8, 'off'], [8, 'on'], [9, 'on'], [8, 'already-on'], [8, 'cancel']]) {
      await page.evaluate(async ({ drive, choice }) => {
        const dom = await import('/src/dom.js');
        const toggle = drive === 8 ? dom.tdeToggleBtn : dom.DRIVE9_UI.tdeBtn;
        if (choice !== 'already-on' && toggle.textContent.includes('ON')) toggle.click();
        const mediaUrl = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/media.js').name;
        const { openMedia } = await import(mediaUrl);
        const { sampleMedia } = await import('/test/fixtures/assembly64.js');
        window.tdeAbort = new AbortController(); window.tdeResult = null;
        window.tdeLoad = openMedia({ name: 'tde-check.d64', mediaType: 'd64', bytes: sampleMedia('d64'), targetDrive: drive, autorun: false, saveToLibrary: false, signal: window.tdeAbort.signal }).then(result => { window.tdeResult = result; }, error => { window.tdeResult = { error: error.name }; });
      }, { drive, choice });
      const modal = page.locator('#confirm-modal');
      if (choice === 'already-on') {
        await page.waitForFunction(() => window.tdeResult !== null);
        assert.equal(await modal.isVisible(), false, 'TDE already on skips confirmation');
      } else {
        await modal.waitFor();
        await modal.getByText(new RegExp(`drive ${drive}\\?`)).waitFor();
        if (choice === 'cancel') await page.evaluate(() => window.tdeAbort.abort());
        else await modal.getByRole('button', { name: choice === 'on' ? 'Turn TDE on' : 'Keep TDE off', exact: true }).click();
        await page.waitForFunction(() => window.tdeResult !== null);
        assert.equal(await modal.isVisible(), false, 'Confirm resolves or aborts without leaving a dialog open');
        if (choice === 'cancel') assert.deepEqual(await page.evaluate(() => window.tdeResult), { error: 'AbortError' }, 'Cancelled confirmation aborts loading');
        else assert.equal(await page.evaluate(drive => localStorage.getItem(drive === 8 ? 'c64emu.tde' : 'c64emu.drive9tde'), drive), choice, 'The selected drive persists the TDE choice');
      }
    }
  } finally { await page.evaluate(() => { window.autoDeclineTde = true; }); }
  console.log('D64 compatibility: accept/decline, drives 8/9, existing TDE and aborted confirmations passed.');
  await checkDiskPickers(page);
}

async function checkDiskPickers(page) {
  await page.evaluate(() => { window.autoDeclineTde = false; });
  try {
    for (const drive of [8, 9]) {
      for (const choice of ['off', 'on', 'already-on']) {
        await page.evaluate(async ({ drive, choice }) => {
          const dom = await import('/src/dom.js');
          const toggle = drive === 8 ? dom.tdeToggleBtn : dom.DRIVE9_UI.tdeBtn;
          if (choice !== 'already-on' && toggle.textContent.includes('ON')) toggle.click();
          window.diskBeforePrompt = drive === 8 ? window.machine.currentD64 : window.machine.currentD64Drive9;
        }, { drive, choice });
        const picker = page.locator(drive === 8 ? '#d64-input' : '#d64-input-9');
        await picker.setInputFiles({ name: `picker-${drive}-${choice}.d64`, mimeType: 'application/octet-stream', buffer: Buffer.from(sampleMedia('d64')) });
        const modal = page.locator('#confirm-modal');
        if (choice !== 'already-on') {
          await modal.waitFor();
          await modal.getByText(new RegExp(`drive ${drive}\\?`)).waitFor();
          assert.equal(await page.evaluate(drive => window.diskBeforePrompt === (drive === 8 ? window.machine.currentD64 : window.machine.currentD64Drive9), drive), true, 'The disk picker waits for the TDE answer before replacing the disk');
          await modal.getByRole('button', { name: choice === 'on' ? 'Turn TDE on' : 'Keep TDE off', exact: true }).click();
        }
        await page.waitForFunction(drive => window.diskBeforePrompt !== (drive === 8 ? window.machine.currentD64 : window.machine.currentD64Drive9), drive);
        await page.waitForFunction(drive => document.querySelector(drive === 8 ? '#d64-input' : '#d64-input-9').value === '', drive);
        assert.equal(await modal.isVisible(), false, 'An accepted or unnecessary picker prompt leaves no dialog open');
        assert.equal(await page.evaluate(drive => localStorage.getItem(drive === 8 ? 'c64emu.tde' : 'c64emu.drive9tde'), drive), choice === 'off' ? 'off' : 'on', 'The picker honors the chosen TDE setting');
      }
    }
  } finally { await page.evaluate(() => { window.autoDeclineTde = true; }); }
  console.log('Drive 8/9 D64 pickers: deferred mount, acceptance, decline and TDE already on passed.');
}
