// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// embed-sid-wasm.mjs — package the compiled Rust SID engine
// (rust/sid → wasm32-unknown-unknown) as src/sid-wasm-blob.js.
//
// The AudioWorkletGlobalScope has no fetch() and no atob(), so the module
// bytes are embedded base64 with a hand decoder, exactly like the wave
// tables in src/sid-wavetables.js. Rebuild flow:
//   sh rust/sid/build.sh        (cargo build --release + this script)
//
// Usage: node tools/embed-sid-wasm.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM = path.join(ROOT, 'rust/sid/target/wasm32-unknown-unknown/release/sid.wasm');
const OUT = path.join(ROOT, 'src/sid-wasm-blob.js');

const bytes = fs.readFileSync(WASM);
const sha = createHash('sha256').update(bytes).digest('hex');
const b64 = bytes.toString('base64');

const js = `// SPDX-License-Identifier: GPL-3.0-or-later
// src/sid-wasm-blob.js — the compiled WASM SID engine, embedded.
//
// GENERATED FILE — do not edit by hand. Rebuild: sh rust/sid/build.sh
// (cargo build of rust/sid with the pinned toolchain, then
// tools/embed-sid-wasm.mjs). Module sha256: ${sha}
//
// The module is a Rust translation of this project's JavaScript SID engine
// (src/sid-voice.js / src/sid-filter.js reSID paths) — itself a translation
// of reSID as distributed in VICE 3.10 src/resid, Copyright (C) 2010
// Dag Lem, GNU GPL v2 or later; corresponding source: rust/sid/. The
// compiled module statically includes portions of the Rust standard
// library (MIT OR Apache-2.0). See NOTICE.txt.
//
// Embedded base64 with a hand decoder: AudioWorkletGlobalScope has neither
// fetch() nor atob().

const WASM_B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const WASM_B64_REV = (() => {
  const r = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) r[WASM_B64_ALPHA.charCodeAt(i)] = i;
  return r;
})();

export function sidWasmBytes() {
  const s = SID_WASM_B64;
  const out = new Uint8Array(${bytes.length});
  let acc = 0, bits = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = WASM_B64_REV[s.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xFF;
    }
  }
  if (n !== ${bytes.length}) throw new Error('sid-wasm-blob: bad payload length ' + n);
  return out;
}

const SID_WASM_B64 =
'${b64}';
`;

fs.writeFileSync(OUT, js);
console.log(`wrote ${OUT}: ${(bytes.length / 1024).toFixed(1)} KiB wasm → ${(js.length / 1024).toFixed(1)} KiB JS, sha256 ${sha.slice(0, 16)}…`);
