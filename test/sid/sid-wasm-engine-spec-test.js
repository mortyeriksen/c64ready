// SID WASM engine: the compiled Rust translation (src/sid-wasm-blob.js,
// built from rust/sid) must be a drop-in for the JS reSID engine — same
// cycle-stamped event stream, same samples, bit for bit. This doubles as a
// stale-blob detector: changing the JS engine (sid-voice.js / sid-filter.js
// reSID paths) without rebuilding the wasm module (sh rust/sid/build.sh)
// fails the identity check here.

import { loadSidIntoContext } from './sid-test-loader.js';

const RATE = 44100;
const ctx = loadSidIntoContext({ sampleRate: RATE });

let tests = 0;
let failures = 0;
const expect = (cond, msg) => {
  tests++;
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
};

// Mixed scenario: filter sweep + combined-waveform churn on v1 (exercises
// the 6581 saw-MSB pulldown ordering) + ring-mod v2/v3 + volume steps.
const scenario = (() => {
  const ev = [];
  const w = (c, r, v) => ev.push([c >>> 0, r, v]);
  w(1000, 0x18, 0x1F); w(1000, 0x17, 0xF1);
  w(1000, 0x15, 0x03); w(1000, 0x16, 0x66);
  w(1000, 0x00, 0x45); w(1000, 0x01, 0x1D);
  w(1000, 0x05, 0x08); w(1000, 0x06, 0xA6); w(1000, 0x04, 0x41);
  w(1000, 0x02, 0x00); w(1000, 0x03, 0x08);
  w(1000, 0x07, 0x00); w(1000, 0x08, 0x31); w(1000, 0x0B, 0x15);
  w(1000, 0x0C, 0x00); w(1000, 0x0D, 0xF0);
  w(1000, 0x0E, 0xFF); w(1000, 0x0F, 0x10); w(1000, 0x12, 0x35);
  w(1000, 0x13, 0x00); w(1000, 0x14, 0xF0);
  for (let i = 0; i < 10; i++) {
    const c = 1000 + i * 39409;
    w(c, 0x16, (i * 23) & 0xFF);
    w(c + 7, 0x04, [0x41, 0x51, 0x71, 0x81, 0x11][i % 5] | 1);
    w(c + 13, 0x18, 0x10 | ((15 - i) & 0xF));
  }
  return ev;
})();

function makeProc(engine, is8580) {
  const proc = new ctx.SIDProcessor();
  const shared = new SharedArrayBuffer(16 + 131072 * 8);
  const sab = { ctrl: new Int32Array(shared, 0, 4), ring: new Uint32Array(shared, 16) };
  proc.port.onmessage({ data: { type: 'init', shared, is8580, engine } });
  makeProc.lastShared = shared;
  // Deterministic t=0 alignment, no fade-in ramp — identical on both sides.
  proc._needCycleSync = false;
  proc.currentCycle = 0;
  proc.fadeInRemaining = 0;
  const push = (c, r, v) => {
    const wi = Atomics.load(sab.ctrl, 0);
    const off = (wi & (131072 - 1)) * 2;
    sab.ring[off] = c;
    sab.ring[off + 1] = ((v & 0xFF) << 8) | (r & 0x1F);
    Atomics.store(sab.ctrl, 0, (wi + 1) & 0x7FFFFFFF);
  };
  return { proc, push };
}

function renderInto(proc, out, from, to) {
  const left = new Float32Array(128);
  let idx = from;
  while (idx < to) {
    proc.process([], [[left]]);
    for (let i = 0; i < 128 && idx < to; i++) out[idx++] = Math.round(left[i] * 32768);
  }
}

async function renderProc(engine, is8580, ev, seconds) {
  const { proc, push } = makeProc(engine, is8580);
  if (engine === 'wasm') { await proc.wasmReady; proc.currentCycle = 0; }
  for (const [c, r, v] of ev) push(c, r, v);
  const n = Math.floor(seconds * RATE);
  const out = new Int16Array(n);
  renderInto(proc, out, 0, n);
  return { out, proc };
}

