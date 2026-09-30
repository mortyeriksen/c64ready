// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/webgl-presenter.js — WebGL path for putting the finished 384×272 RGBA
// framebuffer onto the #screen canvas, replacing ctx.putImageData (which
// converts + re-uploads the whole frame on the main thread every displayed
// frame — disproportionately expensive on mobile GPUs). Per displayed frame
// this uploads the framebuffer with texSubImage2D and draws one textured
// triangle.
//
// Two programs share the texture. With CRT off, the plain pass-through: the
// canvas keeps its 384×272 backing store (CSS scales it, image-rendering:
// pixelated), the context is opaque ({alpha:false}), the texture is sampled
// NEAREST at 1:1 with no blending or mipmaps, and alpha premultiplication is
// off — the same sRGB bytes putImageData wrote reach the compositor unchanged.
// Under a CRT preset (setCrt with a crt-params object), the canvas is backed
// at its displayed size in device pixels and the CRT program draws the effect
// locked to the raster: one beam per emulated line, a phosphor mask on the
// device-pixel grid, beam softness, tone, vignette and the hum bar (see the
// fragment shader below). Nothing then beats against the picture or the
// screen at any size or pixel ratio.
//
// Lifecycle: WebGLPresenter.create() returns null when WebGL is unavailable;
// a failed getContext leaves the canvas unbound, so the caller can still get
// a '2d' context and use the legacy path. `crtAvailable` says whether the CRT
// program linked; when it did not, the plain path still works and the caller
// draws the presets with CSS instead. `softwareGl` flags a CPU rasteriser
// (SwiftShader, llvmpipe and kin), where the per-pixel shader would crawl at
// device resolution; the caller keeps the plain 1:1 path there too. Context loss (mobile backgrounding) is
// handled: present() no-ops while lost, and every GL object is rebuilt on
// webglcontextrestored, after which the last frame is shown again.
import { backingSize, HUM_PERIOD_S } from './crt-params.js';

const VS = `
  attribute vec2 aPos;
  varying vec2 vUV;
  void main() {
    vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

// highp where available: mediump UV precision (~2^-10) is borderline for
// NEAREST texel selection at 1/384 steps on some mobile GPUs.
const PRECISION = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif`;

const FS_PLAIN = `${PRECISION}
  varying vec2 vUV;
  uniform sampler2D uTex;
  void main() { gl_FragColor = texture2D(uTex, vUV); }`;

