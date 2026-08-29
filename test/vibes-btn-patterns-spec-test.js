// Spec test for the VIBES button dot field (the Field part of src/vibes-btn-fx.js).
//
// The contract the painter relies on: every pattern is a pure function of
// (index, count, seconds) that writes a finite point inside the unit cube into a
// caller-owned object, and the show blends between patterns without a jump. The
// painter maps that cube onto the button, so a pattern escaping it would throw
// dots outside the button; a blend discontinuity would show as a visible snap.
import {
  PATTERNS, PATTERN_NAMES, PIXEL_COUNT,
  PATTERN_SECS, MORPH_SECS, SLOT_SECS, CYCLE_SECS,
  sampleField, attachVibesButtonFx, createVibesZoom,
} from '../src/vibes-btn-fx.js';
import { escapeLayerCount, _resetEscapeLayers } from '../src/escape-stack.js';
import { installMiniDom, fire } from './_mini-dom.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const N = PIXEL_COUNT;

// ── The field's shape ────────────────────────────────────────────────────────
expect(N >= 20 && N <= 30, `dot count stays a handful of pixels, got ${N}`);
expect(PATTERNS.length === 10, `ten patterns in the show, got ${PATTERNS.length}`);
expect(
  new Set(PATTERN_NAMES).size === PATTERNS.length,
  'every pattern has its own name (a duplicate means one was pasted over)',
);
expect(
  Math.abs(CYCLE_SECS - SLOT_SECS * PATTERNS.length) < 1e-9,
  'the cycle is every slot once',
);
expect(
  Math.abs(SLOT_SECS - (PATTERN_SECS + MORPH_SECS)) < 1e-9,
  'a slot is one hold plus one morph',
);

// ── Each pattern stays inside the unit cube, finite, for the whole show ──────
// Swept past one full cycle so patterns that drift or ramp with time (the
// tunnel's advancing depth, the ring's breathing tilt) are caught.
const probe = { x: 0, y: 0, z: 0 };
for (const p of PATTERNS) {
  for (let t = 0; t <= CYCLE_SECS + 5; t += 0.05) {
    for (let i = 0; i < N; i++) {
      p.at(probe, i, N, t);
      expect(
        Number.isFinite(probe.x) && Number.isFinite(probe.y) && Number.isFinite(probe.z),
        `${p.name}: dot ${i} at t=${t.toFixed(2)} is not finite`,
      );
      expect(
        Math.abs(probe.x) <= 1 && Math.abs(probe.y) <= 1 && Math.abs(probe.z) <= 1,
        `${p.name}: dot ${i} at t=${t.toFixed(2)} leaves the unit cube ` +
        `(${probe.x.toFixed(3)}, ${probe.y.toFixed(3)}, ${probe.z.toFixed(3)})`,
      );
    }
  }
}

// A pattern writes into the caller's object and nothing else — that is what lets
// sampleField run every frame without allocating.
for (const p of PATTERNS) {
  const only = { x: 0, y: 0, z: 0 };
  expect(p.at(only, 0, N, 1.5) === undefined, `${p.name}: at() returns nothing`);
  expect(
    Object.keys(only).length === 3,
    `${p.name}: at() writes only x/y/z, found ${Object.keys(only).join()}`,
  );
}

// ── No dead patterns, no twins ───────────────────────────────────────────────
function snapshot(p, t) {
  const out = [];
  for (let i = 0; i < N; i++) { p.at(probe, i, N, t); out.push(probe.x, probe.y, probe.z); }
  return out;
}
const spread = (a, b) => {
  let sum = 0;
  for (let k = 0; k < a.length; k++) sum += Math.abs(a[k] - b[k]);
  return sum / a.length;
};

for (const p of PATTERNS) {
  expect(
    spread(snapshot(p, 1.0), snapshot(p, 1.4)) > 0.02,
    `${p.name}: the dots must actually move over 0.4 s`,
  );
}
for (let a = 0; a < PATTERNS.length; a++) {
  for (let b = a + 1; b < PATTERNS.length; b++) {
    expect(
      spread(snapshot(PATTERNS[a], 2.0), snapshot(PATTERNS[b], 2.0)) > 0.05,
      `${PATTERN_NAMES[a]} and ${PATTERN_NAMES[b]} are near-identical fields`,
    );
  }
}

