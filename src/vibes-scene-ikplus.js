// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { markShared } from './vibes-scene-common.js';

// IK+ sunset scene textures (cached): the C64-sunset sky gradient with chunky
// dithered cloud banks, the low sun disc with its signature horizontal stripe
// cuts, and a soft halo glow.
let _ikTex = null;
function ikPlusTextures() {
  if (_ikTex) return _ikTex;
  if (typeof document === 'undefined') { _ikTex = {}; return _ikTex; }
  // Sky: near-black purple zenith → maroon → crimson → orange, with a pale
  // dusk-haze band right above the waterline. Clouds are C64-style dither:
  // solid cores with checkerboard fringes — red-lit banks floating against the
  // dark upper sky, darker banks silhouetted against the bright mid sky. 1024
  // wide so the ~2px dither cells stay readable when sampled by azimuth.
  const skyCv = document.createElement('canvas'); skyCv.width = 1024; skyCv.height = 512;
  const scx = skyCv.getContext('2d'); const grad = scx.createLinearGradient(0, 0, 0, 512);
  [[0, '#0f0618'], [0.2, '#2c0a2c'], [0.38, '#571530'], [0.54, '#8a1f34'], [0.68, '#b03340'],
   [0.8, '#cf5340'], [0.9, '#e8823f'], [0.93, '#f0a35e'], [0.955, '#e8c0a0'],
   [0.975, '#c9c3cd'], [1, '#b7b3c6']].forEach(([o, c]) => grad.addColorStop(o, c));
  scx.fillStyle = grad; scx.fillRect(0, 0, 1024, 512);
  // One cloud bank: walk 2px cells over an ellipse; paint solid where coverage
  // is high, checkerboard where it thins out (the dither), and duplicate at
  // ±width so banks wrap seamlessly across the azimuth seam. The banks GLOW —
  // brighter than the sky field behind them (dark banks read as storm) — with
  // the brightest stipple on the upper rim and only a sparse darker dither
  // shading the underside, like the 16-bit backdrop's fire-lit clouds.
  const cell = 2;
  const bank = (cx0, cy0, rw, rh, body, fringe, shade) => {
    for (let yy = -rh; yy <= rh; yy += cell) for (let xx = -rw; xx <= rw; xx += cell) {
      const d = (xx * xx) / (rw * rw) + (yy * yy) / (rh * rh);
      if (d > 1) continue;
      const cov = 1 - d + Math.random() * 0.5 - 0.25;
      const px = cx0 + xx, py = cy0 + yy;
      if (cov > 0.55 || (cov > 0.18 && (((px + py) / cell) & 1))) {
        let col = body;
        if (fringe && yy < -rh * 0.15 && d > 0.5) col = fringe;
        else if (shade && yy > rh * 0.35 && d > 0.55 && (((px - py) / cell) & 1)) col = shade;
        scx.fillStyle = col;
        for (const ox of [-1024, 0, 1024]) scx.fillRect(px + ox, py, cell, cell);
      }
    }
  };
  const bodyCols = ['#923344', '#a83d4b', '#bb4b52'];   // muted fire-lit bodies against the violet zenith
  for (let i = 0; i < 72; i++) {
    const cy0 = (((55 + Math.pow(Math.random(), 0.9) * 325) / cell) | 0) * cell;
    const cx0 = (((Math.random() * 1024) / cell) | 0) * cell;
    const rw = 24 + Math.random() * 92, rh = rw * (0.14 + Math.random() * 0.2);
    bank(cx0, cy0, rw, rh, bodyCols[(Math.random() * bodyCols.length) | 0],
         cy0 < 180 ? '#d88b86' : '#e59a7c', '#681b32');
  }
  for (let i = 0; i < 30; i++) {                        // salmon wisps low in the glow
    const cy0 = (((210 + Math.random() * 180) / cell) | 0) * cell;
    const cx0 = (((Math.random() * 1024) / cell) | 0) * cell;
    const rw = 16 + Math.random() * 55;
    bank(cx0, cy0, rw, rw * (0.08 + Math.random() * 0.09), ['#e87a62', '#f0936e', '#f7b07a'][(Math.random() * 3) | 0]);
  }
  for (let i = 0; i < 600; i++) {                       // stray dither specks between banks
    const py = (((Math.pow(Math.random(), 1.3) * 430) / cell) | 0) * cell;
    const px = (((Math.random() * 1024) / cell) | 0) * cell;
    scx.fillStyle = Math.random() < 0.55 ? 'rgba(216,90,70,0.6)' : 'rgba(240,147,110,0.5)';
    scx.fillRect(px, py, cell, cell);
  }
  const sky = new THREE.CanvasTexture(skyCv);
  sky.colorSpace = THREE.SRGBColorSpace; sky.wrapS = THREE.RepeatWrapping;
  sky.magFilter = THREE.NearestFilter;    // keep the dither cells crisp on the dome
  // Sun disc with horizontal stripe cuts.
  const sunCv = document.createElement('canvas'); sunCv.width = sunCv.height = 256;
  const sx = sunCv.getContext('2d');
  const sg = sx.createRadialGradient(128, 128, 20, 128, 128, 124);
  sg.addColorStop(0, '#fffce0'); sg.addColorStop(0.5, '#ffe24e'); sg.addColorStop(1, '#ffa42a');
  sx.beginPath(); sx.arc(128, 128, 124, 0, Math.PI * 2); sx.fillStyle = sg; sx.fill();
  sx.globalCompositeOperation = 'destination-out';
  sx.fillRect(0, 148, 256, 5); sx.fillRect(0, 170, 256, 8); sx.fillRect(0, 196, 256, 11); sx.fillRect(0, 226, 256, 14);
  const sun = new THREE.CanvasTexture(sunCv); sun.colorSpace = THREE.SRGBColorSpace;
  // Halo glow behind the sun — dim in the core, peaking outside the disc's rim,
  // so it wraps the disc instead of washing its face out.
  const haloCv = document.createElement('canvas'); haloCv.width = haloCv.height = 128;
  const hx = haloCv.getContext('2d'); const hg = hx.createRadialGradient(64, 64, 4, 64, 64, 64);
  hg.addColorStop(0, 'rgba(255,170,90,0.10)'); hg.addColorStop(0.42, 'rgba(255,150,60,0.55)');
  hg.addColorStop(0.62, 'rgba(255,120,48,0.34)'); hg.addColorStop(1, 'rgba(255,100,40,0)');
  hx.fillStyle = hg; hx.fillRect(0, 0, 128, 128);
  const halo = new THREE.CanvasTexture(haloCv); halo.colorSpace = THREE.SRGBColorSpace;
  // Stone pavers for the courtyard terrace (16-bit IK+ look): running-bond
  // slab grid, per-tile value jitter with the odd dark worn slab, speckle,
  // dark joints. Values sit just above the old plain platform so the terrace
  // reads as stone without breaking the dusk grade.
  // Colour + matching bump drawn in one pass: the bump carries the joints as
  // grooves and each slab's own height offset, so the raking key sculpts the
  // grid instead of it living only in the albedo (which mips average away).
  const pavCv = document.createElement('canvas'); pavCv.width = pavCv.height = 512;
  const pcx = pavCv.getContext('2d');
  const bmpCv = document.createElement('canvas'); bmpCv.width = bmpCv.height = 512;
  const bcx = bmpCv.getContext('2d');
  pcx.fillStyle = '#252632'; pcx.fillRect(0, 0, 512, 512);            // softened blue-grey joints
  bcx.fillStyle = '#565656'; bcx.fillRect(0, 0, 512, 512);            // joints sit below slabs without black trenches
  const TW = 512 / 5, TH = 512 / 8;
  for (let ty = 0; ty < 8; ty++) {
    const off = (ty & 1) ? TW / 2 : 0;                                // running bond
    for (let txi = -1; txi < 5; txi++) {
      const x0 = txi * TW + off;
      const v = 62 + Math.random() * 22 - (Math.random() < 0.1 ? 12 : 0);
      pcx.fillStyle = `rgb(${(v * 0.86) | 0},${(v * 0.94) | 0},${(v * 1.16) | 0})`;
      pcx.fillRect(x0 + 3, ty * TH + 3, TW - 6, TH - 6);
      const bh = 142 + Math.random() * 48;                            // gentler per-slab settle height
      bcx.fillStyle = `rgb(${bh | 0},${bh | 0},${bh | 0})`;
      bcx.fillRect(x0 + 3, ty * TH + 3, TW - 6, TH - 6);
      for (let sp = 0; sp < 26; sp++) {                               // wear speckle + pits
        const g2 = v + Math.random() * 30 - 15;
        pcx.fillStyle = `rgba(${g2 | 0},${g2 | 0},${(g2 * 1.06) | 0},0.5)`;
        const sx2 = x0 + 3 + Math.random() * (TW - 8), sy2 = ty * TH + 3 + Math.random() * (TH - 8);
        pcx.fillRect(sx2, sy2, 2, 2);
        bcx.fillStyle = `rgba(${(bh - 40) | 0},${(bh - 40) | 0},${(bh - 40) | 0},0.5)`;
        bcx.fillRect(sx2, sy2, 2, 2);
      }
    }
  }
  const pavers = new THREE.CanvasTexture(pavCv);
  pavers.colorSpace = THREE.SRGBColorSpace;
  pavers.wrapS = pavers.wrapT = THREE.RepeatWrapping;
  const paversBump = new THREE.CanvasTexture(bmpCv);
  paversBump.colorSpace = THREE.NoColorSpace;
  paversBump.wrapS = paversBump.wrapT = THREE.RepeatWrapping;
  // The tapered courtyard averages ~70×46 scene units. About one scene unit per
  // slab keeps the bond legible without turning every wide view into a grid.
  pavers.repeat.set(14, 7.2);
  paversBump.repeat.set(14, 7.2);
  _ikTex = markShared({ sky, sun, halo, pavers, paversBump });
  return _ikTex;
}

