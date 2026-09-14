import assert from 'node:assert/strict';

export async function checkDownloadProgress(page) {
  const timing = await page.evaluate(async () => {
    const { createDownloadProgress } = await import('/src/assembly64/progress.js');
    const progress = createDownloadProgress();
    document.body.append(progress.root);
    const start = performance.now(); progress.start('fast.prg');
    progress.update({ stage: 'download', name: 'fast.prg', loaded: 8, total: 8, done: true });
    progress.update({ stage: 'open', name: 'fast.prg' });
    const bar = progress.root.querySelector('progress');
    const completedFill = bar.position;
    const animation = bar.getAnimations()[0];
    const duration = animation.effect.getTiming().duration;
    animation.pause();
    animation.currentTime = duration * .25;
    const earlyClip = getComputedStyle(bar).clipPath;
    animation.currentTime = duration * .75;
    const lateClip = getComputedStyle(bar).clipPath;
    animation.currentTime = 0; animation.play();
    await progress.waitMinimum();
    const elapsed = performance.now() - start;
    progress.finish();
    progress.start('cancel.prg');
    const cancelled = progress.waitMinimum(); progress.finish(); await cancelled;
    const animationsAfterFinish = bar.getAnimations().length;
    progress.root.remove();
    return { elapsed, completedFill, duration, earlyClip, lateClip, animationsAfterFinish, hidden: progress.root.hidden };
  });
  assert.ok(timing.elapsed >= 1000, 'Fast downloads retain progress for at least 1 second');
  assert.equal(timing.completedFill, 1, 'The completed download fill stays visible while opening media');
  const clippedPercent = value => Number(value.match(/inset\(0px ([\d.]+)%/)[1]);
  assert.ok(timing.duration > 900 && timing.duration <= 1000, 'Instant downloads animate their visual fill over approximately one second');
  assert.ok(clippedPercent(timing.earlyClip) > 70 && clippedPercent(timing.lateClip) < 30, 'A completed transfer reveals progressively from left to right');
  assert.equal(timing.animationsAfterFinish, 0, 'Finishing removes the visual progress animation');
  assert.equal(timing.hidden, true, 'Cancellation immediately clears progress while settling the minimum-duration wait');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    assert.equal(await page.evaluate(async () => {
      const { createDownloadProgress } = await import('/src/assembly64/progress.js');
      const progress = createDownloadProgress();
      progress.start('fast.prg');
      progress.update({ loaded: 8, total: 8, done: true });
      const animations = progress.root.querySelector('progress').getAnimations().length;
      progress.finish();
      return animations;
    }), 0, 'Reduced-motion preferences disable the simulated reveal');
  } finally { await page.emulateMedia({ reducedMotion: 'no-preference' }); }
  for (const mode of ['known', 'unknown', 'error', 'cancel', 'zip']) {
    await page.evaluate(async mode => {
      const { openDetailsDialog } = await import('/src/assembly64/details-dialog.js');
      const { createAssembly64Actions } = await import('/src/assembly64/actions.js');
      const { readLimited } = await import('/src/media/stream.js');
      const file = { id: 'sample', ref: 'sample', name: mode === 'zip' ? 'progress.zip' : 'progress.prg', mediaType: mode === 'zip' ? 'zip' : 'prg', size: null };
      const item = { id: 'test', ref: 'test', title: 'Progress test', files: [file] };
      window.progressTest = { cancelled: false, opened: false };
      const controller = {
        id: 'test', getDetails: async () => item, getOriginalUrl: () => null,
        download: async (_, { signal, onProgress }) => {
          const stream = new ReadableStream({
            start(controller) { window.progressTest.controller = controller; controller.enqueue(new Uint8Array([1, 8, 0, 0])); },
            cancel() { window.progressTest.cancelled = true; },
          });
          const response = new Response(stream, { headers: mode === 'known' ? { 'content-length': '8' } : {} });
          return readLimited(response, 1024, signal, { onProgress });
        },
      };
      const perform = createAssembly64Actions({ ...controller, online: () => true }, async () => { window.progressTest.opened = true; return { message: 'Saved to Library' }; });
      await openDetailsDialog({ getDetails: controller.getDetails, online: () => true }, item, perform);
    }, mode);
    const dialog = page.getByRole('dialog', { name: 'Progress test', exact: true });
    const save = dialog.getByRole('button', { name: mode === 'zip' ? 'DOWNLOAD' : 'SAVE TO LIB', exact: true });
    if (mode === 'known') await dialog.evaluate(node => {
      const before = document.createElement('div'), after = document.createElement('div');
      before.style.height = after.style.height = '600px';
      const body = node.querySelector('.mb-dialog-body');
      body.prepend(before); body.append(after);
    });
    await save.scrollIntoViewIfNeeded();
    const scrollBefore = await dialog.locator('.mb-dialog-body').evaluate(node => node.scrollTop);
    const download = mode === 'zip' ? page.waitForEvent('download') : null;
    await save.click();
    const bar = dialog.getByRole('progressbar');
    await bar.waitFor();
    assert.equal(await bar.evaluate(node => !!node.closest('.mb-file')), true, 'Download progress belongs to the active file card');
    assert.equal(await dialog.locator('.mb-dialog-body').evaluate(node => node.scrollTop), scrollBefore, 'Starting a download preserves dialog scrolling');
    const bounds = await bar.evaluate(node => ({ bar: node.getBoundingClientRect().toJSON(), row: node.closest('.mb-file').getBoundingClientRect().toJSON() }));
    assert.ok(Math.abs(bounds.bar.height - bounds.row.height) <= 2 && Math.abs(bounds.bar.width - bounds.row.width) <= 2, 'The progress background fills the active file card');
    assert.equal(await save.isDisabled(), true, 'Download actions are disabled while streaming');
    if (mode === 'known') {
      await dialog.getByText('Downloading 50% · 4 B / 8 B', { exact: true }).first().waitFor();
      assert.deepEqual(await bar.evaluate(node => [node.value, node.max]), [4, 8], 'The progress bar reflects received bytes');
      await dialog.screenshot({ path: 'investigation/assembly64/progress-card.png' });
    } else {
      await dialog.getByText('Downloading 4 B · size unknown', { exact: true }).first().waitFor();
      assert.equal(await bar.getAttribute('value'), null, 'Unknown lengths use an indeterminate progress bar');
    }
    if (mode === 'cancel') {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.progressTest.cancelled);
      assert.equal(await dialog.count(), 0, 'Closing details removes the download indicator and cancels its stream');
      continue;
    }
    await page.evaluate(mode => {
      if (mode === 'error') window.progressTest.controller.error(new Error('Download interrupted'));
      else { window.progressTest.controller.enqueue(new Uint8Array(4)); window.progressTest.controller.close(); }
    }, mode);
    await dialog.getByText(mode === 'error' ? 'Download interrupted' : mode === 'zip' ? 'File downloaded.' : 'Saved to Library', { exact: true }).waitFor();
    assert.equal(await bar.isVisible(), false, 'Completion or failure clears download progress');
    await page.waitForFunction(() => [...document.querySelectorAll('.mb-details .mb-file button')].some(node => node.textContent === 'SAVE TO LIB' && !node.disabled) || [...document.querySelectorAll('.mb-details .mb-file button')].some(node => node.textContent === 'DOWNLOAD' && !node.disabled));
    assert.equal(await save.isEnabled(), true, 'Completion or failure restores download actions');
    if (download) {
      assert.equal((await download).suggestedFilename(), 'progress.zip', 'ZIP Download retains the original archive');
      assert.equal(await page.evaluate(() => window.progressTest.opened), false, 'ZIP Download never opens media or extracts the archive');
    }
    await page.keyboard.press('Escape');
  }
}
