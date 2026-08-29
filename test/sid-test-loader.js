// sid-test-loader.js — Helper for SID test files. Concatenates
// src/sid-voice.js + src/sid-worklet.js, strips ESM `import`/`export`
// keywords so `vm.runInContext` can eval them, and exposes the classes
// + constants on the provided context. Needed because the SID
// source files use real ES modules now (so the AudioWorklet and the
// main-thread shadow can share the same SIDVoice code), but the test
// harness loads them into a `vm` context that does NOT honour module
// imports.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.dirname(new URL(import.meta.url).pathname) + '/..';

export function loadSidIntoContext(extraStubs = {}) {
  const wasmBlobSrc = fs.readFileSync(path.join(ROOT, 'src', 'sid-wasm-blob.js'), 'utf8');
  const waveSrc = fs.readFileSync(path.join(ROOT, 'src', 'sid-wavetables.js'), 'utf8');
  const dacSrc = fs.readFileSync(path.join(ROOT, 'src', 'sid-dac.js'), 'utf8');
  const filterSrc = fs.readFileSync(path.join(ROOT, 'src', 'sid-filter.js'), 'utf8');
  const voiceSrc = fs.readFileSync(path.join(ROOT, 'src', 'sid-voice.js'), 'utf8');
  const workletSrc = fs.readFileSync(path.join(ROOT, 'src', 'sid-worklet.js'), 'utf8');
  // Strip ESM keywords for vm-eval. `import {...} from '...'` lines and
  // bare `export` keywords disappear; the classes/constants remain
  // declared in the eval scope. Concatenation order = dependency order:
  // wasm-blob → wavetables → dac → filter → voice → worklet.
  const stripped = (wasmBlobSrc + '\n' + waveSrc + '\n' + dacSrc + '\n' + filterSrc + '\n' + voiceSrc + '\n' + workletSrc)
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^import\s+\S+\s+from\s+['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');

  const ctx = {
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
    },
    registerProcessor: () => {},
    sampleRate: 44100,
    Atomics: globalThis.Atomics,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Int16Array, Int8Array, Float32Array,
    Math, SharedArrayBuffer,
    WebAssembly: globalThis.WebAssembly,
    ...extraStubs,
  };
  vm.createContext(ctx);
  // Expose the names we want to extract after eval.
  const exportTrailer = `;this.SIDVoice=SIDVoice;this.SIDChip=SIDChip;this.SIDProcessor=SIDProcessor;this.RATE_PERIODS=RATE_PERIODS;this.NOISE_TAPS=NOISE_TAPS;this.makeVoiceTrio=makeVoiceTrio;this.computeSyncPulses=computeSyncPulses;this.WAVE_DAC_6581=WAVE_DAC_6581;this.WAVE_DAC_8580=WAVE_DAC_8580;this.ENV_DAC_6581=ENV_DAC_6581;this.ENV_DAC_8580=ENV_DAC_8580;this.WAVE_ZERO_6581=WAVE_ZERO_6581;this.WAVE_ZERO_8580=WAVE_ZERO_8580;this.COMBINED_6581=COMBINED_6581;this.COMBINED_8580=COMBINED_8580;this.SIDFilter=SIDFilter;this.SIDExternalFilter=SIDExternalFilter;this.buildFilterModel=buildFilterModel;this.buildDacTableU16=buildDacTableU16;this.clip16=clip16;this.sidWasmBytes=sidWasmBytes;`;
  vm.runInContext(stripped + exportTrailer, ctx);
  return ctx;
}
