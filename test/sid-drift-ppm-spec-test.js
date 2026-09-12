// SID worklet clock-drift readout.
//
// The two clocks are independent: the producer's stamps come from the main
// loop's sidCycleCounter, the worklet's currentCycle from rendered samples at
// the audio device's rate. Nothing reconciles their RATES (the sync snaps and
// the backlog ceiling both act on position), so a device whose real rate
// differs from its nominal one shows up as a slow, permanent slide in one
// direction, and the diag line has to be able to name that.
//
// What it must NOT do is read the reporting artifact as drift. A player writes
// its registers in one burst per frame, so both the queue head and the
// producer's newest stamp sit on that grid, while a report period is 50.1245
// PAL frames: the 0.1245-frame remainder alone walks oldestFutureΔ down by 2448
// cycles per report and wraps it every ~8 s on a PERFECTLY locked pair of
// clocks. Hence the drift figure is the producer's LEAD, averaged over every
// block of a period (which cancels the burst sawtooth) and differenced across
// eight periods.
import { loadSidIntoContext } from './sid-test-loader.js';

const RATE = 48000;                         // what main.js asks the browser for
const CLOCK = 985248;
const CPS = CLOCK / RATE;
const BLOCK = 128;
const CYCLES_PER_BLOCK = BLOCK * CPS;
const BLOCKS_PER_PERIOD = RATE / BLOCK;     // 375: a report period, exactly
const FRAME_CY = 19656;                     // PAL frame = the write grid
const LOOKAHEAD = 24576;                    // EVENT_LOOKAHEAD_CYCLES
const WINDOW = 8;                           // DRIFT_WINDOW_REPORTS
const ALIAS_STEP = CLOCK - 50 * FRAME_CY;   // 2448: the per-report grid alias

const ctx = loadSidIntoContext({
  sampleRate: RATE,
  // Keep each processor's diag messages instead of dropping them.
  AudioWorkletProcessor: class {
    constructor() {
      const log = [];
      this.port = { onmessage: null, postMessage: (m) => log.push(m), log };
    }
  },
});

let tests = 0;
let failures = 0;
const expect = (cond, msg) => {
  tests++;
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
};

