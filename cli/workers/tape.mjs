// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/workers/tape.mjs — one thread's share of a shelf of tapes.
//
// Where cli/workers/tapeload.mjs splits one tape's files across threads, this
// gives a thread a whole tape: it reads it, mends it, installs the tape's own
// loader once, and works down the side. That is the better division when
// several tapes were named — a tape holding two files can only keep two
// threads busy, while ten tapes keep ten.
//
// Nothing is printed or written here: the answer goes back and the parent
// renders the tapes in the order they were named.

import { parentPort, workerData } from 'node:worker_threads';
import { setQuiet } from '../report.mjs';
import { UsageError } from '../args.mjs';
import { tapeWork } from '../run.mjs';

setQuiet(true);
const { roms, keep, file } = workerData;

parentPort.on('message', async msg => {
  if (!msg) { parentPort.close(); return; }
  try {
    const work = await tapeWork(msg.item, { file }, {
      keep, roms, serial: true,
      onProgress: fraction => parentPort.postMessage({ index: msg.index, progress: fraction }),
    });
    parentPort.postMessage({ index: msg.index, ...work });
  } catch (e) {
    // A wrong invocation is wrong for every tape; anything else is this tape's
    // own failure and the others carry on.
    parentPort.postMessage({ index: msg.index, error: e.message, usage: e instanceof UsageError });
  }
});
