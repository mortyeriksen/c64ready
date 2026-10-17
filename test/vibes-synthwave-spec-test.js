// Spec tests for Synthwave (src/vibes/vibes-scene-synthwave.js): it builds
// around the model's bounds without a renderer, only the neon glows, the whole
// world drives toward the viewer at one speed, the layout is the same on every
// visit, and low-power devices get the painted road. Its palms and mountains
// come from public/models/synthwave.glb, handed over here by a fetch stub.

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { scene, FLOW, gridLines } from '../src/vibes/vibes-scene-synthwave.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const glbPath = path.join(root, 'public/models/synthwave.glb');
if (!fs.existsSync(glbPath)) {
  console.log('# SKIP public/models/synthwave.glb is not present');
  process.exit(0);
}
globalThis.fetch = async (url) => {
  const file = path.join(root, 'public', String(url).replace(/^\//, ''));
  return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, arrayBuffer: async () => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
};

const sphere = new THREE.Sphere(new THREE.Vector3(0, 2, -1), 7.7);
const box = new THREE.Box3(new THREE.Vector3(-5.5, 0, -6.2), new THREE.Vector3(5.2, 3.8, 4.3));
const build = async (lowPower, s = sphere, b = box) => {
  const g = new THREE.Group(), parent = new THREE.Group(); parent.add(g);   // a parent: still on screen when the file arrives
  await scene.preload();
  await scene.build(g, { sphere: s, box: b, screen: null, lowPower });
  return g;
};

// Only what is pushed past 1.0 glows, so the live picture (at most 1.0) stays crisp.
assert.equal(scene.name, 'Synthwave');
assert.ok(!scene.basic, 'Synthwave renders through the composer, for its bloom');
assert.ok(scene.bloom.threshold >= 1.0, 'the bloom threshold keeps the live picture out of the glow');
assert.equal(scene.tone, 'neutral', 'Khronos PBR Neutral leaves everything below its knee as it is');

const g = await build(false), n = g.userData.neon;
const floor = box.min.y - sphere.radius * 0.018;
const sun = g.children.find((o) => o.renderOrder === -1 && o.geometry?.parameters?.width === sphere.radius * 28);
assert.ok(sun && sun.position.z < sphere.center.z, 'the sun sits behind the machine');
const grid = g.children.find((o) => o.material?.uniforms?.uSpeed);
assert.ok(grid && Math.abs(grid.position.y - floor) < 1e-9 && Math.abs(grid.rotation.x + Math.PI / 2) < 1e-9, 'the grid lies flat on the floor line');
let road = null; g.traverse((o) => { if (o.isReflector) road = o; });
assert.ok(road && Math.abs(road.position.y - box.min.y) < 1e-9, 'the road\'s surface is the model\'s lowest point: the machine stands on it');

// The city: one mesh standing on the floor line, beyond where palms and signs
// appear and in front of the sun, wider than the sun's disc.
{
  const city = g.children.filter((o) => o.material?.uniforms?.uR);
  assert.equal(city.length, 1, 'the skyline is one mesh, one draw');
  const b = new THREE.Box3().setFromObject(city[0], true);
  assert.ok(Math.abs(b.min.y - floor) < 1e-4, 'the towers stand on the floor line');
  assert.ok(b.max.z < n.zFar && b.min.z > sun.position.z, 'the city stands beyond the palms\' far end, in front of the sun');
  assert.ok(b.max.x - b.min.x > sun.geometry.parameters.width, 'the skyline spans wider than the sun');
  assert.ok(b.max.y - floor > sphere.radius * 4, 'some towers rise well into the sun\'s disc');
  const again = (await build(false)).children.find((o) => o.material?.uniforms?.uR);
  assert.deepEqual([...again.geometry.attributes.position.array], [...city[0].geometry.attributes.position.array], 'the skyline is the same on every visit');
  scene.animate(g, 12.5, false, null);
  assert.equal(city[0].material.uniforms.uTime.value, 12.5, 'animate drives the windows and beacons');
}

// The scenery: 14 palms that drive, two modelled flanks with contour lines, the rear range.
const palms = n.movers.filter((m) => m.obj.isMesh);
assert.equal(palms.length, 14, 'seven palms a side, from the modelled ones');
let contours = 0, fills = 0;
g.traverse((o) => { if (o.isLineSegments) contours++; if (o.isMesh && /^(Mountain|Rear)/.test(o.name)) fills++; });
assert.equal(contours, 2, 'each flank carries its contour lines');
assert.equal(fills, 4, 'two flanks and two rear ranges');
{
  // Contour lines run along the grid's axes, never across a quad.
  const quad = new THREE.PlaneGeometry(2, 2, 2, 2).rotateX(-Math.PI / 2);
  const p = gridLines(quad).attributes.position;
  for (let i = 0; i < p.count; i += 2) {
    assert.ok(Math.abs(p.getX(i) - p.getX(i + 1)) < 1e-6 || Math.abs(p.getZ(i) - p.getZ(i + 1)) < 1e-6, 'a contour line follows the grid, no diagonals');
  }
  assert.equal(p.count / 2, 12, 'a 2×2 grid has 12 grid edges');
}

// One driving speed for the grid, the road marks, the palms and the signs.
assert.ok(Math.abs(n.gridU.uSpeed.value - FLOW * sphere.radius) < 1e-9 && Math.abs(n.speed - FLOW * sphere.radius) < 1e-9,
  'the grid and the palms and signs drive at one speed');
assert.ok(Math.abs(n.roadU.uFlow.value * sphere.radius * 124 - n.speed) < 1e-9, 'the road marks drive at that speed too');
for (const t of [0, 3.7, 61.2, 1000.5]) {
  scene.animate(g, t, false, null);
  for (const m of n.movers) {
    const z = m.obj.position.z;
    assert.ok(z >= n.zFar - 1e-6 && z < n.zFar + n.span + 1e-6, `at t=${t} every palm and sign stays within its loop`);
  }
}
const before = n.movers.map((m) => m.obj.position.z);
scene.animate(g, 1000.6, false, null);
assert.ok(n.movers.every((m, i) => { const d = m.obj.position.z - before[i]; return (d > 0 && Math.abs(d - n.speed * 0.1) < 1e-6) || d < 0; }),
  'between frames everything moves toward the viewer by the flow (or wraps to the far end)');
assert.equal(n.gridU.uTime.value, 1000.6, 'animate advances the grid clock');

// The mirror, and the painted road on low-power devices.
let mirrors = 0; g.traverse((o) => { if (o.isReflector) mirrors++; });
assert.equal(mirrors, 1, 'the road is a mirror off low-power devices');
assert.ok(g.userData.reflection, 'the mirror refreshes through the 30 Hz reflection cache');
const lite = await build(true);
let liteMirrors = 0; lite.traverse((o) => { if (o.isReflector) liteMirrors++; });
assert.equal(liteMirrors, 0, 'low-power devices get the painted road, no mirror');

// The same layout on every visit.
const layout = (grp) => [
  ...(() => { const out = []; grp.traverse((o) => { if (o.isPoints) out.push(...o.geometry.attributes.position.array.slice(0, 30)); }); return out; })(),
  ...grp.userData.neon.movers.map((m) => m.obj.position.x),
];
assert.deepEqual(layout(await build(false)), layout(await build(false)), 'stars and palms are placed from fixed seeds');

// Scaling the model and its rig preserves the neon light on it.
{
  const k = 3;
  const big = await build(false, new THREE.Sphere(sphere.center.clone().multiplyScalar(k), sphere.radius * k),
    new THREE.Box3(box.min.clone().multiplyScalar(k), box.max.clone().multiplyScalar(k)));
  const rims = g.children.filter((o) => o.isPointLight), bigRims = big.children.filter((o) => o.isPointLight);
  assert.equal(rims.length, 2, 'two opposing neon rim lights');
  for (let i = 0; i < rims.length; i++) {
    assert.equal(rims[i].decay, 2, 'neon light energy follows inverse-square attenuation');
    const a = rims[i].intensity / rims[i].position.distanceToSquared(sphere.center);
    const b = bigRims[i].intensity / bigRims[i].position.distanceToSquared(sphere.center.clone().multiplyScalar(k));
    assert.ok(Math.abs(a - b) < 1e-12, 'scaling the model and rig preserves neon illumination');
  }
}

const viewer = fs.readFileSync(path.join(root, 'src/vibes/retrovibes.js'), 'utf8');
assert.match(viewer, /const SCENES = \[sceneSynthwave, sceneStarry, /, 'Synthwave is the first scene');

console.log('ok  - synthwave: neon-only glow, a city skyline, modelled palms and mountains, one driving speed, fixed layout, mirror or painted road');
