// The paste queue (src/paste-queue.js): pasted text reaches the KERNAL
// keyboard buffer as fast as it takes it, or one key every PASTE_PACED_FRAMES
// frames while a user port device is plugged in, so a terminal program has time
// to send each key and take its echo.

import { createPasteQueue, PASTE_PACED_FRAMES } from '../src/paste-queue.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// A stand-in for the KERNAL buffer: 10 places, emptied by the "machine" each frame.
function keyboard() {
  let buf = '';
  const typed = [];
  return {
    buffer: (text) => { const n = Math.min(10 - buf.length, text.length); buf += text.slice(0, n); return n; },
    frame(i) { if (buf) { typed.push([i, buf]); buf = ''; } },
    typed,
  };
}

{
  const q = createPasteQueue();
  const kb = keyboard();
  q.add('POKE 56579,255\r');
  for (let i = 0; i < 3; i++) { q.flush(kb.buffer, false); kb.frame(i); }
  expect(kb.typed.map(([, t]) => t).join('') === 'POKE 56579,255\r', `all text arrives: ${JSON.stringify(kb.typed)}`);
  expect(kb.typed.length === 2 && kb.typed[0][1].length === 10, 'unpaced: a full buffer per frame');
  ok('without a user port device, paste fills the keyboard buffer every frame');
}

{
  const q = createPasteQueue();
  const kb = keyboard();
  q.add('ATDT');
  for (let i = 0; i < 20; i++) { q.flush(kb.buffer, true); kb.frame(i); }
  const frames = kb.typed.map(([i]) => i);
  expect(kb.typed.map(([, t]) => t).join('') === 'ATDT', 'every key arrives, in order');
  expect(kb.typed.every(([, t]) => t.length === 1), 'one key at a time');
  expect(frames.slice(1).every((f, k) => f - frames[k] === PASTE_PACED_FRAMES), `keys ${PASTE_PACED_FRAMES} frames apart: ${frames}`);
  ok(`with a device plugged in, one key every ${PASTE_PACED_FRAMES} frames`);
}

{
  const q = createPasteQueue();
  const kb = keyboard();
  q.add('ABC');
  q.flush(kb.buffer, true);
  q.clear();
  for (let i = 0; i < 10; i++) { q.flush(kb.buffer, true); kb.frame(i); }
  expect(kb.typed.map(([, t]) => t).join('') === 'A' && q.pending === '', 'clear drops what has not gone in yet');
  ok('clear empties the queue');
}

{
  const q = createPasteQueue();
  let calls = 0;
  q.add('XY');
  q.flush(() => { calls++; return 0; }, false);
  expect(q.pending === 'XY' && calls === 1, 'a full keyboard buffer keeps the text queued');
  ok('nothing is lost while the keyboard buffer is full');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
