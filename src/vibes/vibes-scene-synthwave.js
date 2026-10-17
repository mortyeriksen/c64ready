// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addCrtLight, animateCrtLight } from './vibes-crt-light.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture, markShared } from './vibes-scene-common.js';
import { cacheWaterReflection } from './vibes-reflection-cache.js';

// Synthwave: a neon highway toward a banded sun, lit and driven. Neon (grid, rails,
// sun, chevrons) is pushed above 1.0 so the bloom pass catches only it, under
// Khronos PBR Neutral tone mapping, which leaves everything below ~0.8 as it
// is. The road is a wet mirror (a Reflector refreshed at 30 Hz; a painted sun
// streak on low-power devices), and grid, road marks, palms and signs all flow
// toward the viewer at one speed. A city skyline stands on the horizon in
// front of the sun. Stars, palms and towers are placed from fixed seeds.

// The road's chevron signs: one extruded shape, mirrored for the other side.
export function makeChevronGeometry(radius, side) {
  const s = side < 0 ? -1 : 1;
  const points = [
    [-0.30, 0.25], [-0.12, 0.25], [0.30, 0],
    [-0.12, -0.25], [-0.30, -0.25], [0.10, 0],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0] * radius * s, points[0][1] * radius);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0] * radius * s, points[i][1] * radius);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: radius * 0.05, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -radius * 0.025);
  return geometry;
}

// The shader colours below are written in sRGB, as picked. The composer treats
// shader output as linear, so LIN turns them linear first, and the neon is
// pushed past 1.0 after that.
const LIN = 'vec3 lin(vec3 c){ return pow(max(c, vec3(0.0)), vec3(2.2)); }';

// The world's speed toward the viewer, per model radius per second.
export const FLOW = 1.15 * 0.58;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The sunset as light: violet above, the pink horizon, the sun toward -z (u
// 0.25 in three's equirect), dark ground. Baked to a PMREM once, shared.
let envMap = null;
function neonEnvMap(renderer) {
  if (envMap) return envMap;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 64);
  [[0, '#2a1450'], [0.5, '#6a2a8c'], [0.82, '#b4467e'], [1, '#d8708a']].forEach(([o, col]) => sky.addColorStop(o, col));
  x.fillStyle = sky; x.fillRect(0, 0, 256, 64);
  const ground = x.createLinearGradient(0, 64, 0, 128);
  ground.addColorStop(0, '#5a2a5e'); ground.addColorStop(1, '#2a1a34');
  x.fillStyle = ground; x.fillRect(0, 64, 256, 64);
  // The sun only warms the light: a soft glow, no hot spot for gloss to catch.
  const sun = x.createRadialGradient(64, 58, 4, 64, 58, 34);
  sun.addColorStop(0, 'rgba(255,170,120,0.45)'); sun.addColorStop(0.5, 'rgba(255,90,140,0.25)'); sun.addColorStop(1, 'rgba(255,40,140,0)');
  x.fillStyle = sun; x.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envMap = pmrem.fromEquirectangular(tex).texture;
  envMap._shared = true;
  pmrem.dispose(); tex.dispose();
  return envMap;
}

// The soft dark footprint under the setup, drawn once.
let footprint = null;
function footprintTexture() {
  if (footprint) return footprint;
  const tex = canvasTexture(128, (ctx, size) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.75)'); g.addColorStop(0.55, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  });
  footprint = markShared(tex);
  return footprint;
}

