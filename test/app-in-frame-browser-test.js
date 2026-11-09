// The real app inside a frame, such as the itch.io embed. The "Install C64
// READY." card shows when the app is the page (here its manual-instructions
// form, as headless Chromium offers no install) and never in a frame, where the
// browser would install the page around it. RECORD, which captures the screen,
// says it is not supported in a frame that does not allow screen capture.
//
// Needs Playwright's Chromium; without it it reports a SKIP.
import http from 'node:http';
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

const origin = `http://127.0.0.1:${port}`;
const COI = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Type': 'text/html' };
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.pauseDemo', 'off');
  });
  return ctx;
}
// The page around it, on another origin (another port), as itch.io's is: served by a
// server of its own, since Chrome keeps a page it did not fetch from framing a local address.
const framePort = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const frameServer = http.createServer((q, res) => { res.writeHead(200, COI);
  res.end(`<!doctype html><body style="margin:0"><iframe src="${origin}/" style="width:1280px;height:900px;border:0" allow="cross-origin-isolated"></iframe></body>`); });
await new Promise(r => frameServer.listen(framePort, '127.0.0.1', r));
// The manual card comes 2.5 s after load: wait past it.
const WAIT_MS = 5000;

try {
  // 1. The app as the page: the card shows.
  {
    const ctx = await context();
    const page = await ctx.newPage();
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(WAIT_MS);
    expect(await page.locator('.pwa-install').count() === 1, 'the install card shows when the app is the page');
    ok('the card shows for the app on its own');
    expect(/^Record the browser window/.test(await page.locator('#btn-record').getAttribute('data-tip')), 'RECORD offers to record');
    ok('RECORD on its own');
    await ctx.close();
  }
  // 2. The app in a frame: no card.
  {
    const ctx = await context();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${framePort}/`, { waitUntil: 'networkidle' });
    const app = page.frames().find(f => f !== page.mainFrame());
    await app.waitForSelector('#btn-power', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(WAIT_MS);
    expect(await app.evaluate(() => window.self !== window.top), 'the app runs in a frame');
    expect(await app.locator('.pwa-install').count() === 0, 'no install card inside a frame');
    ok('no card inside a frame');
    expect(await app.locator('#btn-record').getAttribute('data-tip') === 'Recording not supported', 'RECORD says it is not supported where screen capture is not allowed');
    expect(await app.locator('#btn-record').isDisabled(), 'and stays disabled');
    ok('RECORD in a frame without screen capture');
    await ctx.close();
  }
} finally {
  await browser.close();
  await vite.close();
  frameServer.close();
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - the app in a frame: ${testNo} checks`);
