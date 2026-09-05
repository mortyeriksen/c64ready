// Spec test for the worker pool (cli/jobs.mjs): every item is done exactly
// once, the answers come back in the order the items were given whatever order
// the threads finish in, and --jobs is bounded by the work there is to do.
import os from 'node:os';
import { jobsFor, inParallel } from '../jobs.mjs';
import { parseArgs, UsageError } from '../args.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}
const flagsOf = argv => parseArgs(argv, { jobs: { value: true } }).flags;

// How many threads: what was asked for, never more than there is work to do,
// and one per core when nothing was asked.
eq(jobsFor(flagsOf(['--jobs', '3']), 10), 3, '--jobs is taken as given');
eq(jobsFor(flagsOf(['--jobs', '9']), 2), 2, 'never more threads than items');
eq(jobsFor(flagsOf(['--jobs', '1']), 10), 1, 'one thread is one thread');
{
  // Unasked, half the cores: enough to be worth threading, not so much that
  // the machine stops answering the person who started it.
  const cores = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  eq(jobsFor(flagsOf([]), 1000), Math.max(1, Math.floor(cores / 2)), 'unasked, half the cores');
  eq(jobsFor(flagsOf([]), 1), 1, 'and never more than there is work');
}
try {
  jobsFor(flagsOf(['--jobs', '0']), 10);
  assert(false, '--jobs 0 is refused');
} catch (e) {
  assert(e instanceof UsageError, `--jobs 0 is refused as usage, threw ${e.constructor.name}`);
}

// The order of the answers is the order of the items — the whole point, since
// a listing must read the same however many threads filled it in.
{
  const items = Array.from({ length: 20 }, (_, i) => i + 1);
  const answers = await inParallel({
    url: new URL('./echo-worker.mjs', import.meta.url),
    data: { unit: 4 },
    items,
    jobs: 4,
  });
  eq(answers.length, items.length, 'one answer per item');
  eq(answers.map(a => a.doubled), items.map(i => i * 2), 'answers stand in the order the items were given');
  eq(answers.map(a => a.index), items.map((_, i) => i), 'each answer knows which item it belongs to');
}

// One thread and many threads must agree, or a --jobs flag would change what
// the tool says rather than only how long it takes.
{
  const items = Array.from({ length: 12 }, (_, i) => i + 1);
  const one = await inParallel({ url: new URL('./echo-worker.mjs', import.meta.url), data: { unit: 1 }, items, jobs: 1 });
  const many = await inParallel({ url: new URL('./echo-worker.mjs', import.meta.url), data: { unit: 1 }, items, jobs: 6 });
  eq(many.map(a => a.doubled), one.map(a => a.doubled), 'six threads answer exactly as one thread does');
}

if (failures) {
  console.error(`\n${failures} jobs assertion(s) failed`);
  process.exit(1);
}
console.log('cli jobs spec: PASS');
