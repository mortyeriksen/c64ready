import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readAsset } from './external-assets.js';
import { sampleMedia } from './fixtures/assembly64.js';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
const roms = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
}
const ctx = await browser.newContext({ viewport: { width: 1460, height: 1180 } });
await ctx.addInitScript(roms => {
  if (sessionStorage.getItem('panels-seeded')) return;
  sessionStorage.setItem('panels-seeded', '1');
  for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
  localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); localStorage.setItem('c64emu.installDismissed', '1');
}, roms);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const visible = () => page.locator('.panel-col').evaluateAll(columns => columns.map(column =>
  [...column.querySelectorAll(':scope > [data-panel]')].filter(card => !card.classList.contains('is-panel-hidden')).map(card => card.dataset.panel)));
async function revealed(key, columnIndex) {
  await page.waitForFunction(({ key, columnIndex }) => {
    const card = document.querySelector(`[data-panel="${key}"]`);
    const column = document.querySelector(`.panel-col[data-col="${columnIndex}"]`);
    return !card.classList.contains('is-panel-hidden') && card.classList.contains('expanded') && card.parentElement === column && column.lastElementChild === card;
  }, { key, columnIndex });
}
async function hide(key) { await page.locator(`[data-panel="${key}"] .panel-drag-handle`).press('Delete'); }
async function loadWithoutFlash(reload = false) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pattern = '**/src/main.js*';
  await page.route(pattern, async route => { await gate; await route.continue(); });
  try {
    if (reload) await page.reload({ waitUntil: 'commit' });
    else await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'commit' });
    await page.locator('.panel-cols').waitFor({ state: 'attached' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.panel-cols')).display === 'flex');
    assert.equal(await page.locator('.panel-cols').evaluate(element => getComputedStyle(element).visibility), 'hidden', 'panels stay hidden before saved layout restoration');
  } finally { release(); }
  await page.waitForFunction(() => document.querySelector('.panel-cols').classList.contains('is-layout-ready'));
  await page.waitForLoadState('networkidle');
  await page.unroute(pattern);
  assert.equal(await page.locator('.panel-cols').evaluate(element => getComputedStyle(element).visibility), 'visible', 'restored panels are shown after initialization');
}
try {
  await loadWithoutFlash();
  if (await page.locator('#btn-setup-later').isVisible()) await page.click('#btn-setup-later');
  assert.deepEqual(await visible(), [['status', 'controls', 'ports'], ['media', 'media-browser', 'drive8']]);
  const savedLayout = await visible();
  for (const width of [500, 660, 390, 1460]) {
    await page.setViewportSize({ width, height: 1180 });
    await page.waitForFunction(() => {
      const width = document.querySelector('.side-panel').getBoundingClientRect().width;
      return getComputedStyle(document.querySelector('.panel-cols')).flexDirection === (width >= 600 ? 'row' : 'column');
    });
    const layout = await page.evaluate(() => ({ width: document.querySelector('.side-panel').getBoundingClientRect().width, direction: getComputedStyle(document.querySelector('.panel-cols')).flexDirection }));
    assert.equal(layout.direction, layout.width >= 600 ? 'row' : 'column', `controls use available width at viewport ${width}`);
    assert.deepEqual(await visible(), savedLayout, 'responsive stacking preserves saved column membership');
  }
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addInitScript(cache => {
    for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
  }, roms);
  const phonePage = await phone.newPage();
  await phonePage.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  assert.equal(await phonePage.locator('.panel-cols').evaluate(e => getComputedStyle(e).flexDirection), 'column', 'portrait phones use the same width rule as desktop');
  await phone.close();
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(await visible(), [['status', 'controls', 'ports'], ['media', 'media-browser', 'drive8']], 'fresh visibility survives reload');
  console.log('ok  - fresh users see the requested two-column layout');
  if (Object.keys(roms).length !== 3) console.log('ok  - media reveals and state restoration # SKIP local C64 ROMs missing');
  else {
    await page.setInputFiles('#prg-input', { name: 'panels.reu', mimeType: 'application/octet-stream', buffer: Buffer.alloc(128 * 1024, 17) });
    await revealed('reu', 0);
    assert.equal(await page.evaluate(() => window.machine.reu.ram[0]), 17, 'Load Any fits and fills the REU before showing its controls');
    const transfer = await page.evaluateHandle(bytes => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(bytes)], 'panels.crt')); return transfer;
    }, [...sampleMedia('crt')]);
    await page.locator('#monitor').dispatchEvent('drop', { dataTransfer: transfer });
    await revealed('cartridge', 1); await transfer.dispose();
    await page.evaluate(async bytes => {
      const { libSave } = await import('/src/media/library.js');
      await libSave('tap', 'panels.tap', Uint8Array.from(bytes));
    }, [...sampleMedia('tap')]);
    await page.click('#btn-library');
    await page.locator('#library-list .lib-name').filter({ hasText: 'panels.tap' }).click();
    await revealed('datasette', 0);
    console.log('ok  - Load Any, drag and drop and Library reveal loaded device controls in alternating columns');
    await page.click('#btn-save-state');
    await page.fill('#prompt-modal-input', 'Panel controls');
    await page.locator('#prompt-modal').getByRole('button', { name: /SAVE/ }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Saved state'));
    for (const key of ['reu', 'cartridge', 'datasette']) await hide(key);
    await page.click('#btn-load-state');
    await page.locator('#state-list .lib-name').filter({ hasText: 'Panel controls' }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('State loaded'));
    const columns = await visible();
    assert.deepEqual(columns[0], ['status', 'controls', 'ports', 'cartridge', 'reu']);
    assert.deepEqual(columns[1], ['media', 'media-browser', 'drive8', 'datasette'], 'saved states alternate new controls across both columns');
    for (const key of ['reu', 'cartridge', 'datasette']) assert.equal(await page.locator(`[data-panel="${key}"]`).evaluate(card => card.classList.contains('expanded')), true);
    assert.equal(await page.locator('[data-panel="iec"]').evaluate(card => card.classList.contains('is-panel-hidden')), true, 'unrelated panels remain hidden');
    await loadWithoutFlash(true);
    assert.deepEqual(await visible(), columns, 'automatically revealed panels stay visible after reload');
    console.log('ok  - saved states reveal all restored media controls and preserve their layout');
  }
  const custom = await page.locator('.panel-col').evaluateAll(columns => columns.map(column =>
    [...column.querySelectorAll(':scope > [data-panel]')].map(card => card.dataset.panel)).reverse().map(column => column.reverse()));
  await page.evaluate(custom => {
    localStorage.setItem('c64emu.panelOrder', JSON.stringify(custom));
    localStorage.setItem('c64emu.panelHidden', '["reu","cartridge","datasette"]');
  }, custom);
  await loadWithoutFlash(true);
  assert.deepEqual(await page.locator('.panel-col').evaluateAll(columns => columns.map(column =>
    [...column.querySelectorAll(':scope > [data-panel]')].map(card => card.dataset.panel))), custom, 'existing customized order is retained exactly');
  assert.deepEqual(await visible(), custom.map(column => column.filter(key => !['reu', 'cartridge', 'datasette'].includes(key))), 'existing customized visibility is retained exactly');
  console.log('ok  - existing custom order and visibility are restored before panels are shown');
  if (Object.keys(roms).length === 3) {
    const firstVisit = await browser.newContext({ viewport: { width: 1460, height: 1180 } });
    await firstVisit.addInitScript(() => {
      localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.installDismissed', '1');
    });
    await firstVisit.route('**/roms/**', route => route.fulfill({ status: 404, body: '' }));
    const setup = await firstVisit.newPage();
    try {
      await setup.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
      const hint = setup.locator('.panel-equipment-hint');
      assert.equal(await hint.isVisible(), false, 'equipment hint waits for ROMs');
      for (const [input, slot] of [['kernal', 'kernal'], ['basic', 'basic']]) {
        await setup.setInputFiles(`#setup-rom-${input}`, { name: `${input}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.from(roms[`c64emu.rom.${slot}`], 'base64') });
      }
      assert.equal(await hint.isVisible(), false, 'partial ROM setup does not show the hint');
      await setup.setInputFiles('#setup-rom-char', { name: 'chargen.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(roms['c64emu.rom.charRom'], 'base64') });
      await setup.waitForFunction(() => ['kernal', 'basic', 'charRom'].every(slot => localStorage.getItem(`c64emu.rom.${slot}`)));
      assert.equal(await setup.evaluate(() => localStorage.getItem('c64emu.equipmentHintShown')), null, 'setup overlay does not consume the one-time hint');
      await setup.click('#btn-setup-later');
      await setup.locator('.theme-picker').waitFor();
      assert.equal(await hint.isVisible(), false, 'theme selection precedes the equipment hint');
      await setup.locator('.theme-picker').getByRole('button', { name: 'KEEP CURRENT', exact: true }).click();
      await hint.waitFor({ state: 'visible' });
      assert.equal(await hint.evaluate(element => getComputedStyle(element).animationName), 'equipment-arrow-point', 'text and arrow animate together');
      assert.equal(await hint.locator('svg').evaluate(element => getComputedStyle(element).animationName), 'none', 'the arrow has no independent movement');
      assert.equal(await hint.locator('path').getAttribute('d'), 'M3 18h40m-10-10 10 10-10 10', 'the equipment arrow is straight');
      const desktopWidth = await hint.locator('svg').evaluate(element => element.getBoundingClientRect().width);
      if (process.argv.includes('--hint-shot')) await setup.screenshot({ path: 'investigation/equipment-hint-desktop.png', clip: { x: 1050, y: 1070, width: 410, height: 100 }, animations: 'disabled' });
      await setup.setViewportSize({ width: 390, height: 844 });
      assert(desktopWidth > await hint.locator('svg').evaluate(element => element.getBoundingClientRect().width), 'desktop hint is larger than the phone hint');
      if (process.argv.includes('--hint-shot')) await setup.screenshot({ path: 'investigation/equipment-hint-phone.png', clip: { x: 0, y: 734, width: 390, height: 100 }, animations: 'disabled' });
      await setup.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await hint.evaluate(element => getComputedStyle(element).animationName), 'none', 'the hint respects reduced motion');
      await setup.waitForTimeout(8500);
      assert.equal(await hint.isVisible(), true, 'the equipment hint has no automatic timeout');
      await setup.reload({ waitUntil: 'networkidle' });
      await hint.waitFor({ state: 'visible' });
      assert.equal(await setup.evaluate(() => localStorage.getItem('c64emu.equipmentHintShown')), null, 'the hint remains pending across reloads until plus is clicked');
      await setup.click('.panel-restore-btn');
      assert.equal(await hint.isVisible(), false, 'opening equipment dismisses the hint');
      await setup.reload({ waitUntil: 'networkidle' });
      assert.equal(await hint.isVisible(), false, 'equipment hint does not repeat after reload');
      assert.equal(await setup.evaluate(() => localStorage.getItem('c64emu.equipmentHintShown')), '1');
      await setup.goto(`http://127.0.0.1:${port}/?EQUIPMENT_HINT=1`, { waitUntil: 'networkidle' });
      await hint.waitFor({ state: 'visible' });
      assert.equal(await setup.evaluate(() => localStorage.getItem('c64emu.equipmentHintShown')), '1', 'URL preview preserves the saved one-time setting');
      if (process.argv.includes('--hint-shot')) {
        await setup.setViewportSize({ width: 1460, height: 1180 });
        await setup.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await setup.screenshot({ path: 'investigation/equipment-hint-dark.png', clip: { x: 1050, y: 1070, width: 410, height: 100 }, animations: 'disabled' });
      }
      console.log('ok  - the equipment hint waits for ROM setup and persists until plus is clicked, with one-time storage and URL preview');
    } finally { await firstVisit.close(); }
  } else console.log('ok  - equipment hint after ROM setup # SKIP local C64 ROMs missing');
  assert.deepEqual(errors, []);
} finally { await ctx.close(); await browser.close(); await vite.close(); }
