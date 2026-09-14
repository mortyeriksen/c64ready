import assert from 'node:assert/strict';

export async function reviewUI(page) {
  const control = page.locator('#media-browser-body');
  await control.getByLabel('Type', { exact: true }).waitFor();
  await page.locator('#media-browser-card').screenshot({ path: 'investigation/assembly64/review-control.png' });
  await control.getByRole('button', { name: 'EXPLORE', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'Assembly64 Browser', exact: true });
  await catalog.getByLabel('Type / category', { exact: true }).selectOption('Samples');
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 10);
  await catalog.getByLabel('Sort by').selectOption('name');
  await catalog.locator('.mb-result').filter({ hasText: 'Media Browser — all formats' }).waitFor();
  assert.equal(await catalog.locator('.mb-status').innerText(), '', 'Loaded results have one count, without a repeated status count');
  assert.equal(await catalog.getByLabel('Sort by').locator('option[value=""]').count(), 0, 'Sorting offers only meaningful choices');
  const searchButton = catalog.getByRole('button', { name: 'SEARCH', exact: true });
  await searchButton.hover();
  await searchButton.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  console.log('Search hover appearance:', await searchButton.evaluate(node => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, font: style.fontFamily };
  }));
  await catalog.screenshot({ path: 'investigation/assembly64/review-catalog.png' });
  await catalog.locator('.mb-result').first().getByRole('button', { name: 'VIEW', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Media Browser — all formats', exact: true });
  await details.locator('.mb-file').first().waitFor();
  assert.equal(await details.getByRole('heading', { name: 'Media Browser — all formats', exact: true }).count(), 1, 'Release details have one release heading');
  assert.equal(await details.locator('select option[value=""]').count(), 0, 'Media settings do not offer an ambiguous Any choice');
  await details.screenshot({ path: 'investigation/assembly64/review-details.png' });
  await page.keyboard.press('Escape');
  await catalog.getByRole('button', { name: 'ADVANCED', exact: true }).click();
  await page.getByRole('dialog', { name: 'Advanced search' }).screenshot({ path: 'investigation/assembly64/review-advanced.png' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await control.evaluate(node => node.scrollWidth > node.clientWidth), false, 'The launcher fits a narrow viewport');
    await page.evaluate(async () => {
      const { openDetailsDialog } = await import('/src/assembly64/details-dialog.js');
      const item = {
        id: 'long', title: 'A long release title with multiple versions and a very long uninterrupted name '.repeat(3),
        files: [{ id: 'one', name: `${'LongFilename'.repeat(18)}.prg`, mediaType: 'prg', size: 1024 }],
      };
      await openDetailsDialog({ online: () => true, getDetails: async () => item }, { id: 'long', title: 'Loading title' }, async () => ({ message: 'Loaded' }));
    });
    const long = page.locator('.mb-details');
    assert.equal(await long.evaluate(node => node.scrollWidth > node.clientWidth), false, 'Long release titles and filenames fit the details dialog');
    assert.equal(await long.getByLabel('D64 target drive').count(), 0, 'PRG-only releases hide disk-specific settings');
    const boxes = await long.evaluate(node => ({ title: node.querySelector('h2').getBoundingClientRect().toJSON(), close: node.querySelector('.mb-close').getBoundingClientRect().toJSON() }));
    assert.ok(boxes.title.x + boxes.title.width <= boxes.close.x || await long.locator('h2').evaluate(node => parseFloat(getComputedStyle(node).paddingRight) >= 48), 'Long headings reserve space for the close button');
    if (width === 768) await long.locator('fieldset').screenshot({ path: 'investigation/assembly64/review-media-alignment.png' });
    if (width === 390) await long.screenshot({ path: 'investigation/assembly64/review-details-mobile.png' });
    await page.keyboard.press('Escape');
    await control.getByRole('button', { name: 'EXPLORE', exact: true }).click();
    await catalog.getByLabel('Type / category', { exact: true }).selectOption('Samples');
    await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 10);
    assert.equal(await catalog.evaluate(node => node.scrollWidth > node.clientWidth), false, 'The catalog fits narrow viewports');
    if (width === 390) await catalog.screenshot({ path: 'investigation/assembly64/review-catalog-mobile.png' });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const { openDetailsDialog } = await import('/src/assembly64/details-dialog.js');
    const item = { id: 'sid', title: 'Music', files: [{ id: 'one', name: 'music.sid', mediaType: 'sid', size: null }] };
    await openDetailsDialog({ online: () => true, getDetails: async () => item }, item, async () => ({}));
  });
  assert.equal(await page.locator('.mb-details fieldset').count(), 0, 'Download-only releases hide emulator settings');
  await page.keyboard.press('Escape');
  await control.getByLabel('Search media').fill('no-such-release');
  await control.getByLabel('Search media').press('Enter');
  await control.getByRole('button', { name: 'REFINE SEARCH', exact: true }).click();
  await catalog.getByRole('heading', { name: 'No releases found' }).waitFor();
  assert.equal(await catalog.getByRole('heading', { name: '0 releases', exact: true }).count(), 1, 'Empty searches have one count and a clear empty state');
  await page.keyboard.press('Escape');
  await page.context().setOffline(true);
  await control.getByRole('button', { name: 'EXPLORE', exact: true }).click();
  await catalog.getByRole('heading', { name: 'You’re offline' }).waitFor();
  assert.equal(await catalog.getByText('Offline — search is unavailable. Open saved files with LOAD LIB.', { exact: true }).count(), 1, 'Offline guidance is shown once');
  assert.equal(await catalog.getByRole('button', { name: 'SEARCH', exact: true }).isDisabled(), true, 'Search is unavailable offline');
  await page.keyboard.press('Escape');
  await page.context().setOffline(false);
  await page.evaluate(async () => {
    const { createDialog } = await import('/src/assembly64/dom.js');
    const { createTypeIcon } = await import('/src/assembly64/icons.js');
    const dialog = createDialog('Production types');
    for (const kind of ['Demos', 'Games', 'Intros', 'Music', 'Graphics', 'Tools', 'Diskmags', 'Charts', 'BBS', 'EasyFlash', 'REU', 'C128', 'Other']) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:16px;margin:8px';
      row.append(createTypeIcon(kind), document.createTextNode(kind)); dialog.body.append(row);
    }
  });
  await page.getByRole('dialog', { name: 'Production types' }).screenshot({ path: 'investigation/assembly64/review-type-icons.png' });
  await page.keyboard.press('Escape');
  console.log('UI review passed: single titles/counts, concrete settings, long filenames, conditional controls, and 320/390/768px layouts.');
}
