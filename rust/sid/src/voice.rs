// SPDX-License-Identifier: GPL-3.0-or-later
// Translated from reSID (wave.h/wave.cc, envelope.h/envelope.cc, voice.h/
// voice.cc) as distributed in VICE 3.10 src/resid, Copyright (C) 2010
// Dag Lem (voice.cc portions (C) 2004), GNU GPL v2 or later. Line-for-line
// mirror of the VICE-gated JavaScript translation in src/sid-voice.js
// (audio path only — OSC3/ENV3 readback is served by the main-thread JS
// shadow, so the OSC3 view pipeline is intentionally absent here).

use crate::tables::WaveTables;

pub const RATE_PERIODS: [u16; 16] = [
    9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251,
];

// Envelope states (JS numbering kept: release/idle=0, attack=1, decay/sustain=2).
const S_RELEASE: u8 = 0;
const S_ATTACK: u8 = 1;
const S_DECAY: u8 = 2;

// Floating waveform-DAC decay TTLs (reSID wave.cc FLOATING_OUTPUT_TTL_*).
const FLOAT_TTL_START_6581: i32 = 182_000;
const FLOAT_TTL_BIT_6581: i32 = 1_500;
const FLOAT_TTL_START_8580: i32 = 4_400_000;
const FLOAT_TTL_BIT_8580: i32 = 50_000;

// TEST-held LFSR fade (VICE resid shiftreg_bitfade schedule).
const LFSR_FADE_START_6581: i32 = 35_000;
const LFSR_FADE_BIT_6581: i32 = 1_000;
const LFSR_FADE_START_8580: i32 = 2_519_864;
const LFSR_FADE_BIT_8580: i32 = 315_000;

fn rate_cmp(i: usize) -> u16 {
    RATE_PERIODS[i] - 1
}

pub struct Voice {
    pub freq: u32,
    pub pw: u32,
    pub ctrl: u32,
    pub a: usize,
    pub d: usize,
    pub s: u32,
    pub r: usize,
    pub phase: u32,
    pub prev_phase: u32,
    // Envelope (reSID pipelined model).
    pub env: u32,
    rate_counter: u32,
    exp_counter: u32,
    state: u8,
    rate_period: u16,
    exp_period: u32,
    hold_zero: bool,
    env_pipeline: i32,
    exp_pipeline: i32,
    state_pipeline: i32,
    reset_rate_counter: bool,
    next_state: u8,
    // Noise.
    lfsr: u32,
    noise_val: u32,
    lfsr_reset_ctr: i32,
    shift_pipeline: i32,
    // Selector output latch / floating DAC (reSID waveform_output).
    pub out12: u32,
    float_ttl: i32,
    pub pulse_out: u32,
    pub sync_pulse: bool,
    pub is8580: bool,
}

impl Voice {
    pub fn new() -> Voice {
        let mut v = Voice {
            freq: 0,
            pw: 0,
            ctrl: 0,
            a: 0,
            d: 0,
            s: 0,
            r: 0,
            phase: 0x555555,
            prev_phase: 0x555555,
            env: 0,
            rate_counter: 0,
            exp_counter: 0,
            state: S_RELEASE,
            rate_period: rate_cmp(0),
            exp_period: 1,
            hold_zero: true,
            env_pipeline: 0,
            exp_pipeline: 0,
            state_pipeline: 0,
            reset_rate_counter: false,
            next_state: S_RELEASE,
            lfsr: 0x7FFFFE,
            noise_val: 0,
            lfsr_reset_ctr: 0,
            shift_pipeline: 0,
            out12: 0,
            float_ttl: 0,
            pulse_out: 0xFFF,
            sync_pulse: false,
            is8580: false,
        };
        v.set_noise_output();
        v
    }

    pub fn reset(&mut self) {
        // /RESET: everything clears except the phase accumulator (and the
        // 8580 tri/saw pipe, which this audio-only port doesn't carry).
        self.freq = 0;
        self.pw = 0;
        self.ctrl = 0;
        self.a = 0;
        self.d = 0;
        self.s = 0;
        self.r = 0;
        self.env = 0;
        self.rate_counter = 0;
        self.exp_counter = 0;
        self.state = S_RELEASE;
        self.rate_period = rate_cmp(0);
        self.exp_period = 1;
        self.hold_zero = true;
        self.env_pipeline = 0;
        self.exp_pipeline = 0;
        self.state_pipeline = 0;
        self.reset_rate_counter = false;
        self.next_state = S_RELEASE;
        self.lfsr = 0x7FFFFE;
        self.set_noise_output();
        self.shift_pipeline = 0;
        self.lfsr_reset_ctr = 0;
        self.float_ttl = 0;
        self.out12 = 0;
        self.pulse_out = 0xFFF;
        self.sync_pulse = false;
    }