// The road's markings, shared by the mirror and the painted fallback. uv.y runs
// from the near end (0) to the far end (1); marks flow toward the viewer.
const ROAD_MARKS = `
  float stripe(float distance, float width, float pixel) {
    return (1.0 - smoothstep(max(0.0, width - pixel * 0.5), width + pixel * 0.5, distance)) * min(1.0, 2.0 * width / pixel);
  }
  ${LIN}
  vec3 roadMarks(vec2 uv, float t, float flow, float gain) {
    vec2 pixel = max(fwidth(uv), vec2(0.00001));
    float x = abs(uv.x - 0.5);
    float edge = stripe(abs(x - 0.465), 0.018, pixel.x);
    vec3 rail = mix(vec3(1.0, 0.05, 0.62), vec3(0.05, 0.75, 0.9), step(0.5, uv.x));
    float y = uv.y + t * flow;
    float dash = stripe(x, 0.018, pixel.x) * stripe(abs(fract(y * 16.0) - 0.5), 0.14, pixel.y * 16.0);
    vec3 c = vec3(0.012, 0.0, 0.035) + vec3(0.025, 0.002, 0.055) * (1.0 - x * 2.0) * 0.35;
    return lin(c + vec3(0.9, 0.08, 0.48) * dash * 0.18) + lin(rail * 0.56) * edge * gain;
  }`;

const ROAD_VERTEX = `
  uniform mat4 textureMatrix;
  varying vec4 vUvR; varying vec2 vUv; varying vec3 vW;
  void main() {
    vUv = uv;
    vUvR = textureMatrix * vec4(position, 1.0);
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// The mirror: the markings over a dark reflection, smeared a little along the
// road like wet asphalt and strongest at grazing angles. Like real wet asphalt
// it shows bright things (the sun, the neon) and stays dark for a dull sky.
const MirrorShader = {
  name: 'NeonRoadMirror',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    uTime: { value: 0 }, uFlow: { value: 0 }, uGain: { value: 2.2 }, uReflect: { value: 0.6 },
  },
  vertexShader: ROAD_VERTEX,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec3 color; uniform float uTime, uFlow, uGain, uReflect;
    varying vec4 vUvR; varying vec2 vUv; varying vec3 vW;
    ${ROAD_MARKS}
    void main() {
      vec2 r = vUvR.xy / vUvR.w;
      r.x += sin(vW.z * 1.7 + vW.x * 0.6) * 0.0025;
      vec3 refl = vec3(0.0);
      for (int i = 0; i < 4; i++) refl += texture2D(tDiffuse, r + vec2(0.0, (float(i) - 1.5) * 0.0035)).rgb;
      refl *= 0.25;
      refl *= smoothstep(0.12, 0.6, dot(refl, vec3(0.2126, 0.7152, 0.0722)));
      vec3 v = normalize(cameraPosition - vW);
      float fresnel = 0.08 + 0.92 * pow(1.0 - max(v.y, 0.0), 3.0);
      gl_FragColor = vec4(roadMarks(vUv, uTime, uFlow, uGain) + refl * uReflect * fresnel, 1.0);
    }`,
};

// The fallback: the same markings and a painted, broken sun streak.
const PaintedRoadShader = {
  uniforms: { uTime: { value: 0 }, uFlow: { value: 0 }, uGain: { value: 2.2 } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform float uTime, uFlow, uGain;
    varying vec2 vUv;
    ${ROAD_MARKS}
    void main() {
      float x = (vUv.x - 0.5) / 0.09;
      float streak = exp(-x * x) * smoothstep(0.2, 0.97, vUv.y);
      float broken = 0.55 + 0.45 * sin((vUv.y + uTime * uFlow) * 140.0);
      vec3 sun = lin(mix(vec3(1.0, 0.12, 0.5), vec3(1.0, 0.7, 0.3), smoothstep(0.6, 1.0, vUv.y)));
      gl_FragColor = vec4(roadMarks(vUv, uTime, uFlow, uGain) + sun * streak * broken * 0.35, 1.0);
    }`,
};

// The palms and mountains, modelled in Blender: public/models/synthwave.glb.
// The fetch is shared and the parse is per build, as the viewer disposes a
// scene's meshes when it leaves; preload() starts it so the scene arrives whole.
const BASE = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/') + 'models/';
const FILE = BASE + 'synthwave.glb';
let fetched = null, prepared = null;
function loadScenery() {
  if (!fetched) {
    fetched = fetch(FILE).then((r) => { if (!r.ok) throw new Error(`${FILE}: HTTP ${r.status}`); return r.arrayBuffer(); });
    fetched.catch(() => { fetched = null; });
  }
  return fetched.then((bytes) => new GLTFLoader().parseAsync(bytes, BASE));
}
function disposeTree(root) {
  root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}

// A contour mesh is a coarse quad grid; its lines are the triangle edges that
// run along one axis (same x or same z), never the diagonals.
export function gridLines(geo) {
  const pos = geo.attributes.position, idx = geo.index, out = [], seen = new Set();
  const eps = 1e-4, n = idx ? idx.count : pos.count;
  const at = (k) => (idx ? idx.getX(k) : k);
  for (let t = 0; t < n; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = at(t + e), b = at(t + (e + 1) % 3), key = a < b ? a * 1e6 + b : b * 1e6 + a;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Math.abs(pos.getX(a) - pos.getX(b)) > eps && Math.abs(pos.getZ(a) - pos.getZ(b)) > eps) continue;
      out.push(pos.getX(a), pos.getY(a), pos.getZ(a), pos.getX(b), pos.getY(b), pos.getZ(b));
    }
  }
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return lines;
}

// The palms: near-black silhouettes with a faint pink rim, as if backlit by the
// sun, fading into the fog like the rest of the scene.
function rimMaterial() {
  return new THREE.ShaderMaterial({
    fog: true, side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uBody: { value: new THREE.Color(0x020007) }, uRim: { value: new THREE.Color(0.9, 0.12, 0.5) },
    }]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 uBody, uRim; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        gl_FragColor = vec4(uBody + uRim * rim * 0.6, 1.0);
        #include <fog_fragment>
      }`,
  });
}

