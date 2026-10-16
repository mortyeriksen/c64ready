// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { addCrtLight, animateCrtLight } from './vibes-crt-light.js';
import { addBeamDust } from './vibes-scene-spotlight.js';
import { wantsLargeModels } from './vibes-scene-common.js';

// Foggy Spotlight: the Spotlight mood with stage smoke in the beam and its studio
// rendered in Blender's Cycles.
// public/models/spotlight_real.glb carries a worn studio floor whose light is baked
// into its emissive map: the lamp's pool, the computer's soft contact shadows
// and its bounce. The floor's base colour is black, so the live lamp adds only
// glints off its baked roughness and scratch normals, never a second pool. The
// file also holds the hanging lamp itself, and sits in the C64 model's own
// space, so it loads at the origin.
//
// public/models/spotlight_real_env.hdr is a Cycles light probe taken from the
// computer's centre with the computer hidden and the lamp's lens left out: the
// lit floor below, haze toward the lamp above. As the scene's environment it
// gives the computer the studio's bounce light and reflections, while its direct
// light and highlight come from the live lamp.
//
// Marker nodes place the live light: "Light Key" (extras: intensity in candela,
// half-angle, penumbra, linear colour) and "Light Key Target". GLTFLoader turns
// their spaces into underscores.
const BASE = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/') + 'models/';
// Options ▸ Display ▸ 3D MODEL picks the floor file, as it does the C64
// model's: a 2048 px light map and 1024 px detail tiles, or for SMALL (and AUTO
// on a phone or tablet) 1024 px and 512 px. The detail (normal and roughness)
// is one seamless tile repeated three times across the floor; only the baked
// light is unique. One 512 px probe serves both: it feeds soft light and
// blurred reflections only.
const PROBE = BASE + 'spotlight_real_env.hdr';
const studioFiles = () => (wantsLargeModels()
  ? { floor: BASE + 'spotlight_real.glb', probe: PROBE }
  : { floor: BASE + 'spotlight_real_small.glb', probe: PROBE });

// The fetch is shared per file (so a changed setting loads the other one) and
// the parse is per build: the viewer disposes a scene's meshes when it leaves.
const fetched = new Map();
function loadFloor(url) {
  if (!fetched.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    p.catch(() => fetched.delete(url));
    fetched.set(url, p);
  }
  return fetched.get(url).then((bytes) => new GLTFLoader().parseAsync(bytes, BASE));
}
let prepared = null;   // { floor: url, load: Promise<gltf> }

// The probe loads once and stays, as a PMREM per renderer (tagged _shared so
// scene disposal leaves it). Without it the studio falls back to near-black.
let probe = null, probeUrl = null, probeTex = null, probeEnv = null, probeFor = null;
function loadProbe(url) {
  if (!probe || probeUrl !== url) {
    probeUrl = url;
    probe = new HDRLoader().loadAsync(url).then((tex) => {
      if (probeTex) probeTex.dispose();
      probeTex = tex; probeFor = null;
    });
    probe.catch((err) => { console.warn('Foggy Spotlight: no light probe.', err); probe = null; });
  }
  return probe;
}
function probeEnvMap(renderer) {
  if (probeEnv && probeFor === renderer) return probeEnv;
  let tex = probeTex;
  if (!tex) {
    tex = new THREE.DataTexture(new Float32Array([0.004, 0.0035, 0.003, 1, 0.0005, 0.0005, 0.0006, 1]), 1, 2, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
  }
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (probeEnv) probeEnv.dispose();
  probeEnv = pmrem.fromEquirectangular(tex).texture;
  probeEnv._shared = true;
  pmrem.dispose();
  if (tex !== probeTex) { tex.dispose(); return probeEnv; }   // retry with the real probe next time
  probeFor = renderer;
  return probeEnv;
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// The lamp's shaft through faint haze: an open cone, additive, fading at its
// silhouette, toward the lamp and toward the floor.
function lightShaft(start, end, radius) {
  const dir = start.clone().sub(end), len = dir.length();
  const geo = new THREE.CylinderGeometry(radius * 0.04, radius, len, 48, 1, true);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(1.0, 0.86, 0.70) }, uOpacity: { value: 0.03 },
      uTime: { value: 0 }, uScale: { value: 1 / radius },
    },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vUv = uv;
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    // Value noise in world space, drifting slowly sideways and down, so the haze
    // has body and moves like air rather than sitting on the cone as a skin.
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity, uTime, uScale;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vnoise(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float ends = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.8, vUv.y);   // y = 1 at the lamp
        float edge = smoothstep(0.0, 1.0, facing);
        vec3 q = vW * uScale * 2.5 + vec3(uTime * 0.025, -uTime * 0.04, uTime * 0.015);
        float haze = 0.45 + 0.75 * (0.65 * vnoise(q) + 0.35 * vnoise(q * 2.7 + 11.0));
        gl_FragColor = vec4(uColor, edge * edge * edge * ends * haze * uOpacity);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const shaft = new THREE.Mesh(geo, mat);
  shaft.position.copy(start).add(end).multiplyScalar(0.5);
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  shaft.renderOrder = 2;
  return shaft;
}

