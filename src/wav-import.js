// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/wav-import.js — one call to turn a .wav into a tape, with progress.
//
// A worker if the browser will give us one, the main thread if it will not. The
// answer is the same either way; only the waiting differs, and on the main
// thread nothing can be drawn while it happens.
import { wavToTap } from './wav-tape.js';
import { repairTape } from './tap-repair.js';
import { tapDirectory } from './tap-directory.js';

// What each stage is called on screen, and how much of the bar it is worth.
// The weights are measured shares of a 27-minute transfer, near enough.
const STAGES = [
  { id: 'reading', text: 'Reading the recording', share: 0.08 },
  { id: 'level', text: 'Measuring the signal', share: 0.04 },
  { id: 'pulses', text: 'Finding the pulses', share: 0.12 },
  // A stereo transfer's two channels sit a few samples apart, and the delay is
  // measured before they can be averaged lined up. Brief, and mono skips it.
  { id: 'aligning', text: 'Lining up the channels', share: 0.02 },
  // A stereo recording is read four ways over (each channel, their average,
  // and the average lined up) to find which one the tape comes off best from —
  // most of the wait, and skipped entirely for a mono transfer.
  { id: 'comparing', text: 'Comparing the channels', share: 0.46 },
  // Each damaged file read again every way, until two readings agree on it.
  { id: 'mending', text: 'Mending damaged files', share: 0.18 },
  { id: 'directory', text: 'Reading the directory', share: 0.10 },
];

/** Overall progress and a line of text, from a stage and how far into it. */
export function importProgress(stage, at = 0) {
  let before = 0;
  for (const s of STAGES) {
    if (s.id === stage) {
      return { text: s.text, value: Math.min(1, before + s.share * Math.max(0, Math.min(1, at))) };
    }
    before += s.share;
  }
  return { text: 'Working', value: before };
}

/** The whole of it, done here and now. Blocks — see the note above. */
function importInline(bytes, onProgress) {
  const { tap, pulses, seconds, mended, unconfirmed } = wavToTap(bytes, { onProgress });
  onProgress('directory', 0);
  const fixed = repairTape(tap);
  const files = tapDirectory(fixed.tap.subarray(20), { version: fixed.tap[12] });
  return {
    tap: fixed.tap, pulses, seconds,
    repaired: [...mended, ...fixed.repaired],
    unconfirmed,
    damagedNames: files.filter(f => f.damaged).map(f => f.name.trim()),
    files: files.length,
  };
}

const WORKER_START_MS = 4000;   // long enough for a cold module load on a phone

/**
 * @param {Uint8Array} bytes  a RIFF/PCM recording. Handed to the worker, so the
 *   caller's copy is gone afterwards — a tape transfer is hundreds of megabytes
 *   and copying it just to keep the original around helps nobody.
 * @param {(stage: string, at: number) => void} onProgress
 */
export function importWav(bytes, onProgress = () => {}) {
  let worker = null;
  try {
    worker = new Worker(new URL('./wav-import-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve(importInline(bytes, onProgress));
  }
  return new Promise((resolve, reject) => {
    // The recording is handed over rather than copied, and a detached buffer
    // cannot be read back — so nothing is sent until the worker has said it
    // loaded. Before that, falling back to the main thread is still possible;
    // after it, a failure is a failure.
    let sent = false;
    let start = 0;
    const giveUp = (err) => {
      clearTimeout(start);
      worker.terminate();
      if (sent) reject(err instanceof Error ? err : new Error(String(err)));
      else { try { resolve(importInline(bytes, onProgress)); } catch (e) { reject(e); } }
    };
    start = setTimeout(() => { if (!sent) giveUp(); }, WORKER_START_MS);

    worker.onmessage = (e) => {
      if (e.data.ready) {
        clearTimeout(start);
        sent = true;
        worker.postMessage({ bytes }, [bytes.buffer]);
      } else if (e.data.done) { worker.terminate(); resolve(e.data.done); }
      else if (e.data.error) { giveUp(new Error(e.data.error)); }
      else onProgress(e.data.stage, e.data.at);
    };
    worker.onerror = (e) => giveUp(e && e.message);
  });
}
