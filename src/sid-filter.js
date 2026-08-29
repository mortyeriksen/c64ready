// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Translated from reSID as distributed in VICE 3.10 src/resid
// (filter8580new.h/filter8580new.cc, extfilt.h/extfilt.cc, dac.h/dac.cc,
// spline.h), Copyright (C) 2010 Dag Lem <resid@nimrod.no>, GNU GPL version 2
// or (at your option) any later version. Modifications for this project
// (JavaScript translation, light/heavy split with lazy per-model table
// construction, deterministic dither source) © 2026 Morten Øien Eriksen.
// Upstream pin (official VICE 3.10 source release, tarball sha256) and full
// attribution in NOTICE.txt.
//
// src/sid-filter.js — reSID transistor-level SID filter / mixer / volume
// stage and the C64 external RC output filter, integer pipeline.
//
// This replaces the previous Chamberlin-SVF stand-in and its calibrated
// approximations (FC6581 anchor table, damp laws, piecewise saturator, DC
// tracker, aggregate VOICE_DC/DIGI constants, linear master volume). The
// model is reSID's: measured NMOS op-amp voltage transfer curves (6581
// R4AR / 8580 R5) are spline-expanded and pre-solved into lookup tables for
// the summer, mixer, resonance and volume-gain op-amp stages; the cutoff
// VCR (6581) / DAC ladder (8580) integrators run a fixpoint step per cycle
// through those tables. The $D418 volume stage is the chip's actual
// nonlinear gain ladder — volume-register digis and Mahoney-style DAC
// tricks come out of the physics instead of calibration constants.
//
// Table memory is ~10.4 MiB per model (Uint16), built lazily on the first
// setChipModel() of each model and cached for the session; construction
// solves the op-amp equations with the same Newton-Raphson/bisection
// routine as reSID (solve_gain_d), so the tables match the reference.
// Scale constants and the 2 KiB cutoff-DAC tables are "light" parameters,
// computed from closed formulas for both models up front (set_w0 and
// adjust_filter_bias touch both models in the reference).

// The reSID R-2R DAC builder (dac.cc port) lives in ./sid-dac.js so the
// main thread's shadow-SID import graph stays free of this module.
import { buildDacTableU16 } from './sid-dac.js';

// ── spline.h: Catmull-Rom-like piecewise cubic, forward differencing ───────
// Interpolates the measured op-amp points onto integer x with the exact
// coefficient and forward-difference formulation of the reference (the fp
// accumulation pattern matters for table-identical results).
function interpolateSegment(x1, y1, x2, y2, k1, k2, plot, res) {
  const dx = x2 - x1, dy = y2 - y1;
  const a = ((k1 + k2) - 2 * dy / dx) / (dx * dx);
  const b = ((k2 - k1) / dx - 3 * (x1 + x2) * a) / 2;
  const c = k1 - (3 * x1 * a + 2 * b) * x1;
  const d = y1 - ((x1 * a + b) * x1 + c) * x1;
  let y = ((a * x1 + b) * x1 + c) * x1 + d;
  let dyf = (3 * a * (x1 + res) + 2 * b) * x1 * res + ((a * res + b) * res + c) * res;
  let d2y = (6 * a * (x1 + res) + 2 * b) * res * res;
  const d3y = 6 * a * res * res * res;
  for (let x = x1; x <= x2; x += res) {
    plot(x, y);
    y += dyf; dyf += d2y; d2y += d3y;
  }
}

function interpolate(points, plot, res) {
  // Mirrors reSID interpolate(p0, pn=last, …): segments are drawn for
  // p2 = points[2] … points[n-2]; repeated end points pin the ends.
  for (let i = 0; i + 3 < points.length; i++) {
    const p0 = points[i], p1 = points[i + 1], p2 = points[i + 2], p3 = points[i + 3];
    let k1, k2;
    if (p1[0] === p2[0]) continue;
    if (p0[0] === p1[0] && p2[0] === p3[0]) {
      k1 = k2 = (p2[1] - p1[1]) / (p2[0] - p1[0]);
    } else if (p0[0] === p1[0]) {
      k2 = (p3[1] - p1[1]) / (p3[0] - p1[0]);
      k1 = (3 * (p2[1] - p1[1]) / (p2[0] - p1[0]) - k2) / 2;
    } else if (p2[0] === p3[0]) {
      k1 = (p2[1] - p0[1]) / (p2[0] - p0[0]);
      k2 = (3 * (p2[1] - p1[1]) / (p2[0] - p1[0]) - k1) / 2;
    } else {
      k1 = (p2[1] - p0[1]) / (p2[0] - p0[0]);
      k2 = (p3[1] - p1[1]) / (p3[0] - p1[0]);
    }
    interpolateSegment(p1[0], p1[1], p2[0], p2[1], k1, k2, plot, res);
  }
}