    fn clock_shift_register(&mut self) {
        let b = ((self.lfsr >> 22) ^ (self.lfsr >> 17)) & 1;
        self.lfsr = ((self.lfsr << 1) | b) & 0x7FFFFF;
        self.set_noise_output();
    }

    fn set_noise_output(&mut self) {
        let l = self.lfsr;
        self.noise_val = ((l & 0x100000) >> 13)
            | ((l & 0x040000) >> 12)
            | ((l & 0x004000) >> 9)
            | ((l & 0x000800) >> 7)
            | ((l & 0x000200) >> 6)
            | ((l & 0x000020) >> 3)
            | ((l & 0x000004) >> 1)
            | (l & 0x000001);
    }

    fn write_shift_register(&mut self, out12: u32) {
        self.lfsr &= !((1 << 20) | (1 << 18) | (1 << 14) | (1 << 11) | (1 << 9) | (1 << 5) | (1 << 2) | 1)
            | ((out12 & 0x800) << 9)
            | ((out12 & 0x400) << 8)
            | ((out12 & 0x200) << 5)
            | ((out12 & 0x100) << 3)
            | ((out12 & 0x080) << 2)
            | ((out12 & 0x040) >> 1)
            | ((out12 & 0x020) >> 3)
            | ((out12 & 0x010) >> 4);
        self.noise_val &= (out12 >> 4) & 0xFF;
    }

    fn shiftreg_bitfade(&mut self) {
        self.lfsr |= 1;
        self.lfsr |= self.lfsr << 1;
        self.set_noise_output();
        if self.lfsr != 0x7FFFFF {
            self.lfsr_reset_ctr = if self.is8580 { LFSR_FADE_BIT_8580 } else { LFSR_FADE_BIT_6581 };
        }
    }

    fn do_pre_writeback(&self, wf_prev: u32, wf: u32) -> bool {
        if wf_prev <= 8 {
            return false;
        }
        if wf_prev == 0xC {
            if !self.is8580 {
                return false;
            }
            if wf != 0x9 && wf != 0xE {
                return false;
            }
        }
        if !self.is8580
            && ((((wf_prev & 3) == 1) && ((wf & 3) == 2)) || (((wf_prev & 3) == 2) && ((wf & 3) == 1)))
        {
            return false;
        }
        true
    }

    pub fn predict_msb_rise(&self) -> bool {
        if self.ctrl & 0x08 != 0 {
            return false;
        }
        (self.phase & 0x800000) == 0 && ((self.phase.wrapping_add(self.freq)) & 0x800000) != 0
    }

    fn set_exp_period(&mut self) {
        match self.env {
            0xFF => self.exp_period = 1,
            0x5D => self.exp_period = 2,
            0x36 => self.exp_period = 4,
            0x1A => self.exp_period = 8,
            0x0E => self.exp_period = 16,
            0x06 => self.exp_period = 30,
            0x00 => {
                self.exp_period = 1;
                self.hold_zero = true;
            }
            _ => {}
        }
    }

