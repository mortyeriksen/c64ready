// Spec tests for when the app asks the browser for a newer service worker (src/sw-update-checks.js):
// at start, on its timer, and each time the app comes back to the front (focus, pageshow, the page
// shown again, back online), as an installed web app in the macOS Dock gives no other cue. Checks
// close together are run once, and none while offline.

import { watchForUpdates } from '../src/sw-update-checks.js';

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

/** A window and a document that record their listeners and timer, and a registration that counts updates. */
function world() {
  const on = {}, docOn = {};
  let timer = null, every = 0;
  const w = {
    clock: 0, isOnline: true, updates: 0,
    win: { addEventListener: (t, f) => { on[t] = f; }, setInterval: (f, ms) => { timer = f; every = ms; } },
    doc: { visibilityState: 'visible', addEventListener: (t, f) => { docOn[t] = f; } },
    fire: (t) => on[t]?.(),
    show: (state) => { w.doc.visibilityState = state; docOn.visibilitychange?.(); },
    tick: () => timer?.(),
    get every() { return every; },
  };
  w.registration = { update: () => { w.updates++; return Promise.resolve(); } };
  w.start = (o = {}) => watchForUpdates(w.registration, { win: w.win, doc: w.doc, now: () => w.clock, online: () => w.isOnline, ...o });
  return w;
}

// 1. At start: one check, before any cue.
{
  const w = world();
  w.start();
  expect(w.updates === 1, `a check as the app starts (got ${w.updates})`);
  ok('a check at start');
}

// 2. Each cue checks once the gap since the last has passed.
{
  for (const [cue, run] of [['focus', (w) => w.fire('focus')], ['pageshow', (w) => w.fire('pageshow')], ['online', (w) => w.fire('online')],
    ['the page shown again', (w) => w.show('visible')], ['the timer', (w) => w.tick()]]) {
    const w = world();
    w.start({ gap: 60_000 });
    w.clock = 61_000; run(w);
    expect(w.updates === 2, `${cue} checks (got ${w.updates - 1} after start)`);
  }
  const h = world();
  h.start(); h.clock = 61_000; h.show('hidden');
  expect(h.updates === 1, 'the page going out of sight does not');
  ok('focus, pageshow, back online, shown again and the timer each check');
}

// 3. Checks close together are one; the timer runs at the interval given.
{
  const w = world();
  w.start({ gap: 60_000, every: 600_000 });
  w.clock = 1_000; w.fire('focus'); w.fire('pageshow'); w.show('visible');
  expect(w.updates === 1, `cues within the gap of the last check are skipped (got ${w.updates})`);
  w.clock = 60_000; w.fire('focus');
  expect(w.updates === 2, 'and the next one after it checks');
  expect(w.every === 600_000, `the timer runs every ${w.every} ms as asked`);
  ok('close checks are one');
}

// 4. Offline: no check, and the first cue back online does.
{
  const w = world();
  w.isOnline = false;
  w.start();
  w.clock = 120_000; w.fire('focus');
  expect(w.updates === 0, 'none while offline');
  w.isOnline = true; w.fire('online');
  expect(w.updates === 1, 'and one as the app is back online');
  ok('offline');
}

// 5. A failing update (offline after all, the worker gone) is no error.
{
  const w = world();
  w.registration.update = () => Promise.reject(new Error('network'));
  let threw = false;
  try { w.start(); } catch { threw = true; }
  const sync = world();
  sync.registration.update = () => { throw new Error('gone'); };
  try { sync.start(); } catch { threw = true; }
  await new Promise((r) => setTimeout(r, 10));
  expect(!threw, 'a rejected or throwing update is swallowed');
  ok('a failed check is no error');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - service worker update checks: ${testNo} checks`);
