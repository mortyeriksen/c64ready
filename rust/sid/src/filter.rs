// SPDX-License-Identifier: GPL-3.0-or-later
// Translated from reSID (filter8580new.h/filter8580new.cc, extfilt.h/
// extfilt.cc, spline.h) as distributed in VICE 3.10 src/resid, Copyright
// (C) 2010 Dag Lem, GNU GPL v2 or later. Mirror of the VICE-gated
// JavaScript translation in src/sid-filter.js (fused clockOut form).

use crate::tables::build_dac_table;

// Measured op-amp voltage transfer curves (6581 R4AR / 8580 R5).
const OPAMP_6581: [(f64, f64); 35] = [
    (0.81, 10.31), (0.81, 10.31), (2.40, 10.31), (2.60, 10.30), (2.70, 10.29),
    (2.80, 10.26), (2.90, 10.17), (3.00, 10.04), (3.10, 9.83), (3.20, 9.58),
    (3.30, 9.32), (3.50, 8.69), (3.70, 8.00), (4.00, 6.89), (4.40, 5.21),
    (4.54, 4.54), (4.60, 4.19), (4.80, 3.00), (4.90, 2.30), (4.95, 2.03),
    (5.00, 1.88), (5.05, 1.77), (5.10, 1.69), (5.20, 1.58), (5.40, 1.44),
    (5.60, 1.33), (5.80, 1.26), (6.00, 1.21), (6.40, 1.12), (7.00, 1.02),
    (7.50, 0.97), (8.50, 0.89), (10.00, 0.81), (10.31, 0.81), (10.31, 0.81),
];
const OPAMP_8580: [(f64, f64); 23] = [
    (1.30, 8.91), (1.30, 8.91), (4.76, 8.91), (4.77, 8.90), (4.78, 8.88),
    (4.785, 8.86), (4.79, 8.80), (4.795, 8.60), (4.80, 8.25), (4.805, 7.50),
    (4.81, 6.10), (4.815, 4.05), (4.82, 2.27), (4.825, 1.65), (4.83, 1.55),
    (4.84, 1.47), (4.85, 1.43), (4.87, 1.37), (4.90, 1.34), (5.00, 1.30),
    (5.10, 1.30), (8.91, 1.30), (8.91, 1.30),
];

fn res_gain_8580(n8: usize) -> f64 {
    const FB: [f64; 4] = [1.4, (1.4 * 15.3) / (1.4 + 15.3), (1.4 * 7.3) / (1.4 + 7.3), (1.4 * 4.7) / (1.4 + 4.7)];
    const RIN: [f64; 4] = [1.0, 1.4, 2.0, 2.8];
    FB[n8 & 3] / RIN[n8 >> 2]
}

struct ModelInit {
    opamp: &'static [(f64, f64)],
    voice_range: f64,
    voice_dc_v: f64,
    c: f64,
    vdd: f64,
    vth: f64,
    ut: f64,
    k: f64,
    ucox: f64,
    wl_vcr: f64,
    wl_snake: f64,
    dac_zero: f64,
    dac_scale: f64,
    dac_2r: f64,
    dac_term: bool,
}

const INIT: [ModelInit; 2] = [
    ModelInit {
        opamp: &OPAMP_6581, voice_range: 1.5, voice_dc_v: 5.075, c: 470e-12,
        vdd: 12.18, vth: 1.31, ut: 26.0e-3, k: 1.0, ucox: 20e-6,
        wl_vcr: 9.0, wl_snake: 1.0 / 115.0,
        dac_zero: 6.65, dac_scale: 2.63, dac_2r: 2.20, dac_term: false,
    },
    ModelInit {
        opamp: &OPAMP_8580, voice_range: 0.24, voice_dc_v: 4.7975, c: 22e-9,
        vdd: 9.09, vth: 0.80, ut: 26.0e-3, k: 1.0, ucox: 100e-6,
        wl_vcr: 0.0, wl_snake: 0.0,
        dac_zero: 0.0, dac_scale: 0.0, dac_2r: 2.00, dac_term: true,
    },
];

const VREF: f64 = 4.7975;