// 1: the embedded blob decodes to a well-formed wasm module.
{
  const bytes = ctx.sidWasmBytes();
  expect(bytes.length > 40000, `blob decodes to a plausible size (got ${bytes.length})`);
  expect(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6D,
    `blob starts with the \\0asm magic`);
}

// 2: bit-identity vs the JS reSID engine, both models, through the real
// SIDProcessor paths (ring transport, event forwarding, resampler).
for (const is8580 of [false, true]) {
  const { out: js } = await renderProc('resid', is8580, scenario, 0.4);
  const { out: ws, proc } = await renderProc('wasm', is8580, scenario, 0.4);
  expect(proc.wasm !== null && !proc.wasmFailed, `wasm module instantiated (${is8580 ? 8580 : 6581})`);
  let diffs = 0, maxd = 0;
  for (let i = 0; i < js.length; i++) {
    const d = Math.abs(js[i] - ws[i]);
    if (d > 0) diffs++;
    if (d > maxd) maxd = d;
  }
  expect(diffs === 0,
    `wasm output bit-identical to JS reSID (${is8580 ? 8580 : 6581}): ${diffs} diffs, maxΔ=${maxd} — stale blob? rebuild with sh rust/sid/build.sh`);
  let rms = 0;
  for (let i = 0; i < ws.length; i++) rms += ws[i] * ws[i];
  rms = Math.sqrt(rms / ws.length);
  expect(rms > 100, `wasm output is audible (${is8580 ? 8580 : 6581}): rms=${rms.toFixed(1)}`);
}

// 3: live switch OUT of wasm replays the full register file into the JS chip.
{
  const { proc, push } = makeProc('wasm', false);
  await proc.wasmReady;
  proc.currentCycle = 0;
  for (const [c, r, v] of scenario) push(c, r, v);
  const out = new Int16Array(Math.floor(0.2 * RATE));
  renderInto(proc, out, 0, out.length);   // all scenario events forwarded by now
  proc.port.onmessage({ data: { type: 'engine', engine: 'resid' } });
  expect(proc.engineSel === 'resid', `switch out of wasm lands on the resid engine`);
  expect(proc.sid.filter.vol === (proc.regShadow[0x18] & 0xF),
    `volume replayed from the register shadow (vol=${proc.sid.filter.vol})`);
  expect(proc.sid.v1.ctrl === proc.regShadow[0x04],
    `v1 control register replayed (ctrl=$${proc.sid.v1.ctrl.toString(16)})`);
  const cont = new Int16Array(Math.floor(0.05 * RATE));
  renderInto(proc, cont, 0, cont.length);
  expect(cont.every(s => s >= -32768 && s <= 32767), `post-switch render stays finite`);
}

// 4: wasm engine survives reset and model messages.
{
  const { proc, push } = makeProc('wasm', false);
  await proc.wasmReady;
  proc.currentCycle = 0;
  proc.port.onmessage({ data: { type: 'model', is8580: true } });
  proc.port.onmessage({ data: { type: 'reset', is8580: true } });
  expect(proc.engineSel === 'wasm', `engine selection survives a soft reset`);
  proc._needCycleSync = false;
  proc.currentCycle = 0;
  proc.fadeInRemaining = 0;
  push(500, 0x18, 0x0F); push(500, 0x00, 0x45); push(500, 0x01, 0x1D);
  push(500, 0x06, 0xF0); push(500, 0x04, 0x21);
  const out = new Int16Array(Math.floor(0.1 * RATE));
  renderInto(proc, out, 0, out.length);
  let rms = 0;
  for (let i = 0; i < out.length; i++) rms += out[i] * out[i];
  rms = Math.sqrt(rms / out.length);
  expect(rms > 100, `wasm renders after reset+model switch (rms=${rms.toFixed(1)})`);
}

