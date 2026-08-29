// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// A Rust translation of reSID as distributed in VICE 3.10 src/resid,
// Copyright (C) 2010 Dag Lem <resid@nimrod.no> (voice.cc portions (C)
// 2004), GNU GPL version 2 or (at your option) any later version — the
// WASM SID engine for the c64 emulator. Mirrors the VICE-gated JavaScript
// translation (src/sid-voice.js, src/sid-filter.js, src/sid-worklet.js
// reSID paths) structure-for-structure; upstream pin and attribution in
// NOTICE.txt at the repository root.
//
// Scope: the AUDIO pipeline only (3 voices → transistor filter/mixer/
// volume → external RC filter → SINC resampler). $D41B/$D41C readback is
// served by the main thread's JS shadow voices, so the OSC3 view pipeline
// is intentionally absent. Single-instance, single-threaded (worklet).
//
// C ABI (no wasm-bindgen):
//   sid_init(sample_rate, is8580) -> 0    power cycle; builds FIR + tables
//   sid_set_model(is8580)                 lazy heavy-table build per model
//   sid_reset()                           /RESET (accumulators survive)
//   sid_write(reg, val)                   immediate register write
//   sid_queue_write(cycle, reg, val)      cycle-stamped write (u32 wrap)
//   sid_set_cycle(cycle)                  align internal clock (JS syncs)
//   sid_current_cycle() -> u32
//   sid_render(n) -> n                    n mono i16 samples into out buf
//   sid_out_ptr() -> *const i16           out buffer (capacity 512)

mod filter;
mod tables;
mod voice;

use filter::{clip16, ExtFilt, Filter, Light, Model};
use tables::{build_dac_table, WaveTables};
use voice::Voice;

const CLOCK: f64 = 985248.0;
const RINGSIZE: usize = 1 << 14;
const RINGMASK: u32 = (RINGSIZE as u32) - 1;
const FIXP_SHIFT: u32 = 16;
const FIXP_MASK: u32 = 0xFFFF;
const FIR_SHIFT: i32 = 15;
const EVQ_CAP: usize = 1 << 18;
const OUT_CAP: usize = 512;

struct Resampler {
    fir: Vec<i16>,
    fir_n: usize,
    fir_res: u32,
    ring: Vec<i16>,
    sample_index: u32,
    sample_offset: u32,
    cps_fx: u32,
}

fn i0(x: f64) -> f64 {
    // 0th-order modified Bessel (resample-1.5/filterkit.c, J.O. Smith).
    let i0e = 1e-6;
    let mut sum = 1.0;
    let mut u = 1.0;
    let mut n = 1.0;
    let halfx = x / 2.0;
    loop {
        let temp = halfx / n;
        n += 1.0;
        u *= temp * temp;
        sum += u;
        if u < i0e * sum {
            break;
        }
    }
    sum
}