pub const SUMMER_OFFSET: [usize; 5] = [0, 2 << 16, 5 << 16, 9 << 16, 14 << 16];
const SUMMER_SIZE: usize = 20 << 16;
pub const MIXER_OFFSET: [usize; 8] = {
    let mut o = [0usize; 8];
    o[1] = 1;
    let mut i = 2;
    while i < 8 {
        o[i] = o[i - 1] + ((i - 1) << 16);
        i += 1;
    }
    o
};
const MIXER_SIZE: usize = MIXER_OFFSET[7] + (7 << 16);

/// Light per-model parameters (closed formulas + the 2 KiB cutoff DAC).
pub struct Light {
    pub vmin: f64,
    pub n16: f64,
    pub kvddt: i32,
    pub voice_scale_s14: i32,
    pub voice_dc: i32,
    pub filter_gain: i32,
    pub n_snake: i32,
    pub n_param: i32,
    pub f0_dac: Vec<u16>,
}

pub fn light_params(m: usize) -> Light {
    let fi = &INIT[m];
    let vmin = fi.opamp[0].0;
    let opamp_max = fi.opamp[0].1;
    let kvddt_v = fi.k * (fi.vdd - fi.vth);
    let vmax = if kvddt_v < opamp_max { opamp_max } else { kvddt_v };
    let denorm = vmax - vmin;
    let norm = 1.0 / denorm;
    let n16 = norm * 65535.0;
    let n_param_tmp = denorm * (1 << 13) as f64 * ((fi.ucox / 2.0) * 1.0e-6 / fi.c);

    let mut f0_dac = vec![0u16; 2048];
    if m == 0 {
        let raw = build_dac_table(11, fi.dac_2r, fi.dac_term);
        for (n, slot) in f0_dac.iter_mut().enumerate() {
            *slot = ((n16 * (fi.dac_zero + raw[n] as f64 * fi.dac_scale / 2048.0 - vmin) + 0.5)
                .trunc() as i64 & 0xFFFF) as u16;
        }
    } else {
        let dac_wl: u32 = 806;
        f0_dac[0] = (dac_wl >> 8) as u16;
        for n in 1..2048usize {
            let mut wl: u32 = 0;
            for i in 0..11 {
                let bit = 1u32 << i;
                if n as u32 & bit != 0 {
                    wl += dac_wl * (bit << 1);
                }
            }
            f0_dac[n] = (wl >> 8) as u16;
        }
    }

    Light {
        vmin,
        n16,
        kvddt: (n16 * (kvddt_v - vmin) + 0.5).trunc() as i32,
        voice_scale_s14: ((norm * (1 << 14) as f64) * fi.voice_range).trunc() as i32,
        voice_dc: (n16 * (fi.voice_dc_v - vmin)).trunc() as i32,
        filter_gain: (((if m == 0 { 0.93f64 } else { 1.0f64 }) * 4096.0).trunc() as i32),
        n_snake: (fi.wl_snake * n_param_tmp + 0.5).trunc() as i32,
        n_param: (n_param_tmp * 32.0 + 0.5).trunc() as i32,
        f0_dac,
    }
}

/// Heavy per-model tables (~10.4 MiB), incl. the 6581 VCR tables.
pub struct Model {
    pub kvddt: i32,
    pub voice_scale_s14: i32,
    pub voice_dc: i32,
    pub filter_gain: i32,
    pub n_snake: i32,
    pub ak: i32,
    pub bk: i32,
    pub opamp_rev: Vec<u16>,
    pub summer: Vec<u16>,
    pub mixer: Vec<u16>,
    pub gain: Vec<Vec<u16>>,
    pub resonance: Vec<Vec<u16>>,
    // 6581 only (empty for the 8580).
    pub vcr_kvg: Vec<u16>,
    pub vcr_n_ids_term: Vec<u16>,
}

