import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium is unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const keys = ['kernal', 'basic', 'charRom', 'drive1541'];
const urls = Object.fromEntries(keys.map(key => [key, `${origin}/fixture/${key}.bin`]));
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(() => {
      localStorage.setItem('c64emu.splashSeen', '1');
      localStorage.setItem('c64emu.themePickerShown', '1');
    });
    await context.route('**/roms/**', route => route.fulfill({ status: 404, body: '' }));
    await context.route('**/rom-sources.json', route => route.fulfill({ json: urls }));
    let badBasic = true;
    const requests = [];
    await context.route('**/fixture/*.bin', route => {
      const key = new URL(route.request().url()).pathname.split('/').pop().slice(0, -4);
      requests.push(key);
      const size = key === 'basic' && badBasic ? 10 : key === 'charRom' ? 4096 : key === 'drive1541' ? 16384 : 8192;
      return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(size) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#setup-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btn-attract-toggle').textContent(), 'ATTRACT MODE: OFF', 'attract mode defaults to off without a saved preference');
    await page.waitForFunction(() => document.querySelector('#setup-url-kernal').value.includes('/fixture/'));
    assert.equal(await page.locator('#setup-tab-fetch').getAttribute('aria-selected'), 'true', 'Fetch ROMs is selected initially');
    assert.equal(requests.length, 0, 'opening setup never downloads ROMs automatically');
    assert.equal(await page.locator('#setup-tab-vice').isVisible(), !mobile, 'VICE requires a usable desktop folder picker');
    await page.click('#setup-tab-upload');
    assert.equal(await page.locator('#setup-upload-section').isVisible(), true, 'the upload tab reveals the existing file selectors');
    assert.match(await page.locator('#setup-upload-section').innerText(), /buy a licensed set from c64forever.com/, 'upload guidance retains its existing wording');
    await page.locator('#setup-tab-upload').press('Home');
    assert.equal(await page.locator('#setup-tab-fetch').getAttribute('aria-selected'), 'true', 'Home selects the first tab');
    await page.click('#setup-fetch');
    await page.waitForFunction(() => document.querySelector('#setup-fetch-summary').textContent.includes('still missing'));
    assert.match(await page.locator('#setup-fetch-basic').innerText(), /8192/, 'invalid downloads report the required size beside the field');
    badBasic = false;
    await page.click('#setup-fetch');
    await page.waitForFunction(() => document.querySelector('#setup-fetch-summary').textContent.includes('All four'));
    assert.deepEqual(requests.filter(key => key !== 'basic').sort(), ['charRom', 'drive1541', 'kernal'], 'retry preserves successful downloads');
    assert.equal(await page.locator('#btn-setup-later').innerText(), 'Done', 'successful fetch updates the setup dismissal button');
    assert.equal(await page.locator('#setup-modal').isVisible(), true, 'setup stays open after downloads complete');
    const overflow = await page.locator('.setup-panels').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false, 'the ROM panel fits the viewport width');
    assert.deepEqual(errors, [], 'ROM setup produces no uncaught browser errors');
    await context.close();
  }
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('c64emu.splashSeen', '1'));
  await context.route('**/roms/**', route => route.fulfill({ status: 404, body: '' }));
  await context.route('**/rom-sources.json', route => route.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#setup-config-status').textContent.includes('unavailable'));
  assert.equal(await page.locator('#setup-url-kernal').isEditable(), true, 'missing config leaves manual URLs available');
  await page.click('#setup-tab-upload');
  assert.equal(await page.locator('#setup-upload-section').isVisible(), true, 'missing config leaves upload available');
  await context.close();
  console.log('ok  - ROM setup tabs, downloads, retry, missing config and phone layout');
} finally { await browser.close(); await vite.close(); }
