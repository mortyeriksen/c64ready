// Shared dialog close controls in the real app: scaled and unscaled geometry,
// native keyboard activation, cancellation, focus restoration and nested Escape.
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

let browser;
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
try { const engines = await import('playwright'); browser = await engines[engine].launch(); } catch {}
if (!browser) { console.log(`# SKIP Playwright ${engine} is unavailable`); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(port => {
  localStorage.setItem('c64emu.splashSeen', '1');
  localStorage.setItem('c64emu.themePickerShown', '1');
  localStorage.setItem('c64emu.pauseDemo', 'off');
  localStorage.setItem('c64emu.chat.server', `ws://127.0.0.1:${port}/chat`);
}, port);
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const openDialog = (className = '', title = 'Close test') => page.evaluate(async ({ className, title }) => {
  const { createDialog } = await import('/src/assembly64/dom.js');
  window.closeTestDialog = createDialog(title);
  if (className) window.closeTestDialog.card.classList.add(className);
}, { className, title });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!document.querySelector('#btn-library-close svg'));
  if (await page.locator('#setup-modal').isVisible()) await page.click('#btn-setup-later');
  await page.evaluate(async () => {
    const { libSave } = await import('/src/media/library.js');
    for (let i = 0; i < 24; i++) await libSave('prg', `Example ${i}.prg`, new Uint8Array([1, 8, 0, 0]));
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.mouse.move(0, 0);
    const buttons = await page.evaluate(() => [...document.querySelectorAll('.modal-backdrop .dialog-close')].map(button => {
      const backdrop = button.closest('.modal-backdrop');
      const hidden = backdrop.hidden;
      backdrop.hidden = false;
      const r = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
      const css = getComputedStyle(button);
      const result = { id: button.id, width: r.width, height: r.height, iconWidth: icon.width, iconHeight: icon.height,
        radius: css.borderRadius, color: css.color, background: css.backgroundColor, transform: css.transform };
      backdrop.hidden = hidden;
      return result;
    }));
    for (const button of buttons) {
      assert.ok(Math.abs(button.width - 36) < 0.1 && Math.abs(button.height - 36) < 0.1, `${button.id} has the same 36px target at ${width}px`);
      assert.ok(Math.abs(button.iconWidth - 18) < 0.1 && Math.abs(button.iconHeight - 18) < 0.1, `${button.id} has the same 18px icon at ${width}px`);
      assert.equal(button.radius, '6px', `${button.id} has the shared border radius`);
      assert.equal(button.color, buttons[0].color, `${button.id} uses the shared label color`);
      assert.equal(button.background, buttons[0].background, `${button.id} uses the shared background`);
    }
    for (const className of ['', 'mb-details', 'mb-browser']) {
      await openDialog(className, 'A long dialog title that wraps on a narrow screen');
      const geometry = await page.locator('.mb-dialog').evaluate(card => {
        const button = card.querySelector('.dialog-close').getBoundingClientRect();
        const heading = card.querySelector('h2').getBoundingClientRect();
        const rect = card.getBoundingClientRect(), css = getComputedStyle(card);
        const inset = parseFloat(css.borderRightWidth) + (card.classList.contains('mb-browser') ? (innerWidth <= 600 ? 18 : 32) : parseFloat(css.paddingRight));
        return { right: rect.right - button.right, inset, headingRight: heading.right, buttonLeft: button.left };
      });
      assert.ok(Math.abs(geometry.right - geometry.inset) < 1, `${className || 'standard'} close button respects the right content padding at ${width}px: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.headingRight <= geometry.buttonLeft, 'a wrapping title cannot overlap the close button');
      if (process.argv.includes('--screenshot') && width === 390 && !className) await page.screenshot({ path: 'investigation/close-dialog-review.png' });
      await page.keyboard.press('Escape');
    }
    for (const [trigger, modal, content] of [
      ['#btn-settings', '#settings-modal', '.settings-section > h3, .settings-section > .btn-group'],
      ['#btn-library', '#library-modal', '.lib-row, .library-footer'],
      [null, '#setup-modal', '.setup-roms > .rom-row:nth-child(even), .setup-actions'],
    ]) {
      if (trigger) await page.locator(trigger).dispatchEvent('click');
      else await page.locator(modal).evaluate(element => { element.hidden = false; });
      await page.locator(modal).waitFor({ state: 'visible' });
      if (modal === '#library-modal') await page.locator('#library-list .lib-row').first().waitFor();
      for (const gutter of ['auto', 'stable']) {
        await page.locator(`${modal} .dialog-scroll`).evaluate((element, value) => {
          element.style.scrollbarGutter = value;
        }, gutter);
        await page.waitForFunction(({ modal, content }) => {
          const card = document.querySelector(`${modal} .modal-card`);
          const right = card.querySelector('.dialog-close').getBoundingClientRect().right;
          return [...card.querySelectorAll(content)].every(element => Math.abs(element.getBoundingClientRect().right - right) < 1);
        }, { modal, content });
        const edges = await page.locator(`${modal} .modal-card`).evaluate((card, selector) => ({
          close: card.querySelector('.dialog-close').getBoundingClientRect().right,
          content: [...card.querySelectorAll(selector)].map(element => element.getBoundingClientRect().right),
        }), content);
        for (const right of edges.content) assert.ok(Math.abs(right - edges.close) < 1, `${modal} header, rows and footer share a right margin with ${gutter} scrollbar space at ${width}px`);
        if (process.argv.includes('--screenshot') && width === 1440 && gutter === 'stable') {
          await page.locator(`${modal} .modal-card`).screenshot({ path: `investigation/${modal.slice(1)}-margin-review.png` });
        }
      }
      await page.locator(`${modal} .dialog-close`).click();
      console.log(`ok  - ${modal} content aligns with its close button at ${width}px`);
    }
  }
  assert.equal(await page.locator('#btn-fs-close').isVisible(), false, 'fullscreen close stays hidden in the normal view');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#btn-library');
  await page.locator('#library-modal').waitFor({ state: 'visible' });
  await page.locator('#btn-library-close').focus();
  await page.keyboard.press('Enter');
  await page.locator('#library-modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#library-modal').isVisible(), false, 'Enter closes an authored dialog');
  await page.locator('#btn-d64-queue').focus();
  for (const key of ['Enter', 'Space']) {
    await openDialog();
    const button = page.locator('.mb-dialog .dialog-close');
    await button.focus();
    assert.equal(await button.evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'keyboard focus has a visible outline');
    await page.keyboard.press(key);
    assert.equal(await page.locator('.mb-dialog').count(), 0, `${key} closes a generated dialog`);
    assert.equal(await page.locator('#btn-d64-queue').evaluate(el => el === document.activeElement), true, 'generated dialogs restore focus to the opener');
  }
  await page.click('#btn-library');
  await openDialog();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mb-dialog').count(), 0, 'Escape closes the topmost dialog');
  assert.equal(await page.locator('#library-modal').isVisible(), true, 'Escape leaves the underlying dialog open');
  await page.click('#btn-library-close');
  await page.evaluate(async () => {
    const { confirmDialog } = await import('/src/ui/dialogs.js');
    window.closeTestResult = 'pending';
    confirmDialog('Confirm close behavior').then(result => { window.closeTestResult = result; });
  });
  await page.click('#btn-confirm-cancel-x');
  assert.equal(await page.evaluate(() => window.closeTestResult), false, 'the shared close button cancels confirmation');
  await page.evaluate(async () => {
    const { promptDialog } = await import('/src/ui/dialogs.js');
    window.closeTestResult = 'pending';
    promptDialog('Prompt close behavior').then(result => { window.closeTestResult = result; });
  });
  await page.click('#btn-prompt-cancel-x');
  assert.equal(await page.evaluate(() => window.closeTestResult), null, 'the shared close button cancels text entry');
  await page.keyboard.press('Control+Shift+KeyF');
  await page.locator('.crt-panel-close').click();
  assert.equal(await page.locator('.crt-panel').isVisible(), false, 'the floating CRT panel keeps its delegated close action');
  await page.click('#btn-chat');
  await page.locator('.chat-close').click();
  assert.equal(await page.locator('.chat-window').isVisible(), false, 'chat uses the same control to close');
  assert.deepEqual(errors, [], 'dialog close actions have no browser errors');
  console.log('ok  - shared close controls match on desktop and phone and preserve keyboard, cancel, Escape and focus behavior');
} finally { await browser.close(); await vite.close(); }