// spline.h forward-differencing interpolation onto integer x.
fn interpolate(points: &[(f64, f64)], out: &mut [u32]) {
    let n = points.len();
    for i in 0..n.saturating_sub(3) {
        let p0 = points[i];
        let p1 = points[i + 1];
        let p2 = points[i + 2];
        let p3 = points[i + 3];
        if p1.0 == p2.0 {
            continue;
        }
        let (k1, k2);
        if p0.0 == p1.0 && p2.0 == p3.0 {
            k1 = (p2.1 - p1.1) / (p2.0 - p1.0);
            k2 = k1;
        } else if p0.0 == p1.0 {
            k2 = (p3.1 - p1.1) / (p3.0 - p1.0);
            k1 = (3.0 * (p2.1 - p1.1) / (p2.0 - p1.0) - k2) / 2.0;
        } else if p2.0 == p3.0 {
            k1 = (p2.1 - p0.1) / (p2.0 - p0.0);
            k2 = (3.0 * (p2.1 - p1.1) / (p2.0 - p1.0) - k1) / 2.0;
        } else {
            k1 = (p2.1 - p0.1) / (p2.0 - p0.0);
            k2 = (p3.1 - p1.1) / (p3.0 - p1.0);
        }
        // cubic coefficients + forward differencing, res = 1.0
        let dx = p2.0 - p1.0;
        let dy = p2.1 - p1.1;
        let a = ((k1 + k2) - 2.0 * dy / dx) / (dx * dx);
        let b = ((k2 - k1) / dx - 3.0 * (p1.0 + p2.0) * a) / 2.0;
        let c = k1 - (3.0 * p1.0 * a + 2.0 * b) * p1.0;
        let d = p1.1 - ((p1.0 * a + b) * p1.0 + c) * p1.0;
        let x1 = p1.0;
        let mut y = ((a * x1 + b) * x1 + c) * x1 + d;
        let mut dyf = (3.0 * a * (x1 + 1.0) + 2.0 * b) * x1 + ((a + b) + c);
        let mut d2y = (6.0 * a * (x1 + 1.0) + 2.0 * b);
        let d3y = 6.0 * a;
        let mut x = x1;
        while x <= p2.0 {
            let yy = if y < 0.0 { 0.0 } else { y };
            out[x.trunc() as usize] = (yy + 0.5) as u32;
            y += dyf;
            dyf += d2y;
            d2y += d3y;
            x += 1.0;
        }
    }
}

// solve_gain_d: Newton-Raphson + bisection over the op-amp transfer.
#[allow(clippy::too_many_arguments)]
fn solve_gain_d(
    vx_t: &[u16],
    dvx_t: &[i32],
    n: f64,
    vi: i32,
    x: &mut i32,
    ak: i32,
    bk: i32,
    kvddt: i32,
) -> u16 {
    let mut ak = ak;
    let mut bk = bk;
    let a = n + 1.0;
    let b = kvddt;
    let b_vi = if b > vi { (b - vi) as f64 } else { 0.0 };
    let c = n * (b_vi * b_vi);

    loop {
        let xk = *x;
        let vx = vx_t[*x as usize] as i32;
        let dvx = dvx_t[*x as usize];

        let mut vo = vx + (*x << 1) - (1 << 16);
        if vo > 65535 {
            vo = 65535;
        } else if vo < 0 {
            vo = 0;
        }

        let b_vx = if b > vx { (b - vx) as f64 } else { 0.0 };
        let b_vo = if b > vo { (b - vo) as f64 } else { 0.0 };
        let f = a * (b_vx * b_vx) - c - (b_vo * b_vo);
        let df = 2.0 * (b_vo - a * b_vx) * dvx as f64;

        if df != 0.0 {
            *x -= (2048.0 * f / df).trunc() as i32;
        }
        if *x == xk {
            return vo as u16;
        }

        if f < 0.0 {
            ak = xk;
        } else {
            bk = xk;
        }
        if *x <= ak || *x >= bk {
            *x = (ak + bk) >> 1;
            if *x == ak {
                return vo as u16;
            }
        }
    }
}