export const scene = {
  name: 'Foggy Spotlight', css: 'scene-spotlight', envInt: 1.0, envMap: probeEnvMap,
  tone: 'neutral', exposure: 1.1,
  staticShadows: true,
  bg: [[0, '#0b0b10'], [0.55, '#060608'], [1, '#000000']],
  // Contact shadows where the parts meet the desk and each other (the floor's
  // own are baked), and a shallow focus on whatever the view turns around.
  // Eight occlusion samples look the same as sixteen here, for a fifth less time.
  ao: { radius: 0.05, thickness: 0.13, distanceExponent: 1, intensity: 1, samples: 8 },
  dof: { aperture: 0.0012, maxblur: 0.004 },
  // Stage smoke in the beam (ray-marched, shadowed by the computer). Density
  // is a scattering coefficient per model radius, scale the size of its
  // rolling wisps; it settles, 3.5 times as dense at the floor and thinning
  // over half a model radius. The screen lights it too, four times its
  // physical share so the glow in front of the glass reads. Low-power devices
  // draw the soft cone instead.
  volume: { density: 0.03, anisotropy: 0.35, scale: 0.06, steps: 32, ground: 2.5, groundHeight: 0.5, screenGlow: 4 },
  // Bloom only for what is truly bright: the lamp's lens. The live picture
  // tops out at 1.0, so it stays crisp.
  bloom: { strength: 0.35, radius: 0.6, threshold: 1.0 },
  grade: { aberration: 0.0003, vignette: 0.22, grain: 0.008 },
  preload() {
    const files = studioFiles();
    if (prepared?.floor !== files.floor) prepared = { floor: files.floor, load: loadFloor(files.floor) };
    return Promise.all([prepared.load, loadProbe(files.probe)]).then(() => {}, () => {});
  },
  build(g, { sphere, screen, volume }) {
    addCrtLight(g, screen, 2.8);

    const holder = new THREE.Group();
    holder.castShadow = true;
    holder.visible = false;
    g.add(holder);
    const key = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 7, 0.55, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = sphere.radius * 0.5; key.shadow.camera.far = sphere.radius * 12;
    key.shadow.radius = 6; key.shadow.bias = -0.0005;
    key.visible = false;
    g.add(key, key.target);

    const files = studioFiles();
    const load = prepared?.floor === files.floor ? prepared.load : loadFloor(files.floor);
    prepared = null;
    return load.then((gltf) => {
      const room = gltf.scene;
      if (!g.parent) { disposeTree(room); return; }   // switched away while loading
      holder.add(room);
      room.updateMatrixWorld(true);
      const marker = room.getObjectByName('Light_Key'), aim = room.getObjectByName('Light_Key_Target');
      if (marker && aim) {
        const x = marker.userData;
        marker.getWorldPosition(key.position); aim.getWorldPosition(key.target.position);
        key.intensity = x.intensity; key.angle = x.angle; key.penumbra = x.penumbra;
        if (Array.isArray(x.color)) key.color.setRGB(x.color[0], x.color[1], x.color[2]);
        // Shadow blur sized to the lamp's real face: the penumbra an 18 cm lamp
        // throws past an edge a third of the model's radius above its surface,
        // in shadow-map texels.
        if (x.lampRadius) {
          const dist = key.position.distanceTo(key.target.position);
          const texel = 2 * Math.tan(key.angle) * dist / key.shadow.mapSize.x;
          const penumbra = 2 * x.lampRadius * (sphere.radius / 3) / dist;
          key.shadow.radius = Math.min(12, Math.max(2, penumbra / texel));
        }
        // The shaft runs from the lamp to where its axis meets the floor.
        const floorY = room.getObjectByName('Floor')?.getWorldPosition(new THREE.Vector3()).y ?? 0;
        const dir = key.target.position.clone().sub(key.position).normalize();
        const end = key.position.clone().addScaledVector(dir, (key.position.y - floorY) / Math.max(1e-3, -dir.y));
        addBeamDust(g, key, sphere);
        g.userData.noDepth = [g.userData.spotDust];
        if (volume) {
          g.userData.volumeLight = key;
        } else {
          const shaft = lightShaft(key.position.clone(), end, Math.tan(key.angle) * key.position.distanceTo(end));
          g.add(shaft); g.userData.shaft = shaft; g.userData.noDepth.push(shaft);
        }
      }
      // Nothing in the file casts: the floor is lit by its bake, and the lamp
      // must not shade its own beam.
      room.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;
        o.receiveShadow = o.name.startsWith('Floor');
      });
      key.visible = true;
      holder.visible = true;
    }).catch((err) => console.warn('Foggy Spotlight: floor not loaded.', err));
  },
  animate(g, t, powered, screenLight) {
    const dust = g.userData.spotDust, shaft = g.userData.shaft;
    if (dust) dust.material.uniforms.uTime.value = t;
    if (shaft) shaft.material.uniforms.uTime.value = t;
    animateCrtLight(g, t, powered, screenLight);
  },
};
