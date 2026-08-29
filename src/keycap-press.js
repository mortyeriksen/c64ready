// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// ============================================================================
// REMOVABLE PROTOTYPE — keycap press animation for the 3D model.
//
// Sinks a keycap on the modelled keyboard while the matching C64 key is held,
// letting it spring back on release. Currently wired for the keys used to type
// LOAD"*",8,1 (plus RETURN) and the two cursor keys.
//
// Fully isolated so it can be deleted wholesale — remove:
//   1. this file,
//   2. the `import { attachKeycapPresses }` line in retrovibes.js,
//   3. the `this._keycap = attachKeycapPresses(...)` block in retrovibes.js's
//      model-load callback, and
//   4. the `this._keycap?.update()` call in retrovibes.js's _loop().
// Nothing else references it; it reads live key state off window.machine.
// ============================================================================

// Each entry: the C64 keyboard-matrix position (col,row — see the C64_KEY_LABELS
// map in main.js) + the keycap's centre in the keyboard mesh's LOCAL space and
// the half-extents of its footprint box. Centres were read off the GLB by
// clustering the keycap tops into the C64 layout (rows by Z, keys by X).
const HX = 0.10, HZ = 0.088;   // default half-footprint of a standard keycap
// Full C64 keyboard. Each key: matrix (col c, row r) + keycap centre (mesh-local
// cx, cz) and optional wider half-extents (hx/hz). Positions read off the GLB by
// clustering keycap tops into the C64 layout; (c,r) match C64_KEY_LABELS in
// main.js. RESTORE is omitted (it's an NMI line, not in the keyboard matrix).
const KEYS = [
  // ── Number row (z 0.83) ──
  { c: 7, r: 1, cx: -1.10, cz: 0.83 }, // ← (arrow-left)
  { c: 7, r: 0, cx: -0.88, cz: 0.83 }, // 1
  { c: 7, r: 3, cx: -0.65, cz: 0.83 }, // 2
  { c: 1, r: 0, cx: -0.42, cz: 0.83 }, // 3
  { c: 1, r: 3, cx: -0.19, cz: 0.83 }, // 4
  { c: 2, r: 0, cx: 0.03, cz: 0.83 },  // 5
  { c: 2, r: 3, cx: 0.26, cz: 0.83 },  // 6
  { c: 3, r: 0, cx: 0.49, cz: 0.83 },  // 7
  { c: 3, r: 3, cx: 0.72, cz: 0.83 },  // 8
  { c: 4, r: 0, cx: 0.94, cz: 0.83 },  // 9
  { c: 4, r: 3, cx: 1.17, cz: 0.83 },  // 0
  { c: 5, r: 0, cx: 1.40, cz: 0.83 },  // +
  { c: 5, r: 3, cx: 1.62, cz: 0.83 },  // -
  { c: 6, r: 0, cx: 1.85, cz: 0.83 },  // £
  { c: 6, r: 3, cx: 2.08, cz: 0.83 },  // CLR/HOME
  { c: 0, r: 0, cx: 2.31, cz: 0.83 },  // INST/DEL
  // ── QWERTY row (z 1.03) ──
  { c: 7, r: 2, cx: -1.04, cz: 1.03, hx: 0.14 }, // CTRL (wide)
  { c: 7, r: 6, cx: -0.75, cz: 1.03 }, // Q
  { c: 1, r: 1, cx: -0.53, cz: 1.03 }, // W
  { c: 1, r: 6, cx: -0.30, cz: 1.03 }, // E
  { c: 2, r: 1, cx: -0.07, cz: 1.03 }, // R
  { c: 2, r: 6, cx: 0.15, cz: 1.03 },  // T
  { c: 3, r: 1, cx: 0.38, cz: 1.03 },  // Y
  { c: 3, r: 6, cx: 0.61, cz: 1.03 },  // U
  { c: 4, r: 1, cx: 0.83, cz: 1.03 },  // I
  { c: 4, r: 6, cx: 1.06, cz: 1.03 },  // O
  { c: 5, r: 1, cx: 1.29, cz: 1.03 },  // P
  { c: 5, r: 6, cx: 1.51, cz: 1.03 },  // @
  { c: 6, r: 1, cx: 1.74, cz: 1.03 },  // *
  { c: 6, r: 6, cx: 1.97, cz: 1.03 },  // ↑ (up-arrow)
  // ── ASDF row (z 1.22) ──
  { c: 7, r: 7, cx: -1.14, cz: 1.22 }, // RUN/STOP
  { c: 1, r: 7, cx: -0.91, cz: 1.22 }, // SHIFT-LOCK (latches left shift 1,7)
  { c: 1, r: 2, cx: -0.69, cz: 1.22 }, // A
  { c: 1, r: 5, cx: -0.46, cz: 1.22 }, // S
  { c: 2, r: 2, cx: -0.24, cz: 1.22 }, // D
  { c: 2, r: 5, cx: -0.01, cz: 1.22 }, // F
  { c: 3, r: 2, cx: 0.22, cz: 1.22 },  // G
  { c: 3, r: 5, cx: 0.44, cz: 1.22 },  // H
  { c: 4, r: 2, cx: 0.67, cz: 1.22 },  // J
  { c: 4, r: 5, cx: 0.89, cz: 1.22 },  // K
  { c: 5, r: 2, cx: 1.12, cz: 1.22 },  // L
  { c: 5, r: 5, cx: 1.35, cz: 1.22 },  // :
  { c: 6, r: 2, cx: 1.57, cz: 1.22 },  // ;
  { c: 6, r: 5, cx: 1.80, cz: 1.22 },  // =
  { c: 0, r: 1, cx: 2.14, cz: 1.22, hx: 0.27, hz: 0.11 }, // RETURN (wide)
  // ── ZXCV row (z 1.40) ──
  { c: 7, r: 5, cx: -1.14, cz: 1.40 }, // C= (Commodore)
  { c: 1, r: 7, cx: -0.85, cz: 1.40, hx: 0.15 }, // LEFT SHIFT
  { c: 1, r: 4, cx: -0.56, cz: 1.40 }, // Z
  { c: 2, r: 7, cx: -0.34, cz: 1.40 }, // X
  { c: 2, r: 4, cx: -0.11, cz: 1.40 }, // C
  { c: 3, r: 7, cx: 0.11, cz: 1.40 },  // V
  { c: 3, r: 4, cx: 0.33, cz: 1.40 },  // B
  { c: 4, r: 7, cx: 0.56, cz: 1.40 },  // N
  { c: 4, r: 4, cx: 0.78, cz: 1.40 },  // M
  { c: 5, r: 7, cx: 1.00, cz: 1.40 },  // ,
  { c: 5, r: 4, cx: 1.22, cz: 1.40 },  // .
  { c: 6, r: 7, cx: 1.45, cz: 1.40 },  // /
  { c: 6, r: 4, cx: 1.73, cz: 1.40, hx: 0.15 }, // RIGHT SHIFT
  { c: 0, r: 7, cx: 2.03, cz: 1.40 },  // CRSR ↑/↓
  { c: 0, r: 2, cx: 2.25, cz: 1.40 },  // CRSR ←/→
  // ── Space bar (z 1.59) ──
  { c: 7, r: 4, cx: 0.40, cz: 1.59, hx: 1.00 }, // SPACE (very wide — cap top spans x[-0.585,1.387], measured from the 3D keycap mesh)
  // ── Function column (x 2.85) ──
  { c: 0, r: 4, cx: 2.85, cz: 0.83, hx: 0.18 }, // F1
  { c: 0, r: 5, cx: 2.85, cz: 1.02, hx: 0.18 }, // F3
  { c: 0, r: 6, cx: 2.85, cz: 1.21, hx: 0.18 }, // F5
  { c: 0, r: 3, cx: 2.85, cz: 1.40, hx: 0.18 }, // F7
];

