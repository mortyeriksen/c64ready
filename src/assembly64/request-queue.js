// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export function createRequestQueue({ concurrency = 3, intervalMs = 250 } = {}) {
  const waiting = [];
  let active = 0, nextStart = 0, timer;
  function pump() {
    clearTimeout(timer); timer = null;
    while (waiting.length && active < concurrency) {
      const delay = nextStart - performance.now();
      if (delay > 0) { timer = setTimeout(pump, Math.ceil(delay)); return; }
      const job = waiting.shift();
      job.signal.removeEventListener('abort', job.abort);
      active++; nextStart = performance.now() + intervalMs;
      Promise.resolve().then(() => { job.signal.throwIfAborted(); return job.run(); })
        .then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  return function schedule(run, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const job = { run, signal, resolve, reject };
      job.abort = () => {
        const index = waiting.indexOf(job);
        if (index < 0) return;
        waiting.splice(index, 1); signal.removeEventListener('abort', job.abort);
        reject(signal.reason); pump();
      };
      waiting.push(job); signal.addEventListener('abort', job.abort, { once: true }); pump();
    });
  };
}