// The city on the horizon: a seeded row of towers in one mesh, its windows,
// rooftop neon and spire beacons drawn by one shader. aInfo per vertex: the
// tower's seed, its roof height, and its trim (0 none, 1 pink rim, 2 cyan
// rim, 3 spire). Windows below a pixel fade to their average, so they never
// shimmer at a distance.
export function makeSkyline(R, cx, floorY, zFront, rnd) {
  const parts = [];
  const tower = (x, z, w, h, d, trim) => {
    const geo = new THREE.BoxGeometry(w, h, d).translate(x, floorY + h / 2, z);
    const info = new Float32Array(geo.attributes.position.count * 3);
    const seed = rnd() * 97;
    for (let i = 0; i < info.length; i += 3) { info[i] = seed; info[i + 1] = floorY + h; info[i + 2] = trim; }
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 3));
    parts.push(geo);
  };
  for (const [row, z, lift] of [[0, zFront, 1], [1, zFront - R * 2.5, 1.35]]) {
    for (let x = cx - R * 19; x < cx + R * 19;) {
      const w = R * (0.7 + rnd() * 1.1), mid = x + w / 2 - cx;
      const peak = 1 + 0.9 * Math.exp(-(mid * mid) / (R * R * 60));   // taller toward the sun
      let h = R * (0.9 + rnd() * 2.4) * peak * lift;
      if (rnd() < 0.14) h *= 1.6;
      const trim = rnd() < 0.3 ? 1 + (rnd() < 0.5 ? 1 : 0) : 0;
      tower(x + w / 2, z, w, h, R * (0.9 + rnd() * 0.6), row ? 0 : trim);
      if (h > R * 4.6) tower(x + w / 2, z, R * 0.06, h + R * 0.9, R * 0.06, 3);
      x += w + R * rnd() * 0.25;
    }
  }
  const geo = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const uniforms = { uTime: { value: 0 }, uR: { value: R }, uFloor: { value: floorY } };
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `attribute vec3 aInfo; varying vec3 vW, vN, vInfo;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normal; vInfo = aInfo;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vW, vN, vInfo; uniform float uTime, uR, uFloor; ${LIN}
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        vec3 c = lin(vec3(0.03, 0.0, 0.075));
        float roof = step(0.5, vN.y), side = step(0.5, abs(vN.x)), trim = vInfo.z;
        if (trim > 2.5) {
          float blink = step(0.55, fract(uTime * 0.6 + vInfo.x));
          c += lin(vec3(1.0, 0.1, 0.15)) * 2.4 * blink * step(vInfo.y - uR * 0.12, vW.y);
        } else if (roof < 0.5) {
          vec2 f = vec2(side > 0.5 ? vW.z : vW.x, vW.y - uFloor) / uR / vec2(0.26, 0.32);
          vec2 cell = floor(f), q = fract(f), fw = fwidth(f);
          vec2 m = smoothstep(0.2 - fw, 0.2 + fw, q) * (1.0 - smoothstep(0.75 - fw, 0.75 + fw, q));
          float win = mix(m.x * m.y, 0.3, clamp(max(fw.x, fw.y) * 2.0 - 0.6, 0.0, 1.0));
          float swap = floor(uTime / 23.0 + h21(cell + vInfo.x));
          float lit = step(0.72, h21(cell * 1.7 + vInfo.x * 13.0 + swap * 0.37));
          float hue = h21(cell + vInfo.x * 7.0);
          vec3 wc = hue < 0.6 ? vec3(1.0, 0.62, 0.3) : hue < 0.85 ? vec3(1.0, 0.3, 0.72) : vec3(0.35, 0.85, 1.0);
          float street = smoothstep(0.5, 1.5, f.y) * step(f.y, (vInfo.y - uFloor) / uR / 0.32 - 1.0);
          c += lin(wc) * win * lit * street * (side > 0.5 ? 0.45 : 0.9);
          if (trim > 0.5) {
            float px = max(fwidth(vW.y) * 1.5, uR * 0.035);
            float rim = 1.0 - smoothstep(0.0, px, vInfo.y - vW.y);
            c += lin(trim < 1.5 ? vec3(1.0, 0.18, 0.66) : vec3(0.1, 0.85, 1.0)) * 2.2 * rim;
          }
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  return { mesh, uniforms };
}

export const scene = {
  name: 'Synthwave', css: 'scene-synthwave', envInt: 0.6, envMap: neonEnvMap,
  tone: 'neutral', exposure: 1.0,
  fog: { color: 0x100027, near: 9, far: 52 },
  // Only what is pushed past 1.0 glows: the neon, never the live picture.
  bloom: { strength: 0.8, radius: 0.4, threshold: 1.0 },
  halation: [[1, 1, 1], [1, 0.9, 1], [1, 0.75, 0.95], [1, 0.6, 0.9], [1, 0.5, 0.85]],
  grade: { aberration: 0.0007, vignette: 0.28, grain: 0.014 },
  // Resolves once the scenery is ready for build(), or failed (build() then warns).
  preload() {
    if (!prepared) prepared = loadScenery();
    return prepared.then(() => {}, () => {});
  },
  build(g, { sphere, box, screen, lowPower }) {
    const R = sphere.radius, cx = sphere.center.x, cy = sphere.center.y, cz = sphere.center.z;
    // The model stays where it is, so the world is fitted to it: the road's
    // surface is the model's lowest point, the grid and all that stands on it
    // a hair below.
    const roadY = box.min.y, gyFloor = roadY - R * 0.018;
    const rnd = seeded(0x5eed);
    const cell = R * 1.15, speed = FLOW * R;   // world units per second toward +z

    // Sky dome, as in Synthwave.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(R * 72, 32, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec3 vP; ${LIN}
          void main(){
            float h=normalize(vP).y;
            vec3 deep=vec3(0.012,0.0,0.055), mid=vec3(0.13,0.012,0.25), low=vec3(0.72,0.08,0.31);
            vec3 c=mix(mid,deep,smoothstep(0.04,0.62,h));
            c=mix(low,c,smoothstep(-0.025,0.17,h));
            gl_FragColor=vec4(lin(c),1.0);
          }`,
      }),
    );
    sky.position.set(cx, cy, cz); g.add(sky);

    // Twinkling stars, each on its own phase.
    const starU = { uTime: { value: 0 } };
    const stars = (n, px, color, minY) => {
      const p = new Float32Array(n * 3), phase = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, r = R * (38 + rnd() * 25);
        p[i * 3] = cx + Math.cos(a) * r;
        p[i * 3 + 1] = cy + R * (minY + rnd() * (48 - minY));
        p[i * 3 + 2] = cz + Math.sin(a) * r - R * 15;
        phase[i] = rnd();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      g.add(new THREE.Points(geo, new THREE.ShaderMaterial({
        uniforms: { uTime: starU.uTime, uColor: { value: new THREE.Color(color) }, uPx: { value: px } },
        vertexShader: `attribute float aPhase; uniform float uTime, uPx; varying float vA;
          void main(){
            vA = 0.5 + 0.5 * sin(uTime * (0.7 + aPhase * 1.6) + aPhase * 6.2832);
            gl_PointSize = uPx; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `uniform vec3 uColor; varying float vA;
          void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.2, 0.5, d)) * (0.35 + 0.6 * vA)); }`,
        transparent: true, depthWrite: false, fog: false,
      })));
    };
    stars(430, 2.0, 0x9fd9ff, 10);
    stars(85, 3.4, 0xf1ddff, 14);

    // One shooting star, pooled: a streak brightest at its head.
    const streakMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `uniform float uFade; varying vec2 vUv;
        void main(){ float a = vUv.x * vUv.x * (1.0 - smoothstep(0.2, 0.5, abs(vUv.y - 0.5))) * uFade;
          gl_FragColor = vec4(vec3(1.6, 1.2, 1.9) * a, a); }`,
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    });
    const streak = new THREE.Mesh(new THREE.PlaneGeometry(R * 7, R * 0.09), streakMat);
    streak.visible = false; g.add(streak);

    // The banded sun, lower so it sits whole above the horizon, its colour
    // pushed past 1.0 to bloom.
    const sunU = { uTime: { value: 0 } };
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(R * 28, R * 28), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, uniforms: sunU,
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uTime; ${LIN}
        float hash(float n){ return fract(sin(n*12.9898)*43758.5453); }
        void main(){
          vec2 p=vUv-0.5; float d=length(p)*2.0, y=vUv.y;
          float disc=1.0-smoothstep(0.595,0.615,d);
          float bands=y*13.0-uTime*0.1, row=floor(bands);
          float edge=0.31-y*0.28+(hash(row)-0.5)*0.075;
          float cuts=smoothstep(0.0,0.045,abs(fract(bands)-0.5)-edge);
          float mask=disc*clamp(cuts+step(0.57,y),0.0,1.0);
          float halo=(1.0-smoothstep(0.62,1.0,d))*(1.0-disc)*0.32;
          vec3 top=vec3(1.0,0.82,0.28), bot=vec3(1.0,0.08,0.48);
          vec3 c=lin(mix(bot,top,y))*1.9;
          gl_FragColor=vec4(mix(c,lin(vec3(1.0,0.18,0.58))*1.2,halo*0.6),max(mask,halo));
        }`,
    }));
    sun.position.set(cx, cy + R * 3.4, cz - R * 59); sun.renderOrder = -1; g.add(sun);

    // Thin cloud streaks across the sun, dark violet lit pink along their tops.
    const cloudU = { uTime: { value: 0 } };
    const clouds = new THREE.Mesh(new THREE.PlaneGeometry(R * 44, R * 16), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, uniforms: cloudU,
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uTime; ${LIN}
        float hash(float n){ return fract(sin(n*91.345)*43758.5453); }
        void main(){
          vec3 col = vec3(0.0); float a = 0.0;
          for (int k = 0; k < 5; k++) {
            float fk = float(k);
            float cy = 0.34 + fk * 0.1 + (hash(fk) - 0.5) * 0.05, h = 0.012 + hash(fk + 3.0) * 0.014;
            float drift = fract(uTime * (0.002 + hash(fk + 5.0) * 0.003));
            float x0 = 0.05 + hash(fk + 7.0) * 0.35, x1 = x0 + 0.3 + hash(fk + 11.0) * 0.35;
            float x = fract(vUv.x + drift);
            float ends = smoothstep(x0, x0 + 0.1, x) * (1.0 - smoothstep(x1 - 0.1, x1, x));
            float dy = (vUv.y - cy) / h;
            float body = (1.0 - smoothstep(0.5, 1.0, abs(dy))) * ends;
            vec3 c = mix(lin(vec3(0.06, 0.0, 0.12)), lin(vec3(1.0, 0.3, 0.65)) * 1.4, smoothstep(-0.1, 1.0, dy) * 0.7);
            col = mix(col, c, body); a = max(a, body * 0.9);
          }
          gl_FragColor = vec4(col, a);
        }`,
    }));
    clouds.position.set(cx, cy + R * 3.4, cz - R * 57); clouds.renderOrder = -1; g.add(clouds);

    // Two horizon hazes: the pink glow under the sun and a wider violet band.
    const haze = (w, h, y, z, color, alpha) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        uniforms: { uColor: { value: new THREE.Color().setRGB(...color, THREE.SRGBColorSpace) }, uAlpha: { value: alpha } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha; void main(){
          float x=1.0-smoothstep(0.0,0.5,abs(vUv.x-0.5)), y=1.0-smoothstep(0.0,0.5,abs(vUv.y-0.5));
          gl_FragColor=vec4(uColor,x*y*y*uAlpha);
        }`,
      }));
      m.position.set(cx, gyFloor + y, z); m.renderOrder = -2; g.add(m);
    };
    haze(R * 78, R * 11, R * 4.1, cz - R * 58, [0.95, 0.08, 0.45], 0.22);
    haze(R * 120, R * 7, R * 1.8, cz - R * 50, [0.35, 0.05, 0.6], 0.3);

    // The city, between the palms' far end and the clouds, in front of the sun.
    const city = makeSkyline(R, cx, gyFloor, cz - R * 54, seeded(0xc17e));
    g.add(city.mesh);

    // The grid, flat and flowing toward the viewer, its lines pushed to glow.
    const gridU = {
      uTime: { value: 0 }, uCenter: { value: new THREE.Vector2(cx, cz) },
      uCell: { value: cell }, uNear: { value: R * 6 }, uFar: { value: R * 54 }, uSpeed: { value: speed },
    };
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(R * 128, R * 128), new THREE.ShaderMaterial({
      uniforms: gridU,
      vertexShader: 'varying vec2 vXZ; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vXZ=w.xz; gl_Position=projectionMatrix*viewMatrix*w; }',
      fragmentShader: `varying vec2 vXZ; uniform float uTime,uCell,uNear,uFar,uSpeed; uniform vec2 uCenter; ${LIN}
        float lineAt(float v,float w){
          float pixel=max(fwidth(v),0.00001);
          float f=abs(fract(v)-0.5);
          return (1.0-smoothstep(w,w+pixel,f))*min(1.0,w/pixel);
        }
        void main(){
          vec2 rel=vXZ-uCenter;
          vec2 q=vec2(rel.x/uCell,(rel.y-uTime*uSpeed)/uCell);
          float minor=max(lineAt(q.x,0.045),lineAt(q.y,0.045));
          float major=max(lineAt(q.x/5.0,0.022),lineAt(q.y/5.0,0.022));
          float line=max(minor*0.36,major*0.82);
          float fade=max(0.08,1.0-smoothstep(uNear,uFar,length(rel)));
          vec3 base=vec3(0.018,0.0,0.052), cyan=vec3(0.02,0.55,0.7), pink=vec3(0.75,0.04,0.48);
          vec3 c=lin(base)+lin(mix(pink,cyan,smoothstep(uNear*2.0,uFar,abs(rel.y))))*line*fade*2.2;
          gl_FragColor=vec4(c,1.0);
        }`,
    }));
    grid.rotation.x = -Math.PI / 2; grid.position.set(cx, gyFloor, cz); g.add(grid);

    // The road: a wet mirror, or painted on low-power devices.
    const roadLen = R * 124;
    const roadGeo = new THREE.PlaneGeometry(R * 8.0, roadLen);
    let road, roadU;
    if (lowPower) {
      road = new THREE.Mesh(roadGeo, new THREE.ShaderMaterial({ ...PaintedRoadShader, uniforms: THREE.UniformsUtils.clone(PaintedRoadShader.uniforms) }));
      roadU = road.material.uniforms;
    } else {
      const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
      const w = typeof window !== 'undefined' ? window.innerWidth : 1280, h = typeof window !== 'undefined' ? window.innerHeight : 800;
      road = new Reflector(roadGeo, {
        shader: MirrorShader, clipBias: 0.003, multisample: 0,
        textureWidth: Math.round(Math.min(1280, w * dpr * 0.5)), textureHeight: Math.round(Math.min(800, h * dpr * 0.5)),
      });
      roadU = road.material.uniforms;
      g.userData.reflection = cacheWaterReflection(road, []);
    }
    roadU.uFlow.value = speed / roadLen;
    road.rotation.x = -Math.PI / 2; road.position.set(cx, roadY, cz - R * 29); g.add(road);

    // A soft footprint under the setup, on the road.
    const fw = (box.max.x - box.min.x) * 1.35, fd = (box.max.z - box.min.z) * 1.35;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), new THREE.MeshBasicMaterial({
      map: footprintTexture(), transparent: true, depthWrite: false, color: 0x000000, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set((box.min.x + box.max.x) / 2, roadY + R * 0.002, (box.min.z + box.max.z) / 2);
    shadow.renderOrder = 1; g.add(shadow);

    // Palms and chevron signs drive past: each loops from the far fog to just
    // behind the setup. `movers` holds their starting z, read in animate(). The
    // palms and mountains come from the scene's GLB, placed once it is in.
    const zFar = cz - R * 52, zNear = cz + R * 16;
    const movers = [];
    const span = zNear - zFar, step = span / 7;
    const boardGeo = new THREE.BoxGeometry(R * 0.9, R * 0.58, R * 0.08);
    const boardMat = new THREE.MeshBasicMaterial({ color: 0x090016 });
    const chevronMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 1.15, 0.55) });
    const chevron = (side, z) => {
      const sign = new THREE.Group();
      const board = new THREE.Mesh(boardGeo, boardMat); board.position.y = R * 0.78; sign.add(board);
      const arrow = new THREE.Mesh(makeChevronGeometry(R, side), chevronMat);
      arrow.position.set(0, R * 0.78, R * 0.066); sign.add(arrow);
      sign.position.set(cx + side * R * 5.5, gyFloor, z); g.add(sign);
      movers.push({ obj: sign, z0: z });
    };
    chevron(-1, cz - R * 18); chevron(1, cz - R * 50);

    // Light on the setup: a pink rim from behind, a cyan fill, the sunset as
    // its environment and the screen's own glow. No directional backlight: from
    // a low view toward the sun, glossy tops mirror it into a flare. The pink
    // sits further back than a bare rim light would: close in, its highlight
    // on the drive's top passes the bloom threshold and flares too.
    const pink = new THREE.PointLight(0xff2eaa, R * R * 30, R * 30, 2);
    pink.position.set(cx - R * 5.5, cy + R * 3.2, cz - R * 11); g.add(pink);
    const cyan = new THREE.PointLight(0x28d9ff, R * R * 12, R * 19, 2);
    cyan.position.set(cx + R * 4, cy + R * 1.4, cz + R * 1.5); g.add(cyan);
    g.add(new THREE.AmbientLight(0x120526, 0.72));
    addCrtLight(g, screen, 2.0);

    g.userData.neon = {
      starU, sunU, cloudU, gridU, roadU, cityU: city.uniforms, movers, zFar, span, speed, streak, streakMat,
      streakDir: new THREE.Vector3(), streakSpeed: 0, streakLife: 0, streakMax: 1,
      nextStreak: 3, lastT: undefined, rnd, R, cx, cy, cz,
    };

    const load = prepared || loadScenery();
    prepared = null;
    return load.then((gltf) => {
      const file = gltf.scene;
      if (!g.parent) { disposeTree(file); return; }   // switched away while loading
      // The file is in model radii around the model's centre, its floor at 0.
      file.scale.setScalar(R); file.position.set(cx, gyFloor, cz); file.updateMatrixWorld(true);
      const mountainMat = new THREE.MeshBasicMaterial({ color: 0x090018 });
      const rearMat = new THREE.MeshBasicMaterial({ color: 0x16002d, side: THREE.DoubleSide });
      const contourMat = new THREE.LineBasicMaterial({ color: 0x20abc6, transparent: true, opacity: 0.31 });
      const palms = [];
      for (const o of [...file.children]) {
        if (!o.isMesh) continue;
        if (/^Palm/.test(o.name)) { palms.push(o.geometry); file.remove(o); continue; }
        if (/Contour$/.test(o.name)) {
          const lines = new THREE.LineSegments(gridLines(o.geometry), contourMat);
          lines.position.copy(o.position); lines.quaternion.copy(o.quaternion); lines.scale.copy(o.scale);
          file.remove(o); o.geometry.dispose(); file.add(lines);
          continue;
        }
        o.material = /^Rear/.test(o.name) ? rearMat : mountainMat;
      }
      g.add(file);
      // Seven palms a side, alternating, each a model at its own size, lean and turn.
      for (const geo of palms) geo.computeVertexNormals();
      const palmMat = rimMaterial();
      // Their own sequence: the shooting star draws from rnd while this loads.
      const rnd = seeded(0x9a1d);
      for (let i = 0; i < 7; i++) {
        for (const side of [-1, 1]) {
          const z = zNear - i * step - (side > 0 ? step / 2 : 0);
          const palm = new THREE.Mesh(palms[Math.floor(rnd() * palms.length)], palmMat);
          palm.scale.setScalar(R * (0.85 + rnd() * 0.2));
          palm.rotation.set(0, rnd() * Math.PI * 2, -side * (0.03 + rnd() * 0.05), 'YXZ');
          palm.position.set(cx + side * R * (5.5 + rnd() * 1.25), gyFloor, z);
          g.add(palm); movers.push({ obj: palm, z0: z });
        }
      }
    }).catch((err) => console.warn('Synthwave: scenery not loaded.', err));
  },
  animate(g, t, powered, screenLight) {
    animateCrtLight(g, t, powered, screenLight);
    const n = g.userData.neon;
    if (!n) return;
    n.starU.uTime.value = t; n.sunU.uTime.value = t; n.cloudU.uTime.value = t; n.cityU.uTime.value = t;
    n.gridU.uTime.value = t; n.roadU.uTime.value = t;
    if (g.userData.reflection) g.userData.reflection.time = t;
    const travel = t * n.speed;
    for (let i = 0; i < n.movers.length; i++) {
      const m = n.movers[i];
      m.obj.position.z = n.zFar + ((((m.z0 - n.zFar + travel) % n.span) + n.span) % n.span);
    }
    // The shooting star: one every few seconds, across the upper sky.
    const dt = n.lastT === undefined ? 0 : Math.min(0.1, Math.max(0, t - n.lastT));
    n.lastT = t;
    const s = n.streak;
    if (s.visible) {
      n.streakLife += dt;
      s.position.addScaledVector(n.streakDir, n.streakSpeed * dt);
      const k = n.streakLife / n.streakMax;
      n.streakMat.uniforms.uFade.value = k < 0.15 ? k / 0.15 : Math.max(0, 1 - (k - 0.15) / 0.85);
      if (k >= 1) { s.visible = false; n.nextStreak = t + 4 + n.rnd() * 6; }
    } else if (t >= n.nextStreak) {
      const side = n.rnd() < 0.5 ? -1 : 1;
      n.streakDir.set(-side * (0.85 + n.rnd() * 0.15), -(0.25 + n.rnd() * 0.2), 0).normalize();
      s.position.set(n.cx + side * n.R * (6 + n.rnd() * 18), n.cy + n.R * (16 + n.rnd() * 14), n.cz - n.R * 45);
      s.rotation.z = Math.atan2(n.streakDir.y, n.streakDir.x);
      n.streakSpeed = n.R * (22 + n.rnd() * 10);
      n.streakLife = 0; n.streakMax = 0.8 + n.rnd() * 0.5;
      n.streakMat.uniforms.uFade.value = 0;
      s.visible = true;
    }
  },
};