    pub fn write(&mut self, reg: u32, val: u32) {
        match reg {
            0 => self.freq = (self.freq & 0xFF00) | val,
            1 => self.freq = (self.freq & 0x00FF) | (val << 8),
            2 => {
                self.pw = (self.pw & 0x0F00) | val;
                self.pulse_out = if self.phase >= ((self.pw & 0x0FFF) << 12) { 0xFFF } else { 0 };
            }
            3 => {
                self.pw = (self.pw & 0x00FF) | ((val & 0x0F) << 8);
                self.pulse_out = if self.phase >= ((self.pw & 0x0FFF) << 12) { 0xFFF } else { 0 };
            }
            4 => {
                let prev_gate = self.ctrl & 1;
                let prev_test = self.ctrl & 0x08;
                let prev_wf = (self.ctrl >> 4) & 0x0F;
                self.ctrl = val;
                let gate = val & 1;
                let test = val & 0x08;
                if (gate != 0) != (prev_gate != 0) {
                    self.next_state = if gate != 0 { S_ATTACK } else { S_RELEASE };
                    if gate != 0 {
                        self.state = S_DECAY;
                        self.rate_period = rate_cmp(self.d);
                        self.state_pipeline = 2;
                        if self.reset_rate_counter || self.exp_pipeline == 2 {
                            self.env_pipeline = if self.exp_period == 1 || self.exp_pipeline == 2 { 2 } else { 4 };
                        } else if self.exp_pipeline == 1 {
                            self.state_pipeline = 3;
                        }
                    } else {
                        self.state_pipeline = if self.env_pipeline > 0 { 3 } else { 2 };
                    }
                }
                if test != 0 && prev_test == 0 {
                    self.lfsr_reset_ctr =
                        if self.is8580 { LFSR_FADE_START_8580 } else { LFSR_FADE_START_6581 };
                    self.shift_pipeline = 0;
                    self.pulse_out = 0xFFF;
                } else if test == 0 && prev_test != 0 {
                    if self.do_pre_writeback(prev_wf, (val >> 4) & 0x0F) {
                        let o = self.out12;
                        self.write_shift_register(o);
                    }
                    self.lfsr = ((self.lfsr << 1) | ((!self.lfsr >> 17) & 1)) & 0x7FFFFF;
                    self.set_noise_output();
                    self.lfsr_reset_ctr = 0;
                }
                if ((val >> 4) & 0x0F) == 0 && prev_wf != 0 {
                    self.float_ttl =
                        if self.is8580 { FLOAT_TTL_START_8580 } else { FLOAT_TTL_START_6581 };
                }
            }
            5 => {
                self.a = (val >> 4) as usize;
                self.d = (val & 0x0F) as usize;
                if self.state == S_ATTACK {
                    self.rate_period = rate_cmp(self.a);
                } else if self.state == S_DECAY {
                    self.rate_period = rate_cmp(self.d);
                }
            }
            6 => {
                self.s = val >> 4;
                self.r = (val & 0x0F) as usize;
                if self.state == S_RELEASE {
                    self.rate_period = rate_cmp(self.r);
                }
            }
            _ => {}
        }
    }

    fn state_change(&mut self) {
        self.state_pipeline -= 1;
        if self.next_state == S_ATTACK {
            if self.state_pipeline == 0 {
                self.state = S_ATTACK;
                self.rate_period = rate_cmp(self.a);
                self.hold_zero = false;
            }
        } else if self.next_state == S_RELEASE
            && ((self.state == S_ATTACK && self.state_pipeline == 0)
                || (self.state == S_DECAY && self.state_pipeline == 1))
        {
            self.state = S_RELEASE;
            self.rate_period = rate_cmp(self.r);
        }
    }

    pub fn clock_core(&mut self) {
        // Phase accumulator + noise pipeline.
        self.prev_phase = self.phase;
        if self.ctrl & 0x08 != 0 {
            self.phase = 0;
            self.pulse_out = 0xFFF;
            if self.lfsr_reset_ctr > 0 {
                self.lfsr_reset_ctr -= 1;
                if self.lfsr_reset_ctr == 0 {
                    self.shiftreg_bitfade();
                }
            }
        } else {
            let added = self.phase.wrapping_add(self.freq) & 0xFFFFFF;
            if (self.prev_phase & 0x080000) == 0 && (added & 0x080000) != 0 {
                self.shift_pipeline = 2;
            } else if self.shift_pipeline != 0 {
                self.shift_pipeline -= 1;
                if self.shift_pipeline == 0 {
                    self.clock_shift_register();
                }
            }
            self.phase = if self.sync_pulse { 0 } else { added };
        }

        // Envelope (reSID EnvelopeGenerator::clock; ENV3 latch omitted —
        // readback is the JS shadow's job).
        if self.state_pipeline != 0 {
            self.state_change();
        }

        if self.env_pipeline != 0 {
            self.env_pipeline -= 1;
            if self.env_pipeline == 0 && !self.hold_zero {
                if self.state == S_ATTACK {
                    self.env = (self.env + 1) & 0xFF;
                    if self.env == 0xFF {
                        self.state = S_DECAY;
                        self.rate_period = rate_cmp(self.d);
                    }
                } else if self.state == S_DECAY || self.state == S_RELEASE {
                    self.env = self.env.wrapping_sub(1) & 0xFF;
                }
                self.set_exp_period();
            }
        }

        if self.exp_pipeline != 0 {
            self.exp_pipeline -= 1;
            if self.exp_pipeline == 0 {
                self.exp_counter = 0;
                if (self.state == S_DECAY && self.env != ((self.s << 4) | self.s)) || self.state == S_RELEASE {
                    self.env_pipeline = 1;
                }
            }
        } else if self.reset_rate_counter {
            self.rate_counter = 0;
            self.reset_rate_counter = false;
            if self.state == S_ATTACK {
                self.exp_counter = 0;
                self.env_pipeline = 2;
            } else if !self.hold_zero {
                self.exp_counter += 1;
                if self.exp_counter == self.exp_period {
                    self.exp_pipeline = if self.exp_period != 1 { 2 } else { 1 };
                }
            }
        }

        if self.rate_counter != self.rate_period as u32 {
            self.rate_counter = (self.rate_counter + 1) & 0xFFFF;
            if self.rate_counter & 0x8000 != 0 {
                self.rate_counter = (self.rate_counter + 1) & 0x7FFF;
            }
        } else {
            self.reset_rate_counter = true;
        }
    }

