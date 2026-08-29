// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/splash.js — the first-visit welcome overlay. Whether it shows at all is
// decided pre-paint by index.html's inline script (a hand-kept mirror of
// src/splash-policy.js) via body.splash-open; this module only wires an OPEN
// overlay:
//
//   ▶ POWER ON  → remember dismissal, boot through the app's own POWER
//                 button so the click doubles as the user gesture that
//                 unlocks the AudioContext, and fade the splash out over the
//                 booting machine.
//   Explore ›   → a plain link to /docs/ (no dismissal — coming back from the
//                 docs shows the splash again, since they never entered).
//   Esc         → remember dismissal and fade out onto the powered-off app.
//
// Both paths set SPLASH_SEEN_KEY, making the splash first-visit-only
// (bouncing without interacting leaves it unset, so it shows again).
// Dismissal fires a 'c64-splash-dismissed' window event; main.js listens to
// run what the splash deferred while it covered the screen (the attract
// demo's lazy three.js import, the PWA install card).
import { powerBtn } from './dom.js';
import { loader } from './state.js';

// POWER stays enabled with no ROMs (it opens Setup then), so readiness has to be
// asked of the loader itself. Read live: `loader` is created after this module.
const _romsReady = () => !!loader?.allLoaded;
import { SPLASH_SEEN_KEY } from './splash-policy.js';

const splashEl = document.getElementById('splash');
const splashPowerBtn = document.getElementById('splash-power');
const splashTeaser = splashEl?.querySelector('.splash-media video') ?? null;

export function splashIsOpen() {
  return !!splashEl && !splashEl.hidden && document.body.classList.contains('splash-open');
}

// The app shell stays in the DOM behind the overlay; take it out of the tab
// order and the accessibility tree while the splash owns the page.
function _setShellInert(on) {
  for (const el of [document.querySelector('body > header'), document.querySelector('.main-wrap')]) {
    if (el) el.inert = on;
  }
}

// POWER ON can arrive before the ROM auto-fetch has enabled the app's POWER
// button (src/roms.js resolves it shortly after load; instant on repeat
// visits). Boot now if possible, else poll for the enable and boot then.
// If the poll outlives the browser's transient user activation (~5s), the
// AudioContext may stay suspended until the user's next gesture — the app
// already resumes it on later interaction, so worst case is late audio.
function _pressPowerWhenReady() {
  if (_romsReady()) { powerBtn.click(); return; }
  if (splashPowerBtn) { splashPowerBtn.disabled = true; splashPowerBtn.textContent = 'WARMING UP…'; }
  const t0 = performance.now();
  const poll = setInterval(() => {
    if (_romsReady()) { clearInterval(poll); powerBtn.click(); }
    // ROMs never arrived. POWER opens Setup when there is nothing to boot, so
    // press it anyway rather than leave the user on a dead screen.
    else if (performance.now() - t0 > 15000) { clearInterval(poll); powerBtn.click(); }
  }, 100);
}

let _closing = false;
function _dismiss({ boot }) {
  if (_closing || !splashIsOpen()) return;
  _closing = true;
  try { localStorage.setItem(SPLASH_SEEN_KEY, '1'); } catch { /* private mode — splash just shows again next visit */ }
  document.removeEventListener('keydown', _onKeydown, true);
  if (boot) _pressPowerWhenReady();   // inside the click's user activation — see note above
  splashEl.classList.add('splash-closing');
  const finish = () => {
    splashTeaser?.pause();   // don't keep decoding video behind the app
    splashEl.hidden = true;
    document.body.classList.remove('splash-open');
    _setShellInert(false);
    if (!boot) powerBtn.focus();
    window.dispatchEvent(new Event('c64-splash-dismissed'));
  };
  // The fade duration mirrors #splash's transition in styles-splash.css.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
  else setTimeout(finish, 300);
}

function _onKeydown(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  _dismiss({ boot: false });
}

if (splashIsOpen()) {
  _setShellInert(true);
  splashPowerBtn?.addEventListener('click', () => _dismiss({ boot: true }));
  document.addEventListener('keydown', _onKeydown, true);
  splashPowerBtn?.focus({ preventScroll: true });
  // Start the teaser loop only now that the splash is really on screen (the
  // markup has no autoplay/poster + preload="none", so a hidden splash never
  // touches /media/ at all). Muted playback needs no user gesture;
  // reduced-motion users keep the poster, and if play() is refused the
  // poster stays — both fine.
  if (splashTeaser) {
    // ?v= busts the immutable /media/* cache when the poster artwork changes
    // (same convention as the favicon ?v= in index.html).
    splashTeaser.poster = '/media/c64ready-teaser-poster.webp?v=4';
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) splashTeaser.play().catch(() => {});
  }
} else if (splashEl) {
  splashEl.hidden = true;   // parsed for SEO, never shown this visit
}
