import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readAsset } from './external-assets.js';
let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch { /* skip below */ }
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
const roms = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
}
if (Object.keys(roms).length !== 3) { await browser.close(); console.log('# SKIP local C64 ROMs unavailable'); process.exit(0); }
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
try {
  const context = await browser.newContext();
  await context.addInitScript(cache => {
    for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
    localStorage.setItem('c64emu.panelHidden', '[]');
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.equipmentHintShown', '1');
  }, roms);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page.click('#btn-power');
  for (const connector of ['userport', 'iec']) {
    const source = `globalThis.__${connector}ReviewExecuted = true;
export const meta = { id: 'example.${connector}-trust', name: 'Trust probe', version: '1', apiVersion: ${connector === 'iec' ? "1, bus: 'iec'" : '2'} };
export function create() { return {}; }`;
    const file = { name: 'probe.js', mimeType: 'text/javascript', buffer: Buffer.from(source) };
    await page.setInputFiles(`#${connector}-file`, file);
    const trust = page.locator(`#${connector}-install-trust`); await trust.waitFor();
    assert.equal(await page.evaluate(key => window[key], `__${connector}ReviewExecuted`), undefined, `${connector} source is not executed to display its trust review`);
    await page.locator(`#${connector}-modal-actions`).getByRole('button', { name: 'CANCEL', exact: true }).click();
    assert.equal(await page.evaluate(key => window[key], `__${connector}ReviewExecuted`), undefined, `${connector} cancellation never executes the source`);
    await page.setInputFiles(`#${connector}-file`, file); await trust.waitFor(); await trust.check();
    await page.locator(`#${connector}-modal-actions`).getByRole('button', { name: 'INSTALL', exact: true }).click();
    if (connector === 'userport' && !(await page.locator('#userport-power').isChecked())) await page.click('#userport-power-switch');
    await page.waitForFunction(key => window[key] === true, `__${connector}ReviewExecuted`);
    console.log(`ok - ${connector} plugin code runs only after explicit trust and installation`);
  }
} finally { await browser.close(); await vite.close(); }
