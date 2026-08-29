// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';

// Cached vertical-gradient equirect sky texture per scene (opaque background so
// the bloom composite is clean and reflections have something to catch).
const _bgCache = new Map();
export function bgTexture(key, stops) {
  if (_bgCache.has(key)) return _bgCache.get(key);
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = 16; c.height = 256;
  const cx = c.getContext('2d');
  const grad = cx.createLinearGradient(0, 0, 0, 256);
  for (const [pos, col] of stops) grad.addColorStop(pos, col);
  cx.fillStyle = grad; cx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex._shared = true;   // module-cached across opens — never dispose in _teardownGL
  _bgCache.set(key, tex);
  return tex;
}

// Generic procedural CanvasTexture (repeat-tiled, sRGB). draw(ctx, size).
export function canvasTexture(size, draw, repeatX = 1, repeatY = 1) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tag every THREE.Texture in `val` (a texture, or an object whose values are
// textures) with _shared, so the material/teardown disposal never frees a
// module-level cached texture — these persist for the app lifetime. Returns val.
export function markShared(val) {
  if (val && val.isTexture) { val._shared = true; return val; }
  if (val && typeof val === 'object') for (const k in val) { const t = val[k]; if (t && t.isTexture) t._shared = true; }
  return val;
}

// 80s-bedroom room-shell procedural textures — cached at module level (created once, shared)
// so repeatedly entering the room doesn't leak GPU textures.
let _roomTex = null;
export function roomTextures() {
  if (_roomTex) return _roomTex;
  const carpet = canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#8a4a1e'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 42000; i++) { const v = Math.random(); ctx.fillStyle = `rgb(${(110 + v * 60) | 0},${(52 + v * 36) | 0},${(18 + v * 22) | 0})`; ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); }
  }, 4, 4);
  const carpetBump = canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 42000; i++) { const gg = 60 + Math.random() * 140; ctx.fillStyle = `rgb(${gg | 0},${gg | 0},${gg | 0})`; ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
  }, 4, 4);
  if (carpetBump) carpetBump.colorSpace = THREE.NoColorSpace;
  const panel = canvasTexture(512, (ctx, s) => {
    const pw = s / 6;
    for (let p = 0; p < 6; p++) {
      const x0 = p * pw, base = 96 + (p % 3) * 10 + Math.random() * 8;
      ctx.fillStyle = `rgb(${base | 0},${(base * 0.62) | 0},${(base * 0.36) | 0})`; ctx.fillRect(x0, 0, pw, s);
      for (let i = 0; i < 220; i++) { const gx = x0 + Math.random() * pw, sh = Math.random() * 30 - 15; ctx.strokeStyle = `rgba(${(base + sh) | 0},${((base + sh) * 0.6) | 0},${((base + sh) * 0.34) | 0},0.35)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(gx, 0); ctx.bezierCurveTo(gx + 4, s * 0.33, gx - 4, s * 0.66, gx + 2, s); ctx.stroke(); }
      ctx.fillStyle = 'rgba(30,16,6,0.9)'; ctx.fillRect(x0 + pw - 3, 0, 3, s);
    }
  }, 4.3, 1);
  const ceiling = canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#d8d2c4'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 26000; i++) { const gg = 190 + Math.random() * 50; ctx.fillStyle = `rgba(${gg | 0},${(gg * 0.97) | 0},${(gg * 0.9) | 0},${0.3 + Math.random() * 0.5})`; ctx.beginPath(); ctx.arc(Math.random() * s, Math.random() * s, Math.random() * 1.8, 0, 7); ctx.fill(); }
  }, 3, 3);
  const wallpaper = canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#cfc3a8'; ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 32) { ctx.fillStyle = 'rgba(146,120,86,0.5)'; ctx.fillRect(x, 0, 3, s); ctx.fillStyle = 'rgba(146,120,86,0.25)'; ctx.fillRect(x + 10, 0, 1, s); }
  }, 4, 1);
  const sky = canvasTexture(256, (ctx, s) => {
    const grad = ctx.createLinearGradient(0, 0, 0, s); grad.addColorStop(0, '#0a1226'); grad.addColorStop(1, '#050912'); ctx.fillStyle = grad; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) { ctx.fillStyle = `rgba(210,225,255,${0.3 + Math.random() * 0.7})`; ctx.fillRect(Math.random() * s, Math.random() * s * 0.8, 1, 1); }
    const mg = ctx.createRadialGradient(s * 0.72, s * 0.24, 2, s * 0.72, s * 0.24, 34);
    mg.addColorStop(0, 'rgba(230,238,255,0.95)'); mg.addColorStop(0.35, 'rgba(190,205,235,0.5)'); mg.addColorStop(1, 'rgba(190,205,235,0)');
    ctx.fillStyle = mg; ctx.fillRect(0, 0, s, s);
  });
  if (sky) sky.wrapS = sky.wrapT = THREE.ClampToEdgeWrapping;
  _roomTex = markShared({ carpet, carpetBump, panel, ceiling, wallpaper, sky });
  return _roomTex;
}

// Soft, physically attenuated studio spotlight from above. `intensity` is the
// desired illuminance scale at the model centre; converting it to candela with
// distance² keeps the look stable when model bounds change.
export function overheadSpot(color, intensity, sphere, penumbra = 0.8) {
  const R = sphere.radius, height = R * 4.5;
  const spot = new THREE.SpotLight(color, intensity * height * height, R * 11, Math.PI / 5, penumbra, 2);
  spot.position.copy(sphere.center).add(new THREE.Vector3(-R * 0.62, height, R * 0.82));
  spot.target.position.copy(sphere.center);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.camera.near = sphere.radius * 0.5;
  spot.shadow.camera.far = sphere.radius * 12;
  spot.shadow.radius = 8; spot.shadow.bias = -0.0005;
  return spot;
}

export function floorPlane(sphere, box, color, roughness, metalness) {
  const f = new THREE.Mesh(
    new THREE.PlaneGeometry(sphere.radius * 20, sphere.radius * 20),
    new THREE.MeshStandardMaterial({ color, roughness, metalness }),
  );
  f.rotation.x = -Math.PI / 2;
  f.position.set(sphere.center.x, box.min.y, sphere.center.z);
  f.receiveShadow = true;
  return f;
}