// IBL for the scene: a small equirect of the sunset — sky gradient above the
// horizon, dark violet sea below, warm hotspot toward the sun (-z) — baked to a
// PMREM once and shared for the app lifetime.
let _envMap = null;
function ikEnvMap(renderer) {
  if (_envMap) return _envMap;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const cx = c.getContext('2d');
  // Brighter than the visible sky dome: this is the light field, not the
  // backdrop — a true near-black zenith starves every up-facing surface.
  const sky = cx.createLinearGradient(0, 0, 0, 64);
  [[0, '#322a55'], [0.38, '#594064'], [0.68, '#9d4b58'], [0.9, '#dc7b58'], [1, '#efb982']]
    .forEach(([o, col]) => sky.addColorStop(o, col));
  cx.fillStyle = sky; cx.fillRect(0, 0, 256, 64);
  const sea = cx.createLinearGradient(0, 64, 0, 128);
  sea.addColorStop(0, '#393856'); sea.addColorStop(0.4, '#202840'); sea.addColorStop(1, '#0b1020');
  cx.fillStyle = sea; cx.fillRect(0, 64, 256, 64);
  // Sun hotspot: -z maps to u 0.25 in three's equirect convention.
  const hot = cx.createRadialGradient(64, 64, 2, 64, 64, 30);
  hot.addColorStop(0, 'rgba(255,220,140,0.95)'); hot.addColorStop(0.4, 'rgba(255,150,70,0.55)');
  hot.addColorStop(1, 'rgba(255,120,50,0)');
  cx.fillStyle = hot; cx.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  _envMap = pmrem.fromEquirectangular(tex).texture;
  _envMap._shared = true;
  pmrem.dispose(); tex.dispose();
  return _envMap;
}

