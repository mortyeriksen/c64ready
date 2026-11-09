// Retro Vibes in the real app: a mouse click on one of its buttons hands the
// keyboard back to the C64 (its screen, or the page while Retro Vibes is
// fullscreen), as a click on a button in the window does,
// while focus moved there by the keyboard stays, and a dialog inside it (such
// as the model credit) keeps its own.
//
// Needs Playwright's Chromium; without it it reports a SKIP.
import net from 'node:net';
import { fileURLToPath } from 'node:url';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium is unavailable'); process.exit(0); }
const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
process.env.VITE_BUILD_DOCS = '0';
const { createServer } = await import('vite');
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true } });
await vite.listen();

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

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.pauseDemo', 'off');
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  if (await page.locator('#setup-modal').isVisible()) await page.click('#btn-setup-later');
  // The overlay shown with buttons of its own: one in its controls, one in a dialog in it (as the credit popup is).
  await page.evaluate(() => {
    const overlay = document.querySelector('#model-viewer-overlay');
    overlay.hidden = false;
    overlay.removeAttribute('aria-hidden');
    const add = (parent, id) => {
      const b = document.createElement('button');
      b.id = id; b.type = 'button'; b.textContent = id;
      b.style.cssText = 'position:fixed;z-index:2147483647;left:40px;top:' + (id === 'vibes-test-btn' ? 40 : 100) + 'px';
      parent.append(b);
    };
    add(overlay, 'vibes-test-btn');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    overlay.append(dialog);
    add(dialog, 'vibes-test-dialog-btn');
  });
  const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

  // 1. A click on a Retro Vibes button: the screen has the keyboard after it.
  await page.click('#vibes-test-btn');
  expect(await focused() === 'screen', `a click on a Retro Vibes button hands the keyboard to the screen (focus on ${await focused()})`);
  ok('a click in Retro Vibes hands the keyboard back');

  // 2. Fullscreen, as Retro Vibes is: the screen outside it cannot take focus, so the click
  //    leaves focus with the page, which gives the keys to the C64 too.
  await page.evaluate(() => document.querySelector('#vibes-test-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) document.querySelector('#model-viewer-overlay').requestFullscreen();
  }));
  await page.click('#vibes-test-btn');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'model-viewer-overlay', null, { timeout: 5000 }).catch(() => {});
  const fullscreen = await page.evaluate(() => document.fullscreenElement?.id === 'model-viewer-overlay');
  if (!fullscreen) console.log(`ok  - test ${++testNo}: a click in fullscreen Retro Vibes hands the keyboard back # SKIP this browser refused fullscreen`);
  else {
    await page.focus('#vibes-test-btn');
    await page.click('#vibes-test-btn');
    const now = await focused();
    expect(now === 'screen' || now === 'BODY', `a click in fullscreen Retro Vibes leaves the button (focus on ${now})`);
    ok('a click in fullscreen Retro Vibes hands the keyboard back');
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
  }

  // 3. Focus moved there from the keyboard stays: Enter presses the button and focus does not move.
  await page.focus('#vibes-test-btn');
  await page.keyboard.press('Enter');
  expect(await focused() === 'vibes-test-btn', `a button pressed from the keyboard keeps focus (focus on ${await focused()})`);
  ok('keyboard focus stays where it was put');

  // 4. A dialog inside Retro Vibes keeps its own focus.
  await page.click('#vibes-test-dialog-btn');
  expect(await focused() === 'vibes-test-dialog-btn', `a click in a dialog keeps focus there (focus on ${await focused()})`);
  ok('a dialog keeps its focus');
} finally {
  await browser.close();
  await vite.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Retro Vibes keyboard focus: ${testNo} checks`);
