import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

if (process.argv.includes('--pwa')) {
  await import('./pwa-check.mjs');
  process.exit(0);
}

const { createFixtureTransport } = await import('../fixtures/assembly64.js');
const fixtureTransport = createFixtureTransport();

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const { installTdeTestChoice, checkTde } = await import('./tde-check.mjs');
await installTdeTestChoice(page);
const errors = [], external = [], apiRequests = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname === 'hackerswithstyle.se') {
    if (route.request().method() === 'GET') apiRequests.push({ path: url.pathname, query: url.searchParams.get('query') });
    let response = await fixtureTransport(url.href);
    if (process.argv.includes('--api-load') && /\/search\/aql\/\d+\/\d+$/.test(url.pathname)) {
      const items = await response.json();
      response = new Response(JSON.stringify(items.map(({ files, ...item }) => item)), { headers: { 'content-type': 'application/json' } });
    }
    return route.fulfill({ status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'client-id', 'content-type': response.headers.get('content-type') || 'application/octet-stream' } });
  }
  if (url.hostname === '127.0.0.1' && ['/roms/kernal.bin', '/roms/basic.bin', '/roms/chargen.bin', '/roms/1541.bin'].includes(url.pathname)) {
    return route.fulfill({ body: await readFile(new URL(`../../${url.pathname.slice(1)}`, import.meta.url)), contentType: 'application/octet-stream' });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
  external.push(url.href);
  return route.abort();
});
await page.addInitScript(() => {
  localStorage.setItem('c64emu.splashSeen', '1');
  localStorage.setItem('c64emu.installDismissed', '1');
  localStorage.setItem('c64emu.pauseDemo', 'off');
  localStorage.setItem('c64emu.tde', 'off');
});
try {
  await page.goto(new URL('/?SPLASH=0', process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5173').href, { waitUntil: 'networkidle' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#media-browser-card .expand-btn').getAttribute('aria-expanded'), 'true', 'Assembly64 is expanded without a saved preference');
  if (process.argv.includes('--tde')) {
    await page.evaluate(async () => {
      const mediaUrl = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/media.js').name;
      const { openMedia } = await import(mediaUrl);
      const { sampleMedia } = await import('/test/fixtures/assembly64.js');
      await openMedia({ name: 'tde-check.d64', mediaType: 'd64', bytes: sampleMedia('d64'), targetDrive: 9, autorun: false, saveToLibrary: false });
    });
    await checkTde(page);
    assert.deepEqual(errors, [], 'TDE checks have no browser runtime errors');
  } else if (process.argv.includes('--api-load')) {
    const { checkApiLoad } = await import('./api-load-check.mjs');
    await checkApiLoad(page, apiRequests);
    assert.deepEqual(errors, [], 'API-load audit has no browser runtime errors');
  } else if (process.argv.includes('--quick')) {
    const { checkQuickSearch } = await import('./quick-search-check.mjs');
    await checkQuickSearch(page);
    assert.deepEqual(errors, [], 'Quick-search checks have no browser runtime errors');
  } else if (process.argv.includes('--details')) {
    const { checkReleaseDetails } = await import('./release-details-check.mjs');
    await checkReleaseDetails(page, context);
    assert.deepEqual(errors, [], 'Release detail checks have no browser runtime errors');
  } else if (process.argv.includes('--review')) {
    const { reviewUI } = await import('./ui-review.mjs');
    await reviewUI(page);
    assert.deepEqual(errors, [], 'UI review has no browser runtime errors');
    process.exitCode = 0;
  } else if (process.argv.includes('--progress')) {
    const { checkDownloadProgress } = await import('./progress-check.mjs');
    const { checkQuickProgress } = await import('./quick-progress-check.mjs');
    await checkDownloadProgress(page);
    await checkQuickProgress(page);
    assert.deepEqual(errors, [], 'Progress checks have no browser runtime errors');
  } else {
  const { checkQuickSearch } = await import('./quick-search-check.mjs');
  await checkQuickSearch(page);
  const { checkLoadDismissal } = await import('./load-dialog-check.mjs');
  await checkLoadDismissal(page);
  const { checkDownloadProgress } = await import('./progress-check.mjs');
  await checkDownloadProgress(page);
  const { checkQuickProgress } = await import('./quick-progress-check.mjs');
  await checkQuickProgress(page);
  const { checkReleaseDetails } = await import('./release-details-check.mjs');
  await checkReleaseDetails(page, context);
  const control = page.locator('#media-browser-body');
  assert.equal(await control.locator('select').count(), 2, 'The compact control exposes Type and Source filters');
  await control.getByLabel('Type', { exact: true }).selectOption('Samples');
  await control.getByRole('button', { name: 'EXPLORE', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'Assembly64 Browser', exact: true });
  assert.equal(await catalog.getByLabel('Type / category', { exact: true }).inputValue(), 'demos', 'Explore defaults to Demos independently of quick search');
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 9);
  await catalog.getByLabel('Type / category', { exact: true }).selectOption('Samples');
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 10);
  assert.equal(await catalog.locator('.mb-result').count(), 10, 'Results show the first page');
  await page.screenshot({ path: 'investigation/assembly64/catalog-desktop.png' });
  await catalog.getByRole('button', { name: 'LOAD MORE ↓', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 20);
  await catalog.getByRole('button', { name: 'LOAD MORE ↓', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 27);
  await catalog.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await catalog.getByRole('button', { name: 'Explore', exact: true }).click();
  assert.equal(await catalog.locator('.mb-result').count(), 27, 'Returning to Explore preserves loaded pages');
  await catalog.getByRole('button', { name: 'ADVANCED', exact: true }).click();
  const advanced = page.getByRole('dialog', { name: 'Advanced search' });
  await advanced.getByRole('button', { name: 'Close Advanced search' }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await advanced.getByRole('button', { name: 'SHOW RESULTS' }).evaluate(node => node === document.activeElement), true, 'Focus wraps inside the advanced dialog');
  await page.getByRole('dialog', { name: 'Advanced search' }).getByLabel('Group / producer').fill('C64 READY');
  await advanced.getByLabel('Handle / artist').fill('Lab');
  await page.getByRole('button', { name: 'SHOW RESULTS' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 10);
  assert.equal(await catalog.getByRole('button', { name: 'ADVANCED · 1' }).count(), 1, 'Advanced filters are indicated');
  assert.equal(await catalog.getByLabel('Group / producer', { exact: true }).inputValue(), 'C64 READY', 'Advanced producer edits synchronize with the standard form');
  await catalog.getByLabel('Sort by').selectOption('name');
  await catalog.locator('.mb-result').filter({ hasText: 'Media Browser — all formats' }).waitFor();
  await catalog.locator('.mb-result').first().getByRole('button', { name: /^Favorite / }).click();
  await catalog.getByRole('button', { name: '＋ Save search', exact: true }).click();
  await page.getByRole('dialog', { name: 'Save search' }).getByLabel('Name', { exact: true }).fill('My samples');
  await page.getByRole('dialog', { name: 'Save search' }).getByRole('button', { name: 'SAVE', exact: true }).click();
  await catalog.locator('.mb-result').first().getByRole('button', { name: 'VIEW', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Media Browser — all formats' });
  async function reopenDetails() {
    await control.getByRole('button', { name: 'FAVORITES', exact: true }).click();
    await catalog.locator('.mb-result').first().getByRole('button', { name: 'VIEW', exact: true }).click();
    await details.locator('.mb-file').first().waitFor();
    await details.getByLabel('Autorun', { exact: true }).selectOption('off');
  }

  await details.getByText('browser-sample.d64', { exact: true }).waitFor();
  assert.equal(await details.locator('.mb-file').count(), 6, 'Details show every file including REU and unsupported SID');
  assert.equal(await details.getByRole('button', { name: 'DOWNLOAD', exact: true }).count(), 6, 'Every file offers an original download');
  const prg = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.prg', { exact: true }) });
  const downloadEvent = page.waitForEvent('download');
  await prg.getByRole('button', { name: 'DOWNLOAD', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'browser-sample.prg', 'Download retains the media filename');
  await details.getByText('File downloaded.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await (await import('/src/media/library.js')).libList()).some(entry => entry.type === 'prg')), false, 'Download does not save the file to Library');
  await prg.getByRole('button', { name: 'SAVE TO LIB' }).click();
  await details.getByText('Saved to Library', { exact: true }).waitFor();
  await prg.getByRole('button', { name: 'SAVED IN LIB', exact: true }).waitFor();
  assert.equal(await prg.getByRole('button', { name: 'SAVED IN LIB', exact: true }).isDisabled(), true, 'Saving replaces the action with a disabled Library status');
  const library = await page.evaluate(async () => {
    const lib = await import('/src/media/library.js');
    const entries = await lib.libList();
    const exported = await lib.libExport();
    return { entries, exported };
  });
  assert.equal(library.entries[0].source, 'assembly64', 'Library stores source metadata');
  assert.equal(library.exported.entries.find(entry => entry.type === 'prg').provenance.fileId, 'prg', 'Library export preserves file provenance');
  await details.getByLabel('Autorun', { exact: true }).selectOption('off');
  await details.getByLabel('D64 target drive').selectOption('9');
  assert.equal(await details.getByLabel('D64 write protected').count(), 0, 'Release details omit the write-protection setting');
  const disk = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.d64', { exact: true }) });
  await disk.getByRole('button', { name: 'MOUNT ONLY' }).click();
  await details.getByText('Mounted in drive 9', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => {
    const media = await import('/src/media.js'), state = await import('/src/state.js');
    return [state.running, media.drive9Enabled, media.currentD64Drive9.writeProtected];
  }), [true, true, true], 'Opening D64 powers on and enables write-protected drive 9');
  await details.getByLabel('D64 target drive').selectOption('8');
  await disk.getByRole('button', { name: 'MOUNT ONLY' }).click();
  await details.getByText('Mounted in drive 8', { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/src/media.js')).currentD64.writeProtected), true, 'Drive 8 uses write protection');
  await disk.getByRole('button', { name: 'SAVED IN LIB', exact: true }).waitFor();
  assert.equal(await prg.getByRole('button', { name: 'SAVED IN LIB', exact: true }).isDisabled(), true, 'Other media operations retain the disabled saved state');
  const tape = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.tap', { exact: true }) });
  await tape.getByRole('button', { name: 'LOAD', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-overlay').length === 0);
  assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine.datasette.hasMedia), true, 'TAP reaches the existing datasette');
  await reopenDetails();
  await tape.getByRole('button', { name: 'SAVED IN LIB', exact: true }).waitFor();
  assert.equal(await prg.getByRole('button', { name: 'SAVED IN LIB', exact: true }).isDisabled(), true, 'Reopened details recognize saved files');
  const cart = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.crt', { exact: true }) });
  await cart.getByRole('button', { name: 'LOAD', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-overlay').length === 0);
  assert.equal(await page.evaluate(async () => !!(await import('/src/state.js')).machine.mem.cartridge), true, 'CRT reaches the existing cartridge loader');
  await reopenDetails();
  await prg.getByRole('button', { name: 'LOAD', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-overlay').length === 0);
  assert.ok(await page.evaluate(async () => (await import('/src/media.js')).currentD64.entries.length > 0), 'PRG uses the existing PRG disk flow');
  await reopenDetails();
  const reu = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.reu', { exact: true }) });
  await reu.getByRole('button', { name: 'LOAD', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-overlay').length === 0);
  assert.deepEqual(await page.evaluate(async () => {
    const media = await import('/src/media.js'), { machine } = await import('/src/state.js');
    return [media.reuEnabled, machine.reu.ram.length, ...machine.reu.ram.slice(0, 3)];
  }), [true, 1048576, 0x52, 0x45, 0x55], 'REU enables RAM Expansion, upgrades capacity and copies the image');
  await reopenDetails();
  const legacy = await page.evaluate(async () => {
    const lib = await import('/src/media/library.js');
    const exported = await lib.libExport();
    const bytes = exported.entries.find(entry => entry.type === 'prg').data;
    const imported = await lib.libImport({ format: 'c64emu-library', version: 1, entries: [{ type: 'prg', name: 'legacy.prg', data: bytes }] });
    const entry = (await lib.libList()).find(entry => entry.name === 'legacy.prg');
    return { count: imported.imported, hasSource: Object.hasOwn(entry, 'source') };
  });
  assert.deepEqual(legacy, { count: 1, hasSource: false }, 'Library imports legacy entries without source metadata');
  await page.keyboard.press('Escape');
  assert.equal(await catalog.isVisible(), true, 'Escape from details returns to the catalog');
  assert.equal(await catalog.locator('.mb-result').first().getByRole('button', { name: 'VIEW', exact: true }).evaluate(node => node === document.activeElement), true, 'Closing details restores focus to its VIEW button');
  const { checkKeyboard } = await import('./keyboard-check.mjs');
  await checkKeyboard(page);
  await checkTde(page);
  await page.reload({ waitUntil: 'networkidle' });
  await control.getByRole('button', { name: 'FAVORITES', exact: true }).click();
  assert.equal(await catalog.locator('.mb-result').count(), 1, 'Favorites survive reload');
  assert.equal((await catalog.locator('.mb-producer').innerText()).trim(), '— C64 READY', 'Favorites retain producer credits across reload');
  await catalog.locator('.mb-result').first().getByRole('button', { name: 'VIEW', exact: true }).click();
  await prg.getByRole('button', { name: 'SAVED IN LIB', exact: true }).waitFor();
  assert.equal(await prg.getByRole('button', { name: 'SAVED IN LIB', exact: true }).isDisabled(), true, 'Saved Library status survives page reload');
  await page.keyboard.press('Escape');
  await catalog.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await page.getByRole('button', { name: 'My samples', exact: true }).waitFor();
  await catalog.getByRole('button', { name: 'Explore', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 10);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await catalog.evaluate(node => node.scrollWidth > node.clientWidth);
  assert.equal(overflow, false, 'Media Browser has no horizontal overflow on mobile');
  await page.screenshot({ path: 'investigation/assembly64/catalog-mobile.png', fullPage: false });
  await context.setOffline(true);
  await catalog.getByRole('button', { name: 'Favorites', exact: true }).click();
  assert.equal(await catalog.locator('.mb-result').count(), 1, 'Favorites remain available offline');
  const savedBytes = await page.evaluate(async () => {
    const lib = await import('/src/media/library.js');
    const entry = (await lib.libList()).find(entry => entry.type === 'prg');
    return (await lib.libLoad(entry.id)).data.length;
  });
  assert.ok(savedBytes > 2, 'Library returns saved media bytes offline');
  assert.equal(external.some(url => url.includes('hackerswithstyle') || url.includes('assembly64')), false, 'No Assembly64 network request occurs');
  assert.deepEqual(errors, [], 'App has no browser runtime errors');
  console.log('Media Browser: compact launcher, catalog modal, search, pagination, advanced filters, favorites, named searches, details, PRG/D64/CRT/TAP/REU loading, drive 8/9, write protection, Library export/legacy import and mobile/offline checks passed.');
  }
} finally { await browser.close(); }