impl Resampler {
    // reSID sid.cc set_sampling_parameters, SAMPLE_RESAMPLE branch, with
    // the VICE runtime defaults (passband 90 → 0.45·Fs, gain 0.97).
    fn new(rate: f64) -> Resampler {
        let pass_freq = rate * 90.0 / 200.0;
        let filter_scale = 0.97;
        let pi = core::f64::consts::PI;

        let a = -20.0 * (1.0 / 65536.0f64).log10();
        let dw = (1.0 - 2.0 * pass_freq / rate) * pi * 2.0;
        let wc = pi;
        let beta = 0.1102 * (a - 8.7);
        let i0beta = i0(beta);

        let mut n = ((a - 7.95) / (2.285 * dw) + 0.5).floor() as i32;
        n += n & 1;

        let f_samples_per_cycle = rate / CLOCK;
        let f_cycles_per_sample = CLOCK / rate;

        let mut fir_n = (n as f64 * f_cycles_per_sample) as i32 + 1;
        fir_n |= 1;
        let res = 285.0f64;
        let n2 = (res / f_cycles_per_sample).ln() / 2.0f64.ln();
        let fir_res = 1u32 << (n2.ceil() as u32);

        let fir_n = fir_n as usize;
        let mut fir = vec![0i16; fir_n * fir_res as usize];
        let half = (fir_n >> 1) as i32;
        for i in 0..fir_res as usize {
            let fir_offset = i * fir_n + half as usize;
            let j_offset = i as f64 / fir_res as f64;
            for j in -half..=half {
                let jx = j as f64 - j_offset;
                let wt = wc * jx / f_cycles_per_sample;
                let temp = jx / half as f64;
                let kaiser = if temp.abs() <= 1.0 { i0(beta * (1.0 - temp * temp).sqrt()) / i0beta } else { 0.0 };
                let sincwt = if wt.abs() >= 1e-6 { wt.sin() / wt } else { 1.0 };
                let val = 32768.0 * filter_scale * f_samples_per_cycle * wc / pi * sincwt * kaiser;
                // JS Math.round: half-up for positives, half-toward-+inf for
                // negatives (round(-0.5) = -0). Match it exactly.
                fir[(fir_offset as i32 + j) as usize] = (val + 0.5).floor() as i16;
            }
        }

        Resampler {
            fir,
            fir_n,
            fir_res,
            ring: vec![0i16; RINGSIZE * 2],
            sample_index: 0,
            sample_offset: 0,
            cps_fx: (CLOCK / rate * (1u32 << FIXP_SHIFT) as f64 + 0.5).floor() as u32,
        }
    }

    fn reset(&mut self) {
        self.sample_index = 0;
        self.sample_offset = 0;
        self.ring.iter_mut().for_each(|s| *s = 0);
    }
}

struct Sid {
    voices: [Voice; 3],
    wt6581: WaveTables,
    wt8580: WaveTables,
    wdac: [Vec<u16>; 2],
    edac: [Vec<u16>; 2],
    light: [Light; 2],
    models: [Option<Box<Model>>; 2],
    mixer0: [i32; 2],
    filter: Filter,
    extfilt: ExtFilt,
    is8580: bool,
    scale_factor: i32,
    // Event queue (cycle-stamped writes from the JS transport).
    ev_cyc: Vec<u32>,
    ev_pk: Vec<u16>,
    ev_head: usize,
    ev_count: usize,
    current_cycle: u32,
    rs: Resampler,
    out: [i16; OUT_CAP],
}

const WAVE_ZERO: [i32; 2] = [0x380, 0x9E0];

impl Sid {
    /// `models`/`mixer0` carry the (expensive) filter-table caches across a
    /// power cycle — sid_init hands the previous instance's caches in so a
    /// state load / power cycle never re-runs the table build on the audio
    /// thread (the JS engine gets the same for free from its module-scope
    /// MODEL_CACHE). Fresh boot passes [None, None].
    fn new(rate: f64, is8580: bool, models: [Option<Box<Model>>; 2], mixer0: [i32; 2]) -> Sid {
        let mut s = Sid {
            voices: [Voice::new(), Voice::new(), Voice::new()],
            wt6581: tables::wavetables_6581(),
            wt8580: tables::wavetables_8580(),
            wdac: [build_dac_table(12, 2.20, false), build_dac_table(12, 2.00, true)],
            edac: [build_dac_table(8, 2.20, false), build_dac_table(8, 2.00, true)],
            light: [filter::light_params(0), filter::light_params(1)],
            models,
            mixer0,
            filter: Filter::new(),
            extfilt: ExtFilt::new(),
            is8580,
            scale_factor: if is8580 { 5 } else { 3 },
            ev_cyc: vec![0; EVQ_CAP],
            ev_pk: vec![0; EVQ_CAP],
            ev_head: 0,
            ev_count: 0,
            current_cycle: 0,
            rs: Resampler::new(rate),
            out: [0; OUT_CAP],
        };
        s.set_model(is8580);
        s
    }