// Tiling water normal map for THREE.Water (procedural, so no external asset):
// a heightfield of integer-frequency sine gratings (→ seamless wrap) turned into
// a tangent-space normal map. Cached.
let _waterNorm = null;
function waterNormalTexture() {
  if (_waterNorm !== null) return _waterNorm;
  if (typeof document === 'undefined') { _waterNorm = null; return null; }
  const size = 256, c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const waves = [[3, 1, 0.55, 0.0], [1, 4, 0.5, 1.3], [5, 3, 0.32, 2.1], [6, 7, 0.22, 0.7], [2, 8, 0.2, 3.4], [9, 5, 0.13, 1.9],
                 [13, 11, 0.08, 4.2], [17, 9, 0.06, 0.9]];   // fine chop on top of the swell
  const T = Math.PI * 2, strength = 0.05;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size; let dhx = 0, dhy = 0;
    for (const [fx, fy, amp, ph] of waves) {
      const gg = Math.cos(T * (fx * u + fy * v) + ph) * amp * T;
      dhx += gg * fx; dhy += gg * fy;
    }
    let nx = -dhx * strength, ny = -dhy * strength, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
    d[i] = (nx * inv * 0.5 + 0.5) * 255; d[i + 1] = (ny * inv * 0.5 + 0.5) * 255; d[i + 2] = (nz * inv * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  _waterNorm = markShared(t); return _waterNorm;
}

export const scene = {
    // Recreation of the "IK+" C64 sunset scene: the C64 stands on the dark
    // fighting platform before a monumental black torii, a striped low sun over
    // shimmering water, forested bay arms with a tiny fishing village, a leaning
    // autumn maple + hut, gliding gulls and the leaping fish. Scene meshes live
    // in a group scaled to the model (scene units × S) with the platform at the
    // model's base; lights are world-space. Dusk mood → ACES exposure 0.66 +
    // purple haze. Composer on: the sun, halo, water glint and lit windows need
    // bloom to read as light; threshold high so the sky field itself never blows.
    name: 'IK+ Sunset', css: 'scene-ikplus', envInt: 1.1, envMap: ikEnvMap, exposure: 0.66,
    bloom: { strength: 0.3, radius: 0.45, threshold: 0.95 },
    halation: [[1, 1, 1], [1, 0.94, 0.86], [1, 0.86, 0.7], [1, 0.75, 0.55], [1, 0.66, 0.46]],
    grade: { split: 0.46, shadow: [0.8, 0.92, 1.16], highlight: [1.08, 0.98, 0.84] },
    fog: { color: 0x28172f, near: 5, far: 68 },
    bg: [[0, '#12081f'], [1, '#2a0e3f']],
    build(g, { sphere, box }) {
      const R = sphere.radius, cx = sphere.center.x, cy = sphere.center.y, cz = sphere.center.z, gy = box.min.y;
      const S = R * 0.5;                      // world units per scene unit
      const tex = ikPlusTextures();

      // Scene group: seat the model further back on the beach (scene (0, 0.25, 8))
      // so the torii + sunset backdrop sit well in the distance, with the sand
      // surface at the model's base.
      //
      // Ground level for the WHOLE scene. The beach + every prop live in `env`
      // and the reflective sea is world-space, but both key off this one Y so
      // they rise together (moving only the beach would tear it away from the
      // waterline). The sand has gentle dunes (see beachGeo below), and the
      // model happens to stand over a shallow dune trough (~-0.1 scene units) —
      // so with the beach flat exactly at the model base the C64 floated above
      // the sand. Lift the whole scene by `lift` so the sand comes up to meet
      // the model and it nestles into the beach. `lift` is the single knob:
      // raise it to sink the C64 deeper, drop it toward 0 to let it float again.
      // Scale reference: the breadbin case is 75 mm tall and spans 0.808 units
      // here, so ~1 real-world cm ≈ 0.028 * S — the granularity for nudges.
      const lift = 0.09 * S;
      const baseY = gy - 0.25 * S + lift;

      const env = new THREE.Group();
      env.scale.setScalar(S);
      env.position.set(cx, baseY, cz - 8 * S);
      g.add(env);

      const std = (color, rough, metal) => new THREE.MeshStandardMaterial({ color, roughness: rough == null ? 0.85 : rough, metalness: metal || 0 });
      const glow = (color, amt) => { const m = std(color, 0.95); m.emissive = new THREE.Color(color).multiplyScalar(amt == null ? 0.4 : amt); return m; };

      // ── Sky dome (gradient by elevation; surrounds the orbit camera) ──
      {
        const mat = new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false, fog: false,
          uniforms: { uSky: { value: tex.sky } },
          vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: `uniform sampler2D uSky; varying vec3 vDir;
            void main(){
              float u = atan(vDir.z, vDir.x) * 0.1591549 + 0.5;   // azimuth → clouds wrap around
              float v = clamp(vDir.y * 2.8 + 0.035, 0.0, 1.0);     // reach the cool violet zenith within a normal orbit view
              gl_FragColor = texture2D(uSky, vec2(u, v));
            }`,
        });
        // Large enough to contain the full permitted orbit; leaving this dome
        // exposed the renderer's white clear colour as a triangular horizon gap
        // from wide side views.
        const dome = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 24), mat);
        dome.position.set(0, 0, 8); dome.renderOrder = -2; env.add(dome);   // centred on the model anchor
      }

      // ── Low sun disc (striped) + halo, dead-centre behind the torii, sitting
      //    low on the horizon in the sunset direction (−z). Kept within the
      //    camera far plane (the standalone's z=-1200 sun was clipped away). ──
      // Left at the texture's own values: pushed over 1 the bloom bleeds the
      // disc across the sky and the crimson washes out to peach.
      const sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(52, 52),
        new THREE.MeshBasicMaterial({ map: tex.sun, transparent: true, fog: false, depthWrite: false }));
      sunDisc.position.set(0, 8, -200); sunDisc.renderOrder = -1; env.add(sunDisc);
      // Square, so the gradient's ring clears the disc's rim evenly.
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(142, 142),
        new THREE.MeshBasicMaterial({ map: tex.halo, color: new THREE.Color(1.2, 1.05, 1.0),
          transparent: true, fog: false, depthWrite: false }));
      halo.position.set(0, 9, -205); halo.renderOrder = -2; env.add(halo);

      // ── Water — real reflective ocean (THREE.Water) mirroring the torii, sun
      //    and C64 across the dark navy surface. World-space (not the scaled
      //    group) so its ripple/reflection math stays in world units; `size` =
      //    1/S restores the standalone's ripple scale under our model scale. ──
      // Low sun, nudged off-axis so shadows rake across the terrace instead of
      // hiding behind their casters. ~14°: at true disc height (~5°) the
      // horizontal terrace catches nothing and the whole courtyard goes murky.
      const sunDir = new THREE.Vector3(0.22, 0.26, -1).normalize();
      const SEA = 2000;                        // sea plane extent (world units)
      // Fine pointer ≈ desktop → sharper reflections + shadow map.
      const fine = typeof window !== 'undefined' && !window.matchMedia?.('(pointer: coarse)').matches;
      const hiRT = fine ? 1024 : 512;
      // Dark indigo, not daylight blue — at dusk the water is the sky's mirror,
      // with a warm dusk specular.
      const water = new Water(new THREE.PlaneGeometry(SEA, SEA), {
        textureWidth: hiRT, textureHeight: hiRT,
        waterNormals: waterNormalTexture(),
        sunDirection: sunDir.clone(),
        sunColor: 0xffb06a, waterColor: 0x0b1730, distortionScale: 2.05, fog: true,
      });
      water.rotation.x = -Math.PI / 2;
      // Water's stock Fresnel reaches a full-strength mirror at grazing angles;
      // against the pale horizon that became a hard white wedge from side views.
      // Keep the reflection and specular structure, but hold the mirror exposure
      // inside the dusk palette. This shader is built once; animate only advances
      // its existing time uniform.
      water.material.fragmentShader = water.material.fragmentShader.replace(
        'reflectionSample + specularLight',
        'reflectionSample * 0.42 + specularLight',
      );
      water.material.needsUpdate = true;
      // The broad transparent halo billboard is useful in the sky but turns
      // into a clipped white wedge in Water's mirror camera at side-on orbit
      // angles. Exclude both sky billboards from that reflection pass; the
      // water shader's own warm specular remains the sunset trail.
      const renderWaterReflection = water.onBeforeRender;
      water.onBeforeRender = function onBeforeRender(renderer, scene2, camera) {
        sunDisc.visible = false; halo.visible = false;
        renderWaterReflection.call(this, renderer, scene2, camera);
        sunDisc.visible = true; halo.visible = true;
      };
      // Keep the sea BEHIND the shoreline instead of sweeping forward under the
      // beach into the foreground (which read as "water under the ground"). The
      // beach's far edge sits at env-z -14 -> world (cz - 22*S); push the plane
      // back by half its depth so its near (+z) edge lands exactly on that
      // shoreline. Everything in front (the sand the C64 stands on) is dry; the
      // torii stands a few units past the edge, in the shallows.
      const zShore = cz - 22 * S;
      water.position.set(cx, baseY, zShore - SEA / 2);   // same lift as env → the waterline stays fixed relative to the beach
      water.material.uniforms['size'].value = 2.6 / S;   // metre-scale chop, not oil-slick swirls
      g.add(water);

      // ── Courtyard — a tapered stone terrace, intimate around the C64 and
      //    narrowing toward the torii instead of reading as a 300-unit plaza.
      //    A subdivided unit plane is reshaped so it keeps settled-stone relief,
      //    broad non-repeating colour variation and a real shoreline edge. ──
      const groundY = (x, z) => 0.25 + Math.sin(x * 0.22) * 0.08 + Math.cos(z * 0.35 - x * 0.11) * 0.065;
      const beachGeo = new THREE.PlaneGeometry(1, 1, 40, 24);
      const bp = beachGeo.attributes.position, buv = beachGeo.attributes.uv;
      const bcol = new Float32Array(bp.count * 3);
      for (let i = 0; i < bp.count; i++) {
        const u = buv.getX(i), v = buv.getY(i);
        const z = 32 - v * 46, halfW = 44 - v * 20, x = (u - 0.5) * halfW * 2;
        bp.setXYZ(i, x, -z, groundY(x, z) - 0.25);
        const broad = 0.9 + Math.sin(x * 0.09 + z * 0.06) * 0.045 + Math.cos(z * 0.13) * 0.025;
        bcol[i * 3] = broad * 0.9; bcol[i * 3 + 1] = broad * 0.96; bcol[i * 3 + 2] = Math.min(1, broad * 1.04);
      }
      beachGeo.setAttribute('color', new THREE.BufferAttribute(bcol, 3));
      beachGeo.computeVertexNormals();
      const beach = new THREE.Mesh(beachGeo, new THREE.MeshStandardMaterial({
        map: tex.pavers || null, color: tex.pavers ? 0xb8c0d2 : 0x353a4d, vertexColors: true,
        roughness: 0.96, metalness: 0, bumpMap: tex.paversBump || null, bumpScale: 0.28,
      }));
      beach.rotation.x = -Math.PI / 2; beach.position.y = 0.25; beach.receiveShadow = true; env.add(beach);

      // ── Courtyard patina — sparse low-relief detail outside the central walk.
      //    Instancing keeps it to four draw calls, and every matrix is fixed at
      //    build time so none of this enters the animation hot path. ──
      const wornGeo = new THREE.CircleGeometry(1, 7);
      const wornMats = [std(0x30384a, 0.98), std(0x444251, 0.98)];
      const wornSpots = [
        [-23, 19, 1.7, 0.72, 0.2], [-15, 11, 1.25, 0.62, -0.5], [15, 18, 1.5, 0.65, 0.45],
        [24, 9, 1.3, 0.72, -0.2], [-19, 0, 1.1, 0.55, 0.8], [16, -3, 1.25, 0.6, -0.7],
        [-12, -8, 0.95, 0.5, 0.25], [11, -10, 1.0, 0.48, -0.35], [-29, 25, 1.45, 0.7, 0.1],
        [30, 23, 1.55, 0.68, -0.4], [-25, 14, 0.85, 0.46, 0.65], [21, 3, 0.8, 0.44, -0.1],
      ];
      const wornDummy = new THREE.Object3D();
      for (let m = 0; m < wornMats.length; m++) {
        const patches = new THREE.InstancedMesh(wornGeo, wornMats[m], wornSpots.length / 2);
        let ii = 0;
        for (let i = m; i < wornSpots.length; i += 2) {
          const p = wornSpots[i];
          wornDummy.position.set(p[0], groundY(p[0], p[1]) + 0.018, p[1]);
          wornDummy.rotation.set(-Math.PI / 2, 0, p[4]); wornDummy.scale.set(p[2], p[3], 1);
          wornDummy.updateMatrix(); patches.setMatrixAt(ii++, wornDummy.matrix);
        }
        patches.receiveShadow = true; env.add(patches);
      }
      const leafLitterGeo = new THREE.PlaneGeometry(0.2, 0.12);
      const litterSpots = [[5, 0], [7, 2], [10, 5], [12, 1], [15, 7], [18, 4], [6, 8], [14, 11], [20, 13], [9, 15], [23, 8], [17, 18]];
      const litterMats = [new THREE.MeshBasicMaterial({ color: 0xa93220, side: THREE.DoubleSide }),
                          new THREE.MeshBasicMaterial({ color: 0xd68a28, side: THREE.DoubleSide })];
      for (let m = 0; m < litterMats.length; m++) {
        const litter = new THREE.InstancedMesh(leafLitterGeo, litterMats[m], litterSpots.length / 2);
        let ii = 0;
        for (let i = m; i < litterSpots.length; i += 2) {
          const p = litterSpots[i];
          wornDummy.position.set(p[0], groundY(p[0], p[1]) + 0.035, p[1]);
          wornDummy.rotation.set(-Math.PI / 2, 0, i * 0.73); wornDummy.scale.setScalar(0.8 + (i % 3) * 0.16);
          wornDummy.updateMatrix(); litter.setMatrixAt(ii++, wornDummy.matrix);
        }
        env.add(litter);
      }

      // ── Torii gate — near-black silhouette against the sunset (the original
      //    backdrop's gate is flat black; a whisper of warm brown in the albedo
      //    keeps the backlit edges from going dead) ──
      const gate = new THREE.Group();
      const lacquer = new THREE.MeshPhysicalMaterial({
        color: 0x1b0c08, roughness: 0.7, clearcoat: 0.38, clearcoatRoughness: 0.55,
        emissive: 0x351008, emissiveIntensity: 0.12,
      });
      const darkWood = std(0x090609, 0.88), stone = glow(0x25293a, 0.07);
      const cyl = (rt, rb, h, m) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 20), m); c.castShadow = true; c.receiveShadow = true; return c; };
      const bx = (w, h, d, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.castShadow = true; b.receiveShadow = true; return b; };
      const postL = cyl(0.42, 0.52, 10, lacquer); postL.position.set(-4.6, 5, 0); postL.rotation.z = 0.045; gate.add(postL);
      const postR = cyl(0.42, 0.52, 10, lacquer); postR.position.set(4.6, 5, 0); postR.rotation.z = -0.045; gate.add(postR);
      const baseL = cyl(0.7, 0.8, 0.5, stone); baseL.position.set(-4.85, 0.25, 0); gate.add(baseL);
      const baseR = cyl(0.7, 0.8, 0.5, stone); baseR.position.set(4.85, 0.25, 0); gate.add(baseR);
      const kasagi = bx(12.6, 0.75, 1.0, darkWood); kasagi.position.set(0, 10.15, 0); gate.add(kasagi);
      const shimaki = bx(12.0, 0.5, 0.9, lacquer); shimaki.position.set(0, 9.55, 0); gate.add(shimaki);
      const capL = bx(2.6, 0.55, 1.0, darkWood); capL.position.set(-6.6, 10.45, 0); capL.rotation.z = 0.22; gate.add(capL);
      const capR = bx(2.6, 0.55, 1.0, darkWood); capR.position.set(6.6, 10.45, 0); capR.rotation.z = -0.22; gate.add(capR);
      const nuki = bx(10.6, 0.6, 0.7, lacquer); nuki.position.set(0, 7.6, 0); gate.add(nuki);
      const strut = bx(0.5, 1.4, 0.6, lacquer); strut.position.set(0, 8.55, 0); gate.add(strut);
      // Decorative detailing (enriches the backlit silhouette):
      // Kusabi wedges pinning the nuki tie-beam through each post.
      [-4.6, 4.6].forEach((x, i) => {
        const w = bx(0.3, 1.05, 0.95, darkWood); w.position.set(x, 7.6, 0); w.rotation.z = i ? -0.045 : 0.045; gate.add(w);
      });
      // Metal collars (kanawa) near the head + foot of each post.
      const collarMat = std(0x150f0a, 0.6, 0.15);
      [-4.6, 4.6].forEach((x, i) => {
        [9.0, 1.4].forEach((y) => {
          const band = cyl(0.57, 0.59, 0.24, collarMat); band.position.set(x, y, 0); band.rotation.z = i ? -0.045 : 0.045; gate.add(band);
        });
      });
      // Shimenawa (sacred rope) slung across the opening below the nuki.
      const rope = cyl(0.2, 0.2, 9.2, std(0x1c1409, 0.92)); rope.rotation.z = Math.PI / 2; rope.position.set(0, 7.0, 0.35); gate.add(rope);
      // Hanging diamond medallion in the centre of the opening (with its cord).
      const cord = bx(0.07, 1.0, 0.07, darkWood); cord.position.set(0, 6.4, 0.3); gate.add(cord);
      const med = bx(0.98, 0.98, 0.2, lacquer); med.position.set(0, 5.7, 0.3); med.rotation.z = Math.PI / 4; gate.add(med);
      const medIn = bx(0.5, 0.5, 0.22, std(0x160c05, 0.7)); medIn.position.set(0, 5.7, 0.33); medIn.rotation.z = Math.PI / 4; gate.add(medIn);
      gate.scale.setScalar(0.96);            // iconic but contained inside the courtyard composition
      // Standing IN the shallows a few units past the shoreline (z -14), stone
      // bases piercing the surface — so the posts rise from their own reflection.
      gate.position.set(0, -0.35, -19); env.add(gate);

      // ── Terrace edge — a small stone cliff face dropping from the pavement
      //    down into the water (no parapet: the courtyard simply ends and the
      //    bay begins). Flush with the beach edge at z -14; the top tucks into
      //    the pavement's settling bumps, the foot runs below the waterline.
      //    Backlit, so a little emissive keeps it readable rock instead of a
      //    black void. ──
      const cliff = bx(48, 1.0, 0.5, glow(0x414858, 0.12));
      cliff.position.set(0, -0.18, -14.25); env.add(cliff);

      // ── Stone path — a single, nearly flush line of worn slabs. On the
      //    terrace it reads by value rather than height; only the water crossing
      //    has a visible supporting deck. ──
      const slabMats = [std(0x394051, 0.96), std(0x41495a, 0.96), std(0x485163, 0.96)];
      for (let k = 0; k < 23; k++) {
        const sz = 7 - k * 1.27, sx2 = (Math.random() - 0.5) * 0.34;
        const slab = bx(2.25 + (Math.random() - 0.5) * 0.32, sz > -13.8 ? 0.035 : 0.08,
          1.02 + (Math.random() - 0.5) * 0.16, slabMats[(Math.random() * 3) | 0]);
        slab.castShadow = false;
        slab.position.set(sx2, sz > -13.8 ? groundY(sx2, sz) + 0.012 : 0.245, sz);
        slab.rotation.y = (Math.random() - 0.5) * 0.055;
        env.add(slab);
      }
      const deck = bx(3.8, 0.8, 7.0, glow(0x3c4353, 0.11));   // walls the water crossing
      deck.position.set(0, -0.3, -17.6); env.add(deck);

      // ── Water contact — expanding ripple rings where the torii posts and the
      //    deck pierce the surface, and a foam seam along the cliff base, so the
      //    stonework sits IN the bay instead of on it. ──
      const ringGeo = new THREE.RingGeometry(0.82, 1.0, 24);
      const rings = [];
      const ringAt = (x, z, r0, sp, ph) => {
        const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
          color: 0xb06a7a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          depthWrite: false, fog: false }));
        m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); env.add(m);
        rings.push({ mesh: m, r0, r1: r0 * 1.6, sp, ph, a: 0.3 });
      };
      ringAt(-5.9, -19, 1.1, 0.28, 0);   ringAt(-5.9, -19, 1.1, 0.28, 0.5);   // post L
      ringAt(5.9, -19, 1.1, 0.28, 0.23); ringAt(5.9, -19, 1.1, 0.28, 0.73);   // post R
      ringAt(0, -21.4, 2.6, 0.2, 0.4);                                        // deck nose
      g.userData.ikRings = rings;
      // Foam: irregular white blobs on a thin strip, two layers drifting in
      // opposite directions along the cliff base.
      const foamCv = document.createElement('canvas'); foamCv.width = 256; foamCv.height = 32;
      const fcx = foamCv.getContext('2d');
      for (let i = 0; i < 70; i++) {
        fcx.fillStyle = `rgba(232,220,224,${0.25 + Math.random() * 0.45})`;
        fcx.beginPath();
        fcx.ellipse(Math.random() * 256, 10 + Math.random() * 14, 2 + Math.random() * 7, 1 + Math.random() * 2.2, 0, 0, 7);
        fcx.fill();
      }
      const foamTexes = [];
      for (let k = 0; k < 2; k++) {
        const ft = new THREE.CanvasTexture(foamCv);
        ft.wrapS = THREE.RepeatWrapping; ft.repeat.set(8, 1);
        foamTexes.push(ft);
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(48, 0.5 + k * 0.35),
          new THREE.MeshBasicMaterial({ map: ft, transparent: true, opacity: 0.16 - k * 0.08,
            depthWrite: false }));
        strip.rotation.x = -Math.PI / 2; strip.position.set(0, 0.015 + k * 0.004, -14.75 - k * 0.3);
        env.add(strip);
      }
      g.userData.ikFoam = foamTexes;

      // ── Distant headlands ──
      const headland = (x, z, h, rad, color, emission) => {
        const geo = new THREE.ConeGeometry(rad, h, 20, 5);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const vx = p.getX(i), vz = p.getZ(i);
          const n = Math.sin(vx * 0.3 + vz * 0.5) * 0.08 + Math.cos(vz * 0.7 - vx * 0.2) * 0.06;
          p.setX(i, vx * (1 + n)); p.setZ(i, vz * (1 + n));
        }
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, glow(color, emission));
        m.scale.z = 0.62; m.rotation.y = x * 0.013;
        m.position.set(x, h / 2 - 0.5, z); env.add(m);
      };
      headland(-85, -160, 34, 68, 0x182535, 0.035); headland(-42, -180, 25, 44, 0x182239, 0.03);
      headland(80, -165, 31, 62, 0x24203b, 0.035); headland(42, -185, 22, 38, 0x1d203b, 0.03);
      // Near bay arms — overlapping cones read as ridged, forested headlands
      // (deep green closing the bay on the left, dusk-purple on the right).
      headland(-43, -66, 15, 26, 0x1a302c, 0.055); headland(-28, -58, 8, 15, 0x172b29, 0.05); headland(-55, -74, 11, 20, 0x182b2d, 0.05);
      headland(36, -70, 12, 20, 0x29243f, 0.05); headland(26, -60, 7, 12, 0x21213a, 0.045); headland(48, -78, 8, 15, 0x25213c, 0.045);

      // ── Autumn maple (right foreground) — gnarled trunk leaning over the
      //    shore, boughs reaching left toward the gate, wide flat clusters of
      //    turning leaves in the original's green/gold/rust palette ──
      const tree = new THREE.Group();
      const trunkMat = std(0x180b05, 0.92);
      // Connected skeleton: every branch is a bone drawn between two explicit
      // joints, so each starts exactly where its parent ends — no floating
      // limbs. bone(from, to, rBase, rTip); joints named below.
      const bone = (a, b, rBase, rTip) => {
        const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b);
        const d = bv.clone().sub(av), len = d.length();
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTip, rBase, len, 8), trunkMat);
        seg.castShadow = true; seg.receiveShadow = true;
        seg.position.copy(av).addScaledVector(d, 0.5);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
        tree.add(seg);
      };
      const knuckle = (p, r) => {
        const k = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), trunkMat);
        k.castShadow = true; k.position.set(...p); tree.add(k);
      };
      const jBase = [0.1, 0.05, 0], jMid = [-0.7, 3.3, 0], jFork = [-1.75, 5.35, 0.05];
      const jBoughT = [-4.05, 6.25, 0.15], jFarT = [-5.35, 6.6, 0], jRMid = [-0.5, 6.5, -0.15], jRT = [0.35, 7.05, -0.5];
      bone(jBase, [0.9, 0.05, 0.3], 0.22, 0.08);     // root flares
      bone(jBase, [-0.8, 0.05, 0.4], 0.2, 0.08);
      bone(jBase, [-0.1, 0.05, -0.75], 0.18, 0.07);
      bone([0.1, -0.3, 0], jMid, 0.52, 0.3);         // lower trunk (starts below grade)
      bone(jMid, jFork, 0.3, 0.19);                  // upper trunk, leaning left
      bone(jFork, jBoughT, 0.17, 0.09);              // main bough over the water
      bone(jBoughT, jFarT, 0.08, 0.04);              // far tip  → cluster (-5.4, 6.6)
      bone(jBoughT, [-3.45, 7.35, -0.35], 0.07, 0.035); // up-twig → cluster (-3.4, 7.4)
      bone(jBoughT, [-4.0, 6.0, -0.6], 0.05, 0.03);  // low stub → cluster (-4.0, 6.0)
      bone(jFarT, [-4.85, 7.05, 0.3], 0.04, 0.02);   // tip twig → cluster (-4.8, 7.0)
      bone(jFork, [-2.15, 6.6, 0.55], 0.09, 0.045);  // mid twig → cluster (-2.2, 6.6)
      bone(jFork, [0.0, 6.05, 0.75], 0.07, 0.04);    // low-right → cluster (0.0, 6.1)
      bone(jMid, [-2.55, 5.7, -0.15], 0.1, 0.05);    // long low branch → cluster (-2.6, 5.7)
      bone(jFork, jRMid, 0.13, 0.08);                // counter-bough right
      bone(jRMid, [-0.95, 7.55, 0.1], 0.06, 0.03);   // crown-left → cluster (-1.0, 7.6)
      bone(jRMid, jRT, 0.07, 0.04);                  // counter-bough tip → cluster (0.3, 7.0)
      bone(jRT, [1.55, 6.95, 0.35], 0.05, 0.03);     // right twig → cluster (1.5, 6.9)
      bone(jRT, [1.05, 7.85, -0.25], 0.05, 0.025);   // crown-right → cluster (1.0, 7.9)
      bone(jRT, [2.3, 7.4, -0.1], 0.045, 0.025);     // outermost → cluster (2.3, 7.4)
      knuckle(jMid, 0.31); knuckle(jFork, 0.2); knuckle(jBoughT, 0.1);
      knuckle(jRMid, 0.14); knuckle(jRT, 0.08);
      // Leaf masses: tight, hue-coherent clumps hugging the branch tips with
      // sky gaps between them (the 16-bit backdrop's airy, fired canopy) —
      // rust/gold dominant, green accents.
      const blobGeo = new THREE.IcosahedronGeometry(1, 1);
      const cols = [glow(0xd8642a, 0.42), glow(0xc24e22, 0.4), glow(0xe0a838, 0.42), glow(0xb83320, 0.4),
                    glow(0xe08838, 0.42), glow(0x4f8a2e, 0.38), glow(0x7fae36, 0.38)];
      const clusters = [
        [-4.8, 7.0, 0.3], [-3.4, 7.4, -0.5], [-2.2, 6.6, 0.7], [-1.0, 7.6, 0.1],
        [0.3, 7.0, -0.6], [1.5, 6.9, 0.4], [-2.6, 5.7, -0.2], [0.0, 6.1, 0.8],
        [-4.0, 6.0, -0.6], [2.3, 7.4, -0.1], [-5.4, 6.6, 0.0], [1.0, 7.9, -0.3],
      ];
      clusters.forEach(([kx, ky, kz], ci) => {
        const main = cols[ci % cols.length], accent = cols[(ci + 4) % cols.length];
        for (let b = 0, n = 5 + ((Math.random() * 3) | 0); b < n; b++) {
          const blob = new THREE.Mesh(blobGeo, Math.random() < 0.8 ? main : accent);
          blob.castShadow = true;
          const sc = 0.24 + Math.random() * 0.34; blob.scale.set(sc * 1.4, sc * 0.7, sc);
          blob.position.set(kx + (Math.random() - 0.5) * 1.15, ky + (Math.random() - 0.5) * 0.8, kz + (Math.random() - 0.5) * 1.15);
          tree.add(blob);
        }
      });
      // Falling leaves (the 16-bit backdrop's signature touch): small warm
      // quads tumbling from the canopy to the pavement on staggered loops.
      const leafMats = [0xd8642a, 0xe0a838, 0xb83320].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      const leafGeo = new THREE.PlaneGeometry(0.16, 0.11);
      const leaves = [];
      for (let l = 0; l < 7; l++) {
        const leaf = new THREE.Mesh(leafGeo, leafMats[l % leafMats.length]);
        tree.add(leaf);
        leaves.push({ leaf, x0: -4.6 + Math.random() * 7, y0: 6.2 + Math.random() * 1.6,
                      z0: (Math.random() - 0.5) * 2, sp: 0.08 + Math.random() * 0.07, ph: Math.random() });
      }
      g.userData.ikLeaves = leaves;
      tree.position.set(8.6, 0.2, -5); tree.scale.setScalar(1.0); env.add(tree);

      // ── Fishing village on its own rock islet in the bay, clear of the near
      //    arm's footprint (inside it, the slope buries the houses and the
      //    survivor reads as a floating box). Backlit by the sunset, so the
      //    walls/rock carry enough emissive to read as whitewash + ground. ──
      const spit = new THREE.Mesh(new THREE.CylinderGeometry(8, 12, 1.4, 18), glow(0x303944, 0.08));
      spit.position.set(-17, 0.15, -38); env.add(spit);
      // Emissive keeps the backlit walls off black, but stays under the bloom
      // threshold — at 0.75 the whitewash blew out into a lantern.
      const wallMat = glow(0xb8b4ae, 0.17), roofMat = std(0x171621, 0.9);
      [[-14.5, -37, 0.92, 0.25], [-18, -40.5, 1.1, -0.15], [-21, -37.8, 0.76, 0.4]].forEach(([hx, hz, hs, ry]) => {
        const house = new THREE.Group();
        const wb = bx(2.2, 1.3, 1.6, wallMat); wb.position.y = 0.65; house.add(wb);
        const rb = bx(2.6, 0.45, 2.0, roofMat); rb.position.y = 1.5; house.add(rb);
        const wl = bx(0.4, 0.34, 0.06, glow(0xffc86a, 1.5)); wl.position.set(0.5, 0.72, 0.82); house.add(wl);
        house.scale.setScalar(hs); house.position.set(hx, 1.0, hz); house.rotation.y = ry; env.add(house);
      });

      // ── Boat shed at the platform's left edge (the white box of the original
      //    backdrop's near shore) ──
      const shed = new THREE.Group();
      const sb = bx(1.9, 1.1, 1.4, wallMat); sb.position.y = 0.55; shed.add(sb);
      const sr = bx(2.3, 0.4, 1.8, roofMat); sr.position.y = 1.25; shed.add(sr);
      const sd = bx(0.6, 0.75, 0.06, std(0x14100c, 0.9)); sd.position.set(0.3, 0.4, 0.71); shed.add(sd);
      shed.position.set(-18, groundY(-18, -5) - 0.12, -5); shed.rotation.y = 0.5; env.add(shed);

      // ── Reed tufts — dark blades edging the waterline + platform corners ──
      const reedMat = std(0x101c0e, 0.95);
      const reedSpots = [[-8, -12.5], [8.5, -12], [-16, -11], [17, -12.5], [-21, -10], [21, -11]];
      for (const [rx, rz] of reedSpots) {
        for (let bld = 0, n = 4 + ((Math.random() * 3) | 0); bld < n; bld++) {
          const bh = 0.8 + Math.random() * 0.9;
          const bl = new THREE.Mesh(new THREE.ConeGeometry(0.035, bh, 4), reedMat);
          bl.position.set(rx + (Math.random() - 0.5) * 0.9, 0.18 + bh / 2, rz + (Math.random() - 0.5) * 0.9);   // rooted under the dune bumps
          bl.rotation.z = (Math.random() - 0.5) * 0.45; bl.rotation.x = (Math.random() - 0.5) * 0.3;
          env.add(bl);
        }
      }

      // ── Courtyard props (16-bit backdrop): square stone planters with vines
      //    spilling out, a low stone bench on the left, a round millstone
      //    basin on the right. Flanks only — the C64 (around scene (0, 8)) and
      //    the view corridor to the gate stay clear. Each prop is seated on
      //    the pavement's actual settling bump at its spot (groundY, defined
      //    at the stone path above; the beach plane is rotated, so
      //    plane-local v = 16 - world z). ──
      const stoneMatA = glow(0x565662, 0.13), stoneMatB = glow(0x4a4a56, 0.12), insetMat = std(0x14141a, 0.95);
      const vineMats = [glow(0x35702e, 0.16), glow(0x49803a, 0.16), glow(0x5f8a30, 0.16)];
      const vineGeo = new THREE.IcosahedronGeometry(0.22, 1);
      const planter = (x, z, s, ry, vined) => {
        const p = new THREE.Group();
        const skirt = bx(1.7, 0.18, 1.7, stoneMatB); skirt.position.y = 0.09; p.add(skirt);
        const body = bx(1.45, 1.0, 1.45, stoneMatA); body.position.y = 0.68; p.add(body);
        const inset = bx(1.1, 0.14, 1.1, insetMat); inset.position.y = 1.1; p.add(inset);
        if (vined) {
          for (let v = 0; v < 4; v++) {
            const blob = new THREE.Mesh(vineGeo, vineMats[v % vineMats.length]);
            const bs = 0.8 + Math.random() * 0.9; blob.scale.setScalar(bs);
            blob.position.set(0.35 - Math.random() * 0.9, 1.25 + Math.random() * 0.12, 0.35 - Math.random() * 0.9);
            blob.castShadow = true; p.add(blob);
          }
          const strand = cyl(0.05, 0.03, 0.9, vineMats[0]);   // one strand drooping down a side
          strand.position.set(0.62, 0.85, 0.5); strand.rotation.z = -0.35; strand.rotation.x = 0.15; p.add(strand);
        }
        p.scale.setScalar(s); p.rotation.y = ry;
        p.position.set(x, groundY(x, z) - 0.08, z); env.add(p);
      };
      planter(-10.5, 5, 0.95, 0.3, true);
      planter(-17, -5, 0.82, -0.2, true);
      planter(10.5, 3, 0.88, -0.4, true);
      planter(18, -7, 0.86, 0.5, true);
      // Low stone bench, front-left like the original's.
      const bench = new THREE.Group();
      const bTop = bx(2.5, 0.18, 0.95, glow(0x30303c, 0.12)); bTop.position.y = 0.64; bench.add(bTop);
      [-0.9, 0.9].forEach((lx) => { const leg = bx(0.5, 0.55, 0.72, stoneMatB); leg.position.set(lx, 0.28, 0); bench.add(leg); });
      bench.rotation.y = 0.25; bench.position.set(-10.5, groundY(-10.5, 15) - 0.06, 15); env.add(bench);
      // Round millstone basin on the right.
      const basin = new THREE.Group();
      const bOut = cyl(0.8, 0.9, 0.5, stoneMatA); bOut.position.y = 0.25; basin.add(bOut);
      const bIn = cyl(0.62, 0.62, 0.1, insetMat); bIn.position.y = 0.52; basin.add(bIn);
      basin.position.set(10.5, groundY(10.5, 14) - 0.06, 14); env.add(basin);

      // ── Gulls — flat black silhouettes gliding across the bay, slow flap;
      //    wings hinge at the body (root at z 0, tip at -z, so rotation.x
      //    flaps) and taper to a swept tip so a glide never reads as a bar ──
      const birdMat = new THREE.MeshBasicMaterial({ color: 0x120810, side: THREE.DoubleSide });
      const wingGeo = new THREE.BufferGeometry();
      wingGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0.24, 0, 0, -0.24, 0, 0, -0.1, 0, -1.15, 0.06, 0, -1.15,
      ]), 3));
      wingGeo.setIndex([0, 1, 2, 0, 2, 3]);
      wingGeo.computeVertexNormals();
      const bodyGeo = new THREE.SphereGeometry(0.09, 6, 4);
      const birds = [];
      for (let b = 0; b < 5; b++) {
        const bird = new THREE.Group();
        const wl = new THREE.Mesh(wingGeo, birdMat);
        const wr = new THREE.Mesh(wingGeo, birdMat); wr.rotation.y = Math.PI;
        const body = new THREE.Mesh(bodyGeo, birdMat); body.scale.set(2.6, 1, 1);
        bird.add(wl, wr, body); env.add(bird);
        birds.push({ bird, wl, wr, x0: Math.random() * 130, y: 8 + Math.random() * 9,
                     z: -24 - Math.random() * 46, sp: 2 + Math.random() * 1.8,
                     ph: Math.random() * Math.PI * 2, fl: 2.8 + Math.random() * 2 });
      }

      // ── The leaping fish (an IK+ signature), arcing out of the bay near the
      //    sun's glint every few seconds — with a splash ring where it breaks
      //    the surface and another where it re-enters ──
      const fish = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.8, 6),
        new THREE.MeshBasicMaterial({ color: 0x0c1226 }));
      fish.visible = false; env.add(fish);
      const splashes = [];
      for (const [sx3, t0] of [[5.35, 5.654], [2.45, 6.696]]) {   // arc's water-crossing points
        const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
          color: 0xd8907a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
          depthWrite: false, fog: false }));
        m.rotation.x = -Math.PI / 2; m.position.set(sx3, 0.02, -30); env.add(m);
        splashes.push({ mesh: m, t0 });
      }
      g.userData.ikSplashes = splashes;

      // ── Lights (world space) — low grazing warm sun; the cooler sunset IBL
      //    and hemisphere preserve neutral stone and machine shadows. ──
      const sun = new THREE.DirectionalLight(0xffa06a, 1.35);
      sun.position.copy(sphere.center).addScaledVector(sunDir, R * 40);
      sun.target.position.copy(sphere.center);
      sun.castShadow = true;
      // Frustum covers the courtyard — gate, tree, planters, bench — not just
      // the model, so everything on the terrace throws its long dusk shadow.
      // 2048 on desktop buys back the texel density the wider frame costs.
      sun.shadow.mapSize.set(fine ? 2048 : 1024, fine ? 2048 : 1024);
      sun.shadow.bias = -0.0008;
      const sc = sun.shadow.camera; sc.near = R * 15; sc.far = R * 70;
      sc.left = -R * 9; sc.right = R * 9; sc.top = R * 7; sc.bottom = -R * 7;
      g.add(sun, sun.target);
      g.add(new THREE.HemisphereLight(0x665f8c, 0x171d33, 0.94));

      g.userData.ikWater = water;
      g.userData.ikTree = tree;
      g.userData.ikBirds = birds;
      g.userData.ikFish = fish;
    },
    animate(g, t) {
      if (g.userData.ikWater) g.userData.ikWater.material.uniforms['time'].value = t * 0.36;
      if (g.userData.ikTree) g.userData.ikTree.rotation.z = Math.sin(t * 0.42) * 0.012;
      const birds = g.userData.ikBirds;
      if (birds) for (let i = 0; i < birds.length; i++) {   // indexed: no per-frame iterator alloc
        const o = birds[i];
        o.bird.position.set(((o.x0 + t * o.sp) % 130) - 65, o.y + Math.sin(t * 0.7 + o.ph) * 0.6, o.z);
        o.bird.rotation.z = Math.sin(t * 0.5 + o.ph) * 0.18;          // gentle banking
        const flap = Math.sin(t * o.fl + o.ph) * 0.38 + 0.18;         // slow, restrained wingbeats
        o.wl.rotation.x = flap; o.wr.rotation.x = -flap;
      }
      const fish = g.userData.ikFish;
      if (fish) {
        const p = ((t % 7.5) - 5.6) / 1.15;              // brief arc once per cycle
        fish.visible = p >= 0 && p <= 1;
        if (fish.visible) {
          fish.position.set(5.5 - p * 3.2, Math.sin(p * Math.PI) * 2.4 - 0.35, -30);
          fish.rotation.z = Math.atan2(Math.cos(p * Math.PI) * Math.PI * 2.4, -3.2) - Math.PI / 2;
        }
      }
      const rings = g.userData.ikRings;
      if (rings) for (let i = 0; i < rings.length; i++) {   // indexed: no per-frame iterator alloc
        const o = rings[i];
        const q = (t * o.sp + o.ph) % 1;
        o.mesh.scale.setScalar(o.r0 + q * o.r1);
        o.mesh.material.opacity = o.a * (1 - q) * Math.min(1, q * 7);   // fade in fast, out slow
      }
      const foam = g.userData.ikFoam;
      if (foam) { foam[0].offset.x = t * 0.006; foam[1].offset.x = -t * 0.004; }
      const splashes = g.userData.ikSplashes;
      if (splashes) for (let i = 0; i < splashes.length; i++) {
        const o = splashes[i];
        const q = ((t % 7.5) - o.t0) / 0.9;                  // 0.9s ring life after the crossing
        const on = q >= 0 && q <= 1;
        o.mesh.visible = on;
        if (on) { o.mesh.scale.setScalar(0.25 + q * 1.5); o.mesh.material.opacity = 0.5 * (1 - q); }
      }
      const leaves = g.userData.ikLeaves;
      if (leaves) for (let i = 0; i < leaves.length; i++) {   // indexed: no per-frame iterator alloc
        const o = leaves[i];
        const p = (t * o.sp + o.ph) % 1;                 // 0 = canopy, 1 = pavement
        o.leaf.position.set(
          o.x0 + Math.sin((t + o.ph * 9) * 1.7) * 0.5,
          o.y0 - p * (o.y0 - 0.2),
          o.z0 + Math.cos((t + o.ph * 7) * 1.2) * 0.35,
        );
        o.leaf.rotation.set(t * 2.3 + o.ph * 6, o.ph * 6, t * 1.9 + o.ph * 3);
      }
    },
};
