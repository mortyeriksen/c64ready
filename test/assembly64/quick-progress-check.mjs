import assert from 'node:assert/strict';

export async function checkQuickProgress(page) {
  for (const mode of ['complete', 'fast', 'cancel']) {
    await page.evaluate(async mode => {
      const { createAssembly64Control } = await import('/src/assembly64/control.js');
      const { Assembly64Controller } = await import('/src/assembly64/controller.js');
      const { createAssembly64Store } = await import('/src/assembly64/store.js');
      const { createFixtureTransport } = await import('/test/fixtures/assembly64.js');
      const root = document.createElement('section'); root.id = 'quick-progress-fixture';
      root.style.cssText = 'position:fixed;top:100px;left:100px;width:330px;padding:16px;background:#10132b;z-index:10000';
      document.body.append(root);
      const controller = new Assembly64Controller({ transport: createFixtureTransport({ delayMs: 0 }) });
      await controller.initialize();
      const control = createAssembly64Control(root, controller, createAssembly64Store(), (_, file, options, signal, progress) => new Promise((resolve, reject) => {
        window.finishQuickProgress = () => resolve({ message: 'Media loaded', mediaType: file.mediaType });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        progress({ stage: 'download', name: file.name, loaded: mode === 'fast' ? 8 : 4, total: 8, done: mode === 'fast' });
        if (mode === 'fast') window.finishQuickProgress();
      }));
      window.disposeQuickProgress = () => { control.dispose(); root.remove(); };
    }, mode);
    const fixture = page.locator('#quick-progress-fixture');
    try {
      await fixture.getByLabel('Type', { exact: true }).selectOption('Samples');
      await fixture.getByLabel('Search media', { exact: true }).fill('Sample 02');
      await fixture.getByRole('button', { name: 'Quick search', exact: true }).click();
      const load = fixture.getByRole('button', { name: /^LOAD CRT/ });
      await load.waitFor();
      const row = fixture.locator('.mb-quick-result');
      const before = await row.boundingBox();
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await load.click();
      await row.getByText(mode === 'fast' ? 'Downloaded 8 B' : 'Downloading 50% · 4 B / 8 B', { exact: true }).first().waitFor();
      assert.deepEqual(await row.boundingBox(), before, 'Quick download progress preserves the result card position and dimensions');
      assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, 'Quick download progress does not scroll the page');
      const bar = row.getByRole('progressbar');
      assert.deepEqual(await bar.evaluate(node => [node.value, node.max]), mode === 'fast' ? [1, 1] : [4, 8], 'Quick result progress exposes actual received bytes');
      assert.equal(await load.isDisabled(), true, 'Quick Load stays disabled during its download');
      if (mode === 'fast') {
        assert.equal(await bar.evaluate(node => node.getAnimations().some(animation => animation.playState === 'running')), true, 'Instant quick downloads keep an animated card background after the transfer completes');
        await fixture.getByText('Media loaded', { exact: true }).waitFor();
        assert.equal(await bar.count(), 0, 'Instant quick downloads clear the fill after the minimum display time');
      } else if (mode === 'complete') {
        await fixture.screenshot({ path: 'investigation/assembly64/quick-progress-card.png' });
        await page.evaluate(() => window.finishQuickProgress());
        await fixture.getByText('Media loaded', { exact: true }).waitFor();
        assert.equal(await bar.count(), 0, 'Completion removes the progress background');
        assert.equal(await row.locator('.mb-meta').innerText(), 'Utility · Lab · 2026', 'Completion restores release metadata');
      } else {
        await fixture.getByLabel('Search media', { exact: true }).fill('new search');
        assert.equal(await fixture.getByRole('progressbar').count(), 0, 'A new quick-search draft cancels and clears the download');
      }
    } finally { await page.evaluate(() => window.disposeQuickProgress()); }
  }
  console.log('Quick progress: card background, byte count, stable layout, completion and cancellation passed.');
}