// ── filter8580new.cc: measured op-amp voltage transfer functions ───────────
// 6581: measured on CAP1B/CAP1A of a chip marked MOS 6581R4AR 0687 14.
const OPAMP_VOLTAGE_6581 = [
  [0.81, 10.31], [0.81, 10.31], [2.40, 10.31], [2.60, 10.30], [2.70, 10.29],
  [2.80, 10.26], [2.90, 10.17], [3.00, 10.04], [3.10, 9.83], [3.20, 9.58],
  [3.30, 9.32], [3.50, 8.69], [3.70, 8.00], [4.00, 6.89], [4.40, 5.21],
  [4.54, 4.54], [4.60, 4.19], [4.80, 3.00], [4.90, 2.30], [4.95, 2.03],
  [5.00, 1.88], [5.05, 1.77], [5.10, 1.69], [5.20, 1.58], [5.40, 1.44],
  [5.60, 1.33], [5.80, 1.26], [6.00, 1.21], [6.40, 1.12], [7.00, 1.02],
  [7.50, 0.97], [8.50, 0.89], [10.00, 0.81], [10.31, 0.81], [10.31, 0.81],
];
// 8580: measured on CAP1B/CAP1A of a chip marked CSG 8580R5 1690 25.
const OPAMP_VOLTAGE_8580 = [
  [1.30, 8.91], [1.30, 8.91], [4.76, 8.91], [4.77, 8.90], [4.78, 8.88],
  [4.785, 8.86], [4.79, 8.80], [4.795, 8.60], [4.80, 8.25], [4.805, 7.50],
  [4.81, 6.10], [4.815, 4.05], [4.82, 2.27], [4.825, 1.65], [4.83, 1.55],
  [4.84, 1.47], [4.85, 1.43], [4.87, 1.37], [4.90, 1.34], [5.00, 1.30],
  [5.10, 1.30], [8.91, 1.30], [8.91, 1.30],
];

// 8580 resonance ladder gains ((Rf‖Rn)/Rin combinations; die-derived).
const RES_GAIN_8580 = [
  1.4 / 1.0,
  ((1.4 * 15.3) / (1.4 + 15.3)) / 1.0,
  ((1.4 * 7.3) / (1.4 + 7.3)) / 1.0,
  ((1.4 * 4.7) / (1.4 + 4.7)) / 1.0,
  1.4 / 1.4,
  ((1.4 * 15.3) / (1.4 + 15.3)) / 1.4,
  ((1.4 * 7.3) / (1.4 + 7.3)) / 1.4,
  ((1.4 * 4.7) / (1.4 + 4.7)) / 1.4,
  1.4 / 2.0,
  ((1.4 * 15.3) / (1.4 + 15.3)) / 2.0,
  ((1.4 * 7.3) / (1.4 + 7.3)) / 2.0,
  ((1.4 * 4.7) / (1.4 + 4.7)) / 2.0,
  1.4 / 2.8,
  ((1.4 * 15.3) / (1.4 + 15.3)) / 2.8,
  ((1.4 * 7.3) / (1.4 + 7.3)) / 2.8,
  ((1.4 * 4.7) / (1.4 + 4.7)) / 2.8,
];

const MODEL_INIT = [
  { // 6581
    opampVoltage: OPAMP_VOLTAGE_6581,
    voiceVoltageRange: 1.5,
    voiceDCVoltage: 5.075,     // 5V +1.5%
    C: 470e-12,
    Vdd: 12.18,                // 12V +1.5%
    Vth: 1.31,
    Ut: 26.0e-3,
    k: 1.0,
    uCox: 20e-6,
    WL_vcr: 9.0 / 1.0,
    WL_snake: 1.0 / 115,
    dacZero: 6.65,
    dacScale: 2.63,
    dac2RDivR: 2.20,
    dacTerm: false,
  },
  { // 8580
    opampVoltage: OPAMP_VOLTAGE_8580,
    voiceVoltageRange: 0.24,   // FIXME in upstream: measure for the 8580
    voiceDCVoltage: 4.7975,    // 4.75V +1%
    C: 22e-9,
    Vdd: 9.09,                 // 9V +1%
    Vth: 0.80,
    Ut: 26.0e-3,
    k: 1.0,
    uCox: 100e-6,
    WL_vcr: 0, WL_snake: 0, dacZero: 0, dacScale: 0,
    dac2RDivR: 2.00,
    dacTerm: true,
  },
];

