// SPDX-License-Identifier: GPL-3.0-or-later
// Translated from reSID (dac.cc, wave.cc tables) as distributed in VICE
// 3.10 src/resid, Copyright (C) 2010 Dag Lem, GNU GPL v2 or later.
// Upstream pin and attribution: NOTICE.txt at the repository root.
//
// Measured combined-waveform tables + R-2R DAC builder. The .dat payloads
// are byte-identical to src/sid-wavetables.js (same upstream files); DAC
// tables match the JS engine's buildDacTableU16 exactly (pure f64 ladder
// math, floor(x+0.5) rounding).

/// reSID dac.cc build_dac_table: R-2R ladder with per-model 2R/R ratio,
/// optional termination and subthreshold MOSFET leakage.
pub fn build_dac_table(bits: u32, r2r: f64, term: bool) -> Vec<u16> {
    let leakage = if term { 0.0035 } else { 0.0075 };
    let n = 1usize << bits;
    let mut vbit = [0f64; 12];

    for set_bit in 0..bits as usize {
        let mut vn = 1.0f64;
        let r = 1.0f64;
        let r2 = r2r * r;
        let mut rn = if term { r2 } else { f64::INFINITY };

        for _ in 0..set_bit {
            rn = if rn.is_infinite() { r + r2 } else { r + (r2 * rn) / (r2 + rn) };
        }

        if rn.is_infinite() {
            rn = r2;
        } else {
            rn = (r2 * rn) / (r2 + rn);
            vn = (vn * rn) / r2;
        }

        for _ in (set_bit + 1)..bits as usize {
            rn += r;
            let i = vn / rn;
            rn = (r2 * rn) / (r2 + rn);
            vn = rn * i;
        }

        vbit[set_bit] = vn;
    }

    let mut dac = vec![0u16; n];
    for (i, slot) in dac.iter_mut().enumerate() {
        let mut x = i;
        let mut vo = 0f64;
        for b in vbit.iter().take(bits as usize) {
            vo += if x & 1 != 0 { 1.0 } else { leakage } * b;
            x >>= 1;
        }
        *slot = (((n - 1) as f64 * vo + 0.5).floor() as i64 & 0xFFFF) as u16;
    }
    dac
}

/// One model's four measured combined-waveform tables, entries = OSC3
/// sample << 4 (the 12-bit waveform-DAC input, low 4 bits grounded).
pub struct WaveTables {
    pub st: [u16; 4096],
    pub pt: [u16; 4096],
    pub ps: [u16; 4096],
    pub pst: [u16; 4096],
}

fn decode(dat: &[u8; 4096]) -> [u16; 4096] {
    let mut t = [0u16; 4096];
    for (i, &b) in dat.iter().enumerate() {
        t[i] = (b as u16) << 4;
    }
    t
}

pub fn wavetables_6581() -> WaveTables {
    WaveTables {
        st: decode(include_bytes!("../data/wave6581__ST.dat")),
        pt: decode(include_bytes!("../data/wave6581_P_T.dat")),
        ps: decode(include_bytes!("../data/wave6581_PS_.dat")),
        pst: decode(include_bytes!("../data/wave6581_PST.dat")),
    }
}

pub fn wavetables_8580() -> WaveTables {
    WaveTables {
        st: decode(include_bytes!("../data/wave8580__ST.dat")),
        pt: decode(include_bytes!("../data/wave8580_P_T.dat")),
        ps: decode(include_bytes!("../data/wave8580_PS_.dat")),
        pst: decode(include_bytes!("../data/wave8580_PST.dat")),
    }
}
