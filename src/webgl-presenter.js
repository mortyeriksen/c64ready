// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/webgl-presenter.js — WebGL path for putting the finished 384×272 RGBA
// framebuffer onto the #screen canvas, replacing ctx.putImageData (which
// converts + re-uploads the whole frame on the main thread every displayed
// frame — disproportionately expensive on mobile GPUs). Per displayed frame
// this uploads the framebuffer with texSubImage2D and draws one textured
// triangle.
//
// VISUAL IDENTITY by construction: the canvas keeps the same 384×272 backing
// store (CSS still does all scaling via image-rendering: pixelated, exactly
// as with the 2D path), the context is opaque ({alpha:false}), the texture is
// sampled NEAREST at 1:1 with no blending or mipmaps, and alpha
// premultiplication is off — the same sRGB bytes putImageData wrote reach the
// compositor unchanged.
//
// Lifecycle: WebGLPresenter.create() returns null when WebGL is unavailable;
// a failed getContext leaves the canvas unbound, so the caller can still get
// a '2d' context and use the legacy path. Context loss (mobile backgrounding)
// is handled: present() no-ops while lost, and every GL object is rebuilt on
// webglcontextrestored.
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
    this._srcBytes = null;   // Uint8Array view over the framebuffer, cached per buffer
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();     // signal we will restore (else no restored event)
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._initGL();
      this.lost = false;
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
    // Orientation: framebuffer row 0 is the TOP of the picture (putImageData
    // semantics). texImage2D uploads row 0 at texture v=0, and clip-space
    // y=+1 is the top of the canvas, so map top → v=0.
    const vs = compile(gl.VERTEX_SHADER, `
      attribute vec2 aPos;
      varying vec2 vUV;
      void main() {
        vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
        gl_Position = vec4(aPos, 0.0, 1.0);
      }`);
    // highp where available: mediump UV precision (~2^-10) is borderline for
    // NEAREST texel selection at 1/384 steps on some mobile GPUs.
    const fs = compile(gl.FRAGMENT_SHADER, `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying vec2 vUV;
      uniform sampler2D uTex;
      void main() { gl_FragColor = texture2D(uTex, vUV); }`);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
    }
    gl.useProgram(prog);

    // One triangle covering clip space — no index buffer, no second triangle.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // The frame texture: NPOT-legal setup (CLAMP + NEAREST, no mipmaps).
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, this.w, this.h);
    this._srcBytes = null;   // re-derive after a restore
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
    const gl = this.gl;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this._srcBytes);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Present a same-sized 2D canvas (used for the "PRESS POWER TO BOOT" hint —
  // text is rendered on an offscreen 2D canvas, then shown through the same
  // texture). Replaces the texture storage at the source's size; the next
  // present() reallocates implicitly via texSubImage2D onto that storage only
  // if sizes match, so hint canvases must be w×h — the caller guarantees it.
  presentCanvas(srcCanvas) {
    if (this.lost) return;
    const gl = this.gl;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  clearBlack() {
    if (this.lost) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
