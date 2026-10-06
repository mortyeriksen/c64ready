// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { addCrtLight, animateCrtLight } from './vibes-crt-light.js';
import { wantsLargeModels } from './vibes-scene-common.js';

// One frame of what is on the television: a black Trans-Am-ish car head-on on a
// night highway, red scanner sweeping across its nose. `phase` (radians) drives
// the sweep, so animate() can call this per frame. Deliberately blocky — it is
// 128x96 seen across a dark room through a CRT bezel, and crisp detail would
// read as a photo taped to the tube.
// The picture is split in two so the sweep costs nothing per frame: everything
// static is painted ONCE into a backdrop canvas, and the scanner is a small
// pre-rendered glow blitted at its current x. Per frame that is two drawImage
// calls and no allocation — no gradients, no paths, no strings. This scene runs
// inside the same rAF as the emulator, and the project keeps idle allocation at
// ~0 KiB/frame; a fresh createRadialGradient every frame would undo that.
export function drawTvBackdrop(x, w, h) {
  // An overcast desert highway, not a night road. A daylight picture keeps its
  // mid-tones when the tube is shown dim across a dark room; a night scene shown
  // dim collapses to black with two headlights floating in it.
  //
  // The car sits LOW and LARGE, straddling the road in the near field, with the
  // highway running away behind it. Drawn small and high it read as parked on
  // the horizon rather than driving at you.
  const sky = x.createLinearGradient(0, 0, 0, h * 0.46);
  sky.addColorStop(0, '#5f6c7d'); sky.addColorStop(1, '#87919b');       // hazy overcast
  x.fillStyle = sky; x.fillRect(0, 0, w, h * 0.46);
  x.fillStyle = '#5c6472';                                              // distant hills
  x.beginPath(); x.moveTo(0, h * 0.46);
  for (let i = 0; i <= 8; i++) x.lineTo(w * i / 8, h * (0.40 + 0.04 * Math.sin(i * 1.7)));
  x.lineTo(w, h * 0.46); x.closePath(); x.fill();
  x.fillStyle = '#7d7360'; x.fillRect(0, h * 0.46, w, h * 0.54);        // scrub desert
  x.fillStyle = '#59595f';                                              // asphalt, opening toward camera
  x.beginPath(); x.moveTo(w * 0.47, h * 0.46); x.lineTo(w * 0.53, h * 0.46);
  x.lineTo(w * 1.15, h); x.lineTo(-w * 0.15, h); x.closePath(); x.fill();
  x.strokeStyle = '#8e8b84'; x.lineWidth = 1;                           // painted verges
  x.beginPath(); x.moveTo(w * 0.47, h * 0.46); x.lineTo(-w * 0.15, h);
  x.moveTo(w * 0.53, h * 0.46); x.lineTo(w * 1.15, h); x.stroke();
  x.fillStyle = '#c9c2a6';                                              // centre dashes running under the car
  for (let i = 0; i < 4; i++) {
    const t = i / 4, yy = h * (0.48 + t * 0.13), ww = 1 + t * 2;
    x.fillRect(w / 2 - ww / 2, yy, ww, 1 + t * 2);
  }
  // ── the car, head-on and close ──
  const cx = w / 2;
  // Low and wide: a tall cabin on a short body reads as an SUV, which this very
  // much is not. The roof is a shallow slot above a long bonnet line.
  const bodyW = w * 0.50, bodyT = h * 0.645, bodyH = h * 0.165;
  const roofW = w * 0.26, roofT = h * 0.565, roofH = h * 0.080;
  x.fillStyle = 'rgba(30,28,24,0.34)';                                  // shadow on the tarmac
  x.fillRect(cx - bodyW * 0.56, h * 0.845, bodyW * 1.12, h * 0.040);
  x.fillStyle = '#101116';                                              // wheels, just proud of the body
  x.fillRect(cx - bodyW / 2 - w * 0.015, h * 0.790, w * 0.070, h * 0.065);
  x.fillRect(cx + bodyW / 2 - w * 0.055, h * 0.790, w * 0.070, h * 0.065);
  x.fillStyle = '#191a20';                                              // cabin
  x.fillRect(cx - roofW / 2, roofT, roofW, roofH);
  x.fillStyle = '#77828f';                                              // windscreen catching the overcast sky
  x.fillRect(cx - roofW / 2 + w * 0.020, roofT + h * 0.016, roofW - w * 0.040, roofH - h * 0.028);
  x.fillStyle = '#17181c';                                              // bodywork
  x.fillRect(cx - bodyW / 2, bodyT, bodyW, bodyH);
  x.fillStyle = '#0e0f13';                                              // grille shadow + bumper
  x.fillRect(cx - bodyW * 0.52, bodyT + bodyH * 0.72, bodyW * 1.04, bodyH * 0.30);
  // Air dam: closes the daylight gap under the car. Sitting up on visible wheels
  // with road showing beneath is exactly what made it read as a truck.
  x.fillStyle = '#0a0b0e';
  x.fillRect(cx - bodyW * 0.46, bodyT + bodyH * 0.98, bodyW * 0.92, h * 0.030);
  x.fillStyle = '#c8bda0';                                              // headlights, off in daylight
  x.fillRect(cx - bodyW * 0.44, bodyT + bodyH * 0.34, bodyW * 0.20, bodyH * 0.22);
  x.fillRect(cx + bodyW * 0.24, bodyT + bodyH * 0.34, bodyW * 0.20, bodyH * 0.22);
  x.fillStyle = '#0b0c10';                                              // scanner recess across the nose
  x.fillRect(cx - bodyW * 0.40, bodyT + bodyH * 0.04, bodyW * 0.80, bodyH * 0.24);
  x.fillStyle = 'rgba(0,0,0,0.22)';                                     // scanlines
  for (let y = 0; y < h; y += 2) x.fillRect(0, y, w, 1);
  // The tube face itself: a CRT is not a rectangle. Rounded corners and a
  // darkened edge are most of what separates "screen" from "poster", and they
  // cost nothing baked into the texture.
  const vig = x.createRadialGradient(w / 2, h / 2, h * 0.30, w / 2, h / 2, h * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(0.75, 'rgba(0,0,0,0.28)');
  vig.addColorStop(1, 'rgba(0,0,0,0.70)');
  x.fillStyle = vig; x.fillRect(0, 0, w, h);
  x.fillStyle = '#05050a';                                              // corner masks
  const rr = 13;
  for (const [ox, oy, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
    x.beginPath(); x.moveTo(ox, oy);
    x.lineTo(ox + sx * rr, oy);
    x.quadraticCurveTo(ox, oy, ox, oy + sy * rr);
    x.closePath(); x.fill();
  }
}

// The scanner blob, rendered once into its own little canvas.
export function makeTvScanner(doc, w, h) {
  const c = doc.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,70,45,0.92)'); g.addColorStop(0.4, 'rgba(200,18,8,0.34)');
  g.addColorStop(1, 'rgba(180,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = '#d98070'; x.fillRect(w / 2 - 2, h / 2 - 2, 4, 4);      // hot core
  return c;
}

// The 80s Bedroom as a modelled room: public/bedroom.glb, made in
// Blender from the earlier procedural room, with curtains, a draped duvet, period
// props, scanned materials, a lit landing through the open door and a half moon
// outside the window. The computer is not in the file; the viewer places the
// C64 model as in every scene, and the room is fitted around it the way the
// earlier procedural room was (carpet 0.72 m below the model, R * 1.04 world units
// per metre).
//
// The file carries named marker nodes, so the lights follow the room instead of
// repeating its layout here: "Room Origin" (the carpet centre), "Light Lamp",
// "Light Moon", "Light Landing" (each with a "... Target"), "Light TV",
// "Light Clock", "Light Lava", and "Beam Start" / "Beam End" for the moonbeam.
// GLTFLoader turns their spaces into underscores.
//
// Bounce light is baked: the room's surfaces carry a second UV set (uv1) into
// one lightmap, a separate image holding Cycles' indirect diffuse light scaled
// to fit 8 bits. "Room Origin" stores that scale (extras.lightmapScale). Direct
// light stays real-time, so the lamp, the TV and the moon still move and flicker.
const BASE = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/');
// Options ▸ Display ▸ 3D MODEL picks the files, as it does the C64 model's:
// SMALL (and AUTO on a phone or tablet) loads the lighter room, with 512 px
// textures, lighter cloth and a 1024 px lightmap.
const roomFiles = () => (wantsLargeModels()
  ? { room: BASE + 'bedroom.glb', lightmap: BASE + 'bedroom_light.webp' }
  : { room: BASE + 'bedroom_small.glb', lightmap: BASE + 'bedroom_light_small.webp' });
const FILE_UNITS_PER_M = 8.0456;     // the room's scale in the file (the default model's R * 1.04)
const LIGHTMAP_GAIN = 14;            // baked irradiance against the real-time lights' calibration

// The fetches are shared (per file, so a changed setting loads the other pair)
// and the parse is per build: the viewer disposes a scene's geometry,
// materials and textures when it switches away.
const fetched = new Map();
function fetchOnce(url, kind) {
  if (!fetched.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return kind === 'blob' ? r.blob() : r.arrayBuffer();
    });
    p.catch(() => fetched.delete(url));
    fetched.set(url, p);
  }
  return fetched.get(url);
}
function fetchLightmap(url) {
  return fetchOnce(url, 'blob').then((blob) => createImageBitmap(blob, { imageOrientation: 'none' })).then((bitmap) => {
    const tex = new THREE.Texture(bitmap);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;                 // glTF UV convention
    tex.channel = 1;                   // the lightmap UV set
    tex.needsUpdate = true;
    return tex;
  });
}
// The room and its lightmap, parsed: a fresh copy per build, since the viewer
// disposes a scene's meshes when it switches away.
// The meshes decode on the main thread, in tens of milliseconds. Not in
// MeshoptDecoder's workers: Safari will not start them from their blob URL on
// this cross-origin-isolated page, and the decode would never finish.
function loadRoom(files) {
  return Promise.all([
    fetchOnce(files.room, 'buffer').then((bytes) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, BASE)),   // quantised, meshopt-compressed meshes
    fetchLightmap(files.lightmap).catch((err) => { console.warn('80s Bedroom: no lightmap.', err); return null; }),
  ]);
}
// preload() starts the next build's room ahead of it, so the viewer can show
// the scene whole: the room arrives with the computer, not after it.
let prepared = null;   // { room: url, load: Promise<[gltf, lightmap]> }

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// The moonbeam: an open cone from the window into the air above the bed,
// additive, fading at its silhouette and over its lower half, so it reads as lit
// haze and never shows a hard line where furniture cuts through it.
function moonBeam(start, end, r0, r1) {
  const dir = start.clone().sub(end), len = dir.length();
  const geo = new THREE.CylinderGeometry(r0, r1, len, 24, 1, true);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x8cc8ec) }, uOpacity: { value: 0.08 } },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float ends = smoothstep(0.0, 0.55, vUv.y) * smoothstep(1.0, 0.6, vUv.y);   // y = 1 at the window: no glow behind the blinds
        float edge = smoothstep(0.1, 1.0, facing);
        gl_FragColor = vec4(uColor, edge * edge * ends * uOpacity);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.position.copy(start).add(end).multiplyScalar(0.5);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  beam.renderOrder = 2;
  return beam;
}

