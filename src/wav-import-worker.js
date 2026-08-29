// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/wav-import-worker.js — turning a recording into a tape, off the main thread.
//
// Reading a digitised cassette is half a minute of arithmetic on a 300 MB buffer:
// several passes over every sample, then a re-read of each damaged file. Done on
// the main thread the page freezes solid and cannot even draw a progress bar, so
// it is done here and the stages are posted back as they happen.
import { wavToTap } from './wav-tape.js';
import { repairTape } from './tap-repair.js';
import { tapDirectory } from './tap-directory.js';

// Said as soon as the module is up, so the sender knows it is safe to hand over
// the recording — see the note in src/wav-import.js.
self.postMessage({ ready: true });

self.onmessage = (e) => {
  // The recording arrives with its buffer handed over, not copied; it is used as
  // it is. Wrapping it in a fresh Uint8Array would copy all of it again.
  const bytes = e.data.bytes;
  try {
    const { tap, pulses, seconds, mended, unconfirmed } = wavToTap(bytes, {
      onProgress: (stage, at) => self.postMessage({ stage, at }),
    });
    self.postMessage({ stage: 'directory', at: 0 });
    const fixed = repairTape(tap);
    const files = tapDirectory(fixed.tap.subarray(20), { version: fixed.tap[12] });
    const damagedNames = files.filter(f => f.damaged).map(f => f.name.trim());
    const result = {
      tap: fixed.tap, pulses, seconds,
      repaired: [...mended, ...fixed.repaired],
      unconfirmed,
      damagedNames,
      files: files.length,
    };
    self.postMessage({ done: result }, [result.tap.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
