// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Reduce the live RGBA framebuffer to the linear-light colour and luminance a
// CRT contributes to its surroundings. The caller supplies `out` so sampling
// stays allocation-free in the display-rate viewer loop.
export function sampleScreenLight(data, width, height, out) {
  out.r = 0; out.g = 0; out.b = 0; out.luminance = 0; out.active = false;
  if (!data || width <= 0 || height <= 0 || data.length < width * height * 4) return out;

  const cols = Math.min(16, width), rows = Math.min(12, height);
  let r = 0, g = 0, b = 0;
  for (let y = 0; y < rows; y++) {
    const py = Math.min(height - 1, (((y + 0.5) * height) / rows) | 0);
    for (let x = 0; x < cols; x++) {
      const px = Math.min(width - 1, (((x + 0.5) * width) / cols) | 0);
      const i = (py * width + px) * 4;
      const sr = data[i] / 255, sg = data[i + 1] / 255, sb = data[i + 2] / 255;
      r += sr <= 0.04045 ? sr / 12.92 : Math.pow((sr + 0.055) / 1.055, 2.4);
      g += sg <= 0.04045 ? sg / 12.92 : Math.pow((sg + 0.055) / 1.055, 2.4);
      b += sb <= 0.04045 ? sb / 12.92 : Math.pow((sb + 0.055) / 1.055, 2.4);
    }
  }
  const n = cols * rows;
  out.r = r / n; out.g = g / n; out.b = b / n;
  out.luminance = out.r * 0.2126 + out.g * 0.7152 + out.b * 0.0722;
  out.active = true;
  return out;
}