// GLSL ES 1.00 throughout (no derivatives, no dynamic vector indexing) so it
// links on WebGL1. Pixel density arrives as uPx, which is exact.
const FS_CRT = `${PRECISION}
  varying vec2 vUV;
  uniform sampler2D uTex;
  uniform vec2 uTexSize;    // emulated pixels: 384, 272
  uniform vec2 uPx;         // device pixels per emulated column, per raster line
  uniform vec2 uScan;       // scanline depth, beam width (lines)
  uniform float uSoft;      // softness along the line (emulated pixels)
  uniform float uMask;      // phosphor mask strength
  uniform float uMaskType;  // 0 aperture grille, 1 delta, 2 slot
  uniform vec3 uTone;       // brightness, contrast, saturation
  uniform float uVignette;
  uniform float uBlack;     // black level: the darkest output, as a fraction of white
  uniform vec2 uHum;        // hum bar strength, phase 0..1

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  const float BLOOM = 0.5;  // how far a bright line's beam widens toward the gap
  const vec3 LUMA_SRGB = vec3(0.213, 0.715, 0.072);

  // One emulated pixel by integer texel coordinate, decoded to linear light.
  vec3 fetch(vec2 texel) {
    vec3 c = texture2D(uTex, (texel + 0.5) / uTexSize).rgb;
    return pow(c, vec3(2.2));
  }

  // Blend toward the next texel: a ramp w texels wide centred on the shared
  // edge. One device pixel wide it is an antialiased pixel edge, sharp at whole
  // multiples and even at fractional ones; wider is beam softness. Lines never
  // blend beyond that edge: on a tube they are discrete, the beam is their look.
  float ramp(float f, float w) { return clamp((f - 0.5) / w + 0.5, 0.0, 1.0); }

  void main() {
    vec2 p = vUV * uTexSize;
    vec2 u = p - 0.5;
    vec2 i0 = floor(u);
    vec2 f = u - i0;
    vec2 t = vec2(ramp(f.x, max(1.0 / uPx.x, uSoft)), ramp(f.y, 1.0 / uPx.y));
    vec3 c = mix(mix(fetch(i0), fetch(i0 + vec2(1.0, 0.0)), t.x),
                 mix(fetch(i0 + vec2(0.0, 1.0)), fetch(i0 + vec2(1.0, 1.0)), t.x), t.y);

    float lum = min(dot(c, LUMA), 1.0);
    // Back to sRGB: the pattern, mask and tone below are perceptual controls
    // and keep CSS semantics (a 0.28 scanline is a gap 28% darker).
    c = pow(max(c, 0.0), vec3(1.0 / 2.2));

    // Scanlines: a Gaussian beam per raster line, normalised so the gap between
    // two dark lines is exactly uScan.x darker than the beam centre. The centre
    // sits on a device row, so two rows per line still read as centre + gap. A
    // bright line's beam is wider (bloom), so its gap is shallower: it glows.
    // Under two rows per line there is no honest pattern and it fades out.
    float dd = fract(p.y - 0.5 / uPx.y);
    float d = min(dd, 1.0 - dd);
    float sigma = mix(uScan.y, 0.75, BLOOM * lum);
    float beam = exp(-d * d / (2.0 * sigma * sigma));
    float gap0 = exp(-0.125 / (2.0 * uScan.y * uScan.y));
    float g = clamp((beam - gap0) / (1.0 - gap0), 0.0, 1.0);
    float fadeY = smoothstep(1.0, 2.0, uPx.y);
    c *= 1.0 - uScan.x * fadeY * (1.0 - g);

    // Phosphor mask on the device-pixel grid, pitched so one RGB triad spans
    // about one emulated pixel whatever the display density (a one-device-pixel
    // stripe is invisible on a Retina screen); whole pixels keep stripes even.
    // Each stripe passes its own channel and attenuates the other two. Grille:
    // plain stripes. Delta: staggered half a triad every other stripe-row.
    // Slot: double-width stripes broken into slots four stripes tall, alternate
    // slot columns offset by half a slot.
    float pitch = max(1.0, ceil(uPx.x / 3.0 - 0.001));
    vec2 mp = floor(gl_FragCoord.xy / pitch);
    float col = uMaskType > 1.5 ? mp.x * 0.5 : mp.x;
    if (uMaskType > 0.5 && uMaskType < 1.5) col += mod(mp.y, 2.0) * 1.5;
    float s = mod(floor(col), 3.0);
    vec3 stripe = vec3(step(s, 0.5), step(0.5, s) * step(s, 1.5), step(1.5, s));
    vec3 m = mix(vec3(1.0 - uMask), vec3(1.0), stripe);
    if (uMaskType > 1.5) {
      float row = mp.y + mod(floor(mp.x / 6.0), 2.0) * 2.0;
      m *= 1.0 - uMask * step(mod(row, 4.0), 0.5);
    }
    float fadeX = smoothstep(1.0, 2.0, uPx.x);
    c *= mix(vec3(1.0), m, fadeX);

    // Tone controls, CSS filter() semantics.
    c *= uTone.x;
    c = (c - 0.5) * uTone.y + 0.5;
    c = mix(vec3(dot(c, LUMA_SRGB)), c, uTone.z);

    // Tube falloff: nothing inside 60% of the corner radius, then quadratic.
    float r = length((vUV - 0.5) * 1.41421356);
    float vig = clamp((r - 0.6) / 0.4, 0.0, 1.0);
    c *= 1.0 - uVignette * vig * vig;

    // Hum bar: a soft band a third of a 1.1-picture tile, drifting up.
    float b = fract(vUV.y / 1.1 + uHum.y);
    c += uHum.x * max(0.0, 1.0 - abs(b - 0.5) * 6.0);

    // Black level: lift the floor and keep white at white, so gaps and corners
    // never go fully black.
    c = uBlack + c * (1.0 - uBlack);

    // Clip as a whole so a boosted colour keeps its hue.
    float mx = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(max(c, 0.0) / max(mx, 1.0), 1.0);
  }`;

// A CPU rasteriser behind WebGL, by the driver's own name. Unknown names are
// taken as hardware: the honest answer for a GPU we cannot identify.
export function isSoftwareGl(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    return /swiftshader|swangle|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch { return false; }
}

const CRT_UNIFORMS = ['uTex', 'uTexSize', 'uPx', 'uScan', 'uSoft', 'uMask', 'uMaskType', 'uTone', 'uVignette', 'uBlack', 'uHum'];

