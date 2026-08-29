// Small utility: convert a raw Float32 mono audio file to a 16-bit WAV.
// Used to inspect SID reconstruction output without needing ffmpeg.
//
// Usage: node test/f32-to-wav.js <input.f32> <output.wav> [sample-rate]

import fs from 'node:fs';

const [, , inPath, outPath, srArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node test/f32-to-wav.js <input.f32> <output.wav> [sample-rate]');
  process.exit(1);
}
const sr = parseInt(srArg || '44100', 10);

const f32 = new Float32Array(fs.readFileSync(inPath).buffer);
const n = f32.length;
const bytesPerSample = 2;
const dataLen = n * bytesPerSample;
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataLen, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);           // fmt chunk size
header.writeUInt16LE(1, 20);            // PCM
header.writeUInt16LE(1, 22);            // mono
header.writeUInt32LE(sr, 24);           // sample rate
header.writeUInt32LE(sr * bytesPerSample, 28); // byte rate
header.writeUInt16LE(bytesPerSample, 32);
header.writeUInt16LE(16, 34);           // bits per sample
header.write('data', 36);
header.writeUInt32LE(dataLen, 40);

const data = Buffer.alloc(dataLen);
let peak = 0;
for (let i = 0; i < n; i++) if (Math.abs(f32[i]) > peak) peak = Math.abs(f32[i]);
const gain = peak > 0 ? Math.min(1, 0.95 / peak) : 1;
for (let i = 0; i < n; i++) {
  const v = Math.max(-1, Math.min(1, f32[i] * gain));
  data.writeInt16LE(Math.round(v * 32767), i * bytesPerSample);
}

fs.writeFileSync(outPath, Buffer.concat([header, data]));
console.log(`wrote ${outPath}  (${n} samples, peak=${peak.toFixed(3)}, normalized to 0.95)`);