    #[inline]
    fn wave_ix(&self, src_phase: u32) -> usize {
        // reSID: ix = (acc ^ (~src_acc & ring_msb_mask)) >> 12; the mask is
        // active only when RING is on and SAW is off.
        if (self.ctrl & 0x20) == 0 && (self.ctrl & 0x04) != 0 {
            (((self.phase ^ (!src_phase & 0x800000)) >> 12) & 0xFFF) as usize
        } else {
            ((self.phase >> 12) & 0xFFF) as usize
        }
    }

    #[inline]
    fn wave_component(&self, w7: u32, ix: usize, wt: &WaveTables) -> u32 {
        match w7 {
            1 => {
                let i = ix as u32;
                (if i & 0x800 != 0 { !i << 1 } else { i << 1 }) & 0xFFE
            }
            2 => ix as u32,
            3 => wt.st[ix] as u32,
            5 => wt.pt[ix] as u32,
            6 => wt.ps[ix] as u32,
            7 => wt.pst[ix] as u32,
            _ => 0xFFF,
        }
    }

    fn compute_waveform12(&self, src_phase: u32, wt: &WaveTables) -> u32 {
        let wf = (self.ctrl >> 4) & 0x0F;
        if (wf & 0x4) != 0 && self.pulse_out == 0 {
            return 0;
        }
        let mut out = self.wave_component(wf & 0x07, self.wave_ix(src_phase), wt);
        if wf & 0x8 != 0 {
            out &= self.noise_val << 4;
        }
        if (wf & 0xC) == 0xC {
            out = if self.is8580 {
                if out < 0xFC0 { (out & (out << 1)) & 0xFFF } else { 0xFC0 }
            } else if out < 0xF00 {
                0
            } else {
                (out & (out << 1) & (out << 2)) & 0xFFF
            };
        }
        out
    }

    /// Audio output stage: selector + 6581 saw-MSB pulldown + floating-DAC
    /// fade + combined-noise writeback + pulse latch push. Returns the
    /// reSID integer voice product (wave_dac − wave_zero) × env_dac.
    pub fn output_stage_audio(
        &mut self,
        src_phase: u32,
        wt: &WaveTables,
        wdac: &[u16],
        edac: &[u16],
        wz: i32,
    ) -> i32 {
        let out12;
        if self.ctrl & 0xF0 != 0 {
            let o = self.compute_waveform12(src_phase, wt);
            self.out12 = o;
            if !self.is8580 && (self.ctrl & 0x20) != 0 && (self.ctrl & 0xD0) != 0 {
                self.phase &= (o << 12) | 0x7FFFFF;
            }
            out12 = o;
        } else {
            if self.float_ttl != 0 {
                self.float_ttl -= 1;
                if self.float_ttl == 0 {
                    self.out12 &= self.out12 >> 1;
                    if self.out12 != 0 {
                        self.float_ttl =
                            if self.is8580 { FLOAT_TTL_BIT_8580 } else { FLOAT_TTL_BIT_6581 };
                    }
                }
            }
            out12 = self.out12;
        }

        // Combined-noise writeback (reSID: waveform > 8 && !test &&
        // shift_pipeline != 1).
        if (self.ctrl & 0x80) != 0
            && (self.ctrl & 0x70) != 0
            && (self.ctrl & 0x08) == 0
            && self.shift_pipeline != 1
        {
            self.write_shift_register(out12);
        }
        // Pulse latch push (one-cycle delayed rail).
        self.pulse_out = if self.phase >= ((self.pw & 0x0FFF) << 12) { 0xFFF } else { 0 };

        (wdac[out12 as usize] as i32 - wz) * edac[self.env as usize] as i32
    }
}