// The 4.75V virtual ground from the PolySi resistor divider (8580).
const VREF = 4.7975; // 4.75V +1%

// Summer table offsets (2..6 input "resistors") and mixer table offsets
// (0..7 inputs; the 0-input case is a single lookup element at offset 0).
export const SUMMER_OFFSET = [0, 2 << 16, 5 << 16, 9 << 16, 14 << 16];
const SUMMER_SIZE = 20 << 16;
export const MIXER_OFFSET = (() => {
  const o = [0, 1];
  for (let i = 2; i <= 7; i++) o[i] = o[i - 1] + ((i - 1) << 16);
  return o;
})();
const MIXER_SIZE = MIXER_OFFSET[7] + (7 << 16);

// ── Light per-model parameters (closed formulas + 2 KiB DAC tables) ───────
// set_w0() and adjust_filter_bias() consult BOTH models in the reference;
// these stay cheap so the heavy tables are only ever built for the model
// actually being clocked.
const LIGHT = [null, null];

function lightParams(m) {
  if (LIGHT[m]) return LIGHT[m];
  const fi = MODEL_INIT[m];
  const vmin = fi.opampVoltage[0][0];
  const opampMax = fi.opampVoltage[0][1];
  const kVddtV = fi.k * (fi.Vdd - fi.Vth);
  const vmax = kVddtV < opampMax ? opampMax : kVddtV;
  const denorm = vmax - vmin;
  const norm = 1.0 / denorm;
  const N16 = norm * 65535;
  const nParamTmp = denorm * (1 << 13) * ((fi.uCox / 2.0) * 1.0e-6 / fi.C);

  const dacBits = 11;
  const f0Dac = new Uint16Array(1 << dacBits);
  if (m === 0) {
    const dacRaw = buildDacTableU16(dacBits, fi.dac2RDivR, fi.dacTerm);
    for (let n = 0; n < (1 << dacBits); n++) {
      f0Dac[n] = Math.trunc(N16 * (fi.dacZero + dacRaw[n] * fi.dacScale / (1 << dacBits) - vmin) + 0.5) & 0xFFFF;
    }
  } else {
    // Parallel NMOS W/L ladder; bits proportional to W/L.
    const dacWL = 806; // ≈ 0.003075 × 1024 × 256
    f0Dac[0] = dacWL >> 8;
    for (let n = 1; n < (1 << dacBits); n++) {
      let wl = 0;
      for (let i = 0; i < dacBits; i++) {
        const bit = 1 << i;
        if (n & bit) wl += dacWL * (bit << 1);
      }
      f0Dac[n] = wl >> 8;
    }
  }

  LIGHT[m] = {
    vmin, N16,
    kVddt: Math.trunc(N16 * (kVddtV - vmin) + 0.5),
    voiceScaleS14: Math.trunc((norm * (1 << 14)) * fi.voiceVoltageRange),
    voiceDC: Math.trunc(N16 * (fi.voiceDCVoltage - vmin)),
    filterGain: Math.trunc((m === 0 ? 0.93 : 1.0) * (1 << 12)),
    nSnake: Math.trunc(fi.WL_snake * nParamTmp + 0.5),      // 6581
    nParam: Math.trunc(nParamTmp * 32 + 0.5),               // 8580
    f0Dac,
  };
  return LIGHT[m];
}

// solve_gain_d: output voltage of the inverting gain / summer op-amp
// circuits via Newton-Raphson + bisection over the op-amp transfer curve
// (build-time only — the per-cycle path is pure lookups).
function solveGainD(opampVx, opampDvx, n, vi, xRef, ak0, bk0, kVddt) {
  let ak = ak0, bk = bk0;
  const a = n + 1.0;
  const b = kVddt;
  const b_vi = b > vi ? (b - vi) : 0.0;
  const c = n * (b_vi * b_vi);
  let x = xRef[0];

  for (;;) {
    const xk = x;
    const vx = opampVx[x];
    const dvx = opampDvx[x];

    let vo = vx + (x << 1) - (1 << 16);
    if (vo > 65535) vo = 65535;
    else if (vo < 0) vo = 0;

    const b_vx = b > vx ? (b - vx) : 0.0;
    const b_vo = b > vo ? (b - vo) : 0.0;
    const f = a * (b_vx * b_vx) - c - (b_vo * b_vo);
    const df = 2.0 * (b_vo - a * b_vx) * dvx;

    if (df !== 0) {
      x -= Math.trunc(2048 * f / df);
    }
    if (x === xk) {
      xRef[0] = x;
      return vo;
    }

    if (f < 0) ak = xk; else bk = xk;
    if (x <= ak || x >= bk) {
      x = (ak + bk) >> 1;
      if (x === ak) {
        xRef[0] = x;
        return vo;
      }
    }
  }
}

