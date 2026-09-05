// A stand-in for a real job: answer after a jittered wait, so the spec test
// sees answers arriving out of the order they were handed out.
import { parentPort, workerData } from 'node:worker_threads';

parentPort.on('message', msg => {
  if (!msg) { parentPort.close(); return; }
  const until = Date.now() + (msg.item % 5) * workerData.unit;
  while (Date.now() < until) { /* a job is busy, not idle */ }
  parentPort.postMessage({ index: msg.index, doubled: msg.item * 2 });
});
