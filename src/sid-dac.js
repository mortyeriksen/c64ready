// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Translated from reSID dac.h/dac.cc as distributed in VICE 3.10 src/resid,
// Copyright (C) 2010 Dag Lem <resid@nimrod.no>, GNU GPL version 2 or (at
// your option) any later version; upstream pin and full attribution in
// NOTICE.txt.
// src/sid-dac.js — reSID R-2R DAC table builder (uint16, with subthreshold
// MOSFET leakage). Split from sid-filter.js so the main thread's shadow-SID
// import graph (machine.js → sid-voice.js) doesn't pull in the whole filter
// module; the worklet imports both.

// R-2R ladder with per-model 2R/R ratio, optional termination, and
// subthreshold MOSFET leakage (unset bits contribute leakage×bit weight).
const MOSFET_LEAKAGE_6581 = 0.0075;
const MOSFET_LEAKAGE_8580 = 0.0035;

export function buildDacTableU16(bits, _2R_div_R, term) {
  const vbit = new Float64Array(bits);
  const leakage = term ? MOSFET_LEAKAGE_8580 : MOSFET_LEAKAGE_6581;

  for (let set_bit = 0; set_bit < bits; set_bit++) {
    let bit;
    let Vn = 1.0;
    const R = 1.0;
    const _2R = _2R_div_R * R;
    let Rn = term ? _2R : Infinity;

    for (bit = 0; bit < set_bit; bit++) {
      Rn = (Rn === Infinity) ? (R + _2R) : (R + (_2R * Rn) / (_2R + Rn));
    }

    if (Rn === Infinity) {
      Rn = _2R;
    } else {
      Rn = (_2R * Rn) / (_2R + Rn);
      Vn = (Vn * Rn) / _2R;
    }

    for (++bit; bit < bits; bit++) {
      Rn += R;
      const I = Vn / Rn;
      Rn = (_2R * Rn) / (_2R + Rn);
      Vn = Rn * I;
    }

    vbit[set_bit] = Vn;
  }

  const n = 1 << bits;
  const dac = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let Vo = 0;
    for (let j = 0; j < bits; j++) {
      Vo += ((x & 1) ? 1.0 : leakage) * vbit[j];
      x >>= 1;
    }
    dac[i] = Math.floor((n - 1) * Vo + 0.5) & 0xFFFF;
  }
  return dac;
}
