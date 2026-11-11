// Retro Vibes in the real app, as one loop with the emulator (src/main.js
// rafLoop, src/vibes/retrovibes.js):
//
//   1. The view draws once per display frame, from the page's tick, after the
//      machine's frames of that tick.
//   2. Its screen texture is uploaded when the machine has drawn a new
//      picture, not on every display frame, and not while the machine is paused.
//   3. The page behind the view is not drawn while the view covers it, and is
//      drawn again when the view closes.
//   4. With the machine off the view still draws, and closing it stops the tick.
//   5. The idle spin turns at the same speed whatever the display's rate.
//   6. The page under the view holds its animations while it is covered.
//   7. The drawing buffer stays inside the pixel budget, and a view that
//      cannot keep up steps its quality down.
//   8. A low-power device gets the lean pipeline: one scene draw into one
//      multisampled buffer and one pass onto the canvas, at ratio 1.5 at most.
//
// Needs Playwright's Chromium with WebGL, and the ROMs; without them it reports
// a SKIP.
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readAsset, missingNote } from './external-assets.js';

let browser;
try { const { chromium } = await import('playwright'); browser = await chromium.launch(); } catch {}
if (!browser) { console.log('# SKIP Playwright Chromium is unavailable'); process.exit(0); }
const roms = {};
for (const [asset, key] of [['kernal', 'kernal'], ['basic', 'basic'], ['chargen', 'charRom']]) {
  const bytes = readAsset(asset);
  if (!bytes) { console.log(`# SKIP ${missingNote(asset)}`); await browser.close(); process.exit(0); }
  roms[`c64emu.rom.${key}`] = bytes.toString('base64');
}
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
  await context.addInitScript((roms) => {
    for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.pauseDemo', 'off');
    // Every draw of the machine's picture onto the page's own canvas.
    window.pageDraws = 0;
    const count = (proto, name) => {
      if (!proto) return;
      const real = proto[name];
      proto[name] = function (...args) { if (this.canvas?.id === 'screen') window.pageDraws++; return real.apply(this, args); };
    };
    count(globalThis.WebGLRenderingContext?.prototype, 'texSubImage2D');
    count(globalThis.WebGL2RenderingContext?.prototype, 'texSubImage2D');
    count(globalThis.CanvasRenderingContext2D?.prototype, 'putImageData');
  }, roms);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  if (await page.locator('#setup-modal').isVisible()) await page.click('#btn-setup-later');
  if (await page.evaluate(() => document.querySelector('#btn-reset').disabled)) await page.click('#btn-power');
  await page.waitForFunction(() => !document.querySelector('#btn-reset').disabled);

  await page.click('#btn-vibes');
  await page.waitForFunction(() => window.modelViewer?.isOpen(), null, { timeout: 15000 });
  const supported = await page.evaluate(() => window.modelViewer.supported);
  if (!supported) {
    console.log('# SKIP this browser gives the 3D view no WebGL');
  } else {
    // The view is ready once the machine it paused for the opening runs again.
    await page.waitForFunction(() => window.modelViewer._modelLoaded && !window.modelViewer._busy, null, { timeout: 60000 });
    // What happens in each tick: machine frames (E) and view frames (V), in order.
    await page.evaluate(() => {
      const log = window.vibesLog = [];
      const mv = window.modelViewer, m = window.machine;
      const run = m.runFrame;
      m.runFrame = function () { log.push('E'); return run.call(this); };
      const update = mv._updateScreen;
      mv._updateScreen = function (time) { log.push('V'); return update.call(this, time); };
      const tick = () => { log.push('|'); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const sample = (ms) => page.evaluate(async (ms) => {
      const mv = window.modelViewer, log = window.vibesLog;
      log.length = 0;
      const uploads = mv._screenTex.version, draws = window.pageDraws;
      await new Promise((r) => setTimeout(r, ms));
      const frames = log.join('').split('|').slice(1, -1);   // whole display frames only
      return {
        display: frames.length,
        machine: frames.join('').split('E').length - 1,
        view: frames.join('').split('V').length - 1,
        twice: frames.filter((f) => f.split('V').length > 2).length,
        late: frames.filter((f) => /V.*E/.test(f)).length,
        uploads: mv._screenTex.version - uploads,
        pageDraws: window.pageDraws - draws,
      };
    }, ms);

    // 1. One view frame per display frame, after that tick's machine frames.
    // A software rasteriser draws the scene a few times a second, so the counts
    // asked for are small.
    const open = await sample(2000);
    expect(open.display > 3 && open.machine > 10, `the machine and the display ran (${JSON.stringify(open)})`);
    expect(Math.abs(open.view - open.display) <= 2, `the view draws once per display frame (${JSON.stringify(open)})`);
    expect(open.twice === 0, `never twice in one (${JSON.stringify(open)})`);
    expect(open.late === 0, `and never before that tick's machine frame (${JSON.stringify(open)})`);
    ok('the view draws from the page tick, after the machine');

    // 2. The screen texture follows the machine's pictures.
    expect(open.uploads > 0 && open.uploads <= open.machine + 1, `an upload per new picture at most (${JSON.stringify(open)})`);
    // The view covers the page, so PAUSE is pressed from script.
    const pause = () => page.evaluate(() => document.querySelector('#btn-pause').click());
    await pause();
    const paused = await sample(1200);
    expect(paused.machine === 0 && paused.view > 2, `paused, the view still draws (${JSON.stringify(paused)})`);
    expect(paused.uploads === 0, `and uploads nothing, the picture being the same (${JSON.stringify(paused)})`);
    await pause();
    const resumed = await sample(1200);
    expect(resumed.uploads > 0, `running again, it uploads again (${JSON.stringify(resumed)})`);
    ok('the screen texture is uploaded only for a new picture');

    // 5. The idle spin: a second of it, at 60 and at 120 frames a second.
    const spin = await page.evaluate(() => {
      const mv = window.modelViewer, c = mv.controls;
      const was = { hold: mv._holdRender, rotate: c.autoRotate, tween: mv._camTween };
      mv._holdRender = true; c.autoRotate = true; mv._camTween = null;   // turn the camera, draw nothing
      let t = 1e7;
      const second = (hz) => {
        for (let i = 0; i < hz; i++) { t += 1000 / hz; mv._loop(t); }   // up to speed
        const from = c.getAzimuthalAngle();
        for (let i = 0; i < hz; i++) { t += 1000 / hz; mv._loop(t); }
        let turned = c.getAzimuthalAngle() - from;
        if (turned > Math.PI) turned -= 2 * Math.PI; else if (turned < -Math.PI) turned += 2 * Math.PI;
        return turned;
      };
      const at60 = second(60), at120 = second(120);
      mv._holdRender = was.hold; c.autoRotate = was.rotate; mv._camTween = was.tween;
      return { at60, at120 };
    });
    expect(Math.abs(spin.at60) > 0.01, `the idle spin turns the camera (${JSON.stringify(spin)})`);
    expect(Math.abs(spin.at120 - spin.at60) < Math.abs(spin.at60) * 0.05, `as far in a second at 120 Hz as at 60 Hz (${JSON.stringify(spin)})`);
    ok('the idle spin keeps its speed on a faster display');

    // 6. The page's animations hold still under the view, the view's own run.
    const probes = () => page.evaluate(() => {
      const probe = (parent) => {
        const el = document.createElement('i');
        el.style.animation = 'vibes-test-probe 1s linear infinite';
        parent.append(el);
        const state = getComputedStyle(el).animationPlayState;
        el.remove();
        return state;
      };
      return { cls: document.body.classList.contains('vibes-open'), page: probe(document.body), view: probe(document.querySelector('#model-viewer-overlay')) };
    });
    const covered = await probes();

    // 3. The page under the view is left alone, and drawn again on close.
    expect(open.pageDraws === 0 && resumed.pageDraws === 0, `the covered page is not drawn (${open.pageDraws}, ${resumed.pageDraws})`);
    const before = await page.evaluate(() => window.pageDraws);
    await page.evaluate(() => window.modelViewer.close());
    await page.waitForFunction((n) => window.pageDraws > n, before, { timeout: 5000 }).catch(() => {});
    expect(await page.evaluate((n) => window.pageDraws > n, before), 'closing the view draws the page again');
    await page.waitForTimeout(1000);   // the machine resumes once the close has settled
    const closed = await page.evaluate(async () => {
      const draws = window.pageDraws; window.vibesLog.length = 0;
      await new Promise((r) => setTimeout(r, 600));
      return { pageDraws: window.pageDraws - draws, view: window.vibesLog.filter((x) => x === 'V').length, machine: window.vibesLog.filter((x) => x === 'E').length };
    });
    expect(closed.machine > 10 && closed.pageDraws > 10, `with the view closed the page shows the machine (${JSON.stringify(closed)})`);
    expect(closed.view === 0, `and the view no longer draws (${JSON.stringify(closed)})`);
    ok('the covered page is not drawn, and comes back on close');
    const uncovered = await probes();
    expect(covered.cls && covered.page === 'paused' && covered.view === 'running', `covered, the page's animations are paused and the view's run (${JSON.stringify(covered)})`);
    expect(!uncovered.cls && uncovered.page === 'running', `with the view closed the page's animations run again (${JSON.stringify(uncovered)})`);
    ok('the page under the view holds its animations');

    // 4. Machine off: the view keeps the tick, and gives it up on close.
    await page.click('#btn-power');
    await page.waitForFunction(() => document.querySelector('#btn-reset').disabled);
    await page.click('#btn-vibes');
    await page.waitForFunction(() => window.modelViewer.isOpen() && window.modelViewer._modelLoaded, null, { timeout: 60000 });
    const off = await page.evaluate(async () => {
      const mv = window.modelViewer;
      let frames = 0;
      const update = mv._updateScreen;
      mv._updateScreen = function (time) { frames++; return update.call(this, time); };
      await new Promise((r) => setTimeout(r, 1500));
      const whileOpen = frames;
      mv.close();
      await new Promise((r) => setTimeout(r, 300));
      frames = 0;
      await new Promise((r) => setTimeout(r, 300));
      return { whileOpen, afterClose: frames };
    });
    expect(off.whileOpen > 2, `with the machine off the view still draws (${JSON.stringify(off)})`);
    expect(off.afterClose === 0, `and stops when it closes (${JSON.stringify(off)})`);
    ok('the view draws over a powered-off machine');

    // The view opened in a browser context of its own, machine off, as far as its GL being up.
    const openView = async (options) => {
      const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
      await context.addInitScript(() => {
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); localStorage.setItem('c64emu.pauseDemo', 'off');
      });
      const p = await context.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      await p.evaluate(() => { const later = document.querySelector('#btn-setup-later'); if (later?.offsetParent) later.click(); document.querySelector('#btn-vibes').click(); });
      await p.waitForFunction(() => window.modelViewer?.isOpen() && window.modelViewer._glReady, null, { timeout: 15000 });
      return { context, p };
    };
    const size = (p) => p.evaluate(() => {
      const mv = window.modelViewer, c = mv.renderer.domElement;
      return { ratio: mv.renderer.getPixelRatio(), pixels: c.width * c.height, composer: mv._composer?.readBuffer ? mv._composer.readBuffer.width * mv._composer.readBuffer.height : 0,
        passes: (mv._composer?.passes ?? []).map((x) => x.constructor.name), bloom: !!mv._bloomPass?.enabled };
    });

    // 7. The pixel budget and the guard, on displays with two device pixels a pixel.
    {
      const { context, p } = await openView({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
      const small = await size(p);
      expect(small.ratio === 2 && small.pixels === 2000 * 1400, `a window inside the budget draws at the display's ratio (${JSON.stringify(small)})`);
      expect(small.passes.includes('SMAAPass') && small.passes.includes('OutputPass'), `a computer keeps the full pipeline (${small.passes})`);
      // A view that cannot keep up: frames of 120 ms, as the loop reports them.
      const stepped = await p.evaluate(() => {
        const mv = window.modelViewer, seen = [];
        for (let i = 0; i < 400; i++) { mv._noteFrame(120); seen.push(mv.renderer.getPixelRatio()); }
        return { ratios: [...new Set(seen)], bloom: !!mv._bloomPass?.enabled, pixels: mv.renderer.domElement.width * mv.renderer.domElement.height };
      });
      expect(stepped.ratios.join() === '2,1.5,1', `a slow view steps its sharpness down (${JSON.stringify(stepped)})`);
      expect(stepped.bloom === false && stepped.pixels === 1000 * 700, `then drops the bloom (${JSON.stringify(stepped)})`);
      await p.evaluate(() => window.modelViewer.close());
      await context.close();

      const huge = await openView({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 2 });
      const big = await size(huge.p);
      const BUDGET = 3840 * 2160;
      expect(big.pixels <= BUDGET * 1.01 && big.pixels > BUDGET * 0.9, `a 5K window draws the budget, not four times it (${JSON.stringify(big)})`);
      expect(big.composer <= BUDGET * 1.01, `and so do the post-processing buffers (${JSON.stringify(big)})`);
      await huge.p.evaluate(() => window.modelViewer.close());
      await huge.context.close();
      ok('the drawing buffer keeps to the pixel budget, and a slow view steps down');
    }

    // 8. A phone: the lean pipeline.
    {
      const { context: phone, p } = await openView({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const lean = await p.evaluate(() => {
        const mv = window.modelViewer, c = mv._composer;
        return { coarse: matchMedia('(pointer: coarse)').matches, ratio: mv.renderer.getPixelRatio(), passes: (c?.passes ?? []).map((x) => x.constructor.name),
          samples: c?.readBuffer?.samples ?? -1, bloom: !!mv._bloomPass?.enabled, grade: !!mv._gradePass?.uniforms?.uVignette };
      });
      expect(lean.coarse, 'the test device has a coarse pointer');
      expect(lean.ratio <= 1.5, `a low-power device draws at ratio 1.5 at most (${lean.ratio})`);
      expect(lean.passes.length === 1 && !lean.passes.includes('SMAAPass') && !lean.passes.includes('OutputPass'), `one pass onto the canvas (${lean.passes})`);
      expect(lean.samples === 4 && !lean.bloom && lean.grade, `from one multisampled buffer, graded (${JSON.stringify(lean)})`);
      await p.evaluate(() => window.modelViewer.close());
      await phone.close();
      ok('a low-power device gets the lean pipeline');
    }
  }

  expect(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  ok('no page errors');
} finally {
  await browser.close();
  await vite.close();
}

console.log(failing === 0 ? `\nok - vibes frame loop: ${testNo} checks` : `\nFAILED - vibes frame loop: ${failing} of ${testNo} checks`);
process.exit(failing === 0 ? 0 : 1);