// Static 6581 VCR tables (built with the 6581 heavy tables).
let VCR_KVG = null;          // Uint16Array(65536)
let VCR_N_IDS_TERM = null;   // Uint16Array(65536)

// Heavy per-model table cache (~10.4 MiB per model).
const MODEL_CACHE = [null, null];

export function buildFilterModel(m) {
  if (MODEL_CACHE[m]) return MODEL_CACHE[m];

  const fi = MODEL_INIT[m];
  const lp = lightParams(m);
  const vmin = lp.vmin;
  const N16 = lp.N16;
  const N30 = (N16 / 65535) * ((1 << 30) - 1);
  const N31 = (N16 / 65535) * (2 ** 31 - 1);

  const mf = {
    voN16: N16,
    filterGain: lp.filterGain,
    voiceScaleS14: lp.voiceScaleS14,
    voiceDC: lp.voiceDC,
    kVddt: lp.kVddt,
    ak: 0, bk: 0,
    vcMin: Math.trunc(N30 * (fi.opampVoltage[0][1] - fi.opampVoltage[0][0])),
    vcMax: Math.trunc(N30 * (fi.opampVoltage[fi.opampVoltage.length - 1][1] - fi.opampVoltage[fi.opampVoltage.length - 1][0])),
    opampRev: new Uint16Array(1 << 16),
    summer: new Uint16Array(SUMMER_SIZE),
    mixer: new Uint16Array(MIXER_SIZE),
    gain: [],       // 16 × Uint16Array(65536)
    resonance: [],  // 16 × Uint16Array(65536)
    f0Dac: lp.f0Dac,
  };

  // Scale the measured op-amp curve to a 16-bit x axis (x = (vo−vx)/2,
  // translated +32768) with a 31-bit y axis for derivative accuracy, then
  // spline-expand onto integer x.
  const nPts = fi.opampVoltage.length;
  const scaled = [];
  for (let i = 0; i < nPts; i++) {
    scaled[nPts - 1 - i] = [
      N16 * (fi.opampVoltage[i][1] - fi.opampVoltage[i][0]) / 2 + (1 << 15),
      N31 * (fi.opampVoltage[i][0] - vmin),
    ];
  }
  if (scaled[nPts - 1][0] > 65535) {
    scaled[nPts - 1][0] = 65535;
    scaled[nPts - 2][0] = 65535;
  }

  const voltages = new Uint32Array(1 << 16);
  interpolate(scaled, (x, y) => {
    if (y < 0) y = 0;
    voltages[Math.trunc(x)] = (y + 0.5) >>> 0;
  }, 1.0);

  mf.ak = Math.trunc(scaled[0][0] + 0.5);
  mf.bk = Math.trunc(scaled[nPts - 1][0] + 0.5);

  // Op-amp transfer + derivative, packed like reSID's opamp_t.
  const opampVx = new Uint16Array(1 << 16);
  const opampDvx = new Int32Array(1 << 16);
  let j = mf.ak;
  let fV = voltages[j];
  for (; j < mf.bk; j++) {
    const fp = fV;
    fV = voltages[j];                       // scaled m·2^31
    const df = (fV - fp) | 0;               // scaled 2^15
    opampVx[j] = fV > 0x7FFF8000 ? 0xffff : fV >>> 15;
    opampDvx[j] = df >> (15 - 11);          // scaled 2^11
  }
  opampDvx[mf.ak] = opampDvx[mf.ak + 1];

  const solve = (n, vi, xRef) => solveGainD(opampVx, opampDvx, n, vi, xRef, mf.ak, mf.bk, mf.kVddt);

  // Summer: 2-6 input "resistors", n ≈ 1.
  {
    let offset = 0;
    for (let k = 0; k < 5; k++) {
      const idiv = 2 + k;
      const size = idiv << 16;
      const xRef = [mf.ak];
      for (let vi = 0; vi < size; vi++) {
        mf.summer[offset + vi] = solve(idiv, (vi / idiv) | 0, xRef);
      }
      offset += size;
    }
  }

  // Mixer: 0-7 inputs, n ≈ 8/6 (6581) or 8/5 (8580).
  {
    const divider = m === 0 ? 6.0 : 5.0;
    let offset = 0;
    let size = 1;
    for (let l = 0; l < 8; l++) {
      let idiv = l;
      const nDiv = (l << 3) / divider;
      if (idiv === 0) idiv = 1;
      const xRef = [mf.ak];
      for (let vi = 0; vi < size; vi++) {
        mf.mixer[offset + vi] = solve(nDiv, (vi / idiv) | 0, xRef);
      }
      offset += size;
      size = (l + 1) << 16;
    }
  }

  // Volume gain: 16 tables; gain ≈ vol/12 (6581) or vol/16 (8580) — the
  // chip's actual nonlinear $D418 ladder (volume-digi levels live here).
  {
    const divider = m === 0 ? 12.0 : 16.0;
    for (let n8 = 0; n8 < 16; n8++) {
      const t = new Uint16Array(1 << 16);
      const xRef = [mf.ak];
      for (let vi = 0; vi < (1 << 16); vi++) {
        t[vi] = solve(n8 / divider, vi, xRef);
      }
      mf.gain.push(t);
    }
  }

  // opamp_rev: vc → vx.
  for (let i = 0; i < (1 << 16); i++) mf.opampRev[i] = opampVx[i];

  if (m === 0) {
    // 6581 resonance: 1/Q ≈ ~res/8 (die-derived).
    for (let n8 = 0; n8 < 16; n8++) {
      const t = new Uint16Array(1 << 16);
      const n = (~n8 & 0xf) / 8.0;
      const xRef = [mf.ak];
      for (let vi = 0; vi < (1 << 16); vi++) {
        t[vi] = solve(n, vi, xRef);
      }
      mf.resonance.push(t);
    }

    // VCR gate voltage and EKV-model current term tables.
    VCR_KVG = new Uint16Array(1 << 16);
    VCR_N_IDS_TERM = new Uint16Array(1 << 16);
    const kVddtN = N16 * (fi.k * (fi.Vdd - fi.Vth));
    const vminN = vmin * N16;
    for (let i = 0; i < (1 << 16); i++) {
      const Vg = kVddtN - Math.sqrt(i * 65536);
      VCR_KVG[i] = Math.trunc(fi.k * Vg - vminN + 0.5) & 0xFFFF;
    }
    const kVt = fi.k * fi.Vth;
    const Ut = fi.Ut;
    const Is = ((2 * fi.uCox * Ut * Ut) / fi.k) * fi.WL_vcr;
    const nIs = (N16 / 2) * 1.0e-6 / fi.C * Is;
    for (let i = 0; i < (1 << 16); i++) {
      const kVgVx = i - (1 << 15);
      const logTerm = Math.log1p(Math.exp((kVgVx / N16 - kVt) / (2 * Ut)));
      VCR_N_IDS_TERM[i] = Math.trunc(nIs * logTerm * logTerm) & 0xFFFF;
    }
  } else {
    // 8580 resonance: 1/Q = 2^((4 − res)/8) via the split resistor ladder.
    for (let n8 = 0; n8 < 16; n8++) {
      const t = new Uint16Array(1 << 16);
      const xRef = [mf.ak];
      for (let vi = 0; vi < (1 << 16); vi++) {
        t[vi] = solve(RES_GAIN_8580[n8], vi, xRef);
      }
      mf.resonance.push(t);
    }
  }

  // The 6581 snake current factor rides on the model object so the
  // integrator reads a single object (reSID keeps it as a class static).
  mf._nSnake = lightParams(0).nSnake;

  MODEL_CACHE[m] = mf;
  return mf;
}

