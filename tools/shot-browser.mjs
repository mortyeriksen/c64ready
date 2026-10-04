// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Browser launch and a slow-step warning shared by the screenshot tools that
// render Retro Vibes (guide-shots.mjs, brand-shots.mjs, vibes-guide-shots.mjs).
//
// Playwright's default headless browser is the stripped "headless shell", which
// has no GPU: WebGL falls back to SwiftShader, so a Retro Vibes scene draws at
// about 1 fps and a shot can stall for minutes. Full Chromium in its new
// headless mode (channel 'chromium', installed with Playwright) uses the GPU:
// ANGLE on Metal on a Mac, where the same scene runs at about 50 fps. That is
// the default here; SHOTS_SOFTWARE_GL=1 forces software WebGL, and so does a
// machine where the GPU browser will not start.
import { chromium } from 'playwright';

const SOFTWARE_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const GPU_ARGS = process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist'];

export async function launchShotBrowser(opts = {}) {
  const extra = opts.args || [];
  if (process.env.SHOTS_SOFTWARE_GL !== '1') {
    try {
      return await chromium.launch({ ...opts, channel: 'chromium', args: [...GPU_ARGS, ...extra] });
    } catch (e) {
      console.warn(`  ⚠ The GPU browser did not start (${e.message.split('\n')[0]}); using software WebGL, so 3D shots will be slow.`);
    }
  }
  return chromium.launch({ ...opts, args: [...SOFTWARE_ARGS, ...extra] });
}

// Say once which WebGL renderer the page got, and warn when it is software.
export async function reportRenderer(page) {
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }).catch(() => 'unknown');
  const software = /swiftshader|software|llvmpipe/i.test(renderer) || renderer === 'none';
  console.log(`  WebGL: ${renderer}${software ? '  (software: 3D shots will be slow)' : ''}`);
  return { renderer, software };
}

// Start timing a step that usually takes `usualSeconds`. If it is still running
// at `factor` times that, print a warning (once) saying so and what usually
// causes it; the step itself carries on. Call the returned function when the
// step ends.
export function slowWarning(label, usualSeconds, factor = 3) {
  const limit = Math.round(usualSeconds * factor);
  const timer = setTimeout(() => {
    console.warn(`  ⚠ ${label} is taking longer than expected: over ${limit} s, where it usually takes about ${usualSeconds} s. `
      + 'The usual causes are software WebGL (see the WebGL line above) or a page that has stopped responding; '
      + 'it keeps going, so stop it with Ctrl+C if it does not finish.');
  }, limit * 1000);
  timer.unref?.();
  return () => clearTimeout(timer);
}
