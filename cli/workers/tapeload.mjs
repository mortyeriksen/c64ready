// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/workers/tapeload.mjs — one thread's share of a tape's loads.
//
// The thread builds its own machine and, for a turbo tape, installs its own
// copy of the tape's loader; then it takes files one at a time until the
// parent says there are no more. What it does with a load depends on what was
// asked: judge it (loadtest), keep its bytes (tap2d64), or start it and
// photograph it (run --all). Nothing is printed from here — the parent owns
// the terminal.

import { parentPort, workerData } from 'node:worker_threads';
import { setQuiet } from '../report.mjs';
import { loadMachine } from '../core.mjs';
import { tapeEngine, prgFromLoad } from '../tapeload.mjs';
import { shoot } from '../run.mjs';

setQuiet(true);
const { tap, files, roms, keep, shoot: shooting } = workerData;
let at = null;                                   // which item this thread is on
const engine = await tapeEngine({
  tap, files, roms,
  // A thread has no terminal; it tells the parent, which owns the bar.
  onProgress: (label, fraction) => parentPort.postMessage({ index: at, progress: fraction, label }),
});
const dims = shooting ? await loadMachine() : null;

parentPort.on('message', msg => {
  if (!msg) { parentPort.close(); return; }
  // A load is asked for by index; a shot is asked for by index and the name
  // its picture is to be given, which the parent chose for the whole tape.
  at = msg.index;
  const f = files[shooting ? msg.item.file : msg.item];
  const { machine, ...verdict } = engine.loadFile(f, { clearRange: keep });
  const answer = { index: msg.index, ...verdict };
  // The bytes themselves only travel when someone means to keep them.
  if (keep && verdict.ok) answer.prg = prgFromLoad(machine, f);
  if (shooting && verdict.ok) {
    const { out, how, pressed } = shoot(machine, f, { ...shooting, out: msg.item.out }, dims);
    answer.out = out;
    answer.how = how;
    answer.pressed = pressed;
    engine.discardLoader();                      // a game is running on that machine now
  }
  parentPort.postMessage(answer);
});