    fn model_idx(&self) -> usize {
        if self.is8580 { 1 } else { 0 }
    }

    fn ensure_model(&mut self, m: usize) {
        if self.models[m].is_none() {
            let model = filter::build_model(m, &self.light[m]);
            // input(0): ve = mixer[0] (the op-amp "zero" level).
            self.mixer0[m] = model.mixer[0] as i32;
            self.models[m] = Some(Box::new(model));
        }
    }

    fn set_model(&mut self, is8580: bool) {
        self.is8580 = is8580;
        for v in self.voices.iter_mut() {
            v.is8580 = is8580;
        }
        let m = self.model_idx();
        self.ensure_model(m);
        self.filter.set_chip_model(m, &self.light, self.mixer0[m]);
        self.scale_factor = if is8580 { 5 } else { 3 };
    }

    fn reset(&mut self) {
        for v in self.voices.iter_mut() {
            v.reset();
        }
        self.filter.reset(&self.light);
        self.extfilt.reset();
        self.ev_head = 0;
        self.ev_count = 0;
        self.rs.reset();
    }

    fn write(&mut self, reg: u32, val: u32) {
        let reg = reg & 0x1F;
        if reg < 7 {
            self.voices[0].write(reg, val);
        } else if reg < 14 {
            self.voices[1].write(reg - 7, val);
        } else if reg < 21 {
            self.voices[2].write(reg - 14, val);
        } else if reg == 21 {
            self.filter.write_fc_lo(val, &self.light);
        } else if reg == 22 {
            self.filter.write_fc_hi(val, &self.light);
        } else if reg == 23 {
            self.filter.write_res_filt(val);
        } else if reg == 24 {
            self.filter.write_mode_vol(val);
        }
    }

    fn queue_write(&mut self, cycle: u32, reg: u32, val: u32) {
        if self.ev_count == EVQ_CAP {
            // Overflow: drop the oldest (mirrors the JS pend-mirror safety).
            self.ev_head = (self.ev_head + 1) & (EVQ_CAP - 1);
            self.ev_count -= 1;
        }
        let w = (self.ev_head + self.ev_count) & (EVQ_CAP - 1);
        self.ev_cyc[w] = cycle;
        self.ev_pk[w] = (((val & 0xFF) << 5) | (reg & 0x1F)) as u16;
        self.ev_count += 1;
    }

    #[inline]
    fn apply_due(&mut self) {
        while self.ev_count > 0 {
            let cyc = self.ev_cyc[self.ev_head];
            let delta = self.current_cycle.wrapping_sub(cyc);
            if delta > 0x7FFF_FFFF {
                break; // head still in the future
            }
            let pk = self.ev_pk[self.ev_head] as u32;
            self.ev_head = (self.ev_head + 1) & (EVQ_CAP - 1);
            self.ev_count -= 1;
            self.write(pk & 0x1F, (pk >> 5) & 0xFF);
        }
    }