// ── sampleField ──────────────────────────────────────────────────────────────
const xs = new Float64Array(N + 1);
const ys = new Float64Array(N + 1);
const zs = new Float64Array(N + 1);
const field = (t, n = N) => {
  sampleField(t, xs, ys, zs, n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(xs[i], ys[i], zs[i]);
  return out;
};

// Same timestamp, same field: the whole animation is reproducible from its clock.
const twiceA = field(7.3), twiceB = field(7.3);
expect(twiceA.every((v, k) => v === twiceB[k]), 'sampleField is deterministic in t');

// Negative time is clamped to the start rather than running the show backwards.
expect(field(-3).every((v, k) => v === field(0)[k]), 't < 0 samples the show at 0');

// Only the first n slots are touched, so a caller may keep longer arrays.
xs[N] = ys[N] = zs[N] = 42;
sampleField(2.2, xs, ys, zs, N);
expect(xs[N] === 42 && ys[N] === 42 && zs[N] === 42, 'sampleField writes only n dots');

// A smaller count still produces a valid field (the lattice patterns fall back
// to a ragged last row rather than breaking).
for (const t of [1, PATTERN_SECS + 0.5, SLOT_SECS * 8 + 1]) {
  const small = field(t, 9);
  expect(
    small.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    `a 9-dot field at t=${t} stays finite and inside the cube`,
  );
}

// During the hold window the field is exactly the slot's pattern — no residue
// from the previous blend.
for (let slot = 0; slot < PATTERNS.length; slot++) {
  const t = slot * SLOT_SECS + PATTERN_SECS * 0.5;
  const pure = snapshot(PATTERNS[slot], t);
  expect(
    field(t).every((v, k) => Math.abs(v - pure[k]) < 1e-12),
    `slot ${slot} (${PATTERN_NAMES[slot]}) holds its own pattern unblended`,
  );
}

// The morph starts on A and finishes on B, so each slot hands over cleanly.
for (let slot = 0; slot < PATTERNS.length; slot++) {
  const base = slot * SLOT_SECS;
  const a = PATTERNS[slot];
  const b = PATTERNS[(slot + 1) % PATTERNS.length];

  const tStart = base + PATTERN_SECS;
  const atStart = snapshot(a, tStart);
  expect(
    field(tStart).every((v, k) => Math.abs(v - atStart[k]) < 1e-12),
    `slot ${slot}: the morph opens on ${a.name}`,
  );

  const tEnd = base + SLOT_SECS - 1e-9;
  const atEnd = snapshot(b, tEnd);
  expect(
    field(tEnd).every((v, k) => Math.abs(v - atEnd[k]) < 1e-6),
    `slot ${slot}: the morph lands on ${b.name}`,
  );
}

// Crossing a boundary must not jump. Sampled either side of both boundaries in
// every slot: the hold→morph handover and the slot→slot wrap. A broken blend
// weight would show up as a step of order 1, so the tolerance only has to sit
// below that while allowing for the dots' own motion across 2 ms.
for (let slot = 0; slot < PATTERNS.length; slot++) {
  const base = slot * SLOT_SECS;
  for (const [where, t] of [['hold→morph', base + PATTERN_SECS], ['slot wrap', base + SLOT_SECS]]) {
    const before = field(t - 1e-3);
    const after = field(t + 1e-3);
    let worst = 0;
    for (let k = 0; k < before.length; k++) worst = Math.max(worst, Math.abs(before[k] - after[k]));
    expect(worst < 0.05, `slot ${slot} ${where} at t=${t.toFixed(2)} snaps by ${worst.toFixed(3)}`);
  }
}

// ── The painter on the button ────────────────────────────────────────────────
// A stand-in DOM (test/_mini-dom.js) with a recording 2D context: the field
// paints one square per pixel, throttles to its frame rate, parks itself when
// nobody can see it and wakes on every path the page offers.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
{
  const dom = installMiniDom({ innerWidth: 1400, innerHeight: 900, devicePixelRatio: 2 });
  const { document, media } = dom;
  _resetEscapeLayers();

  expect(attachVibesButtonFx(null) === null, 'no host: nothing to draw on');
  document._no2d = true;
  const dead = document.createElement('button');
  expect(attachVibesButtonFx(dead) === null && dead.children.length === 0, 'no 2D context: no field, and no canvas left behind');
  document._no2d = false;

  const btn = document.createElement('button');
  btn.id = 'btn-vibes';
  btn.innerHTML = '<svg><linearGradient id="vibesSun"/></svg><span>VIBES</span>';
  btn._rect = { left: 10, top: 20, width: 120, height: 40 };
  document.body.appendChild(btn);
  const fx = attachVibesButtonFx(btn);
  const canvas = btn.querySelector('canvas.vibes-fx');
  expect(canvas && btn.firstElementChild === canvas && canvas.getAttribute('aria-hidden') === 'true', 'the canvas goes in front of the label, hidden from readers');
  expect(canvas.width === 240 && canvas.height === 80, `the backing store is the button in device pixels (${canvas.width}x${canvas.height})`);
  expect(dom.pendingFrames === 1, 'the loop starts itself');
  const ctx = canvas.getContext('2d');
  const dots = () => ctx.calls.filter(c => c[0] === 'fillRect').length;
  dom.flushFrames(1000);
  expect(dots() === PIXEL_COUNT, `one square per pixel per frame (${dots()})`);
  expect(ctx.calls[0][0] === 'clearRect' && ctx.fillStyle && ctx.globalAlpha === 1, 'cleared first, alpha restored after');
  for (const c of ctx.calls) if (c[0] === 'fillRect') expect(c[3] >= 1 && c[3] === c[4], 'every dot is a square of at least one device pixel');

  dom.flushFrames(1010);
  expect(dots() === PIXEL_COUNT && dom.pendingFrames === 1, 'a frame inside the 30 fps window is skipped but the loop goes on');
  dom.flushFrames(1040);
  expect(dots() === 2 * PIXEL_COUNT, 'the next window paints');

  fx.stop();
  expect(dom.pendingFrames === 0, 'stop parks the loop');
  fx.start();
  expect(dom.pendingFrames === 1, 'start runs it again');

  document.hidden = true;
  dom.flushFrames(2000);
  expect(dom.pendingFrames === 0, 'a hidden tab ends the loop');
  fire(document, 'visibilitychange');
  expect(dom.pendingFrames === 0, 'still hidden: stays parked');
  document.hidden = false;
  fire(document, 'visibilitychange');
  expect(dom.pendingFrames === 1, 'visible again: back on');

  document.body.classList.add('splash-open');
  dom.flushFrames(3000);
  expect(dom.pendingFrames === 0, 'under the splash the loop parks');
  document.body.classList.remove('splash-open');
  dom.fireWindow('c64-splash-dismissed');
  expect(dom.pendingFrames === 1, 'dismissing the splash resumes it');

  const io = dom.IntersectionObserver.all.find(o => o.targets.includes(btn));
  io.fire([{ isIntersecting: false }]);
  expect(dom.pendingFrames === 0, 'scrolled off screen: paused');
  io.fire([{ isIntersecting: true }]);
  expect(dom.pendingFrames === 1, 'back on screen: resumed');

  const ro = dom.ResizeObserver.all.find(o => o.targets.includes(btn));
  btn._rect.width = 150;
  ro.fire([]);
  expect(canvas.width === 300, 'a resize while running re-sizes the backing store');
  fx.stop();
  btn._rect.width = 120;
  ro.fire([]);
  expect(dom.pendingFrames === 0 && canvas.width === 300, 'a resize while stopped starts nothing');
  fx.start();

  fx.setEnabled(false);
  expect(canvas.hidden && dom.pendingFrames === 0 && ctx.calls.at(-1)[0] === 'clearRect', 'disabled: hidden, parked, wiped');
  ro.fire([]);
  fx.setEnabled(true);
  expect(!canvas.hidden && dom.pendingFrames === 1, 're-enabled: running again');

  fx.stop();
  btn._rect.width = 0;
  fx.start();
  expect(dom.pendingFrames === 0, 'a host with no layout yet cannot start');
  btn._rect.width = 120;
  ro.fire([]);
  expect(dom.pendingFrames === 1, 'the observer retries once there is a box');

  fx.stop();
  btn.style.zoom = 3;
  canvas._rect = { left: 0, top: 0, width: 360, height: 120 };
  const before = dots();
  fx.setResolution(3);
  expect(canvas.width === 720 && canvas.height === 240, `under zoom the painted rect sets the store (${canvas.width}x${canvas.height})`);
  expect(dots() === before + PIXEL_COUNT, 'and a still frame is painted, since no loop will');
  fx.setResolution(3);
  fx.setResolution(0);
  fx.remeasure();
  btn.style.zoom = '';

  media.matches = true;
  const n0 = dots();
  fx.start();
  expect(dom.pendingFrames === 0 && dots() === n0 + PIXEL_COUNT, 'reduced motion: one still frame, no loop');
  ro.fire([]);
  expect(dots() === n0 + 2 * PIXEL_COUNT, 'a resize under reduced motion repaints the still');
  media.fire();
  expect(dots() === n0 + 3 * PIXEL_COUNT, 'so does the preference changing');
  media.matches = false;
  media.fire();
  expect(dom.pendingFrames === 1, 'motion allowed again: the loop returns');
  fx.setEnabled(false);
  media.fire();
  fx.setEnabled(true);

  // ── The zoom ──
  const home = document.createElement('div');
  document.body.appendChild(home);
  home.focus();
  const modal = document.createElement('div');
  modal.hidden = true;
  const stage = document.createElement('div');
  stage._rect = { left: 100, top: 100, width: 0, height: 0 };
  const closeBtn = document.createElement('button');
  modal.appendChild(stage);
  modal.appendChild(closeBtn);
  document.body.appendChild(modal);
  expect(createVibesZoom(null, modal, stage) === null && createVibesZoom(btn, null, stage) === null && createVibesZoom(btn, modal, null) === null,
    'the zoom needs its three parts');
  const zoom = createVibesZoom(btn, modal, stage, closeBtn);

  const viewer = document.createElement('div');
  viewer.id = 'model-viewer-overlay';
  viewer.hidden = false;
  document.body.appendChild(viewer);
  const blockedModal = document.createElement('div');
  blockedModal.hidden = true;
  const blockedStage = document.createElement('div');
  blockedModal.appendChild(blockedStage);
  createVibesZoom(btn, blockedModal, blockedStage, null).open();
  expect(blockedModal.hidden, 'with the model viewer open the zoom stays shut');
  viewer.remove();

  btn._rect.width = 0;
  zoom.open();
  expect(modal.hidden && stage.children.length === 1, 'a button without a box: built, but not shown');
  btn._rect.width = 120;
  zoom.open();
  const clone = stage.firstElementChild;
  expect(!modal.hidden && zoom.isOpen(), 'open shows the modal');
  expect(clone.id === '' && clone.innerHTML.includes('vibesSunZoom') && clone.querySelectorAll('canvas').length === 1,
    'the clone drops the id, renames the gradient and gets a live field of its own');
  expect(stage.style.width === '1200px' && stage.style.height === '400px', `the stage carries the 10x footprint (${stage.style.width} x ${stage.style.height})`);
  expect(!clone.classList.contains('is-instant') && clone.style.transform === 'translate(-90px, -80px) scale(1)',
    `the flight starts on the live button (${clone.style.transform})`);
  dom.flushFrames(5000);
  expect(clone.style.transform === 'translate(0px, 0px) scale(10)', `and lands at the zoom (${clone.style.transform})`);
  expect(document.activeElement === closeBtn && escapeLayerCount() === 1, 'focus goes to the close button and Escape is claimed');
  zoom.open();                                  // already open: nothing happens

  let realClicks = 0;
  btn.addEventListener('click', () => realClicks++);
  clone.click();
  expect(realClicks === 1, 'a click on the clone reaches the live button');
  expect(zoom.isOpen() && modal.style.opacity === '0' && escapeLayerCount() === 0, 'and starts the flight home');
  zoom.close();                                 // already closing: ignored
  zoom.toggle();
  expect(zoom.isOpen() && escapeLayerCount() === 1 && modal.style.opacity === '1', 'toggling mid-flight turns it back around');
  await sleep(450);
  expect(!modal.hidden, 'the abandoned flight home lands on nothing');

  globalThis.innerWidth = 600;
  dom.fireWindow('resize');
  expect(stage.style.width === '504px', `a narrower window caps the zoom to what fits (${stage.style.width})`);
  globalThis.innerWidth = 1400;

  fire(modal, 'click', { target: stage });
  expect(escapeLayerCount() === 1, 'a click inside the zoom is not a dismissal');
  fire(modal, 'click');
  expect(escapeLayerCount() === 0 && modal.style.opacity === '0', 'a click on the backdrop closes');
  await sleep(450);
  expect(modal.hidden && !zoom.isOpen() && document.activeElement === home, 'the flight home lands, the modal hides, focus returns');

  media.matches = true;
  zoom.open();
  expect(!modal.hidden && modal.classList.contains('is-instant') && clone.style.transform === 'translate(0px, 0px) scale(10)',
    'reduced motion: straight to the zoom');
  zoom.close();
  expect(modal.hidden, 'and straight back');
  media.matches = false;

  zoom.open();
  fire(closeBtn, 'click');
  expect(escapeLayerCount() === 0, 'the ✕ closes');
  await sleep(450);
  expect(modal.hidden, 'and lands');
  zoom.setFxEnabled(false);
  expect(clone.querySelector('canvas').hidden === true, 'the zoom follows the Options switch off');
  zoom.setFxEnabled(true);
  expect(clone.querySelector('canvas').hidden === false, 'and on');

  console.log('ok  - the button field paints, parks and wakes; the zoom flies out and home (stand-in DOM)');
}

console.log('vibes-btn-patterns spec: PASS');
