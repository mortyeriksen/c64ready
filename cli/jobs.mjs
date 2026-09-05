// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/jobs.mjs — the same work on several threads.
//
// Booting a machine is one core's work for as long as it takes, and the slow
// commands do it once per program: a tape side is fourteen loads of a minute
// or two each. They are independent — a fresh machine every time — so they run
// as well side by side as they do in a queue.
//
// Answers come back in the order the work was handed out, whatever order the
// threads finish in, so a listing reads the same however many threads wrote it.

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { countFlag } from './args.mjs';

/**
 * How many threads to use: --jobs if it was asked for, else half the cores — a
 * machine that spends every core on this has nothing left for the person
 * sitting at it, and the tool is rarely the only thing running. Never more
 * threads than there is work to do.
 */
export function jobsFor(flags, items) {
  const cores = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  const half = Math.max(1, Math.floor(cores / 2));
  return Math.max(1, Math.min(countFlag(flags, 'jobs') ?? half, items));
}

/**
 * Run one worker per job and feed them items until the work runs out.
 * @param {object} o
 * @param {URL} o.url        the worker module
 * @param {object} o.data    workerData every thread starts from
 * @param {Array} o.items    one payload per piece of work
 * @param {number} o.jobs    threads to run
 * @param {Function} [o.onDone]  (finished, total, result) as each answer lands
 * @param {Function} [o.onProgress]  (index, fraction) while a thread works
 * @returns {Promise<Array>} the answers, in the order the items were given
 */
export async function inParallel({ url, data, items, jobs, onDone = () => {}, onProgress = () => {} }) {
  const answers = new Array(items.length);
  const workers = [];
  let next = 0, finished = 0;
  try {
    await new Promise((resolve, reject) => {
      let live = 0;
      // A thread that has answered is handed the next item, so a slow load
      // never leaves a core idle behind it.
      const give = w => {
        if (next >= items.length) { w.postMessage(null); return; }
        const index = next++;
        w.postMessage({ index, item: items[index] });
      };
      for (let n = 0; n < jobs; n++) {
        const w = new Worker(url, { workerData: data });
        workers.push(w);
        live++;
        w.on('message', answer => {
          // A thread says where it has got to as well as what it found; only
          // the latter is an answer, and only the latter earns the next item.
          if (answer.progress !== undefined) { onProgress(answer.index, answer.progress, answer.label); return; }
          answers[answer.index] = answer;
          onDone(++finished, items.length, answer);
          give(w);
        });
        w.on('error', reject);
        w.on('exit', () => { if (--live === 0) resolve(); });
        give(w);
      }
    });
  } finally {
    for (const w of workers) w.terminate();
  }
  return answers;
}
