import assert from 'node:assert/strict';
import { createPrintJob } from '../../src/iec/print-job.js';
import { renderPrintOutput } from '../../src/iec/print-output.js';

{
  const pages = [[{ text: '<script>&"', x: 0, y: 80, width: 720 }], [{ path: 'M0 0h12v10h-12z' }]];
  const svg = renderPrintOutput(pages, 'svg'), html = renderPrintOutput(pages, 'html');
  assert.match(svg, /viewBox="0 0 6120 15840"/, 'SVG stacks two Letter pages');
  assert.match(svg, /translate\(0 7920\)/, 'the second page begins one Letter page below the first');
  assert.match(svg, /&lt;script&gt;&amp;&quot;/, 'text is XML escaped');
  assert.equal((html.match(/<svg /g) || []).length, 2, 'HTML keeps two printable pages');
  assert.match(html, /@page \{ size: letter/, 'HTML declares Letter paper');
  assert.throws(() => renderPrintOutput(pages, 'pdf'), /svg or html/);
}

function fixture(store = new Map()) {
  let frame, status, resumed = 0;
  const job = createPrintJob({
    storage: { get: key => store.get(key), set: (key, value) => store.set(key, value) },
    onFrame(fn) { frame = fn; }, status(value) { status = value; },
  }, { onClear() { resumed++; } });
  return { job, store, frame: () => frame(), status: () => status, resumed: () => resumed,
    bytes: () => Buffer.from(job.serialize().data, 'base64') };
}

const realNow = Date.now;
let now = 10000;
Date.now = () => now;
try {
  const f = fixture(); f.frame();
  assert.equal(f.status(), 'Idle · 0 bytes received', 'an empty job is idle');
  f.job.writeByte(65); f.frame();
  assert.equal(f.status(), 'Receiving… · 1 byte', 'new output shows receiving activity');
  now += 751; f.frame();
  assert.equal(f.status(), 'Idle · 1 byte received', 'silence returns to idle without claiming the job is complete');
  f.job.writeByte(66); f.job.detach();
  const restored = fixture(f.store); restored.frame();
  assert.deepEqual([...restored.bytes()], [65, 66], 'detach saves the raw job');
  assert.equal(restored.status(), 'Idle · 2 bytes received', 'persisted jobs start idle');
  const snapshot = restored.job.serialize();
  restored.job.clearJob();
  assert.equal(restored.store.get('job'), '', 'clear persists the empty job');
  assert.equal(restored.resumed(), 1, 'clear asks the IEC listener to retry a held byte');
  restored.job.deserialize(snapshot);
  assert.deepEqual([...restored.bytes()], [65, 66], 'snapshots restore raw bytes');
  console.log('ok  - print jobs report activity, persist, clear and restore');

  const full = fixture();
  full.job.deserialize({ data: Buffer.alloc(512 * 1024, 65).toString('base64') });
  assert.equal(full.job.writeByte(66), false, 'full storage withholds acknowledgement');
  assert.equal(full.bytes().length, 512 * 1024, 'full storage retains every accepted byte');
  full.frame();
  assert.match(full.status(), /^Job full · 512\.0 KB received/, 'full jobs show the capacity and recovery action');
  full.job.clearJob();
  assert.equal(full.job.writeByte(66), true, 'clearing makes room for the held byte');
  assert.deepEqual([...full.bytes()], [66], 'retry accepts the held byte exactly once');
  for (const data of ['invalid!', 'A'.repeat(800000), Buffer.alloc(512 * 1024 + 1).toString('base64')]) {
    assert.equal(fixture(new Map([['job', data]])).bytes().length, 0, 'invalid or oversized persisted jobs are ignored');
  }
  console.log('ok  - print spool bounds retain accepted bytes and reject invalid storage');
} finally { Date.now = realNow; }