    /// One SID cycle: sync pulses → clock cores → audio output stages →
    /// filter/mixer/volume → external filter. Returns clip16(ext out).
    #[inline]
    fn clock_raw(&mut self, mf: &Model, wt: &WaveTables, wdac: &[u16], edac: &[u16], wz: i32) -> i32 {
        // computeSyncPulses (reSID synchronize semantics, pre-clock).
        let v = &mut self.voices;
        if (v[0].ctrl | v[1].ctrl | v[2].ctrl) & 0x02 == 0 {
            v[0].sync_pulse = false;
            v[1].sync_pulse = false;
            v[2].sync_pulse = false;
        } else {
            let r0 = v[0].predict_msb_rise();
            let r1 = v[1].predict_msb_rise();
            let r2 = v[2].predict_msb_rise();
            v[0].sync_pulse = r2 && (v[0].ctrl & 0x02) != 0 && !((v[2].ctrl & 0x02) != 0 && r1);
            v[1].sync_pulse = r0 && (v[1].ctrl & 0x02) != 0 && !((v[0].ctrl & 0x02) != 0 && r2);
            v[2].sync_pulse = r1 && (v[2].ctrl & 0x02) != 0 && !((v[1].ctrl & 0x02) != 0 && r0);
        }
        v[0].clock_core();
        v[1].clock_core();
        v[2].clock_core();
        // Ring-mod sources (v1←v3, v2←v1, v3←v2), read SEQUENTIALLY like
        // the JS/reSID output-stage order: each stage may run the 6581
        // saw-MSB pulldown on its own phase, and the NEXT stage's ring
        // source must see that post-pulldown value (v1 sees v3 with last
        // cycle's pulldown already stored).
        let p2 = v[2].phase;
        let o1 = v[0].output_stage_audio(p2, wt, wdac, edac, wz);
        let p0 = v[0].phase;
        let o2 = v[1].output_stage_audio(p0, wt, wdac, edac, wz);
        let p1 = v[1].phase;
        let o3 = v[2].output_stage_audio(p1, wt, wdac, edac, wz);
        clip16(self.extfilt.clock_out(self.filter.clock_out(mf, o1, o2, o3)))
    }

    fn render(&mut self, n: usize) -> usize {
        let n = n.min(OUT_CAP);
        let m = self.model_idx();
        // Split the borrows: take the model box out for the duration.
        let model = self.models[m].take().expect("model built in set_model");
        let mf: &Model = &model;
        for i in 0..n {
            let next_offset = self.rs.sample_offset + self.rs.cps_fx;
            let count = next_offset >> FIXP_SHIFT;
            for _ in 0..count {
                self.apply_due();
                let s = {
                    let wt: *const WaveTables = if self.is8580 { &self.wt8580 } else { &self.wt6581 };
                    let wdac: *const Vec<u16> = &self.wdac[m];
                    let edac: *const Vec<u16> = &self.edac[m];
                    // Safe: these fields are disjoint from the &mut self
                    // parts clock_raw touches (voices/filter/extfilt).
                    unsafe { self.clock_raw(mf, &*wt, &*wdac, &*edac, WAVE_ZERO[m]) }
                };
                let idx = self.rs.sample_index as usize;
                self.rs.ring[idx] = s as i16;
                self.rs.ring[idx + RINGSIZE] = s as i16;
                self.rs.sample_index = (self.rs.sample_index + 1) & RINGMASK;
                self.current_cycle = self.current_cycle.wrapping_add(1);
            }
            self.apply_due();
            self.rs.sample_offset = next_offset & FIXP_MASK;

            let fir_offset = ((self.rs.sample_offset * self.rs.fir_res) >> FIXP_SHIFT) as usize;
            let fir_offset_rmd = (self.rs.sample_offset * self.rs.fir_res) & FIXP_MASK;
            let fir_n = self.rs.fir_n;
            let fir_start = fir_offset * fir_n;
            let smp_start = self.rs.sample_index as usize + RINGSIZE - fir_n - 1;
            let fir = &self.rs.fir;
            let ring = &self.rs.ring;
            let mut v1: i64 = 0;
            let mut v2: i64 = 0;
            if fir_offset + 1 != self.rs.fir_res as usize {
                let fb = fir_start + fir_n;
                for j in 0..fir_n {
                    let s = ring[smp_start + j] as i64;
                    v1 += fir[fir_start + j] as i64 * s;
                    v2 += fir[fb + j] as i64 * s;
                }
            } else {
                for j in 0..fir_n {
                    v1 += fir[fir_start + j] as i64 * ring[smp_start + j] as i64;
                }
                let s2 = smp_start + 1;
                for (k, f) in fir.iter().take(fir_n).enumerate() {
                    v2 += *f as i64 * ring[s2 + k] as i64;
                }
            }
            let v1 = v1 as i32; // JS |0 wrap semantics
            let v2 = v2 as i32;
            let interp = ((fir_offset_rmd.wrapping_mul(v2.wrapping_sub(v1) as u32)) >> FIXP_SHIFT) as i32;
            let mut v = v1.wrapping_add(interp);
            v >>= FIR_SHIFT;
            // VICE wrapper amplify: clip(scaleFactor·v / 2), C division
            // truncating toward zero.
            let p = self.scale_factor as i64 * v as i64;
            self.out[i] = clip16((p / 2) as i32) as i16;
        }
        self.models[m] = Some(model);
        n
    }
}