// `writer`: 'player' = nine registers in a tight burst once a frame (a music
// player under a raster IRQ, which is what the shipped diag captures show);
// 'digi' = a continuous $D418 stream, no grid at all.
async function makeRig(engine, writer = 'player') {
  const proc = new ctx.SIDProcessor();
  const shared = new SharedArrayBuffer(16 + 131072 * 8);
  const ctrl = new Int32Array(shared, 0, 4);
  const ring = new Uint32Array(shared, 16);
  proc.port.onmessage({ data: { type: 'init', shared, is8580: false, engine } });
  if (engine === 'wasm') await proc.wasmReady;
  // Start already in step: the clock at zero, the producer ahead by the
  // lookahead plus the few frames of queue a real session carries (the main
  // thread computes a frame of writes before that audio plays), so no sync snap
  // is due and report periods land on exact CLOCK boundaries.
  proc._needCycleSync = false;
  proc.currentCycle = 0;
  proc.diagLastReportCycle = 0;
  proc.fadeInRemaining = 0;

  const left = new Float32Array(BLOCK);
  let machineCycle = LOOKAHEAD + 3 * FRAME_CY;
  let budget = 0;
  const rig = {
    proc,
    get machineCycle() { return machineCycle; },
    push(c, r, v) {
      const wi = Atomics.load(ctrl, 0);
      const off = (wi & (131072 - 1)) * 2;
      ring[off] = c >>> 0;
      ring[off + 1] = ((v & 0xFF) << 8) | (r & 0x1F);
      Atomics.store(ctrl, 0, (wi + 1) & 0x7FFFFFFF);
    },
    produce(cycles) {
      budget += cycles;
      if (writer === 'digi') {
        while (budget >= 200) {                       // ~4900 writes/s
          budget -= 200;
          machineCycle += 200;
          rig.push(machineCycle, 0x18, 0x0F);
        }
        return;
      }
      while (budget >= FRAME_CY) {
        budget -= FRAME_CY;
        const frameStart = machineCycle;
        for (let i = 1; i <= 9; i++) {                // one raster IRQ's worth
          rig.push(frameStart + 200 + i * 150, 0x01, 0x20 + (i % 3));
        }
        machineCycle = frameStart + FRAME_CY;
      }
    },
    // `rate` = producer stamps per cycle of worklet clock; 1 + 500e-6 is a
    // producer running 500 ppm fast.
    run(periods, rate = 1) {
      for (let b = 0; b < periods * BLOCKS_PER_PERIOD; b++) {
        rig.produce(CYCLES_PER_BLOCK * rate);
        proc.process([], [[left]]);
      }
    },
    // Render without producing: the machine frozen, the audio thread running.
    coast(periods) {
      for (let b = 0; b < periods * BLOCKS_PER_PERIOD; b++) proc.process([], [[left]]);
    },
    reports() { return proc.port.log.filter(m => m?.type === 'diag-period'); },
  };
  return rig;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const measured = (rep) => rep.filter(r => r.driftPPM !== null);
// The naive reading the figure replaced: oldestFutureΔ differenced across the
// same window.
const headPPM = (rep, i) => Math.round(
  (rep[i].oldestFutureΔ - rep[i - WINDOW].oldestFutureΔ) * 1e6
  / ((rep[i].currentCycle - rep[i - WINDOW].currentCycle) >>> 0));

// 1: the alias is real, and the drift figure does not read it as drift. A
// perfectly locked producer must report ~0 ppm while oldestFutureΔ marches down
// by 2448 per report and wraps a whole frame every eighth one.
for (const engine of ['resid', 'wasm']) {
  const rig = await makeRig(engine);
  rig.run(20);
  const rep = rig.reports();
  expect(rep.length >= 19, `${engine}: locked run reported every period (${rep.length})`);

  const steps = [];
  for (let i = 1; i < rep.length; i++) steps.push(rep[i].oldestFutureΔ - rep[i - 1].oldestFutureΔ);
  const slides = steps.filter(s => near(s, -ALIAS_STEP, 400));
  const wraps = steps.filter(s => s > FRAME_CY / 2);
  expect(slides.length + wraps.length >= steps.length - 1,
    `${engine}: oldestFutureΔ slides by ${-ALIAS_STEP} per report and wraps (${slides.length} slides, ${wraps.length} wraps of ${steps.length})`);
  expect(wraps.length >= 2, `${engine}: at least two wraps in 20 periods (${wraps.length})`);

  const m = measured(rep);
  expect(m.length >= rep.length - WINDOW - 1,
    `${engine}: the figure appears once the window fills (${m.length}/${rep.length})`);
  const worst = m.reduce((w, r) => Math.max(w, Math.abs(r.driftPPM)), 0);
  expect(worst <= 100,
    `${engine}: a locked producer reads as no drift, alias and all (worst ${worst} ppm)`);
  expect(m.at(-1).driftAvgPPM !== null && Math.abs(m.at(-1).driftAvgPPM) <= 50,
    `${engine}: and its long-run average too (${m.at(-1).driftAvgPPM} ppm over ${m.at(-1).driftAvgSeconds}s)`);
}

// 2: a real rate difference reads back, with its sign. 500 ppm is a fifth of
// what a 50.0-vs-50.1245 fps producer would show, so the figure has to resolve
// well below the scale of the bug it is there to name.
//
// Test 1 covers both engines, since only the wasm path takes currentCycle from
// the module and could read a rate the JS path would not. The rest run on the
// shipped default, where the JS reSID render is ~7x the cost of the whole
// measurement under test.
for (const ppm of [500, -500]) {
  const rig = await makeRig('wasm');
  rig.run(12, 1 + ppm / 1e6);
  const m = measured(rig.reports());
  const worst = m.reduce((w, r) => Math.max(w, Math.abs(r.driftPPM - ppm)), 0);
  expect(m.length > 0 && worst <= 100,
    `${ppm > 0 ? '+' : ''}${ppm} ppm producer reads back within 100 ppm (worst error ${worst})`);
  expect(near(m.at(-1).driftAvgPPM, ppm, 50),
    `${ppm > 0 ? '+' : ''}${ppm} ppm long-run average (${m.at(-1).driftAvgPPM} ppm over ${m.at(-1).driftAvgSeconds}s)`);
  expect(rig.proc.diagBacklogFF === 0 && rig.proc.diagOverrun === 0,
    `${ppm > 0 ? '+' : ''}${ppm} ppm alone disturbs nothing else (FF ${rig.proc.diagBacklogFF}, overrun ${rig.proc.diagOverrun})`);
}

// 3: canary for the observable. oldestFutureΔ measures the same two clocks, but
// it is the distance to the NEXT write, so it wraps every time the head is
// consumed and can only carry drift up to the gap between writes. Under a digi
// stream that gap is a couple of hundred cycles and the naive reading collapses
// to nothing, while the lead the figure actually samples does not wrap.
{
  const rig = await makeRig('wasm', 'digi');
  rig.run(12, 1 + 500 / 1e6);
  const rep = rig.reports();
  const m = measured(rep);
  const worst = m.reduce((w, r) => Math.max(w, Math.abs(r.driftPPM - 500)), 0);
  expect(m.length > 0 && worst <= 100,
    `digi stream: +500 ppm still reads back (worst error ${worst} ppm)`);
  const naive = [];
  for (let i = WINDOW; i < rep.length; i++) naive.push(headPPM(rep, i));
  const naiveWorst = naive.reduce((w, v) => Math.max(w, Math.abs(v)), 0);
  expect(naive.length > 0 && naiveWorst < 100,
    `digi stream: and oldestFutureΔ alone would have missed it entirely (|${naiveWorst}| ppm)`);
}

// 4: a clock re-anchor voids the reading rather than reporting the jump as
// drift. currentCycle moves by an arbitrary amount, so the lead either side of
// it is measured against a different clock.
{
  const rig = await makeRig('wasm');
  rig.run(10);
  expect(rig.reports().at(-1).driftPPM !== null, 'resync: a reading stands before the snap');
  rig.proc.port.onmessage({ data: { type: 'resync' } });
  const before = rig.reports().length;
  rig.run(2);
  const after = rig.reports().slice(before);
  expect(after.length > 0 && after.every(r => r.driftPPM === null && r.driftAvgPPM === null),
    `resync: the snap voids window and average (${after.map(r => r.driftPPM).join(',')})`);
  rig.run(WINDOW + 2);
  expect(rig.reports().at(-1).driftPPM !== null, 'resync: a fresh span restores the reading');
}

// 5: no arrivals, no reading. A frozen machine stops the producer's clock
// rather than running it at a different rate, and there is no rate to compare.
{
  const rig = await makeRig('wasm');
  rig.run(10);
  const before = rig.reports().length;
  rig.coast(3);
  const after = rig.reports().slice(before);
  expect(after.length > 0 && after.at(-1).drained === 0,
    `frozen: nothing arrives (${after.at(-1).drained} drained)`);
  expect(after.at(-1).driftPPM === null,
    `frozen: and the figure says so instead of inventing a rate (${after.at(-1).driftPPM})`);
}

console.log(`\n${tests - failures}/${tests} passed`);
if (failures) process.exit(1);
