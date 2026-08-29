// Spec tests for Retro Vibes framebuffer light sampling and chevron geometry.

import assert from 'node:assert/strict';
import { sampleScreenLight } from '../src/vibes-screen-light.js';
import * as THREE from 'three';
import { makeChevronGeometry, scene as synthwave } from '../src/vibes-scene-synthwave.js';

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

const right = makeChevronGeometry(1, 1), left = makeChevronGeometry(1, -1);
right.computeBoundingBox(); left.computeBoundingBox();
assert.equal(right.groups.length > 0, true, 'each road chevron is one continuous extruded mesh');
assert.ok(Math.abs(right.boundingBox.max.x + left.boundingBox.min.x) < 1e-6, 'left and right chevrons are exact mirrored shapes');
assert.ok(Math.abs(right.boundingBox.min.x + left.boundingBox.max.x) < 1e-6, 'mirrored chevrons keep identical stitched extents');

// The Synthwave scene builds around the model's bounds without a renderer: the
// composition is fixed by the sphere and box it is handed, and the two shader
// clocks it leaves in userData are what animate() advances.
{
  const g = new THREE.Group();
  const sphere = { radius: 2, center: new THREE.Vector3(1, 0.5, -3) };
  const box = { min: new THREE.Vector3(-1, -0.7, -4), max: new THREE.Vector3(3, 1.7, -2) };
  synthwave.build(g, { sphere, box });
  assert.ok(g.children.length >= 15, `the scene is populated (${g.children.length} objects)`);
  assert.ok(g.userData.sunU && g.userData.gridU, 'the sun and grid clocks are exposed for animate');

  const floor = box.min.y - sphere.radius * 0.05;
  const sun = g.children.find(o => o.renderOrder === -1);
  assert.ok(sun && sun.position.z < sphere.center.z, 'the sun sits behind the machine');
  const grid = g.children.find(o => o.material?.uniforms?.uCell);
  assert.ok(grid && Math.abs(grid.position.y - floor) < 1e-9 && Math.abs(grid.rotation.x + Math.PI / 2) < 1e-9,
    'the grid lies flat on the floor line');
  assert.equal(g.children.filter(o => o.isPointLight).length, 2, 'two opposing rim lights');
  assert.equal(g.children.filter(o => o.isPoints).length, 2, 'two star scales');

  synthwave.animate(g, 4.25);
  assert.equal(g.userData.sunU.uTime.value, 4.25, 'animate advances the sun clock');
  assert.equal(g.userData.gridU.uTime.value, 4.25, 'and the grid clock');
  synthwave.animate(new THREE.Group(), 1);   // nothing built: nothing to advance
  assert.equal(synthwave.name, 'Synthwave');
  console.log('ok  - the Synthwave scene builds and animates without a renderer');
}

console.log('vibes screen-light spec: PASS');
