// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// Smoke in a spotlight's beam, ray-marched per pixel on the HDR frame before
// tone mapping. Each view ray is clipped to the light's cone and stopped at the
// scene depth, so smoke veils what stands in front of it and nothing behind.
// Every sample is lit by the spot: inverse-square falloff, the cone's penumbra,
// Henyey-Greenstein forward scattering and the light's own shadow map, so the
// lit object casts a shadow wedge through the smoke. A second light, the glowing
// screen (`screen`, a RectAreaLight), lights the smoke in front of it as a flat
// Lambertian panel, in the live picture's colour. Density comes from a small
// tiling 3D noise texture, domain-warped and drifting, so the smoke rolls.
//
// The march runs at reduced resolution (smoke has no hard edges, and it is the
// pass's whole cost) into a target holding in-scattered light and
// transmittance; a full-resolution composite applies it to the frame.
//
// The viewer sets `light` (the scene's SpotLight) and `camera`, and enables the
// pass only while there is a light. Per frame: uniform copies, no allocation.
// The values that change every frame ride in vector uniforms (uFrame, uFrame2)
// and are set in place: a plain number stored into a `{ value }` uniform would
// be boxed on every store.

const NOISE_SIZE = 32;

// Four independent value-noise channels: hardware trilinear filtering of a
// small random lattice, tiled. RGB warp the domain, A is the density.
function noiseTexture() {
  const n = NOISE_SIZE, data = new Uint8Array(n * n * n * 4);
  let seed = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed >>> 24;
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const VolumeShader = {
  uniforms: {
    tDepth: { value: null },
    tShadow: { value: null },
    tNoise: { value: null },
    uFrame: { value: new THREE.Vector4(0.9, 0.95, 0, 100) },   // cos outer, cos inner, has shadow, max distance
    uFrame2: { value: new THREE.Vector2(0, 1) },              // time, screen near limit
    uProjInv: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uLightPos: { value: new THREE.Vector3() },
    uLightDir: { value: new THREE.Vector3(0, -1, 0) },
    uLightColor: { value: new THREE.Vector3() },
    uSigma: { value: 0.002 },
    uAniso: { value: 0.35 },
    uScale: { value: 0.1 },
    uSteps: { value: 40 },
    uFloorY: { value: 0 },
    uScreenPos: { value: new THREE.Vector3() },
    uScreenDir: { value: new THREE.Vector3(0, 0, 1) },
    uScreenColor: { value: new THREE.Vector3() },
    uGround: { value: 0 },
    uGroundH: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDepth;
    uniform sampler2DShadow tShadow;
    uniform highp sampler3D tNoise;
    uniform float uSigma, uAniso, uScale, uSteps, uFloorY, uGround, uGroundH;
    uniform vec4 uFrame; uniform vec2 uFrame2;
    #define uCosOuter uFrame.x
    #define uCosInner uFrame.y
    #define uHasShadow uFrame.z
    #define uMaxDist uFrame.w
    #define uTime uFrame2.x
    #define uScreenNear uFrame2.y
    uniform mat4 uProjInv, uCamWorld, uShadowMatrix;
    uniform vec3 uLightPos, uLightDir, uLightColor, uScreenPos, uScreenDir, uScreenColor;
    varying vec2 vUv;

    // The ray's stretch inside the forward nappe of the light cone: the nappe
    // is convex, so it is one interval, found by testing which of the root
    // splits has an inside midpoint.
    bool inCone(vec3 p) { vec3 d = p - uLightPos; return dot(d, uLightDir) > uCosOuter * length(d); }
    vec2 coneSpan(vec3 o, vec3 v) {
      vec3 co = o - uLightPos;
      float c2 = uCosOuter * uCosOuter, vd = dot(v, uLightDir), cd = dot(co, uLightDir);
      float a = vd * vd - c2, b = 2.0 * (vd * cd - dot(v, co) * c2), c = cd * cd - dot(co, co) * c2;
      float h = b * b - 4.0 * a * c;
      if (h < 0.0 || abs(a) < 1e-6) return inCone(o) ? vec2(0.0, uMaxDist) : vec2(1.0, 0.0);
      h = sqrt(h);
      float t0 = (-b - h) / (2.0 * a), t1 = (-b + h) / (2.0 * a);
      if (t0 > t1) { float s = t0; t0 = t1; t1 = s; }
      if (t1 > 0.0 && inCone(o + v * (0.5 * (max(t0, 0.0) + t1)))) return vec2(max(t0, 0.0), t1);
      if (inCone(o + v * (max(t1, 0.0) + 1.0))) return vec2(max(t1, 0.0), uMaxDist);
      if (t0 > 0.0 && inCone(o + v * (0.5 * t0))) return vec2(0.0, t0);
      return vec2(1.0, 0.0);
    }

    float smoke(vec3 p) {
      vec3 q = p * uScale + vec3(uTime * 0.011, -uTime * 0.017, uTime * 0.007);
      vec3 w = texture(tNoise, q * 0.37 + vec3(0.0, uTime * 0.006, 0.0)).rgb - 0.5;
      q += w * 1.4;
      float f = texture(tNoise, q).a * 0.55 + texture(tNoise, q * 2.07 + 0.31).a * 0.30 + texture(tNoise, q * 4.13 + 0.71).a * 0.15;
      // A thin haze everywhere with thicker rolling wisps, settling toward the floor.
      float settle = 1.0 + uGround * exp(-max(p.y - uFloorY, 0.0) / uGroundH);
      return (0.18 + 1.6 * smoothstep(0.38, 0.78, f)) * settle;
    }

    float hg(float c) { float g = uAniso, d = 1.0 + g * g - 2.0 * g * c; return (1.0 - g * g) / (12.566371 * d * sqrt(d)); }

    void main() {
      vec4 ndc = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
      vec4 vp = uProjInv * ndc; vp /= vp.w;
      vec3 o = (uCamWorld * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 v = normalize((uCamWorld * vec4(vp.xyz, 0.0)).xyz);
      // Distance to the first surface along this ray.
      float d = texture2D(tDepth, vUv).x;
      float tScene = uMaxDist;
      if (d < 1.0) {
        vec4 sp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); sp /= sp.w;
        tScene = length(sp.xyz);
      }
      vec2 span = coneSpan(o, v);
      span.y = min(span.y, tScene);
      if (span.y <= span.x) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float dt = (span.y - span.x) / uSteps;
      // Interleaved gradient noise: a per-pixel start offset that turns step
      // banding into fine grain the frame's grain hides.
      float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      vec3 light = vec3(0.0); float trans = 1.0;
      for (int i = 0; i < 64; i++) {
        if (float(i) >= uSteps) break;
        vec3 p = o + v * (span.x + (float(i) + jitter) * dt);
        vec3 toL = uLightPos - p; float dist2 = dot(toL, toL); vec3 l = toL * inversesqrt(dist2);
        float spot = smoothstep(uCosOuter, uCosInner, dot(-l, uLightDir));
        float sh = 1.0;
        if (uHasShadow > 0.5) {
          vec4 sc = uShadowMatrix * vec4(p, 1.0); sc.xyz /= sc.w;
          if (all(greaterThan(sc.xyz, vec3(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) sh = texture(tShadow, vec3(sc.xy, sc.z - 0.0008));
        }
        // The screen as a Lambertian panel: radiant intensity L·A·cosθ toward p,
        // nothing behind the glass, and no closer than its own size.
        vec3 toS = p - uScreenPos; float sd2 = max(dot(toS, toS), uScreenNear); vec3 s = toS * inversesqrt(sd2);
        vec3 screen = uScreenColor * (max(dot(s, uScreenDir), 0.0) / sd2) * hg(dot(s, -v));
        float sigma = uSigma * smoke(p);
        light += trans * (uLightColor * (spot * sh / dist2) * hg(dot(-l, -v)) + screen) * sigma * dt;
        trans *= exp(-sigma * dt);
      }
      gl_FragColor = vec4(light, trans);
    }`,
};

const CompositeShader = {
  uniforms: { tDiffuse: { value: null }, tVolume: { value: null } },
  vertexShader: VolumeShader.vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse, tVolume;
    varying vec2 vUv;
    void main() {
      vec4 scene = texture2D(tDiffuse, vUv), vol = texture2D(tVolume, vUv);
      gl_FragColor = vec4(scene.rgb * vol.a + vol.rgb, scene.a);
    }`,
};

export class VolumePass extends Pass {
  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(VolumeShader.uniforms),
      vertexShader: VolumeShader.vertexShader,
      fragmentShader: VolumeShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.uniforms = this.material.uniforms;
    this.uniforms.tNoise.value = noiseTexture();
    this.quad = new FullScreenQuad(this.material);
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.composite = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CompositeShader.uniforms),
      vertexShader: CompositeShader.vertexShader, fragmentShader: CompositeShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.composite.uniforms.tVolume.value = this.target.texture;
    this.compositeQuad = new FullScreenQuad(this.composite);
    this.camera = null;
    this.light = null;   // a SpotLight, or null for a plain copy
    this.screen = null;  // the glowing screen's RectAreaLight, if the scene has one
    this.screenGlow = 1;
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
  }

  // `config`: { density, anisotropy, scale, steps, ground, groundHeight,
  // screenGlow }, the lengths per model radius. `ground` is how much denser the
  // smoke is at the floor (`floorY`), thinning over `groundHeight`. `screenGlow`
  // scales the screen's light in the smoke.
  configure(config, radius, floorY) {
    const u = this.uniforms;
    this.screenGlow = config.screenGlow ?? 1;
    u.uFloorY.value = floorY;
    u.uGround.value = config.ground ?? 0;
    u.uGroundH.value = (config.groundHeight ?? 1) * radius;
    u.uSigma.value = config.density / radius;
    u.uAniso.value = config.anisotropy ?? 0.35;
    u.uScale.value = (config.scale ?? 1) / radius;
    u.uSteps.value = Math.min(64, config.steps ?? 40);
  }

  // Half resolution, and never wider than 800 px: on a Retina screen the march
  // runs on fewer pixels than the CSS grid, which soft smoke never shows.
  setSize(width, height) {
    const k = Math.min(0.5, 800 / Math.max(1, width));
    this.target.setSize(Math.max(1, Math.ceil(width * k)), Math.max(1, Math.ceil(height * k)));
  }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    const out = this.renderToScreen ? null : writeBuffer;
    const light = this.light, cam = this.camera;
    const u = this.uniforms, f = u.uFrame.value, f2 = u.uFrame2.value;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uCamWorld.value.copy(cam.matrixWorld);
    light.getWorldPosition(this._pos); light.target.getWorldPosition(this._target);
    u.uLightPos.value.copy(this._pos);
    u.uLightDir.value.subVectors(this._target, this._pos).normalize();
    const lc = u.uLightColor.value;
    lc.x = light.color.r * light.intensity; lc.y = light.color.g * light.intensity; lc.z = light.color.b * light.intensity;
    const map = light.castShadow ? light.shadow.map?.depthTexture : null;
    u.tShadow.value = map || null;
    if (map) u.uShadowMatrix.value.copy(light.shadow.matrix);
    f.x = Math.cos(light.angle); f.y = Math.cos(light.angle * (1 - light.penumbra)); f.z = map ? 1 : 0; f.w = cam.far;
    const scr = this.screen, sc = u.uScreenColor.value;
    if (scr && scr.intensity > 0) {
      // A RectAreaLight faces down its local -Z.
      scr.updateWorldMatrix(true, false);
      const e = scr.matrixWorld.elements, sp = u.uScreenPos.value, sd = u.uScreenDir.value;
      sp.x = e[12]; sp.y = e[13]; sp.z = e[14];
      sd.x = -e[8]; sd.y = -e[9]; sd.z = -e[10]; sd.normalize();
      const area = scr.width * scr.height, k = scr.intensity * area * this.screenGlow;
      sc.x = scr.color.r * k; sc.y = scr.color.g * k; sc.z = scr.color.b * k;
      f2.y = area;
    } else {
      sc.x = sc.y = sc.z = 0;
    }
    f2.x = performance.now() * 0.001;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(out);
    this.compositeQuad.render(renderer);
  }

  dispose() {
    this.uniforms.tNoise.value.dispose();
    this.material.dispose(); this.quad.dispose();
    this.target.dispose(); this.composite.dispose(); this.compositeQuad.dispose();
  }
}
