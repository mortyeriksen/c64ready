// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// embed-rcheevos-wasm.mjs — package the compiled rcheevos module
// (native/rcheevos → wasm32-wasip1) as src/achievements/rcheevos-wasm-blob.js,
// so the app's build needs no C compiler. Rebuild flow:
//   sh native/rcheevos/build.sh        (clang + this script)
//
// Before writing, it checks the module: rcheevos's C64 hash of a known buffer
// must be that buffer's MD5, as computed here independently.
//
// Usage: node tools/embed-rcheevos-wasm.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM = path.join(ROOT, 'native/rcheevos/build/rcheevos.wasm');
const OUT = path.join(ROOT, 'src/achievements/rcheevos-wasm-blob.js');

const bytes = fs.readFileSync(WASM);
const sha = createHash('sha256').update(bytes).digest('hex');

const { loadRcheevos } = await import('../src/achievements/rcheevos.js');
const rc = await loadRcheevos(bytes);
const probe = new TextEncoder().encode('C64 READY. rcheevos embed check');
const expected = createHash('md5').update(probe).digest('hex');
if (rc.hash(probe) !== expected) {
  console.error(`rcheevos hash check failed: got ${rc.hash(probe)}, expected ${expected}`);
  process.exit(1);
}

const js = `// SPDX-License-Identifier: GPL-3.0-or-later
// src/achievements/rcheevos-wasm-blob.js — rcheevos compiled to WebAssembly, embedded.
//
// GENERATED FILE — do not edit by hand. Rebuild: sh native/rcheevos/build.sh
// (clang to wasm32-wasip1, then tools/embed-rcheevos-wasm.mjs). Module sha256: ${sha}
//
// The module is RetroAchievements' rcheevos ${rc.versionString} (MIT,
// Copyright (c) 2018 RetroAchievements.org; source: native/rcheevos/rcheevos/)
// with this project's glue (native/rcheevos/c64_cheevos.c), and statically
// includes wasi-libc (MIT, Apache-2.0 and others) and LLVM compiler-rt
// builtins (Apache-2.0 WITH LLVM-exception). See NOTICE.txt.

export const RCHEEVOS_WASM_SHA256 = '${sha}';
export const RCHEEVOS_WASM_BASE64 = '${bytes.toString('base64')}';
`;
fs.writeFileSync(OUT, js);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${bytes.length} bytes, rcheevos ${rc.versionString}, sha256 ${sha.slice(0, 16)}…`);
