// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';

// Touch devices (phones AND tablets) never get the heavy 4K model: a large
// tablet like an iPad reports a longest dimension >= 1024 but has neither the
// GPU nor the memory headroom the desktop 4K asset assumes.
const IS_TOUCH_DEVICE = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
    || (typeof window !== 'undefined' && 'ontouchstart' in window);
// Whether the AUTOMATIC choice wants the heavy 4K model. A desktop-sized screen is
// a decent proxy for "has the GPU/memory for it": phones (even hi-DPI) report a
// longest CSS dimension well under 1024, and tablets are excluded via the touch
// check above. This is a model selector, not a screen query.
function autoWantsLargeModel() {
  return (typeof window !== 'undefined' && window.screen)
    ? Math.max(window.screen.width, window.screen.height) >= 1024 && !IS_TOUCH_DEVICE
    : true;
}
// User override for the 3D models (Options ▸ Display ▸ 3D MODEL SIZE): 'small'
// (default — the light files, safe on every device), 'auto' (pick by device: the
// large files on desktop, light on phones/tablets), or 'large' (force the large
// files). It picks both the C64 model and the 80s Bedroom's room. Read
// FRESH at load time so changing it and reopening the viewer picks up the new
// choice. Written by main.js.
const VIBES_MODEL_KEY = 'c64emu.vibesModel';
export function wantsLargeModels() {
  let pref = 'small';
  try { pref = localStorage.getItem(VIBES_MODEL_KEY) || 'small'; } catch { /* storage off */ }
  return pref === 'large' ? true : (pref === 'auto' ? autoWantsLargeModel() : false);
}

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
