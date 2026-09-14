import assert from 'node:assert/strict';

export async function checkLoadDismissal(page) {
  for (const mode of ['browser', 'details', 'error', 'zip-cancel']) {
    await page.locator('#media-browser-body').getByRole('button', { name: 'EXPLORE', exact: true }).focus();
    await page.evaluate(async mode => {
      const { Assembly64Controller } = await import('/src/assembly64/controller.js');
      const { createAssembly64Store } = await import('/src/assembly64/store.js');
      const { openBrowserDialog } = await import('/src/assembly64/browser-dialog.js');
      const { openDetailsDialog } = await import('/src/assembly64/details-dialog.js');
      const { createFixtureTransport } = await import('/test/fixtures/assembly64.js');
      const controller = new Assembly64Controller({ transport: createFixtureTransport({ delayMs: 0 }) });
      await controller.search();
      const perform = (_, file, options, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        window.finishLoad = () => {
          if (mode === 'error') reject(new Error('Load failed: test media is invalid'));
          else resolve(mode === 'zip-cancel' ? { message: 'Archive selection cancelled.' } : { mediaType: file.mediaType, message: 'Media loaded' });
        };
      });
      openBrowserDialog(controller, createAssembly64Store(), perform);
      if (mode !== 'browser') {
        const item = controller.state.items[0];
        if (mode === 'zip-cancel') item.files = [{ id: 'archive', name: 'media.zip', mediaType: 'zip', size: 123 }];
        await openDetailsDialog(controller, item, perform, item);
      }
    }, mode);
    const active = page.locator(mode === 'browser' ? '.mb-browser' : '.mb-details');
    await active.getByRole('button', { name: mode === 'zip-cancel' ? 'CHOOSE FROM ZIP' : 'LOAD', exact: true }).first().click();
    assert.equal(await active.isVisible(), true, 'Dialogs stay open while loading so progress is visible');
    await page.evaluate(() => window.finishLoad());
    if (mode === 'error' || mode === 'zip-cancel') {
      await active.getByText(mode === 'error' ? 'Load failed: test media is invalid' : 'Archive selection cancelled.', { exact: true }).waitFor();
      assert.equal(await page.locator('.mb-overlay').count(), 2, 'Errors and cancelled archive choices retain release details and browser');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    } else {
      await page.waitForFunction(() => document.querySelectorAll('.mb-overlay').length === 0);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'Successful Load restores document scrolling');
      assert.equal(await page.locator('#media-browser-body').getByRole('button', { name: 'EXPLORE', exact: true }).evaluate(node => node === document.activeElement), true, 'Successful Load restores focus to the control');
    }
  }
  console.log('Load dismissal: browser and nested details close after successful loading; progress, failures and cancelled archives retain their dialogs.');
}
