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
    let fetchedMarkers = 0;
    await context.route('**/roms-fetched.html', route => {
      fetchedMarkers++;
      return route.fulfill({ contentType: 'text/html', body: '' });
    });
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
    assert.equal(fetchedMarkers, 0, 'incomplete ROM fetches do not send the fetched marker');
    badBasic = false;
    await Promise.all([page.waitForResponse('**/roms-fetched.html'), page.click('#setup-fetch')]);
    assert.equal(fetchedMarkers, 1, 'a successful Fetch ROMs action sends one fetched marker');
    await page.waitForFunction(() => document.querySelector('#setup-fetch-summary').textContent.includes('All four'));
    assert.deepEqual(requests.filter(key => key !== 'basic').sort(), ['charRom', 'drive1541', 'kernal'], 'retry preserves successful downloads');
    assert.equal(await page.locator('#btn-setup-later').innerText(), 'Done', 'successful fetch updates the setup dismissal button');
    assert.equal(await page.locator('.setup-actions button:visible').count(), 1, 'completed setup leaves only Done in the footer');
    await page.click('#setup-tab-upload');
    await page.click('#setup-tab-fetch');
    assert.equal(await page.locator('#setup-fetch').isVisible(), false, 'switching tabs does not restore Fetch after completion');
    assert.equal(await page.locator('#setup-modal').isVisible(), true, 'setup stays open after downloads complete');
    const overflow = await page.locator('.setup-panels').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false, 'the ROM panel fits the viewport width');
    await page.click('#btn-setup-close');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('powered-on')), false, 'the close icon does not power on the C64');
    await page.locator('#setup-modal').evaluate(el => { el.hidden = false; });
    await page.click('#btn-setup-later');
    await page.waitForFunction(() => document.body.classList.contains('powered-on'));
    assert.equal(await page.locator('#setup-modal').isVisible(), false, 'Done closes setup and powers on the C64');
    await page.evaluate(async () => { window.setupPoweredMachine = (await import('/src/state.js')).machine; document.querySelector('#setup-modal').hidden = false; });
    await page.click('#btn-setup-later');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine === window.setupPoweredMachine), true, 'Done keeps an already-running machine intact');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(fetchedMarkers, 1, 'cached return visits do not send another fetched marker');
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
  await page.click('#btn-setup-later');
  assert.equal(await page.locator('#setup-modal').isVisible(), false, 'Find them later closes setup');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('powered-on')), false, 'Find them later leaves the C64 powered off');
  let viceMarkers = 0;
  await context.route('**/roms-vice.html', route => {
    viceMarkers++;
    return route.fulfill({ contentType: 'text/html', body: '' });
  });
  await page.click('#btn-power');
  await page.click('#setup-tab-vice');
  const importVice = names => page.evaluate(names => {
    const transfer = new DataTransfer();
    for (const [name, size] of names) {
      const file = new File([new Uint8Array(size)], name);
      Object.defineProperty(file, 'webkitRelativePath', { value: `vice/C64/${name}` });
      transfer.items.add(file);
    }
    const input = document.querySelector('#setup-vice-dir');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, names);
  await importVice([['kernal-901227-03.bin', 8192]]);
  await page.waitForFunction(() => document.querySelector('#setup-vice-status').textContent.includes('Not found: BASIC'));
  assert.equal(viceMarkers, 0, 'incomplete VICE imports do not send the VICE marker');
  await Promise.all([
    page.waitForResponse('**/roms-vice.html'),
    importVice([['basic-901226-01.bin', 8192], ['chargen-901225-01.bin', 4096]]),
  ]);
  assert.equal(viceMarkers, 1, 'a VICE import completing the required trio sends one VICE marker');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(viceMarkers, 1, 'cached VICE ROMs do not send another VICE marker on return');
  await context.close();
  console.log('ok  - ROM setup tabs, downloads, retry, missing config and phone layout');
} finally { await browser.close(); await vite.close(); }
