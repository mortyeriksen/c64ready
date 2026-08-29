import { shouldShowSplash, SPLASH_SEEN_KEY } from '../src/splash-policy.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Dark launch: with the ship switch off, nothing shows without a forced query.
expect(
  shouldShowSplash({ query: null, defaultOn: false, seen: false, standalone: false }) === false,
  'dark launch: default-off shows nothing without ?SPLASH=1',
);
expect(
  shouldShowSplash() === false,
  'no inputs at all defaults to hidden (dark launch is the safe state)',
);

// ?SPLASH=1 forces the splash on regardless of every other signal (dev/test/re-entry).
expect(
  shouldShowSplash({ query: '1', defaultOn: false, seen: true, standalone: true }) === true,
  '?SPLASH=1 overrides default-off, a set seen-flag, and standalone mode',
);

// ?SPLASH=0 forces it off even when it would otherwise show.
expect(
  shouldShowSplash({ query: '0', defaultOn: true, seen: false, standalone: false }) === false,
  '?SPLASH=0 overrides an otherwise-eligible first visit',
);

// Live (defaultOn): a plain first visit shows the splash exactly once.
expect(
  shouldShowSplash({ query: null, defaultOn: true, seen: false, standalone: false }) === true,
  'live first visit in a browser tab shows the splash',
);
expect(
  shouldShowSplash({ query: null, defaultOn: true, seen: true, standalone: false }) === false,
  'a visitor who dismissed the splash never sees it again',
);
expect(
  shouldShowSplash({ query: null, defaultOn: true, seen: false, standalone: true }) === false,
  'installed-PWA launches skip the splash (already converted)',
);

// The seen-flag key is the contract between splash.js and the inline mirror
// in index.html — a rename must be deliberate in all three places.
expect(
  SPLASH_SEEN_KEY === 'c64emu.splashSeen',
  'SPLASH_SEEN_KEY matches the key the index.html inline script reads',
);

console.log('ok  - splash first-visit visibility policy');