pub fn build_model(m: usize, lp: &Light) -> Model {
    let fi = &INIT[m];
    let vmin = lp.vmin;
    let n16 = lp.n16;
    let n31 = (n16 / 65535.0) * (2f64.powi(31) - 1.0);

    // Scale the measured curve to the 16-bit x axis; spline-expand.
    let np = fi.opamp.len();
    let mut scaled: Vec<(f64, f64)> = vec![(0.0, 0.0); np];
    for i in 0..np {
        scaled[np - 1 - i] = (
            n16 * (fi.opamp[i].1 - fi.opamp[i].0) / 2.0 + (1 << 15) as f64,
            n31 * (fi.opamp[i].0 - vmin),
        );
    }
    if scaled[np - 1].0 > 65535.0 {
        scaled[np - 1].0 = 65535.0;
        scaled[np - 2].0 = 65535.0;
    }

    let mut voltages = vec![0u32; 1 << 16];
    interpolate(&scaled, &mut voltages);

    let ak = (scaled[0].0 + 0.5).trunc() as i32;
    let bk = (scaled[np - 1].0 + 0.5).trunc() as i32;

    let mut vx_t = vec![0u16; 1 << 16];
    let mut dvx_t = vec![0i32; 1 << 16];
    let mut fv = voltages[ak as usize];
    for j in ak..bk {
        let fp = fv;
        fv = voltages[j as usize];
        let df = fv.wrapping_sub(fp) as i32;
        vx_t[j as usize] = if fv > 0x7FFF8000 { 0xFFFF } else { (fv >> 15) as u16 };
        dvx_t[j as usize] = df >> 4; // 15 - 11
    }
    dvx_t[ak as usize] = dvx_t[ak as usize + 1];

    let solve = |n: f64, vi: i32, x: &mut i32| solve_gain_d(&vx_t, &dvx_t, n, vi, x, ak, bk, lp.kvddt);

    // Summer: 2-6 input "resistors", n ≈ 1.
    let mut summer = vec![0u16; SUMMER_SIZE];
    {
        let mut offset = 0usize;
        for k in 0..5 {
            let idiv = 2 + k as i32;
            let size = (idiv as usize) << 16;
            let mut x = ak;
            for vi in 0..size {
                summer[offset + vi] = solve(idiv as f64, vi as i32 / idiv, &mut x);
            }
            offset += size;
        }
    }

    // Mixer: 0-7 inputs, n ≈ 8/6 (6581) or 8/5 (8580).
    let mut mixer = vec![0u16; MIXER_SIZE];
    {
        let divider = if m == 0 { 6.0 } else { 5.0 };
        let mut offset = 0usize;
        let mut size = 1usize;
        for l in 0..8 {
            let mut idiv = l as i32;
            let n_div = ((l << 3) as f64) / divider;
            if idiv == 0 {
                idiv = 1;
            }
            let mut x = ak;
            for vi in 0..size {
                mixer[offset + vi] = solve(n_div, vi as i32 / idiv, &mut x);
            }
            offset += size;
            size = (l + 1) << 16;
        }
    }

    // Volume gain: 16 tables (the chip's nonlinear $D418 ladder).
    let mut gain: Vec<Vec<u16>> = Vec::with_capacity(16);
    {
        let divider = if m == 0 { 12.0 } else { 16.0 };
        for n8 in 0..16 {
            let mut t = vec![0u16; 1 << 16];
            let mut x = ak;
            for (vi, slot) in t.iter_mut().enumerate() {
                *slot = solve(n8 as f64 / divider, vi as i32, &mut x);
            }
            gain.push(t);
        }
    }

    let mut opamp_rev = vec![0u16; 1 << 16];
    opamp_rev.copy_from_slice(&vx_t);

    // Resonance ladders.
    let mut resonance: Vec<Vec<u16>> = Vec::with_capacity(16);
    for n8 in 0..16 {
        let n = if m == 0 { ((!n8) & 0xF) as f64 / 8.0 } else { res_gain_8580(n8) };
        let mut t = vec![0u16; 1 << 16];
        let mut x = ak;
        for (vi, slot) in t.iter_mut().enumerate() {
            *slot = solve(n, vi as i32, &mut x);
        }
        resonance.push(t);
    }

    // 6581 VCR tables.
    let (mut vcr_kvg, mut vcr_n_ids_term) = (Vec::new(), Vec::new());
    if m == 0 {
        vcr_kvg = vec![0u16; 1 << 16];
        vcr_n_ids_term = vec![0u16; 1 << 16];
        let kvddt_n = n16 * (fi.k * (fi.vdd - fi.vth));
        let vmin_n = vmin * n16;
        for (i, slot) in vcr_kvg.iter_mut().enumerate() {
            let vg = kvddt_n - (i as f64 * 65536.0).sqrt();
            *slot = (((fi.k * vg - vmin_n + 0.5).trunc() as i64) & 0xFFFF) as u16;
        }
        let kvt = fi.k * fi.vth;
        let ut = fi.ut;
        let is = ((2.0 * fi.ucox * ut * ut) / fi.k) * fi.wl_vcr;
        let n_is = (n16 / 2.0) * 1.0e-6 / fi.c * is;
        for (i, slot) in vcr_n_ids_term.iter_mut().enumerate() {
            let kvg_vx = i as f64 - (1 << 15) as f64;
            let log_term = (1.0 + ((kvg_vx / n16 - kvt) / (2.0 * ut)).exp()).ln();
            *slot = (((n_is * log_term * log_term).trunc() as i64) & 0xFFFF) as u16;
        }
    }

    Model {
        kvddt: lp.kvddt,
        voice_scale_s14: lp.voice_scale_s14,
        voice_dc: lp.voice_dc,
        filter_gain: lp.filter_gain,
        n_snake: lp.n_snake,
        ak,
        bk,
        opamp_rev,
        summer,
        mixer,
        gain,
        resonance,
        vcr_kvg,
        vcr_n_ids_term,
    }
}