// Deterministic replacement for the reference's Randomnoise (libc rand()
// ring): 1024 pre-generated 19-bit dither values from a fixed-seed
// xorshift32. The dither decorrelates voice-scaling quantization; its exact
// sequence is not part of the acoustic model (upstream's depends on libc).
const DITHER = (() => {
  const buf = new Int32Array(1024);
  let s = 0x1989cafe | 0;
  for (let i = 0; i < 1024; i++) {
    s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0;
    buf[i] = (s >>> 0) % (1 << 19);
  }
  return buf;
})();

// ── Filter (filter8580new.h clock/output/registers) ────────────────────────
export class SIDFilter {
  // model: 0 = 6581, 1 = 8580. Builds (or reuses) that model's tables.
  constructor(model = 0) {
    this.enabled = true;
    this.voiceMask = 0xf7;    // EXT IN disconnected (VICE set_voice_mask(0x07))
    this.fc = 0; this.res = 0; this.filt = 0; this.mode = 0; this.vol = 0;
    this.sum = 0; this.mix = 0;
    this.Vhp = 0;
    this.Vbp = 0; this.VbpX = 0; this.VbpVc = 0;
    this.Vlp = 0; this.VlpX = 0; this.VlpVc = 0;
    this.ve = 0;
    this.VddtVw2 = 0; this.VwBias = 0;   // 6581 cutoff terms
    this.nDac = 0; this.nVgt = 0;        // 8580 cutoff terms
    this.ditherIdx = 0;
    this._inputSample = 0;
    this.setChipModel(model);
  }