export class WebGLPresenter {
  static create(canvas, w, h) {
    let gl = null;
    const attrs = {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    };
    try {
      gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
    } catch { gl = null; }
    if (!gl) return null;
    try {
      return new WebGLPresenter(canvas, gl, w, h);
    } catch {
      return null;
    }
  }

  constructor(canvas, gl, w, h) {
    this.canvas = canvas;
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.lost = false;
    this.crtAvailable = false;
    this.softwareGl = isSoftwareGl(gl);
    this._srcBytes = null;   // Uint8Array view over the framebuffer, cached per buffer
    this._lastBytes = null;  // what is on screen, for redraw(): the framebuffer view...
    this._lastCanvas = null; // ...or the hint canvas (one of the two, never both)
    this._crt = null;        // active crt-params object, or null for the plain path
    this._reducedMotion = false;
    this._css = { w: 0, h: 0 };      // canvas CSS size from the observer
    this._devicePx = null;           // exact device-pixel box from the observer, if given
    this._dpr = 0;
    this._ro = null;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();     // signal we will restore (else no restored event)
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._initGL();
      this.lost = false;
      this._applyCrt();
      this.redraw();
    });
    this._initGL();
  }

  _initGL() {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      }
      return s;
    };
    // aPos is bound to location 0 in both programs so one vertexAttribPointer
    // setup serves whichever is in use.
    const link = (fsSrc) => {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
      gl.bindAttribLocation(prog, 0, 'aPos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
      }
      return prog;
    };
    // Orientation: framebuffer row 0 is the TOP of the picture (putImageData
    // semantics). texImage2D uploads row 0 at texture v=0, and clip-space
    // y=+1 is the top of the canvas, so the vertex shader maps top → v=0.
    this._plain = link(FS_PLAIN);
    gl.useProgram(this._plain);
    gl.uniform1i(gl.getUniformLocation(this._plain, 'uTex'), 0);

    // The CRT program is optional: a driver that rejects it leaves the plain
    // path intact and the caller falls back to the CSS presets.
    this._crtProg = null;
    this.crtAvailable = false;
    try {
      const prog = link(FS_CRT);
      const u = {};
      for (const name of CRT_UNIFORMS) u[name] = gl.getUniformLocation(prog, name);
      gl.useProgram(prog);
      gl.uniform1i(u.uTex, 0);
      gl.uniform2f(u.uTexSize, this.w, this.h);
      this._crtProg = prog;
      this._crtU = u;
      this.crtAvailable = true;
    } catch { /* plain path only */ }

    // One triangle covering clip space — no index buffer, no second triangle.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // The frame texture: NPOT-legal setup (CLAMP + NEAREST, no mipmaps). The
    // CRT program does its own blending between texel centres, so NEAREST
    // serves both.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this._plain);
    gl.viewport(0, 0, this.w, this.h);
    this._srcBytes = null;   // re-derive after a restore
  }

  // ── CRT mode ───────────────────────────────────────────────────────────────

  // Switch the CRT effect: `params` is a crt-params object, or null for the
  // plain 1:1 path. Under reduced motion the hum bar stands still.
  setCrt(params, { reducedMotion = false } = {}) {
    if (params && !this.crtAvailable) params = null;
    this._crt = params;
    this._reducedMotion = reducedMotion;
    if (params) this._observe();
    else this._unobserve();
    this._applyCrt();
    this.redraw();
  }

  // Put the GL state where the current mode wants it: program, backing store,
  // uniforms. Safe to call again after a context restore.
  _applyCrt() {
    const gl = this.gl;
    const p = this.crtAvailable ? this._crt : null;   // a restore may have lost the CRT program
    if (!p) {
      if (this.canvas.width !== this.w || this.canvas.height !== this.h) {
        this.canvas.width = this.w;
        this.canvas.height = this.h;
      }
      gl.useProgram(this._plain);
      gl.viewport(0, 0, this.w, this.h);
      return;
    }
    this._resizeBacking();
    gl.useProgram(this._crtProg);
    const u = this._crtU;
    gl.uniform2f(u.uScan, p.scanDepth, p.beamWidth);
    gl.uniform1f(u.uSoft, p.softness);
    gl.uniform1f(u.uMask, p.mask);
    gl.uniform1f(u.uMaskType, p.maskType);
    gl.uniform3f(u.uTone, p.brightness, p.contrast, p.saturation);
    gl.uniform1f(u.uVignette, p.vignette);
    gl.uniform1f(u.uBlack, p.black);
    gl.uniform2f(u.uHum, p.humStrength, 0);
    this._setViewport();
  }

  _setViewport() {
    const gl = this.gl;
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    gl.viewport(0, 0, bw, bh);
    if (this._crt) gl.uniform2f(this._crtU.uPx, bw / this.w, bh / this.h);
  }

  // Size the backing store to the displayed size in device pixels: CSS size ×
  // devicePixelRatio, rounded, or the exact device-pixel box where the browser
  // reports one that agrees with it (a box that does not is not describing
  // this screen, as under an emulated pixel ratio).
  _resizeBacking() {
    if (!this._css.w || !this._css.h) return;   // not laid out yet; the observer will call back
    const dpr = window.devicePixelRatio || 1;
    const max = this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE);
    let { w, h } = backingSize(this._css.w, this._css.h, dpr, max);
    const dp = this._devicePx;
    if (dp && Math.abs(dp.w - w) <= 1 && Math.abs(dp.h - h) <= 1) {
      w = Math.min(max, dp.w);
      h = Math.min(max, dp.h);
    }
    this._dpr = dpr;
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this._setViewport();
  }

  _observe() {
    if (this._ro || typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      const cb = e.contentBoxSize && (e.contentBoxSize[0] || e.contentBoxSize);
      const r = e.contentRect;
      this._css = cb ? { w: cb.inlineSize, h: cb.blockSize } : { w: r.width, h: r.height };
      const dp = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      this._devicePx = dp ? { w: dp.inlineSize, h: dp.blockSize } : null;
      if (!this._crt || this.lost) return;
      const before = this.canvas.width + 'x' + this.canvas.height;
      this._resizeBacking();
      if (this.canvas.width + 'x' + this.canvas.height !== before) this.redraw();
    });
    try {
      this._ro.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      this._ro.observe(this.canvas);
    }
  }

  _unobserve() {
    if (!this._ro) return;
    this._ro.disconnect();
    this._ro = null;
    this._css = { w: 0, h: 0 };
    this._devicePx = null;
  }

  // ── Presenting ─────────────────────────────────────────────────────────────

  _draw() {
    const gl = this.gl;
    const p = this._crt;
    if (p) {
      // A zoom or monitor change shows up here before the observer's callback.
      if ((window.devicePixelRatio || 1) !== this._dpr) this._resizeBacking();
      if (p.humStrength > 0) {
        const t = this._reducedMotion ? 0 : (performance.now() / 1000) / HUM_PERIOD_S;
        gl.uniform2f(this._crtU.uHum, p.humStrength, t - Math.floor(t));
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Present one emulator frame. src is the vic2 frameBuffer
  // (Uint8ClampedArray, w*h*4). The Uint8Array view is cached per backing
  // buffer — it refreshes automatically when a power cycle creates a new
  // machine (new framebuffer).
  present(src) {
    if (this.lost) return;
    if (!this._srcBytes || this._srcBytes.buffer !== src.buffer) {
      this._srcBytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    }
    this._lastBytes = this._srcBytes;
    this._lastCanvas = null;
    const gl = this.gl;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this._srcBytes);
    this._draw();
  }

  // Present a same-sized 2D canvas (used for the "PRESS POWER TO BOOT" hint —
  // text is rendered on an offscreen 2D canvas, then shown through the same
  // texture). Replaces the texture storage at the source's size; the next
  // present() reallocates implicitly via texSubImage2D onto that storage only
  // if sizes match, so hint canvases must be w×h — the caller guarantees it.
  presentCanvas(srcCanvas) {
    if (this.lost) return;
    this._lastCanvas = srcCanvas;
    this._lastBytes = null;
    const gl = this.gl;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    this._draw();
  }

  // Show the last presented frame again. Needed after anything that clears the
  // drawing buffer while no new frame is coming: a backing-store resize, a mode
  // change while paused, a context restore.
  redraw() {
    if (this.lost) return;
    if (this._lastBytes) {
      const gl = this.gl;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this._lastBytes);
      this._draw();
    } else if (this._lastCanvas) {
      this.presentCanvas(this._lastCanvas);
    } else {
      this.clearBlack();
    }
  }

  clearBlack() {
    if (this.lost) return;
    this._lastBytes = null;
    this._lastCanvas = null;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
