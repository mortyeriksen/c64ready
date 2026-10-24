import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServe } from '../../cli/serve.mjs';
import { readAsset } from '../external-assets.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (!fs.existsSync(path.join(root, 'dist/index.html'))) { console.log('# SKIP run npm run build before the CLI browser checks'); process.exit(0); }
let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
const roms = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
}
if (Object.keys(roms).length !== 3) { await browser.close(); console.log('# SKIP local C64 ROMs unavailable'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-iec-browser-'));
const file = path.join(tmp, 'iec.mjs');
const source = version => `globalThis.__cliIecLoaded = true;
export const meta = { id:'example.cli-browser', name:'CLI device', version:'${version}', bus:'iec', apiVersion:1, address:4 };
export function create(port,host) { const span = host.panel.ownerDocument.createElement('span'); span.textContent = 'Version ${version}'; host.panel.append(span); return { detach() { globalThis.__cliIecDetached = (globalThis.__cliIecDetached || 0) + 1; } }; }`;
fs.writeFileSync(file, source(1));
const server = await startServe({ port: 0, app: path.join(root, 'dist'), device: file, log: () => {} });
try {
  const ctx = await browser.newContext();
  await ctx.addInitScript(cache => {
    for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, JSON.stringify({ data: value, name: key.split('.').at(-1) + '.bin' }));
    for (const key of ['splashSeen', 'themePickerShown', 'installDismissed', 'equipmentHintShown']) localStorage.setItem(`c64emu.${key}`, '1');
  }, roms);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#iec-status').textContent.includes('loaded from c64rdy serve'));
  assert.equal(await page.locator('#iec-card').evaluate(e => e.classList.contains('is-panel-hidden')), false, 'served IEC plugins reveal their card');
  assert.equal(await page.locator('#iec-power').isChecked(), true, 'served IEC plugin is connected and enabled');
  assert.equal(await page.locator('#userport-device option').filter({ hasText: 'CLI device' }).count(), 0, 'IEC files do not enter the User Port installer');
  await page.click('#btn-power');
  const row = page.locator('.iec-connected[data-address="4"]');
  await row.getByText('Version 1', { exact: true }).waitFor();
  fs.writeFileSync(file, source(2));
  await row.getByText('Version 2', { exact: true }).waitFor();
  assert.equal(await page.locator('.iec-connected').count(), 1, 'reload replaces the existing device instead of adding another');
  assert.equal(await page.evaluate(() => window.machine.iec.devices.size), 1, 'reloaded plugin has exactly one bus participant');
  assert(await page.evaluate(() => window.__cliIecDetached >= 1), 'reload detaches the previous instance');
  await page.click('#iec-power-switch');
  fs.writeFileSync(file, source(3));
  await page.waitForFunction(() => document.querySelector('#iec-status').textContent.includes('CLI device 3 loaded'));
  assert.equal(await page.locator('#iec-power').isChecked(), false, 'reload respects a switched-off IEC card');
  assert.equal(await page.evaluate(() => window.machine.iec), null, 'reload leaves switched-off IEC devices unwired');
  await page.click('#iec-power-switch');
  await row.getByText('Version 3', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const safe = await ctx.newPage();
  await safe.goto(`${server.url}?IEC_SAFE=1`, { waitUntil: 'networkidle' });
  assert.equal(await safe.evaluate(() => window.__cliIecLoaded), undefined, 'safe mode blocks browser imports of served IEC plugins');
  await ctx.close();
  console.log('ok - CLI serve routes IEC devices, reveals and enables the card, reloads edits and respects safe mode');
} finally { await browser.close(); await server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