// 5: filter-table caches survive a power cycle (init message → sid_init).
// Without this, every state load / power cycle re-runs the ~215-360 ms
// table build ON THE AUDIO THREAD — audible distortion on mobile.
{
  const { proc, push } = makeProc('wasm', false);
  await proc.wasmReady;
  expect((proc.wasm.sid_models_cached() & 1) === 1, `6581 tables built at first init`);
  proc.port.onmessage({ data: { type: 'init', shared: makeProc.lastShared, is8580: false, engine: 'wasm' } });
  expect((proc.wasm.sid_models_cached() & 1) === 1,
    `filter tables SURVIVE the power cycle (no audio-thread rebuild on state load)`);
  proc._needCycleSync = false;
  proc.currentCycle = 0;
  proc.fadeInRemaining = 0;
  push(500, 0x18, 0x0F); push(500, 0x00, 0x45); push(500, 0x01, 0x1D);
  push(500, 0x06, 0xF0); push(500, 0x04, 0x21);
  const out = new Int16Array(Math.floor(0.1 * RATE));
  renderInto(proc, out, 0, out.length);
  let rms = 0;
  for (let i = 0; i < out.length; i++) rms += out[i] * out[i];
  rms = Math.sqrt(rms / out.length);
  expect(rms > 100, `renders after power cycle (rms=${rms.toFixed(1)})`);
}

// 6: a clock jump (desync snap / thaw resync) flushes stranded old-domain
// events instead of letting them clog the FIFO head as bogus-future.
{
  const { proc } = makeProc('wasm', false);
  await proc.wasmReady;
  const w = proc.wasm;
  w.sid_init(RATE, 0);
  w.sid_queue_write(5000000, 0x18, 0x0F);   // old-domain future stamps
  w.sid_queue_write(5000100, 0x00, 0x45);
  expect(w.sid_pend_count() === 2, `events queued in the old domain`);
  w.sid_set_cycle(3000000000);              // jump to a new cycle domain
  expect(w.sid_pend_count() === 0, `clock jump flushes stranded events (applied in order)`);
  // The flushed $D418 write took effect and new-domain events still land:
  w.sid_queue_write(3000000100, 0x01, 0x1D);
  w.sid_queue_write(3000000100, 0x06, 0xF0);
  w.sid_queue_write(3000000100, 0x04, 0x21);
  const n = Math.floor(0.1 * RATE);
  const out = new Int16Array(n);
  const ptr = w.sid_out_ptr();
  let idx = 0;
  while (idx < n) {
    const c = Math.min(128, n - idx);
    w.sid_render(c);
    out.set(new Int16Array(w.memory.buffer, ptr, c).subarray(0, c), idx);
    idx += c;
  }
  let rms = 0;
  for (let i = 0; i < n; i++) rms += out[i] * out[i];
  rms = Math.sqrt(rms / n);
  expect(rms > 100, `audio flows in the new domain after the jump (rms=${rms.toFixed(1)})`);
}

// 7: a SYNCHRONOUS instantiation failure (WebAssembly API absent or
// restricted — lockdown modes, strict CSP, OOM in the byte decode) must not
// abort the init handler: the ring transport still gets wired, the session
// downgrades to the JS engine, and the audio is the JS engine's, bit for
// bit. Regression guard: _ensureWasm once ran BEFORE the ring wiring, so an
// escaped sync throw would have silenced the SID with no fallback.
{
  const RealWA = ctx.WebAssembly;
  ctx.WebAssembly = { instantiate() { throw new Error('simulated: wasm disabled'); } };
  const { out: ws, proc } = await renderProc('wasm', false, scenario, 0.2);
  ctx.WebAssembly = RealWA;
  expect(proc.wasmFailed === true, `sync instantiate throw lands in the wasmFailed path`);
  expect(proc.engineSel === 'resid', `session downgrades to the JS engine`);
  expect(!!proc.sidCtrl && !!proc.sidRing32, `init completed: ring transport wired despite the throw`);
  const { out: js } = await renderProc('resid', false, scenario, 0.2);
  let diffs = 0;
  for (let i = 0; i < js.length; i++) if (js[i] !== ws[i]) diffs++;
  expect(diffs === 0, `fallback audio bit-identical to the JS engine (${diffs} diffs)`);
}

if (failures === 0) {
  console.log(`ok - SID WASM engine: ${tests} checks (bit-identity, switch replay, reset/model, power-cycle cache, jump flush, sync-fail fallback)`);
} else {
  console.log(`FAIL - SID WASM engine: ${failures}/${tests} checks failed`);
  process.exit(1);
}