/// Deterministic dither ring (mirrors the JS engine's fixed-seed xorshift32
/// exactly, so the two engines' dither sequences are identical).
pub fn dither_ring() -> [i32; 1024] {
    let mut buf = [0i32; 1024];
    let mut s: i32 = 0x1989cafeu32 as i32;
    for slot in buf.iter_mut() {
        s ^= s << 13;
        s ^= ((s as u32) >> 17) as i32;
        s ^= s << 5;
        *slot = ((s as u32) % (1 << 19)) as i32;
    }
    buf
}

pub struct Filter {
    pub model: usize,
    pub fc: u32,
    pub res: usize,
    pub filt: u32,
    pub mode: u32,
    pub vol: usize,
    voice_mask: u32,
    sum: u32,
    mix: u32,
    vhp: i32,
    vbp: i32,
    vbp_x: i32,
    vbp_vc: i32,
    vlp: i32,
    vlp_x: i32,
    vlp_vc: i32,
    ve: i32,
    vddt_vw_2: u32,
    vw_bias: i32,
    n_dac: i32,
    n_vgt: i32,
    dither: [i32; 1024],
    dither_idx: usize,
}

impl Filter {
    pub fn new() -> Filter {
        Filter {
            model: 0,
            fc: 0,
            res: 0,
            filt: 0,
            mode: 0,
            vol: 0,
            voice_mask: 0xF7, // EXT IN disconnected (VICE set_voice_mask(0x07))
            sum: 0,
            mix: 0,
            vhp: 0,
            vbp: 0,
            vbp_x: 0,
            vbp_vc: 0,
            vlp: 0,
            vlp_x: 0,
            vlp_vc: 0,
            ve: 0,
            vddt_vw_2: 0,
            vw_bias: 0,
            n_dac: 0,
            n_vgt: 0,
            dither: dither_ring(),
            dither_idx: 0,
        }
    }

    pub fn set_chip_model(&mut self, m: usize, light: &[Light; 2], mixer0: i32) {
        self.model = m;
        // VICE defaults: bias 0.5 V (6581) / 0.0 V (8580), reapplied on switch.
        self.adjust_filter_bias(if m == 0 { 0.5 } else { 0.0 }, light);
        self.vhp = 0;
        self.vbp = 0;
        self.vbp_x = 0;
        self.vbp_vc = 0;
        self.vlp = 0;
        self.vlp_x = 0;
        self.vlp_vc = 0;
        self.ve = mixer0; // input(0): op-amp "zero" level
        self.set_sum_mix();
    }

    pub fn reset(&mut self, light: &[Light; 2]) {
        self.fc = 0;
        self.res = 0;
        self.filt = 0;
        self.mode = 0;
        self.vol = 0;
        self.vhp = 0;
        self.vbp = 0;
        self.vbp_x = 0;
        self.vbp_vc = 0;
        self.vlp = 0;
        self.vlp_x = 0;
        self.vlp_vc = 0;
        self.set_w0(light);
        self.set_sum_mix();
    }

    pub fn adjust_filter_bias(&mut self, dac_bias: f64, light: &[Light; 2]) {
        self.vw_bias = (dac_bias * light[0].n16).trunc() as i32;
        let fi = &INIT[1];
        let vg = VREF * (dac_bias * 6.0 / 100.0 + 1.6);
        let vgt = vg - fi.vth;
        self.n_vgt = (light[1].n16 * (vgt - fi.opamp[0].0) + 0.5).trunc() as i32;
        self.set_w0(light);
    }