const TRAVEL = 0.04;   // how far a cap sinks, along the mesh's local −Y (down)
const LERP   = 0.3;    // per-frame approach toward the target (snappy)

// keyboardMesh = the model's "computer_keyboard" mesh. Returns { update() } to
// call once per rendered frame; a no-op stub if the mesh is unusable.
export function attachKeycapPresses(keyboardMesh) {
  if (!keyboardMesh || !keyboardMesh.geometry || !keyboardMesh.geometry.attributes.position) {
    return { update() {} };
  }
  const posAttr = keyboardMesh.geometry.attributes.position;

  const keys = KEYS.map((k) => ({
    col: k.c, row: k.r,
    x0: k.cx - (k.hx ?? HX), x1: k.cx + (k.hx ?? HX),
    z0: k.cz - (k.hz ?? HZ), z1: k.cz + (k.hz ?? HZ),
    verts: [], restY: [], cur: 0,
  }));

  // One pass over the mesh: assign each vertex to the first key whose footprint
  // box contains it (boxes don't overlap, so first-match is unambiguous).
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), z = posAttr.getZ(i);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (x >= key.x0 && x <= key.x1 && z >= key.z0 && z <= key.z1) {
        key.verts.push(i); key.restY.push(posAttr.getY(i));
        break;
      }
    }
  }
  const dirty = posAttr.isInterleavedBufferAttribute ? posAttr.data : posAttr;

  return {
    update() {
      const m = (typeof window !== 'undefined') ? window.machine : null;
      if (!m || !m.cia1 || typeof m.cia1.isKeyDown !== 'function') return;
      let changed = false;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (key.verts.length === 0) continue;
        const target = m.cia1.isKeyDown(key.col, key.row) ? TRAVEL : 0;
        if (key.cur === target) continue;             // settled — skip
        key.cur += (target - key.cur) * LERP;
        if (Math.abs(target - key.cur) < 1e-4) key.cur = target;
        for (let j = 0; j < key.verts.length; j++) posAttr.setY(key.verts[j], key.restY[j] - key.cur);
        changed = true;
      }
      if (changed) dirty.needsUpdate = true;
    },
  };
}
