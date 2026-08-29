// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { markShared } from './vibes-scene-common.js';

// Starry-plain scene sprite textures (star / meteor-head / horizon mist),
// cached at module level. Soft radial gradients on a transparent field.
let _starryTex = null;
function starryTextures() {
  if (_starryTex) return _starryTex;
  const radial = (stops, size = 64) => {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(c);
  };
  _starryTex = markShared({
    star: radial([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]),
    meteor: radial([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(200,220,255,0.5)'], [1, 'rgba(180,200,255,0)']]),
    mist: radial([[0, 'rgba(90,115,170,0.10)'], [0.6, 'rgba(80,100,150,0.04)'], [1, 'rgba(70,90,140,0)']], 128),
  });
  return _starryTex;
}

export const scene = {
    name: 'Starry Plain', css: 'scene-night', envInt: 0.1, basic: true, tone: 'none',
    bg: [[0, '#010208'], [1, '#03040f']],
    build(g, { sphere, box }) {
      // A dark Tron-grid plain under a rich twinkling star field, a procedural
      // Milky Way shader dome, a hazy horizon and the odd shooting star — the
      // C64 sits on the grid. Adapted from the author's standalone "Starry Plain" scene; glow is
      // faked in-shader (no bloom) so this renders basic with raw tone mapping.
      const R = sphere.radius, cx = sphere.center.x, cy = sphere.center.y, cz = sphere.center.z, gy = box.min.y;
      const SKY = R * 90;                              // star-dome / horizon radius
      const fine = R * 0.6, major = fine * 5;          // Tron-grid cell sizes
      // The galactic plane crosses the default rear sky instead of wrapping
      // mostly behind the camera; the Z tilt gives it a natural diagonal sweep.
      const MW_TILT = new THREE.Euler(THREE.MathUtils.degToRad(24), 0, THREE.MathUtils.degToRad(28));
      const tex = starryTextures();
      let gridMat = null;

      const env = new THREE.Group(); env.position.set(cx, gy, cz); g.add(env);   // ground level = model base
      const sky = new THREE.Group(); env.add(sky);                                // stars + dome, slowly rotating

      // ── Ground: dark plain with a glowing Tron grid that dissolves with distance ──
      {
        const mat = new THREE.ShaderMaterial({
          extensions: { derivatives: true },
          uniforms: { uFine: { value: fine }, uMajor: { value: major }, uTime: { value: 0 } },
          vertexShader: `
            varying vec2 vP;
            void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: `
            uniform float uFine; uniform float uMajor; uniform float uTime; varying vec2 vP;
            float gridLine(float coord, float spacing, float halfWidth){
              float p = coord / spacing;
              float dLine = abs(fract(p + 0.5) - 0.5);
              float w = max(fwidth(p), 1e-5);
              float line = 1.0 - smoothstep(halfWidth, halfWidth + w, dLine);
              return line * clamp(halfWidth * 2.0 / w, 0.0, 1.0);
            }
            void main(){
              float d = length(vP);
              float t = smoothstep(uMajor * 0.6, uMajor * 26.0, d);
              vec3 col = mix(vec3(0.009, 0.014, 0.024), vec3(0.018, 0.030, 0.068), t);
              float fade = 1.0 - smoothstep(uMajor * 1.5, uMajor * 10.0, d);
              float g1 = max(gridLine(vP.x, uFine, 0.020), gridLine(vP.y, uFine, 0.020));
              float g2 = max(gridLine(vP.x, uMajor, 0.007), gridLine(vP.y, uMajor, 0.007));
              float h1 = max(gridLine(vP.x, uFine, 0.10), gridLine(vP.y, uFine, 0.10));
              float h2 = max(gridLine(vP.x, uMajor, 0.045), gridLine(vP.y, uMajor, 0.045));
              col += vec3(0.07, 0.18, 0.70) * (g1 * 0.24 + g2 * 0.78 + h1 * 0.06 + h2 * 0.18) * fade;
              // One broad, slow scanner ring gives the otherwise still plain a
              // little life without turning it into the Synthwave highway.
              float ringPhase = mod(d - uTime * uMajor * 0.55, uMajor * 14.0);
              float ring = exp(-pow((ringPhase - uMajor * 7.0) / (uMajor * 0.48), 2.0));
              col += vec3(0.04, 0.20, 0.42) * ring * fade * 0.16;
              gl_FragColor = vec4(col, 1.0);
            }`,
        });
        gridMat = mat;
        const ground = new THREE.Mesh(new THREE.CircleGeometry(SKY * 1.3, 128), mat);
        ground.rotation.x = -Math.PI / 2; env.add(ground);
      }

      // ── Twinkling star layers (custom shader points; soft radial sprite) ──
      const starMats = [];
      const starColor = () => {
        const tt = Math.random(), c = new THREE.Color();
        if (tt < 0.55) c.setHSL(0.60 + Math.random() * 0.05, 0.55, 0.78);       // pale blue
        else if (tt < 0.88) c.setHSL(0.13, 0.12, 0.92);                          // warm white
        else c.setHSL(0.07, 0.75, 0.72);                                         // orange
        return c;
      };
      const makeStars = ({ count, sizeMin, sizeMax, milkyWay, brightness = 1 }) => {
        const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
        const sizes = new Float32Array(count), phase = new Float32Array(count);
        const v = new THREE.Vector3(); let i = 0;
        while (i < count) {
          if (milkyWay) {
            const theta = Math.random() * Math.PI * 2;
            const gauss = (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
            const spread = 0.13 + 0.09 * Math.abs(Math.sin(theta * 2 + 1.3));
            const phi = gauss * spread * Math.PI;
            v.set(Math.cos(theta) * Math.cos(phi), Math.sin(phi), Math.sin(theta) * Math.cos(phi)).applyEuler(MW_TILT);
            if (v.y < 0.0) { i++; continue; }
          } else {
            v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
            if (v.lengthSq() > 1 || v.lengthSq() < 0.01) continue;
            v.normalize();
            if (v.y < -0.02) continue;
          }
          pos[i * 3] = v.x * SKY; pos[i * 3 + 1] = v.y * SKY; pos[i * 3 + 2] = v.z * SKY;
          const c = starColor();
          const dim = (milkyWay ? (0.4 + Math.random() * 0.6) * 1.4 : 0.55 + Math.random() * 0.45) * brightness * 1.4;
          col[i * 3] = c.r * dim; col[i * 3 + 1] = c.g * dim; col[i * 3 + 2] = c.b * dim;
          sizes[i] = sizeMin + Math.random() * (sizeMax - sizeMin);
          phase[i] = Math.random() * Math.PI * 2;
          i++;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uTex: { value: tex.star } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          vertexShader: `
            attribute vec3 aColor; attribute float aSize; attribute float aPhase;
            uniform float uTime; varying vec3 vColor;
            void main(){
              float tw = 0.72 + 0.28 * sin(uTime * (1.5 + aPhase) + aPhase * 7.0);
              vColor = aColor * tw;
              gl_PointSize = aSize * (0.85 + 0.15 * tw);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform sampler2D uTex; varying vec3 vColor;
            void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vColor * t.rgb, t.a); }`,
        });
        starMats.push(mat);
        return new THREE.Points(geo, mat);
      };
      for (const s of [
        makeStars({ count: 9000, sizeMin: 1.0, sizeMax: 3.2, milkyWay: false }),
        makeStars({ count: 150, sizeMin: 3.6, sizeMax: 7.5, milkyWay: false, brightness: 1.4 }),
        makeStars({ count: 24000, sizeMin: 0.6, sizeMax: 1.7, milkyWay: true }),
        makeStars({ count: 6000, sizeMin: 1.5, sizeMax: 2.8, milkyWay: true, brightness: 1.2 }),
      ]) sky.add(s);

      // ── Milky Way: procedural shader dome (coherent band + snaking dust lane) ──
      {
        const mat = new THREE.ShaderMaterial({
          side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: {
            uN: { value: new THREE.Vector3(0, 1, 0).applyEuler(MW_TILT) },
            uU: { value: new THREE.Vector3(1, 0, 0).applyEuler(MW_TILT) },
            uW: { value: new THREE.Vector3(0, 0, 1).applyEuler(MW_TILT) },
            uCenter: { value: new THREE.Vector3(cx, gy, cz) },
          },
          vertexShader: `
            varying vec3 vWorld;
            void main(){ vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0); }`,
          fragmentShader: `
            uniform vec3 uN; uniform vec3 uU; uniform vec3 uW; uniform vec3 uCenter; varying vec3 vWorld;
            float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float vnoise(vec2 p){
              vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
            }
            float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ v += a * vnoise(p); p = p * 2.13 + 7.7; a *= 0.5; } return v; }
            void main(){
              vec3 d = normalize(vWorld - uCenter);
              float s = dot(d, uN);
              float az = atan(dot(d, uW), dot(d, uU));
              vec2 q = vec2(az * 2.6, s * 9.5);
              float n1 = fbm(q), n2 = fbm(q * 2.4 + 31.7);
              float width = 0.15 + 0.05 * sin(az * 1.7 + 0.8);
              float band = exp(-pow(s / width, 2.0));
              float glow = band * (0.45 + 0.55 * n1);
              float core = exp(-pow((az - 1.15) / 0.85, 2.0)) * band;
              glow += core * 0.22 * (0.4 + 0.6 * n2);
              float laneC = 0.035 * sin(az * 2.6 + 1.7) + (n2 - 0.5) * 0.06;
              float laneW = 0.035 + 0.030 * n1;
              float lane = exp(-pow((s - laneC) / laneW, 2.0));
              glow *= 1.0 - lane * (0.45 + 0.40 * n2);
              glow *= 0.55 + 0.45 * smoothstep(0.25, 0.75, n1);
              glow *= smoothstep(0.01, 0.22, d.y);
              glow = clamp(glow, 0.0, 1.0);
              float blueNebula = exp(-pow((az + 0.45) / 0.52, 2.0)) * band * (0.35 + 0.65 * n2);
              float violetNebula = exp(-pow((az - 1.55) / 0.38, 2.0)) * band * (0.3 + 0.7 * n1);
              vec3 col = mix(vec3(0.035, 0.065, 0.17), vec3(0.18, 0.31, 0.62), glow);
              col += vec3(0.03, 0.10, 0.22) * blueNebula;
              col += vec3(0.16, 0.035, 0.24) * violetNebula;
              col += vec3(0.05, 0.042, 0.032) * core;
              gl_FragColor = vec4(col * glow * 1.28, 1.0);
            }`,
        });
        const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY * 0.95, 64, 48), mat);
        dome.renderOrder = -1; sky.add(dome);
      }

      // ── Hazy horizon glow (fades up from the ground) ──
      {
        const mat = new THREE.ShaderMaterial({
          side: THREE.BackSide, transparent: true, depthWrite: false,
          vertexShader: `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: `varying float vY;
            void main(){
              float t = clamp(1.0 - (vY / ${(SKY * 0.15).toFixed(1)} + 1.0) * 0.5, 0.0, 1.0);
              t = pow(t, 1.6);
              gl_FragColor = vec4(mix(vec3(0.007,0.011,0.035), vec3(0.045,0.068,0.15), t), t * 0.9);
            }`,
        });
        const m = new THREE.Mesh(new THREE.CylinderGeometry(SKY * 0.995, SKY * 0.995, SKY * 0.30, 64, 1, true), mat);
        m.position.y = SKY * 0.12; env.add(m);
      }

      // ── Ground mist banks near the horizon ──
      for (let k = 0; k < 26; k++) {
        const a = Math.random() * Math.PI * 2, dd = SKY * (0.3 + Math.random() * 0.3);
        const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.mist, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.25 + Math.random() * 0.25 }));
        m.position.set(Math.cos(a) * dd, R * (0.2 + Math.random() * 0.8), Math.sin(a) * dd);
        m.scale.set(SKY * (0.17 + Math.random() * 0.23), SKY * (0.02 + Math.random() * 0.027), 1);
        env.add(m);
      }

      // ── Soft cool light so the C64 reads under the stars (reference has no lit objects) ──
      const key = new THREE.DirectionalLight(0xbfd0ff, 0.7);
      key.position.set(cx - R * 3, cy + R * 6, cz + R * 2); key.target.position.copy(sphere.center); g.add(key, key.target);
      g.add(new THREE.HemisphereLight(0x2a3a6a, 0x0a0a12, 0.5));
      g.add(new THREE.AmbientLight(0x101828, 0.3));

      // ── Shooting stars (spawned over time in animate) ──
      const meteors = [];
      const spawnMeteor = () => {
        const az = Math.random() * Math.PI * 2, el = 0.5 + Math.random() * 0.9;
        const start = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(SKY * 0.9);
        const dir = new THREE.Vector3(Math.random() - 0.5, -(0.4 + Math.random() * 0.6), Math.random() - 0.5).normalize();
        const len = SKY * (0.07 + Math.random() * 0.13), N = 26;
        const pos = new Float32Array(N * 3), alpha = new Float32Array(N), sz = new Float32Array(N);
        for (let j = 0; j < N; j++) {
          const p = start.clone().addScaledVector(dir, -len * (j / (N - 1)));
          pos[j * 3] = p.x; pos[j * 3 + 1] = p.y; pos[j * 3 + 2] = p.z;
          alpha[j] = Math.pow(1 - j / (N - 1), 1.6);
          sz[j] = j === 0 ? 7 : 4.5 * (1 - j / N);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
        geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTex: { value: tex.meteor }, uFade: { value: 1 } },
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          vertexShader: `
            attribute float aAlpha; attribute float aSize; varying float vA;
            void main(){ vA = aAlpha; gl_PointSize = aSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: `
            uniform sampler2D uTex; uniform float uFade; varying float vA;
            void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vec3(0.85,0.92,1.0) * t.rgb, t.a * vA * uFade); }`,
        });
        const pts = new THREE.Points(geo, mat); env.add(pts);
        meteors.push({ obj: pts, mat, dir, speed: SKY * (0.3 + Math.random() * 0.23), life: 0, maxLife: 1.1 + Math.random() * 0.7 });
      };

      g.userData.starry = { sky, starMats, gridMat, meteors, spawn: spawnMeteor, env, nextMeteor: 2, lastT: undefined };
    },
    animate(g, t) {
      const d = g.userData.starry; if (!d) return;
      const dt = Math.min(t - (d.lastT ?? t), 0.05); d.lastT = t;
      d.sky.rotation.y = t * 0.004;                       // slow parallax drift
      if (d.gridMat) d.gridMat.uniforms.uTime.value = t;
      for (let i = 0; i < d.starMats.length; i++) d.starMats[i].uniforms.uTime.value = t;   // indexed: no per-frame iterator alloc
      d.nextMeteor -= dt;
      if (d.nextMeteor <= 0) { d.spawn(); d.nextMeteor = 3 + Math.random() * 6; }
      for (let i = d.meteors.length - 1; i >= 0; i--) {
        const m = d.meteors[i]; m.life += dt;
        m.obj.position.addScaledVector(m.dir, m.speed * dt);
        const k = m.life / m.maxLife;
        m.mat.uniforms.uFade.value = k < 0.15 ? k / 0.15 : Math.max(0, 1 - (k - 0.15) / 0.85);
        if (k >= 1) { d.env.remove(m.obj); m.obj.geometry.dispose(); m.mat.dispose(); d.meteors.splice(i, 1); }
      }
    },
};
