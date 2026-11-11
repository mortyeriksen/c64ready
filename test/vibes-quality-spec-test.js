// How much the Retro Vibes view draws (src/vibes/vibes-quality.js): the pixel
// ratio its picture gets, the steps a view that cannot keep up takes, and the
// guard that decides when to take one.
//
//   1. The drawing buffer never holds more than the pixel budget, whatever the
//      window and the display's ratio, and never more than the display has.
//   2. A low-power device starts lighter: ratio 1.5 at most, no bloom, no extras.
//   3. Steps only ever take away, the mildest first.
//   4. The guard steps on a sustained low frame rate, not on a hitch, not on a
//      display that runs at 30 Hz, and not after it has seen the view keep up.
import assert from 'node:assert/strict';
import { PIXEL_BUDGET, viewPixelRatio, qualitySteps, QualityGuard } from '../src/vibes/vibes-quality.js';

// ── 1. The pixel budget ──────────────────────────────────────────────────────
{
  const pixels = (w, h, r) => w * h * r * r;
  assert.equal(viewPixelRatio(1280, 800, 2, 2), 2, 'a laptop window inside the budget keeps the display\'s ratio');
  assert.equal(viewPixelRatio(1280, 800, 1, 2), 1, 'the ratio is never above the display\'s own');
  assert.equal(viewPixelRatio(800, 600, 3, 2), 2, 'nor above the cap');
  assert.equal(viewPixelRatio(1728, 1117, 2, 2), 2, 'a 16 inch laptop screen keeps ratio 2');
  assert.equal(viewPixelRatio(1920, 1080, 2, 2), 2, 'and so does a 4K monitor');
  assert.ok(viewPixelRatio(2560, 1440, 2, 2) < 2 && viewPixelRatio(3008, 1692, 2, 2) < viewPixelRatio(2560, 1440, 2, 2), '5K and 6K screens draw at less than ratio 2');
  for (const [w, h, dpr] of [[2560, 1440, 2], [3840, 2160, 2], [1920, 1080, 2], [3008, 1692, 2], [5120, 2880, 1], [1024, 1366, 2]]) {
    const r = viewPixelRatio(w, h, dpr, 2);
    assert.ok(pixels(w, h, r) <= PIXEL_BUDGET * 1.001, `${w}x${h} at ${dpr}x stays inside the budget (${Math.round(pixels(w, h, r))} px)`);
    assert.ok(r <= dpr && r <= 2 && r > 0, `${w}x${h} at ${dpr}x: a ratio between 0 and the smaller of the display's and the cap (${r})`);
  }
  assert.ok(Math.abs(pixels(2560, 1440, viewPixelRatio(2560, 1440, 2, 2)) - PIXEL_BUDGET) < PIXEL_BUDGET * 0.001,
    'a 5K screen gets the whole budget, not more');
  assert.equal(viewPixelRatio(0, 0, 2, 2), 2, 'a view with no size yet takes the capped ratio');
  console.log('ok  - test 1: the drawing buffer stays inside the pixel budget');
}

// ── 2 and 3. The steps ───────────────────────────────────────────────────────
{
  const full = qualitySteps(false), low = qualitySteps(true);
  assert.deepEqual(full[0], { ratio: 2, bloom: true, extras: true }, 'a computer starts with everything');
  assert.equal(low[0].ratio, 1.5, 'a low-power device starts at ratio 1.5');
  assert.ok(!low[0].bloom && !low[0].extras, 'without bloom, smoke or contact shadows');
  for (const [name, steps] of [['computer', full], ['low-power device', low]]) {
    assert.ok(steps.length >= 2, `a ${name} has somewhere to step down to`);
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1], b = steps[i];
      assert.ok(b.ratio <= a.ratio && (!b.bloom || a.bloom) && (!b.extras || a.extras), `${name} step ${i} only takes away`);
      assert.notDeepEqual(a, b, `${name} step ${i} changes something`);
    }
    const last = steps[steps.length - 1];
    assert.deepEqual(last, { ratio: 1, bloom: false, extras: false }, `a ${name}'s last step is the plain picture`);
  }
  const lost = (steps, key) => steps.findIndex((s) => !s[key]);
  assert.ok(full.findIndex((s) => s.ratio < 2) < lost(full, 'bloom') && lost(full, 'bloom') < lost(full, 'extras'),
    'sharpness goes first, then the bloom, then smoke and contact shadows');
  console.log('ok  - test 2: steps start lighter on low-power devices and only take away');
}

// ── 4. The guard ─────────────────────────────────────────────────────────────
{
  const feed = (guard, ms, n) => { let moved = 0; for (let i = 0; i < n; i++) if (guard.frame(ms)) moved++; return moved; };

  const fast = new QualityGuard(5);
  assert.equal(feed(fast, 16.7, 200), 0, 'a view at 60 fps never steps');
  assert.equal(fast.level, 0);
  assert.equal(feed(fast, 80, 200), 0, 'and once it has kept up it is not asked again');

  const thirty = new QualityGuard(5);
  assert.equal(feed(thirty, 33.4, 300), 0, 'a 30 Hz display is not a slow view');

  const slow = new QualityGuard(5);
  assert.equal(feed(slow, 50, 59), 0, 'a sluggish view is watched for a full run before it steps');
  assert.equal(feed(slow, 50, 1), 1, 'then steps once');
  assert.equal(slow.level, 1);
  assert.equal(feed(slow, 16.7, 200), 0, 'a step that fixed it is the last');
  assert.equal(slow.level, 1);

  const hopeless = new QualityGuard(5);
  assert.equal(feed(hopeless, 120, 27), 0, 'a hopeless view still gets its warm-up');
  assert.equal(feed(hopeless, 120, 1), 1, 'and then steps early');
  assert.equal(feed(hopeless, 120, 2000), 3, 'down to the last step and no further');
  assert.equal(hopeless.level, 4);

  const hitch = new QualityGuard(5);
  feed(hitch, 16.7, 30); feed(hitch, 400, 1); feed(hitch, 16.7, 100);
  assert.equal(hitch.level, 0, 'one long frame among fast ones is a hitch');
  const away = new QualityGuard(5);
  feed(away, 16.7, 20); feed(away, 5000, 30);
  assert.equal(away.level, 0, 'gaps as long as a tab switch are not frames');

  const again = new QualityGuard(5);
  feed(again, 50, 60);
  feed(again, 16.7, 200);
  again.reset();
  assert.equal(again.level, 1, 'a new scene keeps the level reached');
  assert.equal(feed(again, 50, 60), 1, 'and is watched again, as scenes differ in cost');

  const one = new QualityGuard(1);
  assert.equal(feed(one, 200, 500), 0, 'with a single step there is nowhere to go');
  console.log('ok  - test 3: the guard steps on a sustained low frame rate only');
}

console.log('\nok - vibes quality: 3 checks');