// ── C ABI (single instance; the worklet is single-threaded) ───────────────

static mut SID_PTR: *mut Sid = core::ptr::null_mut();

#[no_mangle]
pub extern "C" fn sid_init(sample_rate: f64, is8580: i32) -> i32 {
    unsafe {
        // Power cycle: fresh chip state (power-up accumulators, cleared
        // queue/clock) but KEEP the built filter-table caches — rebuilding
        // them here would stall the audio thread for hundreds of ms on
        // every state load / power cycle (audible as distortion on mobile).
        let mut models: [Option<Box<Model>>; 2] = [None, None];
        let mut mixer0 = [0i32; 2];
        if !SID_PTR.is_null() {
            let old = &mut *SID_PTR;
            models = [old.models[0].take(), old.models[1].take()];
            mixer0 = old.mixer0;
            drop(Box::from_raw(SID_PTR));
            SID_PTR = core::ptr::null_mut();
        }
        SID_PTR = Box::into_raw(Box::new(Sid::new(sample_rate, is8580 != 0, models, mixer0)));
    }
    0
}

#[inline]
fn sid() -> &'static mut Sid {
    unsafe { &mut *SID_PTR }
}

#[no_mangle]
pub extern "C" fn sid_set_model(is8580: i32) {
    sid().set_model(is8580 != 0);
}

#[no_mangle]
pub extern "C" fn sid_reset() {
    sid().reset();
}

#[no_mangle]
pub extern "C" fn sid_write(reg: i32, val: i32) {
    sid().write(reg as u32, val as u32);
}

#[no_mangle]
pub extern "C" fn sid_queue_write(cycle: u32, reg: i32, val: i32) {
    sid().queue_write(cycle, reg as u32, val as u32);
}

#[no_mangle]
pub extern "C" fn sid_set_cycle(cycle: u32) {
    let s = sid();
    if cycle == s.current_cycle {
        return; // steady state: the JS mirror hands back our own clock
    }
    // Clock jump (desync snap, resync after thaw, engine switch): events
    // still queued carry stamps from the OLD cycle domain. Left in place
    // they would either clog the FIFO head as bogus-future or fire at a
    // wrong time later — apply them immediately IN ORDER instead, which is
    // exactly what the JS pend queue does with past-due heads.
    while s.ev_count > 0 {
        let pk = s.ev_pk[s.ev_head] as u32;
        s.ev_head = (s.ev_head + 1) & (EVQ_CAP - 1);
        s.ev_count -= 1;
        s.write(pk & 0x1F, (pk >> 5) & 0xFF);
    }
    s.current_cycle = cycle;
}

#[no_mangle]
pub extern "C" fn sid_current_cycle() -> u32 {
    sid().current_cycle
}

#[no_mangle]
pub extern "C" fn sid_pend_count() -> i32 {
    sid().ev_count as i32
}

/// Debug/test probe: bit 0 = 6581 filter tables built, bit 1 = 8580.
/// The power-cycle spec test asserts the caches survive sid_init.
#[no_mangle]
pub extern "C" fn sid_models_cached() -> i32 {
    let s = sid();
    (s.models[0].is_some() as i32) | ((s.models[1].is_some() as i32) << 1)
}

#[no_mangle]
pub extern "C" fn sid_render(n: i32) -> i32 {
    sid().render(n as usize) as i32
}

#[no_mangle]
pub extern "C" fn sid_out_ptr() -> *const i16 {
    sid().out.as_ptr()
}
