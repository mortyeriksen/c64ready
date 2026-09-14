import assert from 'node:assert/strict';

export async function checkQuickSearch(page) {
  const control = page.locator('#media-browser-body');
  const input = control.getByLabel('Search media');
  const rows = control.locator('.mb-quick-result');
  const refine = control.getByRole('button', { name: 'REFINE SEARCH', exact: true });
  const catalog = page.getByRole('dialog', { name: 'Assembly64 Browser', exact: true });
  assert.equal(await refine.isVisible(), false, 'Refine Search is hidden before a quick search');
  assert.equal(await control.evaluate(node => Boolean(node.querySelector('.mb-launcher-navigation').compareDocumentPosition(node.querySelector('form')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Explore and Favorites appear above quick search');
  assert.equal(await control.getByLabel('Type', { exact: true }).inputValue(), 'demos', 'Quick search defaults to the server-defined Demos category');
  await input.press('Enter');
  await control.getByText('9 results', { exact: true }).waitFor();
  assert.ok((await rows.locator('.mb-meta').allTextContents()).every(text => text.startsWith('Demo ·')), 'The default quick search requests demos only');
  assert.equal(await rows.first().locator('.mb-title').innerText(), 'Sample 24 — C64 READY', 'An empty default quick search shows the newest demo first');
  await input.fill('Sample 01');
  const producer = control.getByLabel('Group / producer', { exact: true });
  await producer.fill('C64 READY');
  await control.getByLabel('Source', { exact: true }).selectOption('Lab');
  await control.getByLabel('Type', { exact: true }).selectOption('Samples');
  for (const name of ['EXPLORE', 'FAVORITES']) {
    await control.getByRole('button', { name, exact: true }).click();
    assert.equal(await catalog.getByLabel('Search title', { exact: true }).inputValue(), '', 'Navigation does not transfer the quick-search text');
    assert.equal(await catalog.getByLabel('Group / producer', { exact: true }).inputValue(), '', 'Navigation does not transfer the quick producer');
    assert.equal(await catalog.getByLabel('Source', { exact: true }).inputValue(), '', 'Navigation does not transfer the quick source');
    assert.equal(await catalog.getByLabel('Type / category', { exact: true }).inputValue(), name === 'EXPLORE' ? 'demos' : '', 'Explore uses Demos independently of the quick-search type');
    assert.equal(await catalog.getByLabel('Sort by').inputValue(), 'newest', 'Navigation defaults to Newest');
    if (name === 'EXPLORE') {
      await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 9);
      assert.ok((await catalog.locator('.mb-result-summary .mb-meta').allTextContents()).every(text => text.startsWith('Demo ·')), 'Explore searches Demos by default');
    }
    await page.keyboard.press('Escape');
  }
  assert.equal(await input.inputValue(), 'Sample 01', 'Opening the browser preserves the independent quick-search draft');
  await input.press('Enter');
  await control.getByText('1 result', { exact: true }).waitFor();
  assert.equal(await control.evaluate(node => Boolean(node.querySelector('.mb-quick-results').compareDocumentPosition(node.querySelector('.mb-refine')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Refine Search appears below quick results');
  await refine.click();
  assert.equal(await catalog.getByLabel('Search title', { exact: true }).inputValue(), 'Sample 01', 'Refine Search transfers the completed quick-search text');
  assert.equal(await catalog.getByLabel('Type / category', { exact: true }).inputValue(), 'Samples', 'Refine Search transfers the completed quick-search type');
  assert.equal(await catalog.getByLabel('Group / producer', { exact: true }).inputValue(), 'C64 READY', 'Refine Search transfers the producer to the standard form');
  assert.equal(await catalog.getByLabel('Source', { exact: true }).inputValue(), 'Lab', 'Refine Search transfers the source');
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 1);
  await catalog.getByLabel('Group / producer', { exact: true }).fill('Unknown group');
  await page.waitForFunction(() => document.querySelector('.mb-browser .mb-results').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.mb-result').length === 0);
  await catalog.getByLabel('Group / producer', { exact: true }).fill('C64 READY');
  await catalog.getByLabel('Group / producer', { exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 1);
  await catalog.getByLabel('Search title', { exact: true }).fill('Different browser draft');
  await page.keyboard.press('Escape');
  assert.equal(await input.inputValue(), 'Sample 01', 'Browser edits do not overwrite quick-search text');
  await control.getByRole('button', { name: 'EXPLORE', exact: true }).click();
  assert.equal(await catalog.getByLabel('Search title', { exact: true }).inputValue(), '', 'Explore starts without filters from an earlier refined search');
  await page.keyboard.press('Escape');
  await control.getByLabel('Type', { exact: true }).selectOption('');
  assert.equal(await refine.isVisible(), false, 'Changing quick filters hides results and Refine Search until the next search');
  await input.fill('');
  await control.getByRole('button', { name: 'Quick search', exact: true }).click();
  await control.getByText('Top 10 results', { exact: true }).waitFor();
  assert.equal(await rows.count(), 10, 'Quick search displays only the top ten releases');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Quick search stays inside the control');
  assert.equal(await rows.locator('.btn').count(), 10, 'Each quick result offers a media action');
  assert.equal(await rows.locator('.mb-producer').count(), 10, 'Every credited quick result shows producer with the title');
  assert.deepEqual(await rows.locator('.mb-title').allTextContents(), Array.from({ length: 10 }, (_, i) => `Sample ${26 - i} — C64 READY`), 'Empty quick search returns the ten newest releases in descending order');
  await refine.click();
  assert.equal(await catalog.getByLabel('Sort by').inputValue(), 'newest', 'Refining an empty quick search preserves Newest');
  await page.keyboard.press('Escape');
  await page.locator('#media-browser-card').screenshot({ path: 'investigation/assembly64/quick-desktop.png' });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await control.evaluate(node => node.scrollWidth > node.clientWidth), false, 'Quick results fit a narrow control');
  }
  await page.locator('#media-browser-card').screenshot({ path: 'investigation/assembly64/quick-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await input.fill('Sample 0'); await input.press('Enter');
  await control.getByText('9 results', { exact: true }).waitFor();
  for (const [id, format] of [['01', 'D64'], ['02', 'CRT'], ['03', 'TAP'], ['04', 'PRG'], ['08', 'REU']]) {
    await rows.getByRole('button', { name: `LOAD ${format} — Sample ${id}`, exact: true }).waitFor();
  }
  await input.fill('Media Browser'); await input.press('Enter');
  await control.getByText('1 result', { exact: true }).waitFor();
  assert.equal(await rows.getByRole('button', { name: /^OPEN/ }).count(), 0, 'Ambiguous quick results do not show OPEN');
  await rows.first().locator('.mb-title').click();
  const details = page.getByRole('dialog', { name: 'Media Browser — all formats', exact: true });
  await details.locator('.mb-file').last().waitFor();
  assert.equal(await details.locator('.mb-file').count(), 6, 'Multi-file quick results open file selection');
  await page.keyboard.press('Escape');
  await input.fill('Sample 01');
  await input.press('Enter');
  await control.getByText('1 result', { exact: true }).waitFor();
  await rows.locator('.mb-title').click();
  const singleDetails = page.getByRole('dialog', { name: 'Sample 01', exact: true });
  await singleDetails.locator('.mb-file').last().waitFor();
  assert.equal(await singleDetails.locator('.mb-file').count(), 2, 'Clicking a production title opens its complete file list');
  await page.keyboard.press('Escape');
  await rows.locator('.mb-producer').click();
  await singleDetails.getByText('Group / producer', { exact: true }).waitFor();
  assert.equal(await singleDetails.getByText('C64 READY', { exact: true }).count(), 1, 'Clicking the producer opens full release details');
  await page.keyboard.press('Escape');
  await rows.getByRole('button', { name: 'LOAD D64 — Sample 01', exact: true }).click();
  await control.getByText(/^Mounted in drive 8/).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Quick Load fetches files silently and ignores unsupported companion files');
  assert.equal(await page.evaluate(async () => (await import('/src/media.js')).currentD64.writeProtected), true, 'Single-file quick Load mounts a protected disk through existing media loading');
  await input.fill('Sample 09');
  await input.press('Enter');
  await control.getByText('1 result', { exact: true }).waitFor();
  assert.equal(await rows.locator('.btn').isVisible(), false, 'SID-only quick results have no action button');
  await rows.locator('.mb-title').click();
  const music = page.getByRole('dialog', { name: 'Sample 09', exact: true });
  await music.getByRole('button', { name: 'DOWNLOAD', exact: true }).waitFor();
  assert.equal(await music.getByRole('button', { name: 'LOAD', exact: true }).count(), 0, 'SID-only releases open details without an emulator Load action');
  await page.keyboard.press('Escape');
  await input.fill('no-such-release');
  await input.press('Enter');
  await control.getByText('No results. Try fewer filters.', { exact: true }).waitFor();
  assert.equal(await rows.count(), 0, 'An empty quick search clears old results');
  assert.equal(await refine.isVisible(), true, 'An empty quick search can still be refined');
  await page.context().setOffline(true);
  assert.equal(await control.getByRole('button', { name: 'Quick search', exact: true }).isDisabled(), true, 'Quick search is disabled offline');
  assert.equal(await control.getByRole('button', { name: 'FAVORITES', exact: true }).isEnabled(), true, 'Favorites remains available offline');
  await control.getByRole('button', { name: 'CLEAR', exact: true }).click();
  assert.deepEqual(await control.locator('input, select').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute('aria-label'), node.value]))), {
    'Search media': '', Source: '', 'Group / producer': '', Type: 'demos',
  }, 'Clear restores all quick-search defaults even offline');
  assert.equal(await control.locator('.mb-quick-panel').isVisible(), false, 'Clear removes results, status and refinement actions');
  assert.equal(await page.locator('#screen').evaluate(node => node === document.activeElement), true, 'Clear returns keyboard focus to the emulator');
  await page.context().setOffline(false);
  await input.fill('');
  console.log('Quick search: inline top ten, producer credits, Enter, file selection, actual disk Load, empty state and mobile/offline behavior passed.');
}