  setChipModel(m) {
    this.model = m;
    this.mf = buildFilterModel(m);
    // Hot-loop caches: resonance[res]/gain[vol] rows (re-picked on register
    // writes) and the per-model integrator pair — clockOut() then runs with
    // no model branch and monomorphic call sites.
    this._resRow = this.mf.resonance[this.res];
    this._gainRow = this.mf.gain[this.vol];
    this._integLp = m === 0 ? this._integrate6581Lp : this._integrate8580Lp;
    this._integBp = m === 0 ? this._integrate6581Bp : this._integrate8580Bp;
    // VICE runtime defaults: SidResidFilterBias 500 mV (6581) / 0 mV (8580)
    // — the wrapper re-applies the per-model bias on every model switch.
    this.adjustFilterBias(m === 0 ? 0.5 : 0.0);
    this.Vhp = 0;
    this.Vbp = this.VbpX = this.VbpVc = 0;
    this.Vlp = this.VlpX = this.VlpVc = 0;
    this.input(this._inputSample);
    this.setSumMix();
  }

  reset() {
    this.fc = 0; this.res = 0; this.filt = 0; this.mode = 0; this.vol = 0;
    this._resRow = this.mf.resonance[0];
    this._gainRow = this.mf.gain[0];
    this.Vhp = 0;
    this.Vbp = this.VbpX = this.VbpVc = 0;
    this.Vlp = this.VlpX = this.VlpVc = 0;
    this.setW0();
    this.setSumMix();
  }

  // dac_bias in volts (VICE passes bias-mV/1000). Sets the 6581 Vw bias and
  // the 8580 temperature-divider gate voltage (both, like the reference).
  adjustFilterBias(dacBias) {
    this.VwBias = Math.trunc(dacBias * lightParams(0).N16);
    const fi = MODEL_INIT[1];
    const Vg = VREF * (dacBias * 6.0 / 100.0 + 1.6);
    const Vgt = Vg - fi.Vth;
    this.nVgt = Math.trunc(lightParams(1).N16 * (Vgt - fi.opampVoltage[0][0]) + 0.5);
    this.setW0();
  }

  writeFC_LO(v) { this.fc = (this.fc & 0x7f8) | (v & 0x007); this.setW0(); }
  writeFC_HI(v) { this.fc = ((v << 3) & 0x7f8) | (this.fc & 0x007); this.setW0(); }
  writeRES_FILT(v) {
    this.res = (v >> 4) & 0x0f;
    this._resRow = this.mf.resonance[this.res];
    this.filt = v & 0x0f;
    this.setSumMix();
  }
  writeMODE_VOL(v) {
    this.mode = v & 0xf0;
    this.setSumMix();
    this.vol = v & 0x0f;
    this._gainRow = this.mf.gain[this.vol];
  }

  setW0() {
    {
      // MOS 6581: Vw from the cutoff DAC; (kVddt − Vw)²/2 for the VCR gate.
      const lp = lightParams(0);
      const d = (lp.kVddt - (this.VwBias + lp.f0Dac[this.fc]));
      this.VddtVw2 = Math.floor((d >>> 0) * (d >>> 0) / 2);
    }
    {
      // MOS 8580: parallel-NMOS ladder current factor.
      const lp = lightParams(1);
      this.nDac = (lp.nParam * lp.f0Dac[this.fc]) >> 11;
    }
  }

  setSumMix() {
    // NB! voice3off (mode bit 7) only affects voice 3 if it is routed
    // directly to the mixer.
    this.sum = (this.enabled ? this.filt : 0x00) & this.voiceMask;
    this.mix = (this.enabled
      ? (this.mode & 0x70) | ((~(this.filt | (this.mode & 0x80) >> 5)) & 0x0f)
      : 0x0f) & this.voiceMask;
  }