    pub fn write_fc_lo(&mut self, v: u32, light: &[Light; 2]) {
        self.fc = (self.fc & 0x7F8) | (v & 0x007);
        self.set_w0(light);
    }
    pub fn write_fc_hi(&mut self, v: u32, light: &[Light; 2]) {
        self.fc = ((v << 3) & 0x7F8) | (self.fc & 0x007);
        self.set_w0(light);
    }
    pub fn write_res_filt(&mut self, v: u32) {
        self.res = ((v >> 4) & 0x0F) as usize;
        self.filt = v & 0x0F;
        self.set_sum_mix();
    }
    pub fn write_mode_vol(&mut self, v: u32) {
        self.mode = v & 0xF0;
        self.set_sum_mix();
        self.vol = (v & 0x0F) as usize;
    }

    fn set_w0(&mut self, light: &[Light; 2]) {
        {
            let lp = &light[0];
            let d = lp.kvddt - (self.vw_bias + lp.f0_dac[self.fc as usize] as i32);
            self.vddt_vw_2 = (((d as u32 as u64) * (d as u32 as u64)) / 2) as u32;
        }
        {
            let lp = &light[1];
            self.n_dac = (lp.n_param * lp.f0_dac[self.fc as usize] as i32) >> 11;
        }
    }

    fn set_sum_mix(&mut self) {
        // voice3off only affects a voice 3 routed DIRECTLY to the mixer.
        self.sum = self.filt & self.voice_mask;
        self.mix = ((self.mode & 0x70) | ((!(self.filt | ((self.mode & 0x80) >> 5))) & 0x0F)) & self.voice_mask;
    }

    #[inline]
    fn integrate_6581(vx: &mut i32, vc: &mut i32, vi: i32, mf: &Model, vddt_vw_2: u32) -> i32 {
        let kvddt = mf.kvddt;
        let vgst = kvddt.wrapping_sub(*vx);
        let vgdt = kvddt.wrapping_sub(vi);
        let vgdt2 = vgdt.wrapping_mul(vgdt);
        let n_i_snake = mf.n_snake.wrapping_mul(vgst.wrapping_mul(vgst).wrapping_sub(vgdt2) >> 15);
        let kvg = mf.vcr_kvg[(vddt_vw_2.wrapping_add((vgdt2 as u32) >> 1) >> 16) as usize] as i32;
        let vgs = ((kvg - *vx + (1 << 15)) & 0xFFFF) as usize;
        let vgd = ((kvg - vi + (1 << 15)) & 0xFFFF) as usize;
        let n_i_vcr = (mf.vcr_n_ids_term[vgs] as i32 - mf.vcr_n_ids_term[vgd] as i32) << 15;
        *vc = vc.wrapping_sub(n_i_snake.wrapping_add(n_i_vcr));
        *vx = mf.opamp_rev[(((*vc >> 15) + (1 << 15)) & 0xFFFF) as usize] as i32;
        vx.wrapping_add(*vc >> 14)
    }

    #[inline]
    fn integrate_8580(vx: &mut i32, vc: &mut i32, vi: i32, mf: &Model, n_vgt: i32, n_dac: i32) -> i32 {
        let vgst = n_vgt.wrapping_sub(*vx);
        let vgdt = if vi < n_vgt { n_vgt.wrapping_sub(vi) } else { 0 };
        let n_i_rfc = n_dac.wrapping_mul(vgst.wrapping_mul(vgst).wrapping_sub(vgdt.wrapping_mul(vgdt)) >> 15) >> 4;
        *vc = vc.wrapping_sub(n_i_rfc);
        *vx = mf.opamp_rev[(((*vc >> 15) + (1 << 15)) & 0xFFFF) as usize] as i32;
        vx.wrapping_add(*vc >> 14)
    }