export const scene = {
  // The earlier procedural room's practical lights, quoted per square metre (IL)
  // with decay 2: amber desk lamp, moonlight through the blinds, the flickering
  // TV, a red clock, the lava lamp, and a warm landing light through the door.
  // Shadows are static and cached. The viewer awaits preload() before build(),
  // so the room is parsed by then; it still attaches a microtask after build()
  // returns (before the next frame), inside a shadow-casting holder, so
  // revealing it marks the cached maps dirty once.
  name: '80s Bedroom', css: 'scene-bedroom', envInt: 0.07, exposure: 1.2,
  staticShadows: true,
  // The live CRT picture tops out at 1.0, so a threshold of 1.0 keeps it crisp
  // while the lamp, lava lamp and clock, brighter than that, still glow.
  bloom: { strength: 0.5, radius: 0.85, threshold: 1.0 },
  grade: { aberration: 0.0003, vignette: 0.24, grain: 0.012, split: 0.5, shadow: [0.88, 0.98, 1.10], highlight: [1.09, 1.00, 0.88] },
  screenOff: true,
  halation: [[1, 1, 1], [1, 0.95, 0.90], [1, 0.86, 0.75], [1, 0.77, 0.60], [1, 0.70, 0.50]],
  bg: [[0, '#08060d'], [1, '#08060d']],
  // Resolves once the room is ready for build(), or failed (build() then warns).
  preload() {
    const files = roomFiles();
    if (prepared?.room !== files.room) prepared = { room: files.room, load: loadRoom(files) };
    return prepared.load.then(() => {}, () => {});
  },
  build(g, { sphere, box, screen }) {
    addCrtLight(g, screen, 2.2);
    const R = sphere.radius, S = R * 1.04, IL = S * S;
    // The room sits 6 cm back from the model's centre, so the monitor's cables
    // reach the desk's back edge without hanging over it.
    const anchor = new THREE.Vector3(sphere.center.x, box.min.y - 0.72 * S, sphere.center.z - 0.06 * S);

    const holder = new THREE.Group();
    holder.castShadow = true;
    holder.visible = false;
    g.add(holder);

    // The lamp stands at the desk's left edge and shines straight down beside the drive.
    const lamp = new THREE.SpotLight(0xffa552, 0.5 * IL, R * 9, 0.95, 0.7, 2);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(1024, 1024); lamp.shadow.bias = -0.0008; lamp.shadow.radius = 2;
    lamp.shadow.camera.near = R * 0.05; lamp.shadow.camera.far = R * 9;
    const moon = new THREE.SpotLight(0x72bfe8, 0, R * 40, 0.3, 0.8, 2);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024); moon.shadow.bias = -0.003; moon.shadow.radius = 0.75;
    moon.shadow.camera.near = R * 0.5; moon.shadow.camera.far = R * 40;
    // The landing light reaches the bedroom only through the doorway: a spot
    // aimed in through it, its shadow keeping the walls opaque. A short-range
    // fill lights the landing itself.
    const landing = new THREE.SpotLight(0xffb070, 1.6 * IL, R * 14, 0.75, 0.6, 2);
    landing.castShadow = true;
    landing.shadow.mapSize.set(512, 512); landing.shadow.bias = -0.002; landing.shadow.radius = 2;
    landing.shadow.camera.near = R * 0.2; landing.shadow.camera.far = R * 14;
    const landingFill = new THREE.PointLight(0xffb070, 0.5 * IL, R * 1.6, 2);
    // The desktop returns a small warm bounce onto the keyboard and clutter.
    // It hangs halfway down the lamp's beam: any lower and it burns a hot
    // spot into the monitor's side.
    const lampBounce = new THREE.PointLight(0xff8f45, 0.05 * IL, R * 3, 2);
    const tv = new THREE.PointLight(0x8fcfe5, 0, R * 8, 2);
    const clock = new THREE.PointLight(0xff3020, 0.075 * IL, R * 2.5, 2);
    const lava = new THREE.PointLight(0xff7a45, 0.04 * IL, R * 2.5, 2);
    const lights = [lamp, lampBounce, moon, landing, landingFill, tv, clock, lava];
    for (const l of lights) l.visible = false;
    g.add(lamp, lamp.target, lampBounce, moon, moon.target, landing, landing.target, landingFill, tv, clock, lava);

    // The TV's picture is the earlier procedural room's: a static backdrop and a
    // scanner sprite blitted at its sweep position, redrawn in animate().
    const crtCanvas = document.createElement('canvas'); crtCanvas.width = 128; crtCanvas.height = 96;
    const crtBack = document.createElement('canvas'); crtBack.width = 128; crtBack.height = 96;
    drawTvBackdrop(crtBack.getContext('2d'), 128, 96);
    const crtCtx = crtCanvas.getContext('2d'); crtCtx.drawImage(crtBack, 0, 0);
    const crtTex = new THREE.CanvasTexture(crtCanvas);
    crtTex.colorSpace = THREE.SRGBColorSpace;
    const tvMat = new THREE.MeshBasicMaterial({ map: crtTex, color: 0x000000 });

    Object.assign(g.userData, {
      realLamp: lamp, realLampBase: lamp.intensity, realBounce: lampBounce, realBounceBase: lampBounce.intensity, realTv: tv, realTvBase: 0.2 * IL, realTvMat: tvMat,
      realLava: lava, realLavaBase: lava.intensity, realCrtCtx: crtCtx, realCrtBack: crtBack,
      realCrtScan: makeTvScanner(document, 24, 11), realCrtTex: crtTex, realTvNext: 0,
    });

    const files = roomFiles();
    const load = prepared?.room === files.room ? prepared.load : loadRoom(files);
    prepared = null;
    // Returned, so the viewer compiles the scene once the room is in.
    return load.then(([gltf, lightmap]) => {
      const room = gltf.scene;
      if (!g.parent) { disposeTree(room); if (lightmap) lightmap.dispose(); tvMat.dispose(); crtTex.dispose(); return; }   // switched away while loading
      const k = S / FILE_UNITS_PER_M;
      const origin = room.getObjectByName('Room_Origin');
      room.scale.setScalar(k);
      room.position.copy(anchor).addScaledVector(origin ? origin.position : new THREE.Vector3(), -k);
      holder.add(room);
      room.updateMatrixWorld(true);
      const at = (name, out) => { const o = room.getObjectByName(name); if (o) o.getWorldPosition(out); return !!o; };
      at('Light_Lamp', lamp.position); at('Light_Lamp_Target', lamp.target.position);
      lampBounce.position.lerpVectors(lamp.position, lamp.target.position, 0.5);
      at('Light_TV', tv.position); at('Light_Clock', clock.position); at('Light_Lava', lava.position);
      if (at('Light_Moon', moon.position) && at('Light_Moon_Target', moon.target.position)) {
        // Per square metre at the distance it shines from, as the earlier procedural
        // bedroom's moon is from its 3.6 m.
        const d = moon.position.distanceTo(moon.target.position) / S;
        moon.intensity = 14 * IL * (d / 3.6) * (d / 3.6);
      }
      if (at('Light_Landing', landing.position)) {
        at('Light_Landing_Target', landing.target.position);
        landingFill.position.copy(landing.position);
      }
      const b0 = new THREE.Vector3(), b1 = new THREE.Vector3();
      if (at('Beam_Start', b0) && at('Beam_End', b1)) g.add(moonBeam(b0, b1, 0.32 * S, 0.5 * S));

      // Lightmapped meshes get the baked bounce. A material shared with a mesh
      // that has no lightmap UVs is cloned first, so the other mesh never
      // samples a missing uv1.
      const scale = origin?.userData?.lightmapScale || 1;
      const unlit = new Set();
      room.traverse((o) => { if (o.isMesh && !o.geometry.attributes.uv1) unlit.add(o.material); });
      room.traverse((o) => {
        if (!o.isMesh) return;
        const m = o.material;
        o.receiveShadow = !o.name.startsWith('Outside_');
        // The garden, the sky beyond the blinds and see-through materials let
        // the moon in; the lamp's own shade and bulb would shadow it at the source.
        o.castShadow = !(m && (m.transparent || m.alphaMap)) && !/^(Outside_|Lamp_|Mesh_33$)/.test(o.name);
        // three.js draws a double-sided transparent material in two passes by
        // flipping its side, which re-checks its program and re-uploads its uniforms
        // on every pass of every frame; one pass is enough for thin cases and panes.
        if (m && m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
        if (lightmap && o.geometry.attributes.uv1 && m && 'lightMap' in m) {
          const lm = unlit.has(m) ? m.clone() : m;
          lm.lightMap = lightmap; lm.lightMapIntensity = LIGHTMAP_GAIN * scale;
          o.material = lm;
        }
      });
      // The earlier procedural room's faint additive scanner glow comes through the
      // export as a solid emitter; the live picture carries the scanner instead.
      const overlay = room.getObjectByName('TV_Overlay');
      if (overlay) overlay.visible = false;
      const screenNode = room.getObjectByName('TV_Screen');
      if (screenNode) screenNode.traverse((o) => { if (o.isMesh) { o.material.dispose(); o.material = tvMat; } });
      for (const l of lights) l.visible = true;
      holder.visible = true;
    }).catch((err) => console.warn('80s Bedroom: room model not loaded.', err));
  },
  animate(g, t, powered, screenLight) {
    animateCrtLight(g, t, powered, screenLight);
    const u = g.userData;
    const lampF = 0.99 + Math.sin(t * 1.37) * 0.008 + Math.sin(t * 3.11) * 0.003;
    if (u.realLamp) u.realLamp.intensity = u.realLampBase * lampF;
    if (u.realBounce) u.realBounce.intensity = u.realBounceBase * lampF;
    if (u.realLava) u.realLava.intensity = u.realLavaBase * (0.9 + Math.sin(t * 0.7) * 0.06 + Math.sin(t * 1.9) * 0.03);
    // The TV lives only while the C64 is on, as in the earlier procedural room.
    if (powered) {
      const f = 0.91 + Math.sin(t * 7.3) * 0.035 + Math.sin(t * 17.1) * 0.018;
      if (u.realTv) u.realTv.intensity = u.realTvBase * f;
      if (u.realTvMat) u.realTvMat.color.setScalar(0.68 + 0.16 * f);
      if (u.realCrtCtx && t >= u.realTvNext) {
        u.realTvNext = t + 0.06;
        const scan = u.realCrtScan, sweep = Math.sin(t * 2.2);
        u.realCrtCtx.drawImage(u.realCrtBack, 0, 0);
        u.realCrtCtx.drawImage(scan, 64 + sweep * 16 - scan.width / 2, 63 - scan.height / 2);
        u.realCrtTex.needsUpdate = true;
      }
    } else {
      if (u.realTv) u.realTv.intensity = 0;
      if (u.realTvMat) u.realTvMat.color.setScalar(0);
    }
  },
};