  // EXT IN (16-bit). Grounded on stock C64s; kept for model completeness
  // (the op-amp "zero" mixer[0] term matches the reference's AC-coupling
  // approximation).
  input(sample) {
    this._inputSample = sample;
    const f = this.mf;
    this.ve = (((sample * f.voiceScaleS14 * 3) >> 14) + f.mixer[0]) | 0;
  }

  // 6581 integrators: "snake" triode current + VCR EKV-model current into
  // the capacitor; op-amp inversion via the opamp_rev lookup. Specialized
  // per state pair (bp/lp) so the hot loop carries no selector branches.
  _integrate6581Lp(vi, f) {
    const kVddt = f.kVddt;
    const vx = this.VlpX;
    const Vgst = (kVddt - vx) | 0;
    const Vgdt = (kVddt - vi) | 0;
    const Vgdt2 = Math.imul(Vgdt, Vgdt);
    const nISnake = f._nSnake * ((Math.imul(Vgst, Vgst) - Vgdt2) >> 15);
    const kVg = VCR_KVG[(this.VddtVw2 + (Vgdt2 >>> 1)) >>> 16];
    const nIVcr = ((VCR_N_IDS_TERM[(kVg - vx + (1 << 15)) & 0xFFFF] -
                    VCR_N_IDS_TERM[(kVg - vi + (1 << 15)) & 0xFFFF]) << 15) | 0;
    const vc = (this.VlpVc - (nISnake + nIVcr)) | 0;
    const nvx = f.opampRev[((vc >> 15) + (1 << 15)) & 0xFFFF];
    this.VlpX = nvx; this.VlpVc = vc;
    return (nvx + (vc >> 14)) | 0;
  }
  _integrate6581Bp(vi, f) {
    const kVddt = f.kVddt;
    const vx = this.VbpX;
    const Vgst = (kVddt - vx) | 0;
    const Vgdt = (kVddt - vi) | 0;
    const Vgdt2 = Math.imul(Vgdt, Vgdt);
    const nISnake = f._nSnake * ((Math.imul(Vgst, Vgst) - Vgdt2) >> 15);
    const kVg = VCR_KVG[(this.VddtVw2 + (Vgdt2 >>> 1)) >>> 16];
    const nIVcr = ((VCR_N_IDS_TERM[(kVg - vx + (1 << 15)) & 0xFFFF] -
                    VCR_N_IDS_TERM[(kVg - vi + (1 << 15)) & 0xFFFF]) << 15) | 0;
    const vc = (this.VbpVc - (nISnake + nIVcr)) | 0;
    const nvx = f.opampRev[((vc >> 15) + (1 << 15)) & 0xFFFF];
    this.VbpX = nvx; this.VbpVc = vc;
    return (nvx + (vc >> 14)) | 0;
  }

  // 8580 integrators: parallel NMOS DAC ladder current.
  _integrate8580Lp(vi, f) {
    const nVgt = this.nVgt;
    const Vgst = (nVgt - this.VlpX) | 0;
    const Vgdt = vi < nVgt ? (nVgt - vi) | 0 : 0;
    const nIRfc = (this.nDac * ((Math.imul(Vgst, Vgst) - Math.imul(Vgdt, Vgdt)) >> 15)) >> 4;
    const vc = (this.VlpVc - nIRfc) | 0;
    const nvx = f.opampRev[((vc >> 15) + (1 << 15)) & 0xFFFF];
    this.VlpX = nvx; this.VlpVc = vc;
    return (nvx + (vc >> 14)) | 0;
  }
  _integrate8580Bp(vi, f) {
    const nVgt = this.nVgt;
    const Vgst = (nVgt - this.VbpX) | 0;
    const Vgdt = vi < nVgt ? (nVgt - vi) | 0 : 0;
    const nIRfc = (this.nDac * ((Math.imul(Vgst, Vgst) - Math.imul(Vgdt, Vgdt)) >> 15)) >> 4;
    const vc = (this.VbpVc - nIRfc) | 0;
    const nvx = f.opampRev[((vc >> 15) + (1 << 15)) & 0xFFFF];
    this.VbpX = nvx; this.VbpVc = vc;
    return (nvx + (vc >> 14)) | 0;
  }

