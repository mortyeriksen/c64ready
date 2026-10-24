import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readAsset } from './external-assets.js';
import { PHOSPHOR_THEME } from '../src/ui/themes/phosphor.js';
import { themeCss, validateTheme } from '../src/ui/themes.js';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium unavailable'); process.exit(0); }
const roms = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
  const bytes = readAsset(asset); if (bytes) roms[`c64emu.rom.${slot}`] = bytes.toString('base64');
}
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
const url = `http://127.0.0.1:${port}`;
try {
  if (Object.keys(roms).length === 3) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(cache => {
      if (sessionStorage.getItem('theme-test-seeded')) return;
      sessionStorage.setItem('theme-test-seeded', '1');
      for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
      localStorage.setItem('c64emu.splashSeen', '1');
      localStorage.setItem('c64emu.installDismissed', '1');
      localStorage.setItem('c64emu.theme', 'phosphor');
      localStorage.setItem('c64emu.appearance', 'dark');
    }, roms);
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle' });
    const picker = page.locator('.theme-picker');
    await picker.waitFor();
    assert.equal(await picker.locator('[data-theme-use]').textContent(), 'APPLY THEME');
    assert(await picker.locator('.theme-picker-actions .btn').evaluateAll(buttons => buttons.every(button => parseFloat(getComputedStyle(button).paddingInlineStart) >= 24 && parseFloat(getComputedStyle(button).paddingInlineEnd) >= 24)), 'desktop actions have room on both sides of their labels');
    assert.equal(await picker.getByRole('radio').count(), 8, 'cached ROM users without a seen flag get all eight theme choices');
    assert.equal(await picker.locator('.theme-picker-grid').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length), 4);
    const motifs = await picker.locator('.theme-tile-art').evaluateAll(nodes => nodes.map(n => n.innerHTML));
    assert.equal(new Set(motifs).size, 8, 'each built-in theme has a distinct motif');
    await picker.getByRole('radio', { name: 'Out Run', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.theme')), 'phosphor', 'a card only stages the selection');
    await picker.getByRole('button', { name: 'KEEP CURRENT', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.theme')), 'phosphor', 'cancelling preserves the theme');
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.themePickerShown')), '1');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await picker.count(), 0, 'the automatic picker is one-time');
    await page.goto(`${url}/?THEME_PICKER=1`, { waitUntil: 'networkidle' });
    await picker.waitFor();
    await picker.getByRole('radio', { name: 'Phosphor', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await picker.getByRole('radio', { name: 'Classic', exact: true }).getAttribute('aria-checked'), 'true', 'arrows select and focus themes');
    await picker.getByRole('radio', { name: 'Out Run', exact: true }).click();
    await picker.locator('[data-theme-use]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.theme')), 'outrun', 'Apply theme applies and persists the choice');
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.click('#btn-settings');
    await page.click('#btn-theme-cycle');
    await picker.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await picker.count(), 0, 'closing URL preview does not immediately reopen onboarding');
    assert.equal(await page.locator('#settings-modal').isVisible(), true, 'closing the manual picker returns to Options');
    await page.locator('#settings-modal .dialog-close').click();
    await page.evaluate(() => localStorage.removeItem('c64emu.themePickerShown'));
    await page.goto(`${url}/?THEME_PICKER=1`, { waitUntil: 'networkidle' });
    await picker.waitFor();
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const bounds = await picker.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, 'dialog fits both phone orientations');
      await picker.locator('[data-theme-use]').scrollIntoViewIfNeeded();
      assert(await picker.locator('[data-theme-use]').isVisible(), 'actions remain available on short screens');
      assert(await picker.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'no horizontal overflow');
      assert(await picker.locator('.theme-picker-actions .btn').evaluateAll(buttons => buttons.every(button => parseFloat(getComputedStyle(button).paddingInlineStart) >= 18 && parseFloat(getComputedStyle(button).paddingInlineEnd) >= 18)), 'phone actions retain label padding');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await picker.locator('.theme-picker-grid').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length), 2);
    if (process.argv.includes('--shots')) {
      await page.screenshot({ path: 'investigation/theme-picker-phone.png' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: 'investigation/theme-picker-desktop.png' });
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => localStorage.getItem('c64emu.themePickerShown')), null, 'URL preview preserves the one-time setting');
    assert.equal(await picker.count(), 0, 'closing URL preview without a seen flag does not reopen the picker');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url, { waitUntil: 'networkidle' });
    await picker.getByRole('button', { name: 'KEEP CURRENT', exact: true }).click();
    await page.click('#btn-settings');
    assert.deepEqual(errors, [], 'the app initializes without errors before Options');
    await page.locator('#settings-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#settings-modal').isVisible(), true, 'Options opens for importing a theme');
    await page.setInputFiles('#theme-input', { name: 'custom.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'c64ready-theme/2', name: 'Ocean ink', modes: { dark: { accent: '#57c9ff', 'panel-bg': '#081b29', text: '#e4f8ff' } } })) });
    await page.waitForFunction(() => localStorage.getItem('c64emu.theme')?.startsWith('user:'));
    await page.click('#btn-theme-cycle');
    const custom = picker.getByRole('radio', { name: 'Ocean ink', exact: true });
    assert.equal(await picker.getByRole('radio').count(), 9, 'imported themes join the gallery');
    assert.equal(await custom.getAttribute('aria-checked'), 'true', 'the imported theme is selected');
    assert.equal(await custom.evaluate(e => e.style.getPropertyValue('--tile-accent')), '#57c9ff', 'custom cards use their own colours');
    await page.keyboard.press('Escape');
    await page.click('#btn-theme-remove');
    await page.getByRole('button', { name: 'REMOVE', exact: true }).last().click();
    await page.waitForFunction(() => !localStorage.getItem('c64emu.theme'));
    await page.click('#btn-theme-cycle');
    assert.equal(await picker.getByRole('radio').count(), 8, 'removed themes leave the gallery');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('ok - theme picker: cached ROM onboarding, cancellation, selection, keyboard, Options, phone layouts and URL preview');
  } else console.log('ok - theme picker # SKIP local C64 ROMs unavailable');

  if (existsSync(`${root}public/docs/theme.js`)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    await page.goto(`${url}/docs/guide-interface.html`, { waitUntil: 'networkidle' });
    const theme = validateTheme(PHOSPHOR_THEME).theme;
    await page.evaluate(({ theme, css }) => {
      localStorage.setItem('c64emu.theme', 'phosphor'); localStorage.setItem('c64emu.themeCss', css); localStorage.setItem('c64emu.appearance', 'dark');
    }, { theme, css: themeCss(theme) });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), theme.modes.dark.accent);
    await page.click('#appearance-btn');
    assert.equal(await page.getAttribute('html', 'data-mode'), 'light');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), theme.modes.light.accent);
    const other = await ctx.newPage();
    await other.goto(`${url}/docs/guide-looks.html`, { waitUntil: 'networkidle' });
    await other.evaluate(() => {
      localStorage.setItem('c64emu.themes', JSON.stringify([{ id: 'user:example', theme: { name: 'Example', modes: { dark: { accent: '#123456', text: '#eeeeee' } } } }]));
      localStorage.setItem('c64emu.theme', 'user:example');
    });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#123456');
    assert.equal(await page.getAttribute('html', 'data-mode'), 'dark', 'one-mode imported themes pin the docs appearance');
    await other.evaluate(() => localStorage.removeItem('c64emu.theme'));
    await page.waitForFunction(() => !document.getElementById('c64-theme')?.textContent);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const [portrait, landscape] = await page.locator('.mobile-views img').evaluateAll(images => images.map(img => { const r = img.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom }; }));
      assert(portrait.right < landscape.x, 'phone mockups are side by side');
      assert(portrait.y < landscape.bottom && landscape.y < portrait.bottom, 'both phone mockups share the same row');
      assert(landscape.right <= width, 'the mobile gallery fits narrow viewports');
    }
    await ctx.close();
    console.log('ok - docs follow built-in and imported themes, appearance and other tabs, with side-by-side phone mockups');
  } else console.log('ok - themed docs # SKIP run npm run build:docs first');
} finally { await browser.close(); await vite.close(); }
