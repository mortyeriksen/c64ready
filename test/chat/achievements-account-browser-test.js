// The Achievements window (src/achievements/panel.js, src/account/account.js,
// src/ui/floating-window.js) in a real browser, with Chromium's virtual
// authenticator as the passkey device: the app on its own Vite dev server,
// which hosts the accounts API at /api. Creating an account signs in, a reload
// keeps it, signing out and back in with the passkey works, and deleting the
// account signs out and frees the name. The window floats without blocking the
// app, drags, resizes and keeps its place, and fills a phone's screen.
//
// Needs Playwright's Chromium (npx playwright install chromium). Without it the
// file reports a SKIP. No ROMs needed.
import net from 'node:net';
import { fileURLToPath } from 'node:url';
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
const root = fileURLToPath(new URL('../../', import.meta.url));
const freePort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
process.env.VITE_BUILD_DOCS = '0';
process.env.VITE_ACCOUNTS_IN_MEMORY = '1';
const { createServer } = await import('vite');
const vite = await createServer({ root, configFile: `${root}vite.config.js`, logLevel: 'silent', server: { port: freePort, strictPort: true, host: '127.0.0.1' } });
await vite.listen();
// A passkey's relying party must be a domain, never an IP address: the page is
// served as localhost.
const BASE = `http://localhost:${freePort}`;

const context = await browser.newContext();
await context.addInitScript((port) => {
  try {
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.chat.server', `ws://localhost:${port}/chat`);
  } catch { /* storage blocked */ }
}, freePort);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true,
} });

async function openApp() {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('btn-online'), null, { timeout: 30_000 });
  await page.evaluate(() => { document.querySelector('.splash-overlay, #splash')?.remove(); const m = document.getElementById('setup-modal'); if (m) m.hidden = true; });
}
const panel = page.locator('#online-window');
const account = page.locator('#achievements-account');
async function openPanel() {
  await page.click('#btn-online');
  await panel.waitFor({ state: 'visible' });
  await page.click('#online-tab-account');
  await page.waitForFunction(() => document.getElementById('achievements-account')?.getAttribute('aria-busy') === 'false', null, { timeout: 10_000 });
}
const signedInAs = () => account.locator('.achievements-signed-in strong').textContent({ timeout: 10_000 }).catch(() => null);

