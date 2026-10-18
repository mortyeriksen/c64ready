// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/paste-queue.js – pasted text on its way into the C64's keyboard buffer,
// fed once per emulated frame.
//
// While a device is plugged into the user port, paste types at a person's
// pace. A terminal program sends each key out over the serial line as it reads
// it, and a bit-banged driver garbles keys that arrive while it is still
// receiving the echo of the one before (CCGMS does, in VICE too). 4 frames
// apart leaves room for a key and its echo down to 300 baud.

export const PASTE_PACED_FRAMES = 4;

export function createPasteQueue() {
  let pending = '';
  let wait = 0;
  return {
    get pending() { return pending; },
    add(text) { pending += text; },
    clear() { pending = ''; wait = 0; },
    // Once per frame. `buffer(text)` puts what fits into the keyboard buffer
    // and returns how many characters it took.
    flush(buffer, paced) {
      if (!pending) return;
      if (paced) {
        if (wait > 0) { wait--; return; }
        if (buffer(pending[0]) > 0) {
          pending = pending.slice(1);
          wait = PASTE_PACED_FRAMES - 1;
        }
        return;
      }
      const taken = buffer(pending);
      if (taken > 0) pending = pending.slice(taken);
    },
  };
}