    /// Fused clock + output: one SID cycle in, the 16-bit mixer/volume
    /// output back (mirrors src/sid-filter.js clockOut exactly).
    pub fn clock_out(&mut self, mf: &Model, voice1: i32, voice2: i32, voice3: i32) -> i32 {
        let scale = mf.voice_scale_s14;
        let vdc = mf.voice_dc;
        let d = &self.dither;
        let mut di = self.dither_idx;
        di = (di + 1) & 0x3FF;
        let v1 = ((voice1.wrapping_mul(scale).wrapping_add(d[di])) >> 18).wrapping_add(vdc);
        di = (di + 1) & 0x3FF;
        let v2 = ((voice2.wrapping_mul(scale).wrapping_add(d[di])) >> 18).wrapping_add(vdc);
        di = (di + 1) & 0x3FF;
        let v3 = ((voice3.wrapping_mul(scale).wrapping_add(d[di])) >> 18).wrapping_add(vdc);
        self.dither_idx = di;

        let s = self.sum;
        let mut vi = 0i32;
        let mut ni = 0usize;
        if s & 1 != 0 { vi += v1; ni += 1; }
        if s & 2 != 0 { vi += v2; ni += 1; }
        if s & 4 != 0 { vi += v3; ni += 1; }
        if s & 8 != 0 { vi += self.ve; ni += 1; }

        let (vlp, vbp);
        if self.model == 0 {
            vlp = Self::integrate_6581(&mut self.vlp_x, &mut self.vlp_vc, self.vbp, mf, self.vddt_vw_2);
            vbp = Self::integrate_6581(&mut self.vbp_x, &mut self.vbp_vc, self.vhp, mf, self.vddt_vw_2);
        } else {
            vlp = Self::integrate_8580(&mut self.vlp_x, &mut self.vlp_vc, self.vbp, mf, self.n_vgt, self.n_dac);
            vbp = Self::integrate_8580(&mut self.vbp_x, &mut self.vbp_vc, self.vhp, mf, self.n_vgt, self.n_dac);
        }
        self.vlp = vlp;
        self.vbp = vbp;
        let vhp = mf.summer
            [SUMMER_OFFSET[ni] + mf.resonance[self.res][(vbp & 0xFFFF) as usize] as usize + vlp as usize + vi as usize]
            as i32;
        self.vhp = vhp;

        let m = self.mix;
        let mut mi = 0i32;
        let mut nm = 0usize;
        if m & 0x70 != 0 {
            let mut flt = 0i32;
            if m & 0x10 != 0 { flt += vlp; nm += 1; }
            if m & 0x20 != 0 { flt += vbp; nm += 1; }
            if m & 0x40 != 0 { flt += vhp; nm += 1; }
            mi = (flt * mf.filter_gain + 32767 * (4096 - mf.filter_gain)) >> 12;
        }
        if m & 0x01 != 0 { mi += v1; nm += 1; }
        if m & 0x02 != 0 { mi += v2; nm += 1; }
        if m & 0x04 != 0 { mi += v3; nm += 1; }
        if m & 0x08 != 0 { mi += self.ve; nm += 1; }

        mf.gain[self.vol][mf.mixer[MIXER_OFFSET[nm] + mi as usize] as usize] as i32 - (1 << 15)
    }
}

/// reSID ExternalFilter (integer C64 output RC model), fused clock+output.
pub struct ExtFilt {
    vlp: i32,
    vhp: i32,
    w0lp_1_s7: i32,
    w0hp_1_s17: i32,
}

impl ExtFilt {
    pub fn new() -> ExtFilt {
        ExtFilt {
            vlp: 0,
            vhp: 0,
            w0lp_1_s7: ((1e-6f64 / (1e-6 + 1e4 * 1e-9) * 128.0 + 0.5).trunc() as i32),
            w0hp_1_s17: ((1e-6f64 / (1e-6 + 1e3 * 1e-5) * 131072.0 + 0.5).trunc() as i32),
        }
    }
    pub fn reset(&mut self) {
        self.vlp = 0;
        self.vhp = 0;
    }
    #[inline]
    pub fn clock_out(&mut self, vi: i32) -> i32 {
        let vlp = self.vlp.wrapping_add(self.w0lp_1_s7.wrapping_mul((vi << 11).wrapping_sub(self.vlp)) >> 7);
        let vhp = self.vhp.wrapping_add(self.w0hp_1_s17.wrapping_mul(self.vlp.wrapping_sub(self.vhp)) >> 17);
        self.vlp = vlp;
        self.vhp = vhp;
        (vlp - vhp) >> 11
    }
}

#[inline]
pub fn clip16(x: i32) -> i32 {
    x.clamp(-32768, 32767)
}
