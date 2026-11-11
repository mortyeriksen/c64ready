// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vibes/vibes-grade.js – the Retro Vibes view's last image stage.
//
// The grade: chromatic aberration toward the edges, a vignette, an optional
// split tone and film grain. It runs on the finished picture, so after tone
// mapping and the colour space conversion.
//
// On a computer it is a pass of its own, behind three's OutputPass and SMAA
// (GradeShader). On a low-power device those are one pass, OutputGradePass,
// and LeanComposer is the whole pipeline: the scene drawn once into one
// multisampled buffer, then that pass onto the canvas. A phone's GPU pays for
// every fullscreen pass with a store and a load of the whole frame, so it gets
// two where the full pipeline has six.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const GRADE_UNIFORMS = () => ({
  uTime: { value: 0 },
  uAberration: { value: 0.0008 },
  uVignette: { value: 0.24 },
  uGrain: { value: 0.025 },
  // Split tone, off by default; a scene opts in through `grade`.
  uSplit: { value: 0.0 },
  uSplitShadow: { value: new THREE.Vector3(1, 1, 1) },
  uSplitHigh: { value: new THREE.Vector3(1, 1, 1) },
});

// The grade itself, over `vec3 tap(vec2 uv)`: the finished picture's colour at
// a point. Each shader below supplies its own tap and shares this body.
export const GRADE_BODY = `
    uniform float uTime, uAberration, uVignette, uGrain, uSplit;
    uniform vec3 uSplitShadow, uSplitHigh;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    vec3 grade(vec2 uv){
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);
      // chromatic aberration grows toward the edges
      vec2 off = d * uAberration * (0.4 + r2 * 3.0);
      vec3 col;
      col.r = tap(uv + off).r;
      col.g = tap(uv).g;
      col.b = tap(uv - off).b;
      // vignette
      col *= 1.0 - uVignette * smoothstep(0.25, 0.9, r2);
      // Per-pixel, so unlike the aberration above this cannot alias anything.
      if (uSplit > 0.0) {
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, col * mix(uSplitShadow, uSplitHigh, smoothstep(0.05, 0.7, l)), uSplit);
      }
      // film grain
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5;
      col += g * uGrain;
      return col;
    }`;

// The grade as a pass of its own: its input is already the finished picture.
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, ...GRADE_UNIFORMS() },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    vec3 tap(vec2 uv){ return texture2D(tDiffuse, uv).rgb; }
    ${GRADE_BODY}
    void main(){ gl_FragColor = vec4(grade(vUv), 1.0); }`,
};

// Tone mapping, the colour space conversion and the grade in one fullscreen
// pass. The first two are three's OutputPass, switch for switch (its shader
// is raw, with the renderer's settings as defines), done per tap since the
// aberration reads the picture at three points.
export class OutputGradePass extends Pass {
  constructor() {
    super();
    this.uniforms = { tDiffuse: { value: null }, toneMappingExposure: { value: 1 }, ...GRADE_UNIFORMS() };
    this.material = new THREE.RawShaderMaterial({
      name: 'OutputGradeShader',
      uniforms: this.uniforms,
      vertexShader: `
        precision highp float;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        varying vec2 vUv;
        vec3 tap(vec2 uv){
          vec4 c = texture2D(tDiffuse, uv);
          #ifdef LINEAR_TONE_MAPPING
            c.rgb = LinearToneMapping(c.rgb);
          #elif defined( REINHARD_TONE_MAPPING )
            c.rgb = ReinhardToneMapping(c.rgb);
          #elif defined( CINEON_TONE_MAPPING )
            c.rgb = CineonToneMapping(c.rgb);
          #elif defined( ACES_FILMIC_TONE_MAPPING )
            c.rgb = ACESFilmicToneMapping(c.rgb);
          #elif defined( AGX_TONE_MAPPING )
            c.rgb = AgXToneMapping(c.rgb);
          #elif defined( NEUTRAL_TONE_MAPPING )
            c.rgb = NeutralToneMapping(c.rgb);
          #elif defined( CUSTOM_TONE_MAPPING )
            c.rgb = CustomToneMapping(c.rgb);
          #endif
          #ifdef SRGB_TRANSFER
            c = sRGBTransferOETF(c);
          #endif
          return c.rgb;
        }
        ${GRADE_BODY}
        void main(){ gl_FragColor = vec4(grade(vUv), 1.0); }`,
    });
    this._fsQuad = new FullScreenQuad(this.material);
    this._outputColorSpace = null;
    this._toneMapping = null;
  }

  // Draws `readBuffer`, finished, onto the canvas.
  render(renderer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    if (this._outputColorSpace !== renderer.outputColorSpace || this._toneMapping !== renderer.toneMapping) {
      this._outputColorSpace = renderer.outputColorSpace;
      this._toneMapping = renderer.toneMapping;
      const defines = {};
      if (THREE.ColorManagement.getTransfer(this._outputColorSpace) === THREE.SRGBTransfer) defines.SRGB_TRANSFER = '';
      const tone = TONE_DEFINES.get(this._toneMapping);
      if (tone) defines[tone] = '';
      this.material.defines = defines;
      this.material.needsUpdate = true;
    }
    renderer.setRenderTarget(null);
    this._fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}
const TONE_DEFINES = new Map([
  [THREE.LinearToneMapping, 'LINEAR_TONE_MAPPING'],
  [THREE.ReinhardToneMapping, 'REINHARD_TONE_MAPPING'],
  [THREE.CineonToneMapping, 'CINEON_TONE_MAPPING'],
  [THREE.ACESFilmicToneMapping, 'ACES_FILMIC_TONE_MAPPING'],
  [THREE.AgXToneMapping, 'AGX_TONE_MAPPING'],
  [THREE.NeutralToneMapping, 'NEUTRAL_TONE_MAPPING'],
  [THREE.CustomToneMapping, 'CUSTOM_TONE_MAPPING'],
]);

// The low-power pipeline, with the part of EffectComposer's shape the viewer
// uses: render, setSize, setPixelRatio, readBuffer, passes, dispose. The scene
// is drawn into one multisampled half-float buffer (light above 1.0 survives
// until it is tone mapped, and the edges are smoothed as the buffer resolves),
// then `grade` draws it onto the canvas.
export class LeanComposer {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.readBuffer = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.grade = new OutputGradePass();
    this.passes = [this.grade];
    this._pixelRatio = 1;
    this._width = 1;
    this._height = 1;
  }

  setPixelRatio(ratio) {
    this._pixelRatio = ratio;
    this.setSize(this._width, this._height);
  }

  setSize(width, height) {
    this._width = width;
    this._height = height;
    this.readBuffer.setSize(Math.round(width * this._pixelRatio), Math.round(height * this._pixelRatio));
  }

  render() {
    const renderer = this.renderer, was = renderer.getRenderTarget();
    renderer.setRenderTarget(this.readBuffer);
    renderer.render(this.scene, this.camera);
    this.grade.render(renderer, this.readBuffer);
    renderer.setRenderTarget(was);
  }

  dispose() {
    this.readBuffer.dispose();
  }
}
