// test/app-accel-spec-test.js
//
// Locks the modifier chord that decides whether a keystroke is the app's or the
// C64's (src/app-accel.js). Every letter the app binds is also a C64 key, so a
// chord that matches too eagerly stops the user typing an F, and one that
// matches too rarely leaves the shortcut dead.
//
// The chord is Cmd+Shift on macOS and Ctrl+Shift on Windows and Linux, both
// accepted on every platform.

import { appAccel } from '../src/app-accel.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// A KeyboardEvent stand-in: only the modifier flags and getModifierState matter.
const ev = (mods = {}) => ({
  altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods,
  getModifierState: (m) => m === 'AltGraph' && !!mods.altGraph,
});

// ── Both spellings of the chord ─────────────────────────────────────────────

assert(appAccel(ev({ metaKey: true, shiftKey: true }), false),
  'Cmd+Shift is the chord (macOS spelling)');
assert(appAccel(ev({ ctrlKey: true, shiftKey: true }), false),
  'Ctrl+Shift is the chord (Windows/Linux spelling)');

// ── Everything else stays the C64's ─────────────────────────────────────────

assert(!appAccel(ev({ ctrlKey: true }), false),
  "bare Ctrl+key stays the C64's — colour codes and the like");
assert(!appAccel(ev({ metaKey: true }), false),
  'bare Cmd+key is not a shortcut, so the host keeps Cmd+V and Cmd+S');
assert(!appAccel(ev({ shiftKey: true }), false),
  'plain Shift+letter types on the C64');
assert(!appAccel(ev(), false),
  'an unmodified letter types on the C64');
assert(!appAccel(ev({ altKey: true }), false) &&
       !appAccel(ev({ altKey: true, shiftKey: true }), false),
  'the old Alt / Alt+Shift chord no longer fires');
assert(!appAccel(ev({ ctrlKey: true, metaKey: true, shiftKey: true }), false),
  'Ctrl and Cmd together is neither spelling');

// ── AltGr, which types @ [ ] { } \ | ~ $ on the European layouts ────────────

assert(!appAccel(ev({ ctrlKey: true, altKey: true, shiftKey: true }), false),
  'Windows AltGr arrives as Ctrl+Alt and must never fire a shortcut');
assert(!appAccel(ev({ ctrlKey: true, shiftKey: true, altGraph: true }), false),
  'a live AltGraph state disqualifies the chord even when the flags look right');

// ── A focused text field owns its own keys ──────────────────────────────────

assert(!appAccel(ev({ metaKey: true, shiftKey: true }), true),
  'a focused text field keeps Cmd+Shift+V (paste and match style)');
assert(!appAccel(ev({ ctrlKey: true, shiftKey: true }), true),
  'a focused text field keeps Ctrl+Shift+V (paste as plain text)');

console.log('app-accel spec: OK');
