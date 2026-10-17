// Spec tests for Retro Vibes framebuffer light sampling, the live picture's
// brightness ceiling and chevron geometry.

import assert from 'node:assert/strict';
import { sampleScreenLight } from '../src/vibes/vibes-screen-light.js';
import { addCrtLight, animateCrtLight } from '../src/vibes/vibes-crt-light.js';
import * as THREE from 'three';
import fs from 'node:fs';
import { makeChevronGeometry } from '../src/vibes/vibes-scene-synthwave.js';

const result = { r: 0, g: 0, b: 0, luminance: 0, active: false };
const solid = (r, g, b) => new Uint8ClampedArray([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]);

sampleScreenLight(solid(255, 0, 0), 2, 2, result);
assert.equal(result.active, true, 'a valid live framebuffer contributes CRT light');
assert.equal(result.r, 1, 'screen-light sampling preserves full linear red energy');
assert.equal(result.g, 0, 'screen-light sampling does not invent green energy');
assert.ok(Math.abs(result.luminance - 0.2126) < 1e-9, 'screen-light luminance follows linear Rec. 709 weights');

sampleScreenLight(solid(128, 128, 128), 2, 2, result);
assert.ok(result.r > 0.21 && result.r < 0.22, 'screen-light sampling decodes sRGB before averaging');
assert.ok(Math.abs(result.r - result.g) < 1e-12 && Math.abs(result.g - result.b) < 1e-12, 'neutral screen content produces neutral spill');

sampleScreenLight(null, 2, 2, result);
assert.equal(result.active, false, 'a missing framebuffer disables CRT spill');

{
  const screen = { center: new THREE.Vector3(1, 2, 3), normal: new THREE.Vector3(0, 0, 1), width: 4, height: 3 };
  const makeLight = () => {
    const group = new THREE.Group();
    addCrtLight(group, screen, 2);
    return group;
  };
  const red = sampleScreenLight(solid(255, 0, 0), 2, 2, {});
  const blue = sampleScreenLight(solid(0, 0, 255), 2, 2, {});
  const black = sampleScreenLight(solid(0, 0, 0), 2, 2, {});
  const group = makeLight(), light = group.userData.crtGlow;
  const outward = new THREE.Vector3(0, 0, -1).applyQuaternion(light.quaternion);
  assert.ok(outward.dot(screen.normal) > 0.999, 'CRT illumination leaves the front of the glass');
  assert.equal(light.intensity, 0, 'a newly built CRT waits for live picture energy');
  for (let i = 0; i <= 120; i++) animateCrtLight(group, i / 60, true, red);
  assert.ok(light.color.r > light.color.b * 5, 'a red picture casts predominantly red spill');
  assert.ok(light.intensity > 0, 'a powered CRT with a bright picture illuminates its surroundings');
  for (let i = 121; i <= 240; i++) animateCrtLight(group, i / 60, true, blue);
  assert.ok(light.color.b > light.color.r * 5, 'spill follows a change in picture colour');
  for (let i = 241; i <= 360; i++) animateCrtLight(group, i / 60, true, black);
  assert.ok(light.intensity < 1e-5, 'black picture energy decays to darkness without a constant light floor');
  for (let i = 361; i <= 480; i++) animateCrtLight(group, i / 60, true, blue);
  for (let i = 481; i <= 600; i++) animateCrtLight(group, i / 60, false, blue);
  assert.ok(light.intensity < 1e-5, 'power off extinguishes spill even if a bright sample remains cached');
  const slow = makeLight(), fast = makeLight();
  for (let i = 0; i <= 15; i++) animateCrtLight(slow, i / 30, true, red);
  for (let i = 0; i <= 60; i++) animateCrtLight(fast, i / 120, true, red);
  assert.ok(Math.abs(slow.userData.crtGlow.intensity - fast.userData.crtGlow.intensity) < 1e-12,
    'CRT response depends on elapsed time, not display refresh rate');
  animateCrtLight(slow, 0.6, true, null);
  assert.ok(slow.userData.crtGlow.intensity < fast.userData.crtGlow.intensity, 'a missing live sample fades the emitter');
  const empty = new THREE.Group();
  addCrtLight(empty, null, 2);
  animateCrtLight(empty, 0, true, red);
  assert.equal(empty.children.length, 0, 'models without glass do not acquire a misplaced CRT light');
}

const right = makeChevronGeometry(1, 1), left = makeChevronGeometry(1, -1);
right.computeBoundingBox(); left.computeBoundingBox();
assert.equal(right.groups.length > 0, true, 'each road chevron is one continuous extruded mesh');
assert.ok(Math.abs(right.boundingBox.max.x + left.boundingBox.min.x) < 1e-6, 'left and right chevrons are exact mirrored shapes');
assert.ok(Math.abs(right.boundingBox.min.x + left.boundingBox.max.x) < 1e-6, 'mirrored chevrons keep identical stitched extents');

{
  // The live picture never passes 1.0, so a bloom threshold of 1.0 keeps it out
  // of the glow: the scanline gain is capped after it is applied.
  const viewer = fs.readFileSync(new URL('../src/vibes/retrovibes.js', import.meta.url), 'utf8');
  const out = viewer.match(/gl_FragColor\.rgb\s*=\s*min\(\s*gl_FragColor\.rgb\s*\*\s*lines\s*\*\s*vig\s*\*\s*mix\(\s*1\.0,\s*uGain,\s*fade\s*\),\s*vec3\(\s*1\.0\s*\)\s*\)/);
  assert.ok(out, 'the CRT scanline gain is capped at 1.0, so the live picture stays under the bloom threshold');
  for (const file of fs.readdirSync(new URL('../src/vibes/', import.meta.url)).filter((f) => /^vibes-scene-.*\.js$/.test(f))) {
    const src = fs.readFileSync(new URL(`../src/vibes/${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/bloom:\s*\{[^}]*threshold:\s*([\d.]+)/g)) {
      assert.ok(Number(m[1]) >= 1.0, `${file}: a bloom threshold of ${m[1]} would make the live picture's whites glow (it tops out at 1.0)`);
    }
  }
}

console.log('vibes screen-light spec: PASS');
