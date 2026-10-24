import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readAsset } from '../external-assets.js';
let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch { /* skip below */ }
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const root = fileURLToPath(new URL('../../', import.meta.url));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
const roms = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
}
const base = `http://127.0.0.1:${port}`;
let userportLayout;
async function reviewLayout(page, id) {
  return page.locator(`#${id}-modal`).evaluate(modal => {
    const body = modal.querySelector('.userport-modal-body');
    return {
      sections: [...body.children].map(el => [el.tagName, el.className]),
      fields: [...body.querySelectorAll('dt')].map(el => el.textContent),
      warning: body.querySelector('[role="alert"] strong')?.textContent,
      grid: getComputedStyle(body.querySelector('dl')).display,
      consent: getComputedStyle(body.querySelector('.userport-consent')).display,
      buttons: [...modal.querySelector('.confirm-actions').children].map(el => el.className),
    };
  });
}
async function checkReviewBounds(page, id) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1180 });
    assert.equal(await page.locator(`#${id}-modal .modal-card`).evaluate(card => {
      const body = card.querySelector('.userport-modal-body');
      const box = card.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && card.scrollWidth <= card.clientWidth + 1
        && body.scrollWidth <= body.clientWidth + 1;
    }), true, `${id} review fits ${width}px without clipping its metadata`);
    assert.equal(await page.locator(`#${id}-modal .userport-consent`).evaluate(label => {
      const box = label.querySelector('input').getBoundingClientRect();
      const range = document.createRange(); range.selectNode(label.lastChild);
      return box.right <= range.getBoundingClientRect().left;
    }), true, `${id} trust checkbox stays before its label at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1180 });
}
async function install(page, kind, replace = false) {
  await page.click('#btn-iec-url'); await page.selectOption('#iec-plugin-choice', kind);
  await page.locator('#iec-modal-actions').getByRole('button', { name: 'FETCH', exact: true }).click();
  await page.locator('#iec-install-trust').waitFor();
  const layout = await reviewLayout(page, 'iec');
  assert.deepEqual({ ...layout, fields: layout.fields.filter(key => key !== 'Replaces') }, userportLayout, 'IEC install uses the User Port review layout');
  if (replace) {
    assert.equal(layout.fields.includes('Replaces'), true, 'replacement shows the previous version');
    assert.equal(await page.locator('#iec-modal-body dt').filter({ hasText: 'Replaces' }).evaluate(el => el.nextElementSibling.textContent), 'version 1.0.0');
  }
  assert.match(await page.locator('#iec-modal-body dt').filter({ hasText: /^Size$/ }).evaluate(el => el.nextElementSibling.textContent), /^\d+\.\d KB$/);
  assert.match(await page.locator('#iec-modal-body dt').filter({ hasText: 'SHA-256' }).evaluate(el => el.nextElementSibling.textContent), /^[a-f0-9]{64}$/);
  if (kind === 'printer') {
    const findings = await page.locator('#iec-modal-body .userport-findings').textContent();
    assert.match(findings, /Found in the code/);
    assert.match(findings, /line \d+/);
    assert.match(findings, /Creates an embedded document/, 'printer review describes its hidden print document');
    assert.doesNotMatch(findings, /Changes the page outside its own panel|fake dialog/, 'printing is distinct from modifying the app controls');
  } else {
    assert.match(await page.locator('#iec-modal-body .userport-findings').textContent(), /Nothing risky found/);
  }
  await checkReviewBounds(page, 'iec');
  const go = page.locator('#iec-modal-actions .btn:last-child');
  assert.equal(await go.isDisabled(), true, 'installation requires explicit trust');
  await page.check('#iec-install-trust'); await go.click();
  await page.waitForFunction(() => document.querySelector('#iec-status').textContent.startsWith('Installed'));
}
async function connect(page, address) {
  await page.selectOption('#iec-address', String(address)); await page.click('#btn-iec-connect');
}
async function type(page, command) {
  await page.evaluate(command => {
    let at = 0;
    for (let i = 0; i < 220; i++) { at += window.machine.bufferKeyboardText(command.slice(at)); window.machine.runFrame(); }
  }, command);
}
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1180 } });
  await ctx.addInitScript(roms => {
    window.__printedDocuments = [];
    window.print = () => {
      window.parent.__printedDocuments.push(document.documentElement.outerHTML);
      window.dispatchEvent(new Event('afterprint'));
    };
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('c64emu.panelHidden', '[]');
    for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.userport', 'on');
  }, roms);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  if (await page.locator('#btn-setup-later').isVisible()) await page.click('#btn-setup-later');
  await page.click('#btn-userport-url'); await page.selectOption('#userport-plugin-choice', 'led-board');
  await page.locator('#userport-modal-actions').getByRole('button', { name: 'FETCH', exact: true }).click();
  await page.locator('#userport-install-trust').waitFor();
  userportLayout = await reviewLayout(page, 'userport');
  await checkReviewBounds(page, 'userport');
  await page.locator('#userport-modal-actions').getByRole('button', { name: 'CANCEL', exact: true }).click();
  assert.equal(await page.evaluate(() => document.querySelector('#diskdrive9-card').nextElementSibling.id), 'iec-card', 'IEC devices follow drive 9 by default');
  await page.locator('#iec-card .panel-card-header h2').click();
  const addresses = await page.locator('#iec-address option').evaluateAll(options => options.map(o => o.value));
  assert(!addresses.includes('8') && !addresses.includes('9'), 'disk addresses are reserved');
  assert.equal(await page.locator('#iec-connections > section').count(), 0);
  await install(page, 'printer'); await connect(page, 4);
  const printerRow = page.locator('.iec-connected[data-address="4"]');
  assert.equal(await printerRow.locator('.iec-device-description').textContent(), 'This printer supports Commodore text and bitmap graphics.');
  assert.equal(await printerRow.locator('.iec-device-status').textContent(), 'Waiting for power.');
  assert.equal(await printerRow.evaluate(row => {
    const description = row.querySelector('.iec-device-description').getBoundingClientRect();
    const status = row.querySelector('.iec-device-status').getBoundingClientRect();
    return description.bottom <= status.top;
  }), true, 'the printer description appears above status before power is on');
  await install(page, 'monitor'); await connect(page, 5);
  await page.selectOption('#iec-device', 'c64ready.iec-printer'); await connect(page, 6);
  await connect(page, 4);
  assert.match(await page.textContent('#iec-status'), /already connected/);
  assert.equal(await page.locator('#iec-connections > section').count(), 3);
  await install(page, 'printer', true);
  assert.equal(await page.locator('#iec-connections > section').count(), 3, 'replacing a plugin retains its connections');
  console.log('ok  - IEC catalog, trust gate, independent addresses and collision handling');
  if (process.argv.includes('--install')) { await ctx.close(); }
  else {
  if (Object.keys(roms).length !== 3) console.log('ok  - live IEC printing # SKIP local C64 ROMs missing');
  else {
    await page.click('#btn-power');
    const row4 = page.locator('.iec-connected[data-address="4"]');
    await row4.getByRole('button', { name: 'Preview / Print' }).waitFor();
    assert.equal(await row4.getByRole('button', { name: 'Preview / Print' }).isDisabled(), true, 'empty jobs cannot be printed');
    assert.equal(await row4.getByRole('button', { name: 'Clear job' }).isDisabled(), true, 'empty jobs cannot be cleared');
    assert.equal(await row4.locator('.controls > *').count(), 2, 'the controls contain only print and clear buttons');
    assert.equal(await row4.evaluate(row => {
      const status = row.querySelector('.iec-device-status').getBoundingClientRect();
      const description = row.querySelector('.iec-device-description').getBoundingClientRect();
      const controls = row.querySelector('.userport-device-panel').shadowRoot.querySelector('.controls').getBoundingClientRect();
      return description.bottom <= status.top && status.bottom < controls.top;
    }), true, 'printer status and bytes appear above the print and clear buttons');
    await page.waitForFunction(() => window.machine?.userport?.deviceId === 'builtin.wifi-modem');
    assert.equal(await page.evaluate(() => window.machine.iec.devices.size), 3);
    assert.equal(await row4.locator('#userport-relay').count(), 0, 'IEC printer has no modem relay');
    await type(page, 'OPEN1,5:PRINT#1,"MONITOR":CLOSE1\r');
    await page.locator('.iec-connected[data-address="5"] pre').filter({ hasText: 'MONITOR' }).waitFor();
    await type(page, 'OPEN1,4:PRINT#1,"HELLO  <SCRIPT>ALERT(1)</SCRIPT>"\r');
    await page.waitForFunction(() => document.querySelector('.iec-connected[data-address="4"] .iec-device-status').textContent.startsWith('Receiving…'));
    for (const command of ['PRINT#1,CHR$(8);CHR$(129);CHR$(192)', 'PRINT#1,CHR$(12);CHR$(15);"PAGE TWO"', 'CLOSE1']) {
      await type(page, command + '\r');
    }
    await page.waitForFunction(() => /^Idle · \d+ bytes received$/.test(document.querySelector('.iec-connected[data-address="4"] .iec-device-status').textContent));
    const received = await row4.locator('.iec-device-status').textContent();
    await row4.getByRole('button', { name: 'Preview / Print' }).click();
    await page.waitForFunction(() => window.__printedDocuments.length === 1);
    assert.equal(ctx.pages().length, 1, 'Preview / Print invokes printing without opening a page');
    await page.waitForFunction(() => !document.querySelector('iframe[data-c64ready-print]'));
    const preview = await ctx.newPage();
    await preview.setContent(await page.evaluate(() => window.__printedDocuments[0]));
    assert.match(await preview.locator('svg').first().textContent(), /HELLO  <SCRIPT>ALERT\(1\)<\/SCRIPT>/);
    assert.equal(await preview.locator('script').count(), 0, 'printed bytes never become executable markup');
    assert.equal(await preview.locator('svg text').first().evaluate(el => el.getNumberOfChars() === el.textContent.length), true, 'consecutive spaces survive printing');
    assert(await preview.locator('svg path').count() > 0, 'MPS graphics render');
    assert.equal(await preview.locator('svg').count(), 2, 'form feeds produce two pages');
    const pdf = await preview.pdf({ preferCSSPageSize: true });
    assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 2, 'browser PDF contains exactly two Letter pages');
    await preview.close();
    await page.locator('#iec-card .panel-card-header h2').click();
    assert.equal(await page.locator('#iec-power').isChecked(), false, 'the card header switches the IEC expansion off');
    assert.equal(await page.evaluate(() => window.machine.iec === null && window.machine.userport?.deviceId === 'builtin.wifi-modem'), true, 'IEC power leaves the user port modem connected');
    await page.click('#btn-power'); await page.click('#btn-power');
    await page.waitForFunction(() => window.machine?.ready && window.machine.iec === null);
    await page.reload({ waitUntil: 'networkidle' }); await page.click('#btn-power');
    await page.waitForFunction(() => window.machine?.ready && window.machine.iec === null);
    assert.equal(await page.locator('#iec-power').isChecked(), false, 'IEC plugins stay unwired after power cycling and reload while the card is off');
    await page.locator('#iec-card .panel-card-header h2').click();
    await row4.getByRole('button', { name: 'Preview / Print' }).waitFor();
    assert.equal(await page.evaluate(() => window.machine.iec.devices.size), 3, 'IEC power restores every configured additional device');
    assert.equal(await page.locator('.iec-connected[data-address="6"]').getByRole('button', { name: 'Preview / Print' }).isDisabled(), true, 'unaddressed printer receives no output');
    await page.click('#btn-power');
    assert.equal(await page.locator('#iec-connections button').filter({ hasText: 'Preview / Print' }).count(), 0);
    assert.equal(await row4.locator('.iec-device-status').textContent(), 'Waiting for power.', 'powering off clears the previous printer activity status');
    await page.click('#btn-power'); await row4.getByRole('button', { name: 'Preview / Print' }).waitFor();
    assert.equal(await row4.getByRole('button', { name: 'Preview / Print' }).isDisabled(), false, 'job survives power cycling');
    await page.waitForFunction(received => document.querySelector('.iec-connected[data-address="4"] .iec-device-status').textContent === received, received);
    await row4.getByRole('button', { name: 'Preview / Print' }).click();
    await page.waitForFunction(() => window.__printedDocuments.length === 1);
    await row4.getByRole('button', { name: 'Clear job' }).click();
    await page.waitForFunction(() => document.querySelector('.iec-connected[data-address="4"] .iec-device-status').textContent === 'Idle · 0 bytes received');
    assert.equal(await row4.getByRole('button', { name: 'Preview / Print' }).isDisabled(), true, 'clearing disables print');
    assert.equal(await row4.getByRole('button', { name: 'Clear job' }).isDisabled(), true, 'clearing disables clear');
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#btn-power');
    await row4.getByRole('button', { name: 'Preview / Print' }).waitFor();
    assert.equal(await row4.getByRole('button', { name: 'Preview / Print' }).isDisabled(), true, 'the cleared job stays empty after reload');
    console.log('ok  - modem and multiple IEC devices coexist, KERNAL output and bitmap PDF work, jobs survive power cycles');
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#iec-connections > section').length === 3);
  await page.locator('.iec-connected[data-address="5"]').getByRole('button', { name: 'DISCONNECT' }).click();
  assert.equal(await page.locator('#iec-connections > section').count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('#iec-card').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'IEC card fits the phone width');
  assert(await page.locator('#btn-iec-connect').evaluate(el => {
    const button = el.getBoundingClientRect(), address = document.querySelector('#iec-address').getBoundingClientRect();
    return button.left >= address.right && Math.abs((button.top + button.bottom - address.top - address.bottom) / 2) < 3;
  }), 'CONNECT stays immediately after the address dropdown on a phone');
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('ok  - IEC connections persist, disconnect independently and fit phone layout');
  }
} finally { await browser.close(); await vite.close(); }
