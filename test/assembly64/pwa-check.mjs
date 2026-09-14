import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFixtureTransport } from '../fixtures/assembly64.js';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const { installTdeTestChoice } = await import('./tde-check.mjs');
await installTdeTestChoice(page);
const errors = [], remote = [];
const fixtureTransport = createFixtureTransport();
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname === 'hackerswithstyle.se') {
    const response = await fixtureTransport(url.href);
    return route.fulfill({ status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'client-id', 'content-type': response.headers.get('content-type') || 'application/octet-stream' } });
  }
  if (url.hostname !== '127.0.0.1') { remote.push(url.href); return route.abort(); }
  if (['/roms/kernal.bin', '/roms/basic.bin', '/roms/chargen.bin', '/roms/1541.bin'].includes(url.pathname)) {
    return route.fulfill({ body: await readFile(new URL(`../../${url.pathname.slice(1)}`, import.meta.url)), contentType: 'application/octet-stream' });
  }
  return route.continue();
});
await page.addInitScript(() => {
  localStorage.setItem('c64emu.splashSeen', '1');
  localStorage.setItem('c64emu.installDismissed', '1');
  localStorage.setItem('c64emu.pauseDemo', 'off');
  localStorage.setItem('c64emu.tde', 'off');
  localStorage.setItem('c64emu.autorun', 'off');
});
try {
  await page.goto(new URL('/?SPLASH=0', process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:4173').href, { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  for (const [slot, name] of [['kernal', 'kernal.bin'], ['basic', 'basic.bin'], ['char', 'chargen.bin'], ['1541', '1541.bin']]) {
    await page.locator(`#rom-${slot}`).setInputFiles({ name, mimeType: 'application/octet-stream', buffer: await readFile(new URL(`../../roms/${name}`, import.meta.url)) });
  }
  await page.locator('#media-browser-body').getByRole('button', { name: 'EXPLORE', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'Assembly64 Browser', exact: true });
  await catalog.getByLabel('Type / category', { exact: true }).selectOption('Samples');
  await page.waitForFunction(() => document.querySelectorAll('.mb-result').length === 10);
  await catalog.getByLabel('Sort by').selectOption('name');
  await catalog.locator('.mb-result').filter({ hasText: 'Media Browser — all formats' }).waitFor();
  await catalog.locator('.mb-result').first().getByRole('button', { name: /^Favorite / }).click();
  await catalog.getByRole('button', { name: '＋ Save search' }).click();
  const naming = page.getByRole('dialog', { name: 'Save search' });
  await naming.getByLabel('Name', { exact: true }).fill('Offline bookmark');
  await naming.getByRole('button', { name: 'SAVE', exact: true }).click();
  await catalog.locator('.mb-result').first().getByRole('button', { name: 'VIEW', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Media Browser — all formats' });
  const file = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.d64', { exact: true }) });
  await file.getByRole('button', { name: 'SAVE TO LIB' }).click();
  await details.getByText('Saved to Library', { exact: true }).waitFor();

  const reu = details.locator('.mb-file').filter({ has: page.getByText('browser-sample.reu', { exact: true }) });
  await reu.getByRole('button', { name: 'SAVE TO LIB' }).click();
  await details.getByText('Saved to Library', { exact: true }).waitFor();

  // The offline phase has no route capable of supplying media or ROM bytes.
  await context.unrouteAll();
  await context.setOffline(true);
  const response = await page.reload({ waitUntil: 'load' });
  assert.equal(response.fromServiceWorker(), true, 'The production shell reloads from the service worker offline');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'The offline shell preserves cross-origin isolation');
  await page.locator('#media-browser-body').getByRole('button', { name: 'FAVORITES' }).click();
  assert.equal(await catalog.locator('.mb-result').count(), 1, 'Favorites survive an offline page reload');
  assert.equal(await catalog.getByRole('button', { name: 'SEARCH', exact: true }).isDisabled(), true, 'Offline search is disabled');
  await catalog.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await catalog.getByRole('button', { name: 'Offline bookmark', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#btn-library').click();
  await page.locator('#library-list .lib-row').filter({ hasText: 'browser-sample.d64' }).click();
  await page.waitForFunction(() => document.querySelector('#library-modal').hidden && document.body.classList.contains('powered-on'));
  assert.equal(await page.locator('#drive-disk-name').getByRole('img', { name: 'BROWSER', exact: true }).count(), 1, 'Offline LOAD LIB mounts the saved disk using cached ROMs');
  await page.locator('#btn-library').click();
  await page.locator('#library-list .lib-row').filter({ hasText: 'browser-sample.reu' }).click();
  await page.waitForFunction(() => document.querySelector('#library-modal').hidden && document.querySelector('#reu-label').textContent.includes('browser-sample.reu'));
  assert.equal(await page.locator('#reu-unit').inputValue(), '1mb', 'Offline LOAD LIB restores the REU image through RAM Expansion with sufficient capacity');
  const cachedUrls = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    return urls;
  });
  assert.equal(cachedUrls.some(url => /hackerswithstyle|assembly64|\/search\/|\.(d64|prg|tap|crt|reu|zip)(?:\?|$)|\/roms\//i.test(url)), false, 'App cache contains no catalog queries, downloaded media or ROMs');
  assert.equal(remote.some(url => /hackerswithstyle|assembly64/.test(url)), false, 'PWA checks make no Assembly64 connection');
  assert.deepEqual(errors, [], 'Production app has no browser runtime errors');
  console.log('PWA passed: offline reload, isolation, favorites, named searches, offline LOAD LIB/power-on, and media/cache separation.');
} finally { await browser.close(); }