try {
  await openApp();
  // 1. Signed out, the panel offers both ways in.
  await openPanel();
  const buttons = await account.locator('button').allTextContents();
  expect(buttons.includes('SIGN IN WITH PASSKEY') && buttons.includes('CREATE ACCOUNT'), `signed out, the panel offers sign-in and sign-up (got ${buttons})`);
  expect(await page.locator('#btn-online').getAttribute('aria-label') === 'Achievements', 'the trophy button is named for screen readers');
  ok('signed out: sign in with a passkey, or create an account');

  // 2. Creating an account makes a passkey and signs in. A failed try keeps the name, with the focus on it.
  await page.route('**/api/auth/register/options', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy, try again shortly"}' }));
  await account.locator('#achievements-new-name').fill('Tester');
  await account.locator('button[type=submit]').click();
  await account.locator('.achievements-error').waitFor({ timeout: 5000 }).catch(() => {});
  expect(await account.locator('#achievements-new-name').inputValue() === 'Tester', 'a failed try keeps the typed name');
  expect(await page.evaluate(() => document.activeElement?.id) === 'achievements-new-name', 'and puts the focus back on it');
  await page.unroute('**/api/auth/register/options');
  await account.locator('button[type=submit]').click();
  expect(await signedInAs() === 'Tester', 'after creating the account, the panel shows it signed in');
  const token = await page.evaluate(() => localStorage.getItem('c64emu.account.token'));
  expect(typeof token === 'string' && token.length > 20, 'the session token is kept');
  const recoveryCode = (await account.locator('#achievements-recovery-code').textContent({ timeout: 10_000 }).catch(() => '')).trim();
  expect(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/.test(recoveryCode), `the new account's recovery code is shown (got "${recoveryCode}")`);
  expect(await page.evaluate(() => document.activeElement?.id) === 'achievements-recovery-copy', 'with the focus on COPY, so it is not missed');
  await account.locator('button', { hasText: 'I HAVE SAVED IT' }).click();
  expect(await account.locator('#achievements-recovery-code').count() === 0, 'and put away once saved');
  await account.locator('.ach-passkeys li').first().waitFor({ timeout: 10_000 });
  expect(await account.locator('.ach-passkeys li').count() === 1, 'the account lists its one passkey');
  expect(await account.locator('.ach-passkey-remove').count() === 0, 'which cannot be removed while it is the only one');
  ok('creating an account registers a passkey, signs in and shows the recovery code once');

  // 3. A reload keeps the account (the stored session is checked on first open).
  await openApp();
  await openPanel();
  expect(await signedInAs() === 'Tester', 'after a reload the account is still signed in');
  ok('the session survives a reload');

  // 3b. With the account server out of reach, the account stays as last seen.
  await page.route('**/api/me', (r) => r.abort());
  await openApp();
  await openPanel();
  expect(await signedInAs() === 'Tester', 'with the account server out of reach, a reload still shows the account');
  expect(await page.evaluate(() => localStorage.getItem('c64emu.account.token')) === token, 'and keeps its session');
  await page.unroute('**/api/me');
  await openApp();
  await openPanel();
  ok('a network failure is not a sign-out');

  // 3c. A picture, from the profile's tile: shrunk to fit 256x256 before it is uploaded, never cropped.
  {
    const { PNG } = await import('pngjs');
    const img = new PNG({ width: 400, height: 300 });
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = (i / 4) % 400 < 200 ? 220 : 40; img.data[i + 1] = 90; img.data[i + 2] = 160; img.data[i + 3] = 255; }
    await account.locator('button', { hasText: 'YOUR PROFILE' }).click();
    const own = page.locator('#achievements-detail .ach-picture-own');
    await own.waitFor({ timeout: 10_000 });
    expect(await own.locator('.ach-picture-pick').getAttribute('aria-label') === 'Add a badge', 'your own profile\'s tile offers to add a badge');
    await own.locator('input[type=file]').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: PNG.sync.write(img) });
    const pic = page.locator('#achievements-detail .ach-picture');
    await pic.waitFor({ timeout: 10_000 }).catch(() => {});
    const size = await pic.evaluate(async (el) => { await el.decode().catch(() => {}); return [el.naturalWidth, el.naturalHeight, el.getAttribute('src')]; }).catch(() => [0, 0, '']);
    expect(size[0] === 256 && size[1] === 192 && /\/users\/\d+\/avatar\?v=\d+$/.test(size[2]), `a 400x300 picture is stored whole at 256x192, and shown (got ${size})`);
    const fit = await pic.evaluate((el) => getComputedStyle(el).objectFit);
    expect(fit === 'contain', 'centred whole in its square, not cropped');
    // A tall one fits its square too: the picture's box is never bigger than the tile's.
    const tall = new PNG({ width: 150, height: 256 });
    tall.data.fill(200);
    await own.locator('input[type=file]').setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: PNG.sync.write(tall) });
    await page.waitForFunction(() => document.querySelector('#achievements-detail .ach-picture')?.naturalHeight === 256, null, { timeout: 10_000 }).catch(() => {});
    const boxes = await page.locator('#achievements-detail .ach-picture').evaluate((el) => [el.getBoundingClientRect().height, el.parentElement.getBoundingClientRect().height]);
    expect(boxes[0] <= boxes[1] + 0.5, `a tall badge fits inside its square, uncut (picture ${boxes[0]}px, square ${boxes[1]}px)`);
    await page.locator('.achievements-back').click();
    ok('a picture is set from the profile, shrunk to fit 256x256 and shown whole');
  }

  // 4. Signing out, then back in with the passkey.
  await account.locator('button', { hasText: 'SIGN OUT' }).click();
  await account.locator('button', { hasText: 'SIGN IN WITH PASSKEY' }).waitFor();
  expect(await page.evaluate(() => localStorage.getItem('c64emu.account.token')) === null, 'signing out forgets the token');
  await account.locator('button', { hasText: 'SIGN IN WITH PASSKEY' }).click();
  expect(await signedInAs() === 'Tester', 'the passkey signs back in to the same account');
  ok('sign out, and sign back in with the passkey');

  // 4b. A lost passkey: on another device, the name and recovery code make a
  // new passkey there and sign in; the code is then replaced.
  {
    const device = await browser.newContext();
    await device.addInitScript((port) => { try { localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); localStorage.setItem('c64emu.chat.server', `ws://localhost:${port}/chat`); } catch { /* storage blocked */ } }, freePort);
    const p2 = await device.newPage();
    const cdp2 = await device.newCDPSession(p2);
    await cdp2.send('WebAuthn.enable');
    await cdp2.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => document.getElementById('btn-online'), null, { timeout: 30_000 });
    await p2.evaluate(() => { document.querySelector('.splash-overlay, #splash')?.remove(); const m = document.getElementById('setup-modal'); if (m) m.hidden = true; });
    await p2.click('#btn-online');
    await p2.click('#online-tab-account');
    const acc2 = p2.locator('#achievements-account');
    await acc2.locator('button', { hasText: 'Lost your passkey?' }).click();
    await p2.fill('#achievements-recover-name', 'tester');
    await p2.fill('#achievements-recover-code', 'AAAAA-AAAAA-AAAAA-AAAAA');
    await acc2.locator('button', { hasText: 'RECOVER' }).click();
    await acc2.locator('.achievements-error').waitFor({ timeout: 10_000 });
    expect(/do not match/.test(await acc2.locator('.achievements-error').textContent()), 'a wrong code is refused, plainly');
    await p2.fill('#achievements-recover-code', recoveryCode.toLowerCase());
    await acc2.locator('button', { hasText: 'RECOVER' }).click();
    const newCode = (await acc2.locator('#achievements-recovery-code').textContent({ timeout: 10_000 }).catch(() => '')).trim();
    expect(await acc2.locator('.achievements-signed-in strong').textContent() === 'Tester', 'the right code signs in to the account on the new device');
    expect(newCode && newCode !== recoveryCode, 'and shows a new recovery code in place of the used one');
    await acc2.locator('button', { hasText: 'I HAVE SAVED IT' }).click();
    await acc2.locator('.ach-passkeys li').nth(1).waitFor({ timeout: 10_000 });
    expect(await acc2.locator('.ach-passkeys li').count() === 2, 'the account now has a passkey on each device');
    await acc2.locator('button', { hasText: 'ADD A PASSKEY' }).click();
    await acc2.locator('.achievements-error').waitFor({ timeout: 10_000 });
    expect(/already holds a passkey/.test(await acc2.locator('.achievements-error').textContent()), 'a device that already holds one is told so, not given a second');
    await acc2.locator('.ach-passkey-remove').first().click();
    await p2.locator('#confirm-modal').waitFor({ state: 'visible' });
    await p2.click('#btn-confirm-ok');
    await p2.waitForFunction(() => document.querySelectorAll('#achievements-account .ach-passkeys li').length === 1, null, { timeout: 10_000 });
    expect(await acc2.locator('.ach-passkeys li').count() === 1, 'one of the two can be removed');
    await device.close();
    ok('a lost passkey: the recovery code adds one on a new device, and passkeys can be managed');
  }

  // 5. A taken name is refused with the server's reason.
  const other = await context.newPage();
  await other.goto(BASE, { waitUntil: 'domcontentloaded' });
  const taken = await other.evaluate(async () => {
    const r = await fetch('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'TESTER' }) });
    return { status: r.status, body: await r.json() };
  });
  expect(taken.status === 409 && /taken/.test(taken.body.error), 'a name already in use, in any case, is refused');
  await other.close();
  ok('account names are unique');

  // 6. Deleting the account signs out and frees the name.
  await account.locator('button', { hasText: 'DELETE ACCOUNT' }).click();
  await page.locator('#confirm-modal').waitFor({ state: 'visible' });
  await page.click('#btn-confirm-ok');
  await account.locator('button', { hasText: 'CREATE ACCOUNT' }).waitFor({ timeout: 10_000 });
  // Asked until the sign-in rate limit (this test's many sign-ins share one address) lets it through.
  let free = 429;
  for (let i = 0; i < 15 && free === 429; i++) {
    if (i) await page.waitForTimeout(2000);
    free = await page.evaluate(async () => (await fetch('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tester' }) })).status);
  }
  expect(free === 200, `after deletion the name is free (got ${free})`);
  // The deleted account's passkey is still in the browser: signing in with it is explained under the button.
  await page.waitForTimeout(20_000);   // the sign-in limit for this address refills
  await account.locator('button', { hasText: 'SIGN IN WITH PASSKEY' }).click();
  const underButton = account.locator('.achievements-signin + .achievements-error');
  await underButton.waitFor({ timeout: 10_000 }).catch(() => {});
  expect(/not registered here.*Try another passkey, or create an account/.test(await underButton.textContent().catch(() => '')), `a passkey whose account is gone is explained right under SIGN IN WITH PASSKEY (got "${await account.locator('.achievements-error').allTextContents().catch(() => [])}")`);
  ok('deleting the account signs out and frees the name');

  // 7. Escape closes the panel.
  await page.keyboard.press('Escape');
  expect(await panel.isHidden(), 'Escape closes the Achievements panel');
  ok('Escape closes the panel');

  // 8. A floating window: no backdrop, dragged by its title bar, resized from
  // its corner, remembered across a reload; the trophy button toggles it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel();
  expect(await panel.evaluate((el) => el.classList.contains('is-docked')), 'on a desktop it first opens docked on the right');
  await page.evaluate(() => localStorage.setItem('c64emu.online.dock', JSON.stringify({ on: false, w: 400 })));
  await openApp();
  await openPanel();
  const box = () => panel.boundingBox();
  const before = await box();
  expect(await page.locator('.modal-backdrop:visible').count() === 0, 'it opens without a backdrop over the app');
  await page.mouse.move(before.x + 60, before.y + 15);
  await page.mouse.down(); await page.mouse.move(before.x - 140, before.y + 75, { steps: 4 }); await page.mouse.up();
  const moved = await box();
  expect(Math.round(moved.x - before.x) === -200 && Math.round(moved.y - before.y) === 60, `dragging the title bar moves it (by ${Math.round(moved.x - before.x)},${Math.round(moved.y - before.y)})`);
  const se = await page.locator('#online-window > .float-resize-se').boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down(); await page.mouse.move(se.x + se.width / 2 + 80, se.y + se.height / 2 - 40, { steps: 4 }); await page.mouse.up();
  const sized = await box();
  expect(Math.round(sized.width - moved.width) === 80 && Math.round(sized.height - moved.height) === -40, `the corner resizes it (by ${Math.round(sized.width - moved.width)},${Math.round(sized.height - moved.height)})`);
  await page.click('#btn-online');
  expect(await panel.isHidden(), 'the trophy button closes it again');
  await page.locator('#screen').focus().catch(() => {});
  await page.keyboard.press('Control+Shift+KeyO');
  await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  expect(await panel.isVisible(), 'Ctrl+Shift+O opens it');
  await page.keyboard.press('Control+Shift+KeyO');
  await panel.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  expect(await panel.isHidden(), 'and closes it again');
  await openApp();
  await openPanel();
  const again = await box();
  expect(['x', 'y', 'width', 'height'].every((k) => Math.abs(again[k] - sized[k]) < 1), 'after a reload it opens where it was left, at that size');
  ok('the window floats, drags, resizes and keeps its place');

  // 9b. Docked on the right, on a desktop: full height, the page beside it, and remembered.
  const floating = await box();
  await page.click('#btn-online-dock');
  const docked = await box();
  const vw = 1280, vh = 800;
  expect(Math.round(docked.x + docked.width) === vw && Math.round(docked.y) === 0 && Math.round(docked.height) === vh, `docking puts it full height on the right (got ${JSON.stringify(docked)})`);
  expect(await page.locator('#btn-online-dock').getAttribute('aria-pressed') === 'true', 'and the button says it is docked');
  const mainRight = await page.evaluate(() => document.querySelector('.main-wrap').getBoundingClientRect().right);
  expect(mainRight <= docked.x + 1, `the app makes room beside it (main ends at ${Math.round(mainRight)}, the window starts at ${Math.round(docked.x)})`);
  const corner = await page.evaluate(() => document.querySelector('.panel-hide-target')?.getBoundingClientRect().right ?? null);
  expect(corner === null || corner <= docked.x + 1, `the page's corner controls move out from under it (drop zone ends at ${Math.round(corner)})`);
  const edge = await page.locator('#online-window > .float-resize-w').boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down(); await page.mouse.move(edge.x + edge.width / 2 - 60, edge.y + 200, { steps: 4 }); await page.mouse.up();
  const wider = await box();
  expect(Math.round(wider.width - docked.width) === 60 && Math.round(wider.x + wider.width) === vw, `its left edge widens it (by ${Math.round(wider.width - docked.width)})`);
  await openApp();
  await page.click('#btn-online');
  await panel.waitFor({ state: 'visible' });
  const again2 = await box();
  expect(Math.round(again2.width) === Math.round(wider.width) && Math.round(again2.x + again2.width) === vw, 'after a reload it opens docked, at that width');
  await page.click('#btn-online-dock');
  const back = await box();
  expect(['x', 'y', 'width', 'height'].every((k) => Math.abs(back[k] - floating[k]) < 1), 'floating again puts it back where it was');
  expect(!(await page.evaluate(() => document.body.classList.contains('has-docked-window'))), 'and the page takes its room back');
  ok('on a desktop it docks on the right, beside the page');

  // 9c. Fullscreen splits the screen: the window docks beside the picture, whatever was chosen.
  await page.click('#btn-fullscreen');
  await page.waitForFunction(() => document.body.classList.contains('has-docked-window'), null, { timeout: 5000 }).catch(() => {});
  const split = await box();
  expect(Math.round(split.x + split.width) === vw && Math.round(split.height) === vh, `in fullscreen it docks full height on the right (got ${JSON.stringify(split)})`);
  expect(await page.locator('#btn-online-dock').isHidden(), 'with no dock button, as fullscreen always docks it');
  const fsRects = await page.evaluate(() => ['.c64-monitor', '.crt-bezel', '#btn-fs-close', '#btn-fs-online'].map((s) => document.querySelector(s)?.getBoundingClientRect().right ?? null));
  expect(fsRects.every((r) => r === null || r <= split.x + 1), `the picture and its buttons sit beside it (right edges ${fsRects.map(Math.round)}, the window starts at ${Math.round(split.x)})`);
  await page.click('#btn-fs-close');
  await page.waitForFunction(() => !document.body.classList.contains('fullscreen-mode') && !document.fullscreenElement);
  const after = await box();
  expect(['x', 'y', 'width', 'height'].every((k) => Math.abs(after[k] - floating[k]) < 1), 'leaving fullscreen floats it where it was');
  ok('in fullscreen it docks beside the picture');

  // 9. On a phone it fills the screen, and Back closes it.
  // The window may still be leaving fullscreen: a resize waits for it.
  for (let i = 0; ; i++) {
    try { await page.setViewportSize({ width: 390, height: 780 }); break; } catch (e) { if (i > 10) throw e; await page.waitForTimeout(300); }
  }
  await page.waitForFunction(() => document.getElementById('online-window').classList.contains('is-full'));
  const phone = await box();
  expect(phone.x === 0 && phone.width === 390 && Math.round(phone.height) === 780, `it fills the phone's screen (got ${JSON.stringify(phone)})`);
  expect(await page.locator('#btn-online-dock').isHidden(), 'and has no dock button');
  await page.click('#btn-online-close');
  await openPanel();
  await page.goBack();
  await panel.waitFor({ state: 'hidden', timeout: 5000 });
  expect(page.url().startsWith(BASE), 'the Back button closes the window without leaving the app');
  ok('on a phone it fills the screen and Back closes it');
} finally {
  await browser.close();
  await vite.close();
}
if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - achievements account: ${testNo} browser checks`);
