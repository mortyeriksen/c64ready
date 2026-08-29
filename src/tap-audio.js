// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tap-audio.js – Turning a .tap back into the sound that was on the cassette.
//
// A C64 tape stores data as square-wave pulses in the audible band: the pulse
// WIDTH is the data, which is why a tape screeches and why a recording of that
// screech loads again. So this is a transcription, not an impression — each TAP
// pulse becomes one square-wave cycle of exactly its own length. Feed the result
// to a speaker and a real C64 will read it back.
//
// TAP pulse encoding, per Peter Schepers' TAP (Raw tape image) description for
// v0/v1 and Markus Brenner's v2 half-wave extension. It mirrors the reader in
// datasette.js deliberately — if that changes, this has to follow:
//   byte != 0            -> byte * 8 cycles
//   byte == 0, v0        -> a fixed long gap
//   byte == 0, v1/v2     -> the next three bytes, little-endian, in cycles
// In v0/v1 a pulse is one full wave; in v2 it is a half wave, so the level
// simply toggles per pulse.
//
// The .wav side is just the canonical 44-byte RIFF/PCM header — a published
// container format, nothing reverse-engineered.

export const PAL_CPU_HZ = 985248;
// What a v0 `0` byte is worth. The format does not say; the deck settles on
// 2048 (256×8) and everything that reads a tape has to agree with it, or the
// speaker, the scope and the head each measure a different tape.
export const V0_ZERO_GAP_CYCLES = 2048;

/**
 * Walk a .tap's pulse stream and emit the waveform it describes.
 * @param {Uint8Array} tapData    pulse bytes (the 20-byte header already stripped)
 * @param {object} opts
 * @param {number} opts.version   TAP version 0, 1 or 2
 * @param {number} opts.zeroGapCycles  what a 0 byte means in v0
 * @param {number} opts.sampleRate
 * @param {number} opts.cpuHz     cycles per second the tape was written at
 * @param {number} opts.maxSeconds safety cap; longer tapes are truncated
 * @param {number} opts.startLevel  level the wave is already sitting at, for
 *   transcribing a tape in pieces — only v2 carries level across a pulse
 * @returns {{ pcm: Float32Array, seconds: number, truncated: boolean, level: number }}
 */
export function tapToPcm(tapData, {
  version = 1,
  zeroGapCycles = V0_ZERO_GAP_CYCLES,
  sampleRate = 44100,
  cpuHz = PAL_CPU_HZ,
  maxSeconds = 900,
  startLevel = 1,
} = {}) {
  const d = tapData || new Uint8Array(0);
  const perSample = cpuHz / sampleRate;          // cycles per output sample
  const cap = Math.floor(maxSeconds * sampleRate);

  // One pass to total the cycles, so the buffer is allocated once at the right
  // size rather than grown.
  let cycles = 0;
  for (let p = 0; p < d.length;) {
    const b = d[p++];
    if (b !== 0) { cycles += b * 8; continue; }
    if (version === 0) { cycles += zeroGapCycles; continue; }
    if (p + 2 >= d.length) break;
    cycles += d[p++] | (d[p++] << 8) | (d[p++] << 16);
  }
  const wanted = Math.ceil(cycles / perSample);
  const len = Math.min(wanted, cap);
  const pcm = new Float32Array(len);

  // Second pass writes the levels. A full-wave pulse is low for its first half
  // and high for its second; a half-wave pulse just holds one level.
  let at = 0;              // fractional sample position
  let level = startLevel;
  for (let p = 0; p < d.length && at < len;) {
    const b = d[p++];
    let pulse;
    if (b !== 0) pulse = b * 8;
    else if (version === 0) pulse = zeroGapCycles;
    else if (p + 2 < d.length) pulse = d[p++] | (d[p++] << 8) | (d[p++] << 16);
    else break;

    if (version === 2) {
      const end = at + pulse / perSample;
      fill(pcm, at, end, level, len);
      level = -level;
      at = end;
    } else {
      const half = pulse / (2 * perSample);
      fill(pcm, at, at + half, -1, len);
      fill(pcm, at + half, at + 2 * half, 1, len);
      at += 2 * half;
    }
  }
  // The per-pulse rounding can land a sample short of the total the first pass
  // estimated; hand back exactly what was written rather than a trailing zero.
  const written = Math.max(0, Math.min(len, Math.round(at)));
  const out = written === len ? pcm : pcm.subarray(0, written);
  return { pcm: out, seconds: out.length / sampleRate, truncated: wanted > cap, level };
}

function fill(buf, from, to, value, len) {
  const a = Math.max(0, Math.round(from));
  const b = Math.min(len, Math.round(to));
  for (let i = a; i < b; i++) buf[i] = value;
}

/**
 * Wrap PCM as a 16-bit mono WAV file — the thing you can hand to any player, or
 * to a cassette deck wired to a real C64.
 * @param {Float32Array} pcm  samples in -1..1
 * @param {number} sampleRate
 * @returns {Uint8Array} complete .wav bytes
 */
export function pcmToWav(pcm, sampleRate = 44100) {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);            // PCM header size
  view.setUint16(20, 1, true);             // format: PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  tag(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
  }
  return bytes;
}