  // One SID cycle, fused clock + output (reSID Filter::clock followed by
  // Filter::output — the worklet always calls them back-to-back, so the
  // scaled voices stay in locals instead of round-tripping through fields).
  // voiceN are reSID 20-bit voice outputs ((wave_dac − wave_zero) ×
  // env_dac), range ±(2047×255). Returns the 16-bit mixer/volume output.
  clockOut(voice1, voice2, voice3) {
    const f = this.mf;
    const d = DITHER;
    const scale = f.voiceScaleS14, vdc = f.voiceDC;
    let di = this.ditherIdx;
    const v1 = (((voice1 * scale + d[di = (di + 1) & 0x3ff]) >> 18) + vdc) | 0;
    const v2 = (((voice2 * scale + d[di = (di + 1) & 0x3ff]) >> 18) + vdc) | 0;
    const v3 = (((voice3 * scale + d[di = (di + 1) & 0x3ff]) >> 18) + vdc) | 0;
    this.ditherIdx = di;

    // Sum inputs routed into the filter.
    const s = this.sum;
    let Vi = 0, ni = 0;
    if (s & 1) { Vi += v1; ni++; }
    if (s & 2) { Vi += v2; ni++; }
    if (s & 4) { Vi += v3; ni++; }
    if (s & 8) { Vi += this.ve; ni++; }

    // Vlp integrates the (old) Vbp; Vbp integrates the (old) Vhp — via the
    // per-model integrators bound in setChipModel (no model branch here).
    const Vlp = this._integLp(this.Vbp, f);
    const Vbp = this._integBp(this.Vhp, f);
    this.Vlp = Vlp;
    this.Vbp = Vbp;
    const Vhp = f.summer[SUMMER_OFFSET[ni] + this._resRow[Vbp & 0xFFFF] + Vlp + Vi];
    this.Vhp = Vhp;

    // Mixer + nonlinear volume gain op-amps (reSID Filter::output).
    const m = this.mix;
    let Mi = 0, mi = 0;
    if (m & 0x70) {
      let flt = 0;
      if (m & 0x10) { flt += Vlp; mi++; }
      if (m & 0x20) { flt += Vbp; mi++; }
      if (m & 0x40) { flt += Vhp; mi++; }
      // 6581: the filter lines' mixer input resistors are slightly larger
      // than the voice ones (filterGain = 0.93·4096); the dc_offset keeps
      // the op-amp operating point when scaling down.
      Mi = ((flt * f.filterGain) + 32767 * ((1 << 12) - f.filterGain)) >> 12;
    }
    if (m & 0x01) { Mi += v1; mi++; }
    if (m & 0x02) { Mi += v2; mi++; }
    if (m & 0x04) { Mi += v3; mi++; }
    if (m & 0x08) { Mi += this.ve; mi++; }

    return (this._gainRow[f.mixer[MIXER_OFFSET[mi] + Mi]] - (1 << 15)) | 0;
  }

  serialize() {
    return {
      fc: this.fc, res: this.res, filt: this.filt, mode: this.mode, vol: this.vol,
      Vhp: this.Vhp, Vbp: this.Vbp, VbpX: this.VbpX, VbpVc: this.VbpVc,
      Vlp: this.Vlp, VlpX: this.VlpX, VlpVc: this.VlpVc,
    };
  }
}

// ── ExternalFilter (extfilt.h/extfilt.cc) ──────────────────────────────────
// The C64 output RC networks: ~16 kHz low-pass then ~16 Hz high-pass,
// integer state with 27-bit headroom (reSID's scaling).
export class SIDExternalFilter {
  constructor() {
    // Assume a 1 MHz clock; cutoff accuracy traded for signal accuracy.
    this.w0lp_1_s7 = Math.trunc(1e-6 / (1e-6 + 1e4 * 1e-9) * (1 << 7) + 0.5);
    this.w0hp_1_s17 = Math.trunc(1e-6 / (1e-6 + 1e3 * 1e-5) * (1 << 17) + 0.5);
    this.reset();
  }
  reset() { this.Vlp = 0; this.Vhp = 0; }
  // Fused clock + output (always called back-to-back in the worklet):
  // update both RC states, return the post-update output — identical to
  // reSID's extfilt.clock(Vi) followed by output().
  clockOut(Vi) {
    const Vlp = (this.Vlp + (Math.imul(this.w0lp_1_s7, ((Vi << 11) - this.Vlp) | 0) >> 7)) | 0;
    const Vhp = (this.Vhp + (Math.imul(this.w0hp_1_s17, (this.Vlp - this.Vhp) | 0) >> 17)) | 0;
    this.Vlp = Vlp;
    this.Vhp = Vhp;
    return (Vlp - Vhp) >> 11;
  }
}

// 16-bit saturation, as in the reference wrapper's amplify()/clip().
export function clip16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x;
}
