// Drive 8 queues through Library and Assembly64, including the real swap path,
// keyboard shortcut, drag-and-drop, persistence and a narrow phone viewport.
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readAsset } from './external-assets.js';
import { createFixtureTransport } from './fixtures/assembly64.js';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium is unavailable'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const transport = createFixtureTransport();
await context.route('https://hackerswithstyle.se/**', async route => {
  const response = await transport(route.request().url());
  await route.fulfill({ status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*' } });
});
const roms = {};
for (const [asset, key] of [['kernal', 'kernal'], ['basic', 'basic'], ['chargen', 'charRom']]) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${key}`] = bytes.toString('base64');
}
await context.addInitScript(roms => {
  if (sessionStorage.getItem('diskQueueSeeded')) return;
  sessionStorage.setItem('diskQueueSeeded', '1');
  for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
  localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
  localStorage.setItem('c64emu.pauseDemo', 'off');
  localStorage.setItem('c64emu.tde', 'off');
}, roms);
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const openQueue = async () => {
  await page.click('#btn-d64-queue');
  const dialog = page.getByRole('dialog', { name: 'Drive 8 disk queue', exact: true });
  await dialog.waitFor(); return dialog;
};
const waitQueue = () => page.waitForFunction(() => !document.querySelector('.disk-queue-dialog [data-action="remove"]')?.disabled);
const mounted = () => page.evaluate(() => window.queueTestMedia.currentD64?._libName || null);
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => { window.queueTestMedia = await import('/src/media.js'); });
  if (await page.locator('#setup-modal').isVisible()) await page.click('#btn-setup-later');
  if (Object.keys(roms).length === 3) {
    const running = await page.evaluate(async () => (await import('/src/state.js')).running);
    if (!running) await page.click('#btn-power');
    await page.waitForFunction(() => !document.querySelector('#btn-reset').disabled);
    await page.evaluate(() => { window.queueOriginalMachine = window.machine; });
  } else console.log('ok  - live machine checks # SKIP local ROMs unavailable');
  await page.evaluate(async () => {
    const { libSave } = await import('/src/media/library.js');
    const { sampleMedia } = await import('/test/fixtures/assembly64.js');
    await libSave('d64', 'Disk A.d64', sampleMedia('d64'));
    await libSave('d64', 'Disk B.d64', sampleMedia('d64'));
  });
  await page.click('#btn-library');
  await page.getByRole('button', { name: 'Queue Disk A.d64', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#btn-d64-queue').textContent === 'QUEUE (1)');
  await page.getByRole('button', { name: 'Queue Disk B.d64', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#btn-d64-queue').textContent === 'QUEUE (2)');
  assert.equal(await mounted(), null, 'queueing from Library does not insert a disk');
  await page.click('#btn-library-close');
  let dialog = await openQueue();
  await dialog.getByRole('button', { name: 'Move down Disk A.d64', exact: true }).click(); await waitQueue();
  assert.match(await dialog.locator('.disk-queue-name').first().innerText(), /Disk B/);
  await page.evaluate(() => {
    const setDragImage = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function(element, x, y) {
      window.queueDragImageIsCard = element.matches('.disk-queue-row') && !!element.querySelector('.disk-queue-name');
      return setDragImage.call(this, element, x, y);
    };
  });
  await dialog.locator('.disk-queue-handle').first().dragTo(dialog.locator('.disk-queue-row').last()); await waitQueue();
  assert.equal(await page.evaluate(() => window.queueDragImageIsCard), true, 'dragging the grip carries the whole disk card');
  assert.match(await dialog.locator('.disk-queue-name').first().innerText(), /Disk A/, 'dragging changes queue order');
  await dialog.getByRole('button', { name: 'Insert Disk A.d64', exact: true }).click(); await waitQueue();
  assert.equal(await mounted(), 'Disk A.d64');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+Digit8');
  await page.waitForFunction(() => window.queueTestMedia.currentD64?._libName === 'Disk B.d64');
  assert.equal(await page.locator('#btn-d64-next').isDisabled(), true, 'queue stops at its last disk');
  if (Object.keys(roms).length === 3) assert.equal(await page.evaluate(() => window.queueOriginalMachine === window.machine), true, 'disk changes never reset the machine');
  dialog = await openQueue();
  await dialog.getByRole('checkbox', { name: 'Loop queue' }).check(); await waitQueue();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+Digit8');
  await page.waitForFunction(() => window.queueTestMedia.currentD64?._libName === 'Disk A.d64');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit8', key: '*', ctrlKey: true, shiftKey: true, repeat: true, bubbles: true })));
  assert.equal(await mounted(), 'Disk A.d64', 'key repeat does not advance disks');
  await page.click('#btn-library');
  await page.locator('#library-filter').focus();
  await page.keyboard.press('Control+Shift+Digit8');
  assert.equal(await mounted(), 'Disk A.d64', 'a text field owns its shortcuts');
  await page.keyboard.press('Escape');
  console.log('ok  - Library queues, arrows, drag-and-drop, insertion and shortcuts');

  await page.evaluate(async () => {
    const { openDetailsDialog } = await import('/src/assembly64/details-dialog.js');
    const { createAssembly64Actions } = await import('/src/assembly64/actions.js');
    const { openMedia } = await import('/src/media.js');
    const { sampleMedia } = await import('/test/fixtures/assembly64.js');
    const item = { id: 'queue-game', title: 'Queue game', ref: { id: 'queue-game', categoryId: 3 }, files: [
      { id: 'c', name: 'Disk C.d64', mediaType: 'd64', ref: { id: 'c' } },
      { id: 'd', name: 'Disk D.d64', mediaType: 'd64', ref: { id: 'd' } },
    ] };
    const controller = { online: () => true, download: async () => sampleMedia('d64') };
    await openDetailsDialog(controller, item, createAssembly64Actions(controller, openMedia), item);
  });
  const details = page.getByRole('dialog', { name: 'Queue game', exact: true });
  const queueButton = details.getByRole('button', { name: 'QUEUE', exact: true }).first();
  assert.equal(await queueButton.getAttribute('data-tip'), 'Queue to drive 8');
  await queueButton.click();
  await page.waitForFunction(() => document.querySelector('#btn-d64-queue').textContent === 'QUEUE (3)');
  assert.equal(await details.getByRole('button', { name: /QUEUE SELECTED/ }).count(), 0);
  await details.getByRole('button', { name: 'QUEUE', exact: true }).last().click();
  await page.waitForFunction(() => document.querySelector('#btn-d64-queue').textContent === 'QUEUE (4)');
  assert.equal(await mounted(), 'Disk A.d64', 'Assembly64 queueing leaves the inserted disk untouched');
  await page.keyboard.press('Escape');
  dialog = await openQueue();
  await dialog.getByRole('button', { name: 'Remove Disk A.d64', exact: true }).click(); await waitQueue();
  assert.equal(await mounted(), 'Disk A.d64', 'removing the current entry does not eject it');
  await dialog.getByRole('button', { name: 'Move up Disk D.d64', exact: true }).click(); await waitQueue();
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(async () => { window.queueTestMedia = await import('/src/media.js'); });
  await page.waitForFunction(() => document.querySelector('#btn-d64-queue').textContent === 'QUEUE (3)');
  assert.equal(await mounted(), null, 'restoring a queue does not insert a disk');
  dialog = await openQueue();
  assert.deepEqual(await dialog.locator('.disk-queue-name').allTextContents(), ['1. Disk B.d64', '2. Disk D.d64', '3. Disk C.d64'], 'queue order survives reload');
  assert.equal(await dialog.getByRole('checkbox', { name: 'Loop queue' }).isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'queue dialog fits a phone');
  await dialog.getByRole('button', { name: 'Move up Disk C.d64', exact: true }).click(); await waitQueue();
  if (process.argv.includes('--screenshot')) await page.screenshot({ path: 'investigation/disk-queue-review.png' });
  await page.keyboard.press('Escape');
  await context.setOffline(true);
  await page.click('#btn-d64-next');
  await page.waitForFunction(() => window.queueTestMedia.currentD64?._libName === 'Disk B.d64');
  assert.equal(await page.locator('#diskdrive9-card #btn-d64-queue').count(), 0, 'drive 9 has no queue');
  assert.deepEqual(errors, [], 'queue actions have no browser errors');
  console.log('ok  - Assembly64 queue actions, removal, persistence, phone layout and offline insertion');
} finally { await browser.close(); await vite.close(); }
