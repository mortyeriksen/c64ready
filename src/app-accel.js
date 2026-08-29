// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/app-accel.js – the modifier chord that marks a keystroke as the app's,
// not the C64's.
//
// A pure predicate over a KeyboardEvent, split out of input.js so it can be
// tested without a DOM. input.js owns the shortcut registry and the dispatch;
// this file only answers "is the chord held?".
//
// Every letter the app binds is also a C64 key, so the chord is the whole
// distinction: get it wrong in either direction and the user either can't type
// an F or can't cycle the CRT.

// The chord: Cmd+Shift on macOS, Ctrl+Shift on Windows and Linux. Both are
// accepted on every platform — the branches are independent — so one muscle
// memory works wherever the user is.
//
// Ctrl is a real C64 key ([7,2] in the matrix) and a bare Ctrl+key belongs to
// the machine: CTRL+digit picks a colour, CTRL held slows a listing down. Shift
// is what makes borrowing it safe. It also steps outside the browser's plain
// Alt+letter menu accelerators, which are LOCALIZED in Firefox (Arkiv / Rediger
// / Vis on a Norwegian build) and so can't be dodged letter by letter.
//
// Alt is excluded rather than merely unrequired, because Windows delivers AltGr
// as Ctrl+Alt and the Nordic/European layouts type @ [ ] { } \ | ~ $ with it. A
// live AltGraph state disqualifies the chord too: Linux raises it from
// ISO_Level3_Shift without setting altKey.
//
// A focused text field owns its own keys: both Cmd+Shift+V (paste and match
// style) and Ctrl+Shift+V (paste as plain text) are text-editing chords there,
// so the ROM URL boxes keep them.
export function appAccel(e, inField) {
  if (inField || e.altKey || !e.shiftKey) return false;
  if (e.getModifierState && e.getModifierState('AltGraph')) return false;
  return e.metaKey ? !e.ctrlKey : e.ctrlKey;
}
